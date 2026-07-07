import { EventEmitter } from 'node:events';
import type { RegistryClient } from './index';
import type {
  AgentSearchResult,
  AgentCompliance,
  AuthorizationEntry,
  AgentSearchResponse,
  FeedFreshness,
} from './types.generated';
import type { CatalogEvent, FeedResponse, PropertyEventPayload, PropertyIdentifier, ResolvedBrand } from './types';
import type { FeedStreamQuery } from './feed-stream';
import {
  FeedStreamCursorExpiredError,
  FeedStreamUnsupportedError,
  FeedStreamHttpError,
  sanitizeStreamText,
} from './feed-stream';
import type { CursorStore } from './cursor-store';
import { InMemoryCursorStore } from './cursor-store';

// ====== Configuration ======

export interface RegistrySyncConfig {
  /** RegistryClient instance to use for API calls. */
  client: RegistryClient;
  /**
   * Feed transport for tailing changes after bootstrap:
   * - `'auto'` (default): try the SSE stream, fall back to polling on an
   *   unsupported endpoint (404/406), proxy/network failure, or stream parse
   *   failure.
   * - `'stream'`: SSE only; reconnect on failure and never fall back to polling.
   * - `'poll'`: polling only.
   */
  transport?: 'auto' | 'stream' | 'poll';
  /** Polling interval in milliseconds. Default: 30000 (30s). */
  pollIntervalMs?: number;
  /**
   * Comma-separated event type filter (glob, e.g. `authorization.*`) applied to
   * every feed read (bootstrap drain, polling, and SSE).
   *
   * A persisted cursor is scoped to the logical `types` subscription it was
   * minted under: a cursor from a broader subscription can skip events that were
   * filtered out previously. This is NOT enforced by the cursor store (the store
   * holds only the cursor string), so if you change `types` you must
   * `reset()` before `start()`. With a persistent {@link FileCursorStore} that
   * survives restarts, changing `types` between deploys against the same store
   * path will silently resume from a foreign cursor — point each subscription at
   * its own store path, or clear the store when the filter changes.
   */
  types?: string;
  /** Max events requested per feed page (polling and SSE). Default: 1000. */
  feedPageLimit?: number;
  /**
   * Server-side caught-up interval hint for the SSE stream, in **seconds** (5–60,
   * default 15) — maps to the `poll_interval_seconds` query param. Note the unit:
   * `pollIntervalMs` and `streamIdleTimeoutMs` are milliseconds.
   */
  streamPollIntervalSeconds?: number;
  /**
   * Client-side idle watchdog: reconnect the stream if no feed page or heartbeat
   * arrives within this window. Must exceed the server poll interval.
   * Default: 90000 (90s).
   */
  streamIdleTimeoutMs?: number;
  /** Reconnect backoff floor in ms. Default: 1000. */
  streamReconnectMinMs?: number;
  /** Reconnect backoff ceiling in ms. Default: 30000. */
  streamReconnectMaxMs?: number;
  /**
   * Consecutive stream failures (with no successful message in between) before
   * `'auto'` mode falls back to polling. Default: 3. Ignored in `'stream'` mode.
   */
  maxStreamFailures?: number;
  /** Choose which indexes to maintain. */
  indexes?: {
    /** Agent inventory profiles. Default: true. */
    agents?: boolean;
    /** Authorization entries (agent→domain mappings). Default: true. */
    authorizations?: boolean;
    /** Property feed records (property_rid→property and publisher domain→properties). Default: true. */
    properties?: boolean;
    /** Ordered brand hierarchy chains (self → parents → house). Default: true. */
    brandHierarchies?: boolean;
  };
  /** Optional cursor store for persisting the feed cursor between restarts. */
  cursorStore?: CursorStore;
  /** Called when RegistrySync intentionally ignores an event family it does not index. */
  onIgnoredEvent?: (event: CatalogEvent, reason: string) => void;
  /** Called on errors during polling/bootstrap. */
  onError?: (error: Error) => void;
}

export type RegistrySyncState = 'idle' | 'bootstrapping' | 'syncing' | 'error';

/** Active feed transport once syncing. */
export type RegistrySyncTransport = 'stream' | 'poll';

/**
 * Outcome of one SSE connection, driving the reconnect loop.
 * - `closed`: the server ended the stream cleanly (EOF), no error.
 * - `reconnect`: a transport/parse failure or a server `feed_stream_error` —
 *   counts toward `auto` polling fallback.
 */
type StreamDisposition = 'closed' | 'reconnect' | 'rebootstrap' | 'fallback' | 'fatal' | 'stopped';
type RegistrySyncComplianceStatus = AgentCompliance['status'] | 'opted_out';
type AuthorizationRemoveOptions = {
  matchByRowId?: boolean;
  fallbackToTupleOnMissingRowId?: boolean;
};

// ====== Event types ======

export interface RegistrySyncEvents {
  bootstrap: [{ agentCount: number; authorizationCount: number }];
  sync: [{ cursor: string; eventsApplied: number }];
  /** Emitted for each event applied during polling. Not emitted during bootstrap. */
  event: [{ event: CatalogEvent }];
  error: [{ error: Error }];
  /** Emitted when an agent's compliance status changes. */
  compliance_changed: [
    { agentUrl: string; previousStatus: RegistrySyncComplianceStatus; currentStatus: RegistrySyncComplianceStatus },
  ];
  stateChange: [{ from: RegistrySyncState; to: RegistrySyncState }];
  /** Emitted whenever a feed page or heartbeat carries freshness metadata, for lag monitoring. */
  freshness: [{ freshness: FeedFreshness }];
  /** Emitted when the active feed transport changes (e.g. stream → polling fallback). */
  transport: [{ transport: RegistrySyncTransport }];
  /** Emitted when an event is intentionally not indexed by RegistrySync. */
  ignoredEvent: [{ event: CatalogEvent; reason: string }];
}

// ====== Agent filter for client-side search ======

export interface AgentFilter {
  type?: string;
  channels?: string[];
  markets?: string[];
  categories?: string[];
  property_types?: string[];
  tags?: string[];
  delivery_types?: string[];
  has_tmp?: boolean;
  min_properties?: number;
  compliance_status?: RegistrySyncComplianceStatus[];
}

export type RegistrySyncProperty = {
  /** Stable registry property RID. */
  property_rid: string;
  /** Publisher domain that owns the property, when supplied by the feed. */
  publisher_domain?: string;
  identifiers?: PropertyIdentifier[];
  classification?: string;
  source?: PropertyEventPayload['source'];
  property?: PropertyEventPayload['property'];
  changed_fields?: string[];
  last_resolved_at?: string;
  reactivated_at?: string;
  reason?: string;
  evidence?: string;
  [key: string]: unknown;
};

// ====== RegistrySync ======

/**
 * In-memory replica of the AdCP registry.
 *
 * Bootstraps from the agent search endpoint, then tails the change feed —
 * Server-Sent Events by default (`transport: 'auto'`), falling back to polling
 * `/api/registry/feed` when streaming is unavailable — to keep its indexes
 * current for zero-latency lookups.
 *
 * **Staleness:** lookups (`getAgent`, `isAuthorized`, the authorization getters)
 * return the last synced state. After a transient failure the engine keeps
 * reconnecting/polling, but a fatal error (e.g. `401`) leaves `state === 'error'`
 * while the indexes still hold their last values. For decisions where staleness
 * is unsafe (e.g. authorization enforcement), gate on `state` and
 * `getLagSeconds()` / `getFreshness()` rather than trusting a lookup blindly.
 * Index size is bounded only by registry trust — a replica mirrors the whole
 * registry, so an untrusted/compromised feed could grow memory without limit.
 *
 * @example
 * ```ts
 * const client = new RegistryClient({ apiKey: 'sk_...' });
 * const sync = new RegistrySync({ client }); // transport: 'auto' (SSE, polling fallback)
 *
 * // Zero-latency lookups
 * sync.on('event', ({ event }) => console.log('registry change:', event.event_type));
 *
 * // Lag monitoring for the SSE feed
 * sync.on('transport', ({ transport }) => console.log('feed transport:', transport));
 * sync.on('freshness', ({ freshness }) => {
 *   if ((freshness.lag_seconds ?? 0) > 300) console.warn('registry feed lag > 5m');
 * });
 *
 * await sync.start();
 * const agent = sync.getAgent('https://ads.example.com');
 * const authorized = sync.isAuthorized('https://ads.example.com', 'publisher.com');
 * const ctv = sync.findAgents({ channels: ['ctv'], markets: ['US'] });
 * sync.stop();
 * ```
 */
export class RegistrySync extends EventEmitter<RegistrySyncEvents> {
  private readonly client: RegistryClient;
  private readonly transportMode: 'auto' | 'stream' | 'poll';
  private readonly pollIntervalMs: number;
  private readonly types: string | undefined;
  private readonly feedPageLimit: number;
  private readonly streamPollIntervalSeconds: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly streamReconnectMinMs: number;
  private readonly streamReconnectMaxMs: number;
  private readonly maxStreamFailures: number;
  private readonly indexAgents: boolean;
  private readonly indexAuthorizations: boolean;
  private readonly indexProperties: boolean;
  private readonly indexBrandHierarchies: boolean;
  private readonly ignoredEventHandler: ((event: CatalogEvent, reason: string) => void) | undefined;
  private readonly errorHandler: ((error: Error) => void) | undefined;
  private readonly cursorStore: CursorStore;

  private _state: RegistrySyncState = 'idle';
  private cursor: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  // Streaming state
  private activeTransport: RegistrySyncTransport | null = null;
  private streamController: AbortController | null = null;
  private streamIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFreshness: FeedFreshness | null = null;
  /**
   * Incremented by stop()/reset() and each start(). Async work (bootstrap,
   * rebootstrap, the stream loop) captures its generation and bails the moment
   * it no longer matches — so a stop() that lands mid-bootstrap is honored and
   * a stale loop can never resume after the caller stopped or restarted.
   */
  private generation = 0;

  // Indexes
  private agents = new Map<string, AgentSearchResult>();
  private authByDomain = new Map<string, AuthorizationEntry[]>();
  private authByAgent = new Map<string, AuthorizationEntry[]>();
  private authLocationsById = new Map<string, { agentKey: string; domainKey: string }>();
  private propertiesByRid = new Map<string, RegistrySyncProperty>();
  private propertyRidsByDomain = new Map<string, Set<string>>();
  private propertyAliasesByRid = new Map<string, string>();
  private brandAncestorsByDomain = new Map<string, string[]>();
  private brandHierarchyByDomain = new Map<string, ResolvedBrand[]>();
  private brandHierarchyKeysByEntity = new Map<string, Set<string>>();
  private brandHierarchyEntityByKey = new Map<string, string>();

  constructor(config: RegistrySyncConfig) {
    super();
    this.client = config.client;
    this.transportMode = config.transport ?? 'auto';
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
    this.types = config.types;
    this.feedPageLimit = config.feedPageLimit ?? 1000;
    // Fail closed on out-of-range values rather than letting the registry reject
    // them with a 400 that the reconnect/poll loop would hot-retry forever.
    if (!Number.isInteger(this.feedPageLimit) || this.feedPageLimit < 1 || this.feedPageLimit > 10_000) {
      throw new Error('feedPageLimit must be an integer between 1 and 10000');
    }
    this.streamPollIntervalSeconds = config.streamPollIntervalSeconds ?? 15;
    if (
      !Number.isInteger(this.streamPollIntervalSeconds) ||
      this.streamPollIntervalSeconds < 5 ||
      this.streamPollIntervalSeconds > 60
    ) {
      throw new Error('streamPollIntervalSeconds must be an integer between 5 and 60');
    }
    this.streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 90_000;
    this.streamReconnectMinMs = config.streamReconnectMinMs ?? 1_000;
    this.streamReconnectMaxMs = config.streamReconnectMaxMs ?? 30_000;
    this.maxStreamFailures = config.maxStreamFailures ?? 3;
    this.indexAgents = config.indexes?.agents !== false;
    this.indexAuthorizations = config.indexes?.authorizations !== false;
    this.indexProperties = config.indexes?.properties !== false;
    this.indexBrandHierarchies = config.indexes?.brandHierarchies !== false;
    this.cursorStore = config.cursorStore ?? new InMemoryCursorStore();
    this.ignoredEventHandler = config.onIgnoredEvent;
    this.errorHandler = config.onError;
  }

  // ====== Lifecycle ======

  /** Bootstrap from the registry and begin tailing the event feed. */
  async start(): Promise<void> {
    if (this._state === 'syncing' || this._state === 'bootstrapping') return;
    const gen = ++this.generation;
    await this.bootstrap(gen);
    // A stop()/reset() (or another start()) during bootstrap bumps the
    // generation; beginSync re-validates both generation and state before
    // starting the sync loop.
    this.beginSync(gen);
  }

  /** Stop tailing the feed. In-memory state is preserved. */
  stop(): void {
    // Invalidate any in-flight bootstrap/rebootstrap/stream loop, even while
    // state is still 'bootstrapping'.
    this.generation++;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.abortStream();
    this.activeTransport = null;
    if (this._state === 'syncing' || this._state === 'bootstrapping') {
      this.setState('idle');
    }
  }

  /**
   * Stop, clear all in-memory state, and drop the persisted cursor. Call start()
   * again to re-bootstrap from scratch. Because this clears the stored cursor,
   * it is the correct way to switch the `types` subscription: `reset()` then
   * `start()` begins a fresh subscription rather than resuming a cursor minted
   * under the previous filter.
   */
  async reset(): Promise<void> {
    this.stop();
    this.clearIndexes();
    this.cursor = null;
    this.lastFreshness = null;
    await this.cursorStore.clearCursor();
    this.setState('idle');
  }

  /** Begin tailing the feed using the configured transport. Bootstrap leaves state at 'syncing'. */
  private beginSync(gen: number): void {
    if (gen !== this.generation || this._state !== 'syncing') return;
    if (this.transportMode === 'poll') {
      this.setTransport('poll');
      this.schedulePoll(gen);
      return;
    }
    this.setTransport('stream');
    void this.runStream(gen);
  }

  // ====== Agent Lookups ======

  /** Get an agent by URL. */
  getAgent(url: string): AgentSearchResult | undefined {
    return this.agents.get(url);
  }

  /** Get all agents in the index. */
  getAgents(): AgentSearchResult[] {
    return [...this.agents.values()];
  }

  /** Find agents matching a filter. All specified dimensions use AND; values within arrays use OR. */
  findAgents(filter: AgentFilter): AgentSearchResult[] {
    return this.getAgents().filter(agent => {
      const p = agent.inventory_profile;
      if (filter.type && agent.type !== filter.type) return false;
      if (filter.channels?.length && !filter.channels.some(c => p.channels.includes(c))) return false;
      if (filter.markets?.length && !filter.markets.some(m => p.markets.includes(m))) return false;
      if (filter.categories?.length && !filter.categories.some(c => p.categories.includes(c))) return false;
      if (filter.property_types?.length && !filter.property_types.some(t => p.property_types.includes(t))) return false;
      if (filter.tags?.length && !filter.tags.some(t => p.tags.includes(t))) return false;
      if (filter.delivery_types?.length && !filter.delivery_types.some(d => p.delivery_types.includes(d))) return false;
      if (filter.has_tmp != null && p.has_tmp !== filter.has_tmp) return false;
      if (filter.min_properties != null && p.property_count < filter.min_properties) return false;
      if (filter.compliance_status?.length) {
        const status = (agent.compliance_summary?.status ?? 'unknown') as RegistrySyncComplianceStatus;
        if (!filter.compliance_status.includes(status)) return false;
      }
      return true;
    });
  }

  // ====== Authorization Lookups ======

  /** Get all authorizations for a publisher domain. */
  getAuthorizationsForDomain(domain: string): AuthorizationEntry[] {
    return this.authByDomain.get(this.authDomainKey(domain)) ?? [];
  }

  /** Get all authorizations for an agent. */
  getAuthorizationsForAgent(agentUrl: string): AuthorizationEntry[] {
    return this.authByAgent.get(this.authAgentKeyFromUrl(agentUrl)) ?? [];
  }

  /**
   * Check if an agent has any authorization for a publisher domain.
   * Does not evaluate property_id scoping, time bounds, or effective dates.
   * For scoped checks, use getAuthorizationsForDomain() and inspect entries directly.
   *
   * Returns the last synced state — see the class-level staleness note. For
   * enforcement, confirm `state === 'syncing'` and an acceptable `getLagSeconds()`
   * before trusting an allow decision, so a stalled feed can't serve a stale
   * authorization after a missed revocation.
   */
  isAuthorized(agentUrl: string, domain: string): boolean {
    const entries = this.authByDomain.get(this.authDomainKey(domain));
    const agentKey = this.authAgentKeyFromUrl(agentUrl);
    return entries != null && entries.some(entry => this.authAgentKey(entry) === agentKey);
  }

  // ====== Property Lookups ======

  /** Get a property feed record by property_rid. Merged aliases resolve to their canonical RID. */
  getProperty(rid: string): RegistrySyncProperty | undefined {
    const property = this.propertiesByRid.get(this.resolvePropertyRid(rid));
    return property ? this.cloneProperty(property) : undefined;
  }

  /** Get all property feed records for a publisher domain. */
  getPropertiesForDomain(domain: string): RegistrySyncProperty[] {
    const rids = this.propertyRidsByDomain.get(this.normalizeDomainKey(domain));
    if (!rids) return [];
    const properties: RegistrySyncProperty[] = [];
    for (const rid of rids) {
      const property = this.propertiesByRid.get(this.resolvePropertyRid(rid));
      if (property) properties.push(this.cloneProperty(property));
    }
    return properties;
  }

  // ====== Brand Hierarchy Lookups ======

  /**
   * Get the ordered corporate ancestor domain chain for a brand domain.
   *
   * The returned array includes the resolved brand itself as the first entry and
   * the house domain as the last entry when known.
   */
  getAncestors(domain: string): string[] {
    return [...(this.brandAncestorsByDomain.get(this.normalizeDomainKey(domain)) ?? [])];
  }

  /** Get the ordered resolved brand chain for a brand domain, when the feed supplied it. */
  getBrandHierarchy(domain: string): ResolvedBrand[] {
    return (this.brandHierarchyByDomain.get(this.normalizeDomainKey(domain)) ?? []).map(brand => ({ ...brand }));
  }

  // ====== State ======

  get state(): RegistrySyncState {
    return this._state;
  }

  getCursor(): string | null {
    return this.cursor;
  }

  getStats(): { agents: number; authorizations: number; properties: number; brandHierarchies: number } {
    let authCount = 0;
    for (const entries of this.authByDomain.values()) authCount += entries.length;
    return {
      agents: this.agents.size,
      authorizations: authCount,
      properties: this.propertiesByRid.size,
      brandHierarchies: this.brandHierarchyKeysByEntity.size,
    };
  }

  /** The active feed transport once syncing, or null when idle. */
  getTransport(): RegistrySyncTransport | null {
    return this.activeTransport;
  }

  /**
   * Latest feed freshness metadata, or null if the registry has not reported it
   * yet (e.g. before the first feed page/heartbeat lands). For push updates,
   * prefer the `freshness` event over polling this right after `start()`.
   */
  getFreshness(): FeedFreshness | null {
    return this.lastFreshness;
  }

  /** Latest feed lag in seconds, or null when unavailable. Convenience over getFreshness(). */
  getLagSeconds(): number | null {
    return this.lastFreshness?.lag_seconds ?? null;
  }

  // ====== Private: Bootstrap ======

  private async bootstrap(gen: number): Promise<void> {
    this.setState('bootstrapping');
    try {
      // Restore cursor from store if available
      const storedCursor = await this.cursorStore.getCursor();
      if (storedCursor) {
        this.cursor = storedCursor;
      }

      // Paginate searchAgents to load all agents
      if (this.indexAgents) {
        let cursor: string | undefined;
        do {
          const query: Record<string, unknown> = { limit: 200 };
          if (cursor) query.cursor = cursor;
          const res: AgentSearchResponse = await this.client.searchAgents(query as any);
          for (const agent of res.results) {
            this.agents.set(agent.url, agent);
          }
          cursor = res.has_more && res.cursor ? res.cursor : undefined;
        } while (cursor);
      }

      // Get initial feed cursor and apply any events
      await this.drainFeed(gen);

      // A stop()/reset() landed mid-bootstrap: do not flip to 'syncing' or emit.
      if (gen !== this.generation) return;

      this.setState('syncing');
      this.emit('bootstrap', {
        agentCount: this.agents.size,
        authorizationCount: this.getStats().authorizations,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // If we were stopped mid-bootstrap, swallow the abort rather than parking
      // the engine in 'error'.
      if (gen !== this.generation) return;
      this.setState('error');
      this.errorHandler?.(error);
      this.emit('error', { error });
      throw error;
    }
  }

  /** Clear all state, drop the persisted cursor, and bootstrap again from scratch. */
  private async rebootstrap(gen: number): Promise<void> {
    this.clearIndexes();
    this.cursor = null;
    await this.cursorStore.clearCursor();
    await this.bootstrap(gen);
  }

  // ====== Private: Polling ======

  private schedulePoll(gen: number): void {
    this.pollTimer = setTimeout(() => this.pollLoop(gen), this.pollIntervalMs);
  }

  private async pollLoop(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    try {
      await this.poll(gen);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      this.errorHandler?.(error);
    }
    // Schedule next poll even after errors (will retry), unless stopped/superseded.
    if (gen === this.generation && this._state === 'syncing') {
      this.schedulePoll(gen);
    }
  }

  private async poll(gen: number): Promise<void> {
    let totalEventsApplied = 0;
    let hasMore = true;

    while (hasMore) {
      const feed: FeedResponse = await this.client.getFeed(this.feedQuery());

      if (feed.cursor_expired) {
        // Cursor aged out of retention: drop state and re-bootstrap, then resume.
        try {
          await this.rebootstrap(gen);
        } catch {
          // bootstrap() already emitted 'error' and parked state in 'error'.
          // Restore 'syncing' so pollLoop reschedules and retries (mirrors the
          // stream path, which also keeps trying after a failed rebootstrap).
          if (gen === this.generation && this._state === 'error') this.setState('syncing');
        }
        return;
      }

      for (const event of feed.events) {
        this.applyEvent(event);
        this.emit('event', { event });
        totalEventsApplied++;
      }

      this.observeFreshness(feed.freshness);

      if (feed.cursor) {
        this.cursor = feed.cursor;
      }

      hasMore = feed.has_more && feed.cursor != null;
    }

    await this.persistCursor();

    if (totalEventsApplied > 0) {
      this.emit('sync', { cursor: this.cursor!, eventsApplied: totalEventsApplied });
    }
  }

  /**
   * Drain all available feed pages. Used during bootstrap (does not emit 'event' per event).
   */
  private async drainFeed(gen: number): Promise<void> {
    let hasMore = true;
    let recoveredFromExpiry = false;
    while (hasMore) {
      const feed: FeedResponse = await this.client.getFeed(this.feedQuery());
      if (feed.cursor_expired) {
        // Stored cursor aged out of retention: drop it and retry once from the
        // start of the window. A second expiry (now cursor-less) means a
        // misbehaving server — stop draining rather than hot-looping.
        this.cursor = null;
        await this.cursorStore.clearCursor();
        if (recoveredFromExpiry) break;
        recoveredFromExpiry = true;
        continue;
      }
      for (const event of feed.events) {
        this.applyEvent(event);
      }
      this.observeFreshness(feed.freshness);
      if (feed.cursor) this.cursor = feed.cursor;
      hasMore = feed.has_more && feed.cursor != null;
    }
    // A stop()/reset() during the drain bumps the generation — don't persist a
    // cursor a later start() would read back.
    if (gen === this.generation) await this.persistCursor();
  }

  // ====== Private: Streaming ======

  private async runStream(gen: number): Promise<void> {
    // `consecutiveFailures` drives 'auto' polling fallback. It counts connections
    // that ended in a transport/parse failure — a heartbeat does NOT reset it
    // (else heartbeat → malformed-frame → reconnect could loop forever and never
    // fall back, despite the parse-failure fallback contract). It resets only on
    // real feed progress or a clean close that delivered something.
    // `consecutiveRebootstraps` bounds a tight cursor_expired loop.
    let consecutiveFailures = 0;
    let consecutiveRebootstraps = 0;

    while (gen === this.generation && this.transportMode !== 'poll') {
      const controller = new AbortController();
      this.streamController = controller;
      let feedApplied = false;
      let receivedAny = false;
      let disposition: StreamDisposition;

      try {
        disposition = await this.streamConnection(gen, controller.signal, isFeed => {
          receivedAny = true;
          if (isFeed) feedApplied = true;
        });
      } catch (err) {
        // Aborted by stop()/reset() (which bumps the generation): exit quietly.
        if (controller.signal.aborted && gen !== this.generation) {
          return;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        disposition = this.classifyStreamError(error);
        if (disposition === 'reconnect' || disposition === 'fatal') {
          this.emit('error', { error });
          this.errorHandler?.(error);
        }
      } finally {
        this.clearStreamIdleTimer();
      }

      if (gen !== this.generation) return;
      // Applying a feed page proves the stream works end to end.
      if (feedApplied) {
        consecutiveFailures = 0;
        consecutiveRebootstraps = 0;
      }

      if (disposition === 'stopped') return;

      if (disposition === 'fatal') {
        // Permanent error (e.g. 400/401): retrying cannot help. Park in 'error'.
        this.setState('error');
        this.activeTransport = null;
        return;
      }

      if (disposition === 'rebootstrap') {
        let ok = false;
        try {
          await this.rebootstrap(gen);
          ok = true;
        } catch {
          // bootstrap() already emitted 'error' and parked state in 'error'.
        }
        if (gen !== this.generation) return;
        if (!ok) {
          consecutiveFailures++;
          if (this.shouldFallBack(consecutiveFailures)) {
            this.fallBackToPolling(gen);
            return;
          }
          // Recover: bootstrap left us in 'error'. In 'stream' mode the contract
          // is to keep reconnecting, so restore 'syncing' and back off.
          this.setState('syncing');
          await this.delay(this.reconnectBackoffMs(consecutiveFailures), controller.signal);
          if (gen !== this.generation) return;
          continue;
        }
        // Successful re-bootstrap. Back off proportionally to repeated expiries
        // so a server stuck emitting cursor_expired can't drive a tight loop.
        consecutiveRebootstraps++;
        await this.delay(this.reconnectBackoffMs(consecutiveRebootstraps), controller.signal);
        if (gen !== this.generation) return;
        continue;
      }

      if (disposition === 'fallback') {
        this.fallBackToPolling(gen);
        return;
      }

      if (disposition === 'closed' && receivedAny) {
        // Clean close after real activity (feed or heartbeat): the transport
        // works; reconnect promptly without counting it as a failure.
        consecutiveFailures = 0;
        await this.delay(this.reconnectBackoffMs(0), controller.signal);
        if (gen !== this.generation) return;
        continue;
      }

      // 'reconnect' (transport/parse failure or server feed_stream_error), or a
      // clean close that delivered nothing — count toward fallback so 'auto'
      // degrades to polling rather than looping on a stream that never delivers.
      consecutiveFailures++;
      if (this.shouldFallBack(consecutiveFailures)) {
        this.fallBackToPolling(gen);
        return;
      }
      await this.delay(this.reconnectBackoffMs(consecutiveFailures), controller.signal);
      if (gen !== this.generation) return;
    }
  }

  /**
   * Consume one SSE connection. Invokes `onMessage(isFeed)` for each feed page
   * (true) or heartbeat (false) received. Returns the disposition for the
   * reconnect loop: `closed` on a clean server EOF, `reconnect` on a server
   * `feed_stream_error`, `rebootstrap` on `cursor_expired`, `stopped` if the
   * engine was stopped mid-stream.
   */
  private async streamConnection(
    gen: number,
    signal: AbortSignal,
    onMessage: (isFeed: boolean) => void
  ): Promise<StreamDisposition> {
    this.armStreamIdleTimer();
    const query: FeedStreamQuery = {
      cursor: this.cursor ?? undefined,
      types: this.types,
      limit: this.feedPageLimit,
      pollIntervalSeconds: this.streamPollIntervalSeconds,
    };

    for await (const msg of this.client.streamFeed(query, { signal })) {
      if (gen !== this.generation) return 'stopped';
      this.armStreamIdleTimer();

      if (msg.type === 'feed') {
        onMessage(true);
        await this.applyStreamPage(msg.page);
      } else if (msg.type === 'heartbeat') {
        onMessage(false);
        // Heartbeats keep the connection alive and expose freshness; they do NOT
        // advance the cursor and do NOT count as feed progress for fallback.
        this.observeFreshness(msg.heartbeat.freshness);
      } else {
        // 'error' — the server closes the stream after this frame.
        if (msg.error.error === 'cursor_expired') {
          return 'rebootstrap';
        }
        // Registry-supplied strings are untrusted: escape before logging/emitting.
        const code = sanitizeStreamText(msg.error.error);
        const detail = msg.error.message ? ` (${sanitizeStreamText(msg.error.message)})` : '';
        const error = new Error(`registry feed stream error: ${code}${detail}`);
        this.emit('error', { error });
        this.errorHandler?.(error);
        return 'reconnect';
      }
    }

    // Stream closed cleanly by the server — reconnect from the last cursor.
    return 'closed';
  }

  /** Apply one SSE feed page: events, freshness, then advance + persist the cursor. */
  private async applyStreamPage(page: FeedResponse): Promise<void> {
    let applied = 0;
    for (const event of page.events) {
      this.applyEvent(event);
      this.emit('event', { event });
      applied++;
    }
    this.observeFreshness(page.freshness);

    // Advance the cursor only after the full page is applied, so a mid-page
    // disconnect resumes from the last fully-applied page.
    if (page.cursor) {
      this.cursor = page.cursor;
      try {
        await this.persistCursor();
      } catch (err) {
        // Persisting is best-effort; replay after restart is idempotent.
        const error = err instanceof Error ? err : new Error(String(err));
        this.emit('error', { error });
        this.errorHandler?.(error);
      }
    }

    if (applied > 0) {
      this.emit('sync', { cursor: this.cursor!, eventsApplied: applied });
    }
  }

  private classifyStreamError(error: Error): StreamDisposition {
    if (error instanceof FeedStreamCursorExpiredError) return 'rebootstrap';
    if (error instanceof FeedStreamUnsupportedError) {
      // Endpoint absent (older registry) or a proxy returned non-stream content.
      return this.transportMode === 'auto' ? 'fallback' : 'reconnect';
    }
    if (error instanceof FeedStreamHttpError && (error.status === 400 || error.status === 401)) {
      // Permanent client-side error: a malformed request or bad credentials.
      // Retrying (or polling, which hits the same status) cannot recover.
      return 'fatal';
    }
    // Other HTTP errors, parse failures, idle timeouts, network/abort errors.
    return 'reconnect';
  }

  private shouldFallBack(consecutiveFailures: number): boolean {
    return this.transportMode === 'auto' && consecutiveFailures >= this.maxStreamFailures;
  }

  private fallBackToPolling(gen: number): void {
    if (gen !== this.generation || this._state !== 'syncing') return;
    this.abortStream();
    this.setTransport('poll');
    this.schedulePoll(gen);
  }

  private armStreamIdleTimer(): void {
    this.clearStreamIdleTimer();
    const controller = this.streamController;
    if (!controller) return;
    this.streamIdleTimer = setTimeout(() => {
      controller.abort(new Error('registry feed stream idle timeout'));
    }, this.streamIdleTimeoutMs);
    this.streamIdleTimer.unref?.();
  }

  private clearStreamIdleTimer(): void {
    if (this.streamIdleTimer) {
      clearTimeout(this.streamIdleTimer);
      this.streamIdleTimer = null;
    }
  }

  private abortStream(): void {
    this.clearStreamIdleTimer();
    if (this.streamController) {
      this.streamController.abort();
      this.streamController = null;
    }
  }

  private reconnectBackoffMs(attempt: number): number {
    const exp = this.streamReconnectMinMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(this.streamReconnectMaxMs, Math.max(this.streamReconnectMinMs, exp));
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ====== Private: Shared feed helpers ======

  private feedQuery(): { cursor?: string; types?: string; limit: number } {
    const query: { cursor?: string; types?: string; limit: number } = { limit: this.feedPageLimit };
    if (this.cursor) query.cursor = this.cursor;
    if (this.types) query.types = this.types;
    return query;
  }

  private observeFreshness(freshness: FeedFreshness | undefined): void {
    if (!freshness) return;
    this.lastFreshness = freshness;
    this.emit('freshness', { freshness });
  }

  private async persistCursor(): Promise<void> {
    if (this.cursor) {
      await this.cursorStore.setCursor(this.cursor);
    }
  }

  private setTransport(transport: RegistrySyncTransport): void {
    if (this.activeTransport === transport) return;
    this.activeTransport = transport;
    this.emit('transport', { transport });
  }

  // ====== Private: Event Application ======

  private applyEvent(event: CatalogEvent): void {
    const payload = this.asRecord(event.payload);

    switch (event.event_type) {
      case 'agent.discovered':
      case 'agent.profile_updated': {
        if (!this.indexAgents) break;
        const existing = this.agents.get(event.entity_id);
        const inventoryProfile = this.isAgentInventoryProfile(payload.inventory_profile)
          ? payload.inventory_profile
          : undefined;
        if (existing && inventoryProfile) {
          this.agents.set(event.entity_id, {
            ...existing,
            inventory_profile: inventoryProfile,
          });
        } else if (!existing) {
          // New agent: use payload data or create stub
          this.agents.set(event.entity_id, {
            url: event.entity_id,
            name: typeof payload.name === 'string' ? payload.name : event.entity_id,
            type: typeof payload.type === 'string' ? payload.type : 'unknown',
            inventory_profile: inventoryProfile ?? this.emptyInventoryProfile(),
            match: { score: 0, matched_filters: [] },
          });
        }
        break;
      }

      case 'agent.removed': {
        if (this.indexAgents) this.agents.delete(event.entity_id);
        if (this.indexAuthorizations) this.removeAuthorizationsForAgent(event.entity_id);
        break;
      }

      case 'authorization.granted': {
        if (!this.indexAuthorizations) break;
        if (!this.isAuthorizationPayload(payload)) break;
        if (typeof payload.authorization_type !== 'string') break;
        this.upsertAuthorizationEntry(this.authorizationEntryFromEvent(payload));
        break;
      }

      case 'authorization.modified': {
        if (!this.indexAuthorizations) break;
        if (!this.isAuthorizationPayload(payload)) break;
        const entry = this.authorizationEntryFromEvent(payload);
        if (!entry.id && !entry.authorization_type) break;
        this.upsertAuthorizationEntry(entry, { fallbackToTupleOnMissingRowId: true });
        break;
      }

      case 'authorization.revoked': {
        if (!this.indexAuthorizations) break;
        if (!this.isAuthorizationPayload(payload)) break;
        const entry = this.authorizationEntryFromEvent(payload);
        this.removeAuthorizationEntries(entry, {
          matchByRowId: Boolean(entry.id || !entry.authorization_type),
          fallbackToTupleOnMissingRowId: true,
        });
        break;
      }

      case 'agent.compliance_changed': {
        if (this.indexAgents) {
          const existing = this.agents.get(event.entity_id);
          const summary = payload.compliance_summary;
          if (existing && this.isAgentCompliance(summary)) {
            this.agents.set(event.entity_id, {
              ...existing,
              compliance_summary: summary,
            });
          }
        }
        this.emit('compliance_changed', {
          agentUrl: event.entity_id,
          previousStatus: (typeof payload.previous_status === 'string'
            ? payload.previous_status
            : 'unknown') as RegistrySyncComplianceStatus,
          currentStatus: (typeof payload.current_status === 'string'
            ? payload.current_status
            : 'unknown') as RegistrySyncComplianceStatus,
        });
        break;
      }

      case 'property.created':
      case 'property.updated':
      case 'property.reactivated':
      case 'property.stale': {
        if (this.indexProperties) this.upsertPropertyEvent(payload);
        break;
      }

      case 'property.merged': {
        if (this.indexProperties) this.handlePropertyMerge(payload);
        break;
      }

      case 'brand.hierarchy_updated':
      case 'brand.updated':
      case 'brand.resolved': {
        if (this.indexBrandHierarchies) this.applyBrandHierarchyEvent(event.entity_id, payload);
        break;
      }

      case 'brand.removed':
      case 'brand.deleted': {
        if (this.indexBrandHierarchies) this.deleteBrandHierarchy(event.entity_id, payload);
        break;
      }

      case 'collection.created':
      case 'collection.updated':
      case 'collection.merged':
      case 'collection.removed': {
        this.ignoreEvent(event, 'collection.* indexing requires typed collection schemas and a reference consumer');
        break;
      }

      case 'publisher.adagents_changed':
      case 'publisher.adagents_discovered': {
        this.ignoreEvent(event, 'publisher.* indexing requires a reference consumer');
        break;
      }

      default:
        this.ignoreEvent(event, 'unknown or unsupported registry feed event type');
        break;
    }
  }

  // ====== Private: Helpers ======

  private clearIndexes(): void {
    this.agents.clear();
    this.authByDomain.clear();
    this.authByAgent.clear();
    this.authLocationsById.clear();
    this.propertiesByRid.clear();
    this.propertyRidsByDomain.clear();
    this.propertyAliasesByRid.clear();
    this.brandAncestorsByDomain.clear();
    this.brandHierarchyByDomain.clear();
    this.brandHierarchyKeysByEntity.clear();
    this.brandHierarchyEntityByKey.clear();
  }

  private ignoreEvent(event: CatalogEvent, reason: string): void {
    this.ignoredEventHandler?.(event, reason);
    this.emit('ignoredEvent', { event, reason });
  }

  private upsertAuthorizationEntry(
    entry: AuthorizationEntry,
    options?: { fallbackToTupleOnMissingRowId?: boolean }
  ): void {
    const normalizedEntry = this.normalizeAuthorizationEntry(entry);
    this.removeAuthorizationEntries(normalizedEntry, {
      matchByRowId: Boolean(normalizedEntry.id),
      fallbackToTupleOnMissingRowId: options?.fallbackToTupleOnMissingRowId,
    });

    const domainKey = this.authDomainKey(normalizedEntry.publisher_domain);
    const domainEntries = this.authByDomain.get(domainKey) ?? [];
    domainEntries.push(normalizedEntry);
    this.authByDomain.set(domainKey, domainEntries);

    const agentKey = this.authAgentKey(normalizedEntry);
    const agentEntries = this.authByAgent.get(agentKey) ?? [];
    agentEntries.push(normalizedEntry);
    this.authByAgent.set(agentKey, agentEntries);

    if (normalizedEntry.id) {
      this.authLocationsById.set(normalizedEntry.id, {
        agentKey,
        domainKey,
      });
    }
  }

  private normalizeAuthorizationEntry(entry: AuthorizationEntry): AuthorizationEntry {
    if (entry.effective_until || !entry.effective_to) return entry;
    return { ...entry, effective_until: entry.effective_to };
  }

  private authorizationEntryFromEvent(entry: AuthorizationEntry): AuthorizationEntry {
    return this.normalizeAuthorizationEntry(entry);
  }

  private removeAuthorizationsForAgent(agentUrl: string): void {
    const agentKeys = new Set<string>([this.authAgentKeyFromUrl(agentUrl)]);
    for (const [key, entries] of this.authByAgent) {
      if (entries.some(entry => this.authorizationAgentMatches(entry, agentUrl))) agentKeys.add(key);
    }

    for (const agentKey of agentKeys) {
      const entries = [...(this.authByAgent.get(agentKey) ?? [])];
      for (const entry of entries) {
        this.removeAuthorizationEntries(entry, {
          matchByRowId: Boolean(entry.id),
          fallbackToTupleOnMissingRowId: true,
        });
      }
      this.authByAgent.delete(agentKey);
    }
  }

  private removeAuthorizationEntries(target: AuthorizationEntry, options?: AuthorizationRemoveOptions): void {
    const normalizedTarget = this.normalizeAuthorizationEntry(target);
    const domainKeys = new Set<string>([this.authDomainKey(normalizedTarget.publisher_domain)]);
    const agentKeys = new Set<string>([this.authAgentKey(normalizedTarget)]);
    let effectiveOptions = options;

    if (normalizedTarget.id && options?.matchByRowId) {
      const existingLocation = this.authLocationsById.get(normalizedTarget.id);
      if (!existingLocation && options.fallbackToTupleOnMissingRowId) {
        effectiveOptions = { ...options, matchByRowId: false };
      }
      if (existingLocation) {
        domainKeys.add(existingLocation.domainKey);
        agentKeys.add(existingLocation.agentKey);
      }
    }

    for (const domain of domainKeys) {
      this.removeAuthorizationEntriesFromBucket(this.authByDomain, domain, normalizedTarget, effectiveOptions);
    }

    for (const agentUrl of agentKeys) {
      this.removeAuthorizationEntriesFromBucket(this.authByAgent, agentUrl, normalizedTarget, effectiveOptions);
    }
  }

  private removeAuthorizationEntriesFromBucket(
    bucket: Map<string, AuthorizationEntry[]>,
    key: string,
    target: AuthorizationEntry,
    options?: AuthorizationRemoveOptions
  ): void {
    const entries = bucket.get(key);
    if (!entries) return;

    const filtered: AuthorizationEntry[] = [];
    for (const entry of entries) {
      if (this.authorizationMatches(entry, target, options)) {
        if (entry.id) this.authLocationsById.delete(entry.id);
      } else {
        filtered.push(entry);
      }
    }
    if (filtered.length > 0) bucket.set(key, filtered);
    else bucket.delete(key);
  }

  private authorizationMatches(
    entry: AuthorizationEntry,
    target: AuthorizationEntry,
    options?: AuthorizationRemoveOptions
  ): boolean {
    if (target.id && options?.matchByRowId) return entry.id === target.id;
    if (this.authAgentKey(entry) !== this.authAgentKey(target)) return false;
    if (this.authDomainKey(entry.publisher_domain) !== this.authDomainKey(target.publisher_domain)) return false;
    if (target.authorization_type) return entry.authorization_type === target.authorization_type;
    return true;
  }

  private authorizationAgentMatches(entry: AuthorizationEntry, agentUrl: string): boolean {
    return entry.agent_url === agentUrl || this.authAgentKey(entry) === this.authAgentKeyFromUrl(agentUrl);
  }

  private authDomainKey(domain: string): string {
    return this.normalizeDomainKey(domain);
  }

  private authAgentKey(entry: Pick<AuthorizationEntry, 'agent_url' | 'agent_url_canonical'>): string {
    return entry.agent_url_canonical?.trim() || this.authAgentKeyFromUrl(entry.agent_url);
  }

  private authAgentKeyFromUrl(agentUrl: string): string {
    const trimmed = agentUrl.trim();
    const schemeEnd = trimmed.indexOf('://');
    if (schemeEnd <= 0) return trimmed;

    const authorityStart = schemeEnd + 3;
    let authorityEnd = trimmed.length;
    for (const delimiter of ['/', '?', '#'] as const) {
      const index = trimmed.indexOf(delimiter, authorityStart);
      if (index >= 0 && index < authorityEnd) authorityEnd = index;
    }
    if (authorityEnd === authorityStart) return trimmed;

    return (
      trimmed.slice(0, authorityStart).toLowerCase() +
      trimmed.slice(authorityStart, authorityEnd).toLowerCase() +
      trimmed.slice(authorityEnd)
    );
  }

  private upsertPropertyEvent(payload: Record<string, unknown>): void {
    const rid = this.propertyRidFromPayload(payload);
    if (!rid) return;
    const canonicalRid = this.resolvePropertyRid(rid);
    const existing = this.propertiesByRid.get(canonicalRid);
    const next = this.propertyFromPayload(canonicalRid, payload, existing);
    if (!next) return;

    this.setPropertyEntry(next, existing);
  }

  private handlePropertyMerge(payload: Record<string, unknown>): void {
    if (typeof payload.alias_rid !== 'string' || typeof payload.canonical_rid !== 'string') return;
    const aliasRid = this.resolvePropertyRid(payload.alias_rid);
    const canonicalRid = this.resolvePropertyRid(payload.canonical_rid);
    if (!aliasRid || !canonicalRid || aliasRid === canonicalRid) return;

    const aliasEntry = this.propertiesByRid.get(aliasRid);
    const canonicalEntry = this.propertiesByRid.get(canonicalRid);
    const payloadEntry = this.propertyFromPayload(canonicalRid, payload);
    this.propertyAliasesByRid.set(payload.alias_rid, canonicalRid);
    this.propertyAliasesByRid.set(aliasRid, canonicalRid);

    if (!aliasEntry && !canonicalEntry && !payloadEntry) return;

    const merged: RegistrySyncProperty = {
      ...(aliasEntry ? this.cloneProperty(aliasEntry) : {}),
      ...(canonicalEntry ? this.cloneProperty(canonicalEntry) : {}),
      ...(payloadEntry ? this.cloneProperty(payloadEntry) : {}),
      property_rid: canonicalRid,
    };
    if (!merged.publisher_domain) {
      merged.publisher_domain = canonicalEntry?.publisher_domain ?? aliasEntry?.publisher_domain;
    }

    this.deletePropertyEntry(aliasRid);
    this.setPropertyEntry(merged, canonicalEntry);
  }

  private propertyFromPayload(
    rid: string,
    payload: Record<string, unknown>,
    existing?: RegistrySyncProperty
  ): RegistrySyncProperty | null {
    const publisherDomain = this.propertyDomainFromPayload(payload) ?? existing?.publisher_domain;
    const next: RegistrySyncProperty = existing ? this.cloneProperty(existing) : { property_rid: rid };
    let hasPayloadFields = false;

    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || key === 'alias_rid' || key === 'canonical_rid') continue;
      hasPayloadFields = true;
      next[key] = this.cloneJsonValue(value);
    }
    next.property_rid = rid;
    if (publisherDomain) next.publisher_domain = publisherDomain;

    return hasPayloadFields || publisherDomain || existing ? next : null;
  }

  private setPropertyEntry(entry: RegistrySyncProperty, previous?: RegistrySyncProperty): void {
    if (previous?.publisher_domain && previous.publisher_domain !== entry.publisher_domain) {
      this.removePropertyRidFromDomain(entry.property_rid, previous.publisher_domain);
    }
    this.propertiesByRid.set(entry.property_rid, this.cloneProperty(entry));
    if (entry.publisher_domain) {
      const key = this.normalizeDomainKey(entry.publisher_domain);
      const rids = this.propertyRidsByDomain.get(key) ?? new Set<string>();
      rids.add(entry.property_rid);
      this.propertyRidsByDomain.set(key, rids);
    }
  }

  private deletePropertyEntry(rid: string): void {
    const entry = this.propertiesByRid.get(rid);
    if (entry?.publisher_domain) this.removePropertyRidFromDomain(rid, entry.publisher_domain);
    this.propertiesByRid.delete(rid);
  }

  private removePropertyRidFromDomain(rid: string, domain: string): void {
    const key = this.normalizeDomainKey(domain);
    const rids = this.propertyRidsByDomain.get(key);
    if (!rids) return;
    rids.delete(rid);
    if (rids.size === 0) this.propertyRidsByDomain.delete(key);
  }

  private propertyRidFromPayload(payload: Record<string, unknown>): string | null {
    if (typeof payload.property_rid === 'string' && payload.property_rid.trim()) return payload.property_rid;
    if (typeof payload.rid === 'string' && payload.rid.trim()) return payload.rid;
    if (typeof payload.id === 'string' && payload.id.trim()) return payload.id;
    return null;
  }

  private propertyDomainFromPayload(payload: Record<string, unknown>): string | undefined {
    if (typeof payload.publisher_domain === 'string' && payload.publisher_domain.trim())
      return payload.publisher_domain;
    const property = this.asRecord(payload.property);
    return typeof property.publisher_domain === 'string' && property.publisher_domain.trim()
      ? property.publisher_domain
      : undefined;
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private resolvePropertyRid(rid: string): string {
    let current = rid;
    const seen = new Set<string>();
    while (this.propertyAliasesByRid.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.propertyAliasesByRid.get(current)!;
    }
    return current;
  }

  private cloneProperty(property: RegistrySyncProperty): RegistrySyncProperty {
    return this.cloneJsonValue(property) as RegistrySyncProperty;
  }

  private applyBrandHierarchyEvent(entityId: string, payload: Record<string, unknown>): void {
    const resolvedChain = this.extractResolvedBrandChain(payload.chain);
    const domainChain =
      resolvedChain.length > 0
        ? resolvedChain.map(brand => this.domainFromBrand(brand)).filter((domain): domain is string => domain != null)
        : (this.extractDomainChain(payload.chain) ??
          this.extractDomainChain(payload.ancestor_domains) ??
          this.extractDomainChain(payload.domains));

    if (!domainChain || domainChain.length === 0) return;

    const keys = new Set<string>();
    keys.add(this.normalizeDomainKey(entityId));
    for (const field of ['domain', 'canonical_domain', 'canonical_id'] as const) {
      const value = payload[field];
      if (typeof value === 'string' && value.trim()) keys.add(this.normalizeDomainKey(value));
    }
    keys.add(this.normalizeDomainKey(domainChain[0]!));

    const entityKey = this.normalizeDomainKey(entityId);
    const entitiesToClear = new Set<string>([entityKey]);
    for (const key of keys) {
      const existingEntity = this.brandHierarchyEntityByKey.get(key);
      if (existingEntity) entitiesToClear.add(existingEntity);
    }
    for (const key of entitiesToClear) this.clearBrandHierarchyEntity(key);

    for (const key of keys) {
      this.brandAncestorsByDomain.set(key, [...domainChain]);
      if (resolvedChain.length > 0)
        this.brandHierarchyByDomain.set(
          key,
          resolvedChain.map(brand => ({ ...brand }))
        );
      else this.brandHierarchyByDomain.delete(key);
      this.brandHierarchyEntityByKey.set(key, entityKey);
    }
    this.brandHierarchyKeysByEntity.set(entityKey, keys);
  }

  private deleteBrandHierarchy(entityId: string, payload: Record<string, unknown>): void {
    const keys = new Set<string>([this.normalizeDomainKey(entityId)]);
    for (const field of ['domain', 'canonical_domain', 'canonical_id'] as const) {
      const value = payload[field];
      if (typeof value === 'string' && value.trim()) keys.add(this.normalizeDomainKey(value));
    }
    const entitiesToClear = new Set<string>();
    for (const key of keys) {
      const existingEntity = this.brandHierarchyEntityByKey.get(key);
      if (existingEntity) entitiesToClear.add(existingEntity);
    }
    if (entitiesToClear.size > 0) {
      for (const key of entitiesToClear) this.clearBrandHierarchyEntity(key);
      return;
    }
    for (const key of keys) {
      this.brandAncestorsByDomain.delete(key);
      this.brandHierarchyByDomain.delete(key);
      this.brandHierarchyEntityByKey.delete(key);
    }
  }

  private clearBrandHierarchyEntity(entityKey: string): void {
    const keys = this.brandHierarchyKeysByEntity.get(entityKey);
    if (!keys) return;
    for (const key of keys) {
      this.brandAncestorsByDomain.delete(key);
      this.brandHierarchyByDomain.delete(key);
      this.brandHierarchyEntityByKey.delete(key);
    }
    this.brandHierarchyKeysByEntity.delete(entityKey);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private emptyInventoryProfile(): AgentSearchResult['inventory_profile'] {
    return {
      channels: [],
      property_types: [],
      markets: [],
      categories: [],
      category_taxonomy: 'iab_content_3.0',
      tags: [],
      delivery_types: [],
      property_count: 0,
      publisher_count: 0,
      has_tmp: false,
    };
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
  }

  private isAgentInventoryProfile(value: unknown): value is AgentSearchResult['inventory_profile'] {
    const profile = this.asRecord(value);
    return (
      this.isStringArray(profile.channels) &&
      this.isStringArray(profile.property_types) &&
      this.isStringArray(profile.markets) &&
      this.isStringArray(profile.categories) &&
      (typeof profile.category_taxonomy === 'string' || profile.category_taxonomy === null) &&
      this.isStringArray(profile.tags) &&
      this.isStringArray(profile.delivery_types) &&
      (profile.format_ids === undefined || this.isStringArray(profile.format_ids)) &&
      typeof profile.property_count === 'number' &&
      typeof profile.publisher_count === 'number' &&
      typeof profile.has_tmp === 'boolean'
    );
  }

  private isAuthorizationPayload(value: unknown): value is AuthorizationEntry {
    const payload = this.asRecord(value);
    return (
      (payload.id === undefined || this.stringValue(payload.id) !== undefined) &&
      this.stringValue(payload.agent_url) !== undefined &&
      this.stringValue(payload.publisher_domain) !== undefined &&
      (payload.authorization_type === undefined || this.stringValue(payload.authorization_type) !== undefined) &&
      (payload.property_ids === undefined || this.isStringArray(payload.property_ids)) &&
      (payload.property_tags === undefined || this.isStringArray(payload.property_tags)) &&
      (payload.placement_ids === undefined || this.isStringArray(payload.placement_ids)) &&
      (payload.placement_tags === undefined || this.isStringArray(payload.placement_tags)) &&
      (payload.countries === undefined || this.isStringArray(payload.countries)) &&
      (payload.effective_from === undefined || typeof payload.effective_from === 'string') &&
      (payload.effective_until === undefined || typeof payload.effective_until === 'string') &&
      (payload.effective_to === undefined || typeof payload.effective_to === 'string')
    );
  }

  private isAgentCompliance(value: unknown): value is AgentCompliance {
    const summary = this.asRecord(value);
    const statuses = new Set(['passing', 'degraded', 'failing', 'unknown', 'opted_out']);
    const lifecycleStages = new Set(['development', 'testing', 'production', 'deprecated']);
    if (summary.status === 'opted_out') {
      return (
        (summary.lifecycle_stage === undefined ||
          (typeof summary.lifecycle_stage === 'string' && lifecycleStages.has(summary.lifecycle_stage))) &&
        (summary.tracks === undefined ||
          (summary.tracks != null && typeof summary.tracks === 'object' && !Array.isArray(summary.tracks))) &&
        (summary.streak_days === undefined || typeof summary.streak_days === 'number') &&
        (summary.last_checked_at === undefined ||
          typeof summary.last_checked_at === 'string' ||
          summary.last_checked_at === null) &&
        (summary.headline === undefined || typeof summary.headline === 'string' || summary.headline === null)
      );
    }
    return (
      typeof summary.status === 'string' &&
      statuses.has(summary.status) &&
      typeof summary.lifecycle_stage === 'string' &&
      lifecycleStages.has(summary.lifecycle_stage) &&
      summary.tracks != null &&
      typeof summary.tracks === 'object' &&
      !Array.isArray(summary.tracks) &&
      typeof summary.streak_days === 'number' &&
      (typeof summary.last_checked_at === 'string' || summary.last_checked_at === null) &&
      (typeof summary.headline === 'string' || summary.headline === null)
    );
  }

  private isResolvedBrand(value: unknown): value is ResolvedBrand {
    const brand = this.asRecord(value);
    return typeof brand.canonical_id === 'string' && typeof brand.canonical_domain === 'string';
  }

  private cloneJsonValue<T>(value: T): T {
    if (Array.isArray(value)) return value.map(item => this.cloneJsonValue(item)) as T;
    if (value && typeof value === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        copy[key] = this.cloneJsonValue(nested);
      }
      return copy as T;
    }
    return value;
  }

  private extractResolvedBrandChain(value: unknown): ResolvedBrand[] {
    if (!Array.isArray(value)) return [];
    return value.filter(item => this.isResolvedBrand(item));
  }

  private extractDomainChain(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const domains: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        domains.push(item);
        continue;
      }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const domain = this.domainFromBrand(item as Partial<ResolvedBrand>);
        if (domain) domains.push(domain);
      }
    }
    return domains.length > 0 ? domains : null;
  }

  private domainFromBrand(brand: Partial<ResolvedBrand>): string | null {
    return brand.canonical_domain ?? brand.canonical_id ?? null;
  }

  private normalizeDomainKey(domain: string): string {
    return domain.trim().toLowerCase();
  }

  private setState(next: RegistrySyncState): void {
    const from = this._state;
    if (from === next) return;
    this._state = next;
    this.emit('stateChange', { from, to: next });
  }
}
