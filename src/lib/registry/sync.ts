import { EventEmitter } from 'node:events';
import type { RegistryClient } from './index';
import type {
  CatalogEvent,
  AgentSearchResult,
  AgentCompliance,
  AuthorizationEntry,
  AgentSearchResponse,
  FeedResponse,
  FeedFreshness,
} from './types.generated';
import type { FeedStreamQuery } from './feed-stream';
import { FeedStreamCursorExpiredError, FeedStreamUnsupportedError, FeedStreamHttpError } from './feed-stream';
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
  /** Server-side caught-up interval hint for the SSE stream (5–60s, default 15). */
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
  };
  /** Optional cursor store for persisting the feed cursor between restarts. */
  cursorStore?: CursorStore;
  /** Called on errors during polling/bootstrap. */
  onError?: (error: Error) => void;
}

export type RegistrySyncState = 'idle' | 'bootstrapping' | 'syncing' | 'error';

/** Active feed transport once syncing. */
export type RegistrySyncTransport = 'stream' | 'poll';

/** Outcome of one SSE connection, driving the reconnect loop. */
type StreamDisposition = 'reconnect' | 'rebootstrap' | 'fallback' | 'fatal' | 'stopped';

// ====== Event types ======

export interface RegistrySyncEvents {
  bootstrap: [{ agentCount: number; authorizationCount: number }];
  sync: [{ cursor: string; eventsApplied: number }];
  /** Emitted for each event applied during polling. Not emitted during bootstrap. */
  event: [{ event: CatalogEvent }];
  error: [{ error: Error }];
  /** Emitted when an agent's compliance status changes. */
  compliance_changed: [
    { agentUrl: string; previousStatus: AgentCompliance['status']; currentStatus: AgentCompliance['status'] },
  ];
  stateChange: [{ from: RegistrySyncState; to: RegistrySyncState }];
  /** Emitted whenever a feed page or heartbeat carries freshness metadata, for lag monitoring. */
  freshness: [{ freshness: FeedFreshness }];
  /** Emitted when the active feed transport changes (e.g. stream → polling fallback). */
  transport: [{ transport: RegistrySyncTransport }];
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
  compliance_status?: AgentCompliance['status'][];
}

// ====== RegistrySync ======

/**
 * In-memory replica of the AdCP registry.
 *
 * Bootstraps from the agent search endpoint, then polls the event feed
 * to maintain up-to-date indexes for zero-latency lookups.
 *
 * @example
 * ```ts
 * const client = new RegistryClient({ apiKey: 'sk_...' });
 * const sync = new RegistrySync({ client });
 * await sync.start();
 *
 * // Zero-latency lookups
 * const agent = sync.getAgent('https://ads.example.com');
 * const authorized = sync.isAuthorized('https://ads.example.com', 'publisher.com');
 * const ctv = sync.findAgents({ channels: ['ctv'], markets: ['US'] });
 *
 * sync.on('event', ({ event }) => console.log('registry change:', event.event_type));
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
    this.cursorStore = config.cursorStore ?? new InMemoryCursorStore();
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

  /** Stop, clear all state. Call start() again to re-bootstrap. */
  async reset(): Promise<void> {
    this.stop();
    this.clearIndexes();
    this.cursor = null;
    this.lastFreshness = null;
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
        const status = agent.compliance_summary?.status ?? 'unknown';
        if (!filter.compliance_status.includes(status)) return false;
      }
      return true;
    });
  }

  // ====== Authorization Lookups ======

  /** Get all authorizations for a publisher domain. */
  getAuthorizationsForDomain(domain: string): AuthorizationEntry[] {
    return this.authByDomain.get(domain) ?? [];
  }

  /** Get all authorizations for an agent. */
  getAuthorizationsForAgent(agentUrl: string): AuthorizationEntry[] {
    return this.authByAgent.get(agentUrl) ?? [];
  }

  /**
   * Check if an agent has any authorization for a publisher domain.
   * Does not evaluate property_id scoping, time bounds, or effective dates.
   * For scoped checks, use getAuthorizationsForDomain() and inspect entries directly.
   */
  isAuthorized(agentUrl: string, domain: string): boolean {
    const entries = this.authByDomain.get(domain);
    return entries != null && entries.some(e => e.agent_url === agentUrl);
  }

  // ====== State ======

  get state(): RegistrySyncState {
    return this._state;
  }

  getCursor(): string | null {
    return this.cursor;
  }

  getStats(): { agents: number; authorizations: number } {
    let authCount = 0;
    for (const entries of this.authByDomain.values()) authCount += entries.length;
    return { agents: this.agents.size, authorizations: authCount };
  }

  /** The active feed transport once syncing, or null when idle. */
  getTransport(): RegistrySyncTransport | null {
    return this.activeTransport;
  }

  /** Latest feed freshness metadata, or null if the registry has not reported it. */
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
      await this.drainFeed();

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
        await this.rebootstrap(gen);
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

      hasMore = feed.has_more && this.cursor != null;
    }

    await this.persistCursor();

    if (totalEventsApplied > 0) {
      this.emit('sync', { cursor: this.cursor!, eventsApplied: totalEventsApplied });
    }
  }

  /**
   * Drain all available feed pages. Used during bootstrap (does not emit 'event' per event).
   */
  private async drainFeed(): Promise<void> {
    let hasMore = true;
    while (hasMore) {
      const feed: FeedResponse = await this.client.getFeed(this.feedQuery());
      if (feed.cursor_expired) {
        // Stored cursor aged out of retention: drop it and resume from the start
        // of the retention window on the next request.
        this.cursor = null;
        await this.cursorStore.clearCursor();
        continue;
      }
      for (const event of feed.events) {
        this.applyEvent(event);
      }
      this.observeFreshness(feed.freshness);
      this.cursor = feed.cursor;
      hasMore = feed.has_more && this.cursor != null;
    }
    await this.persistCursor();
  }

  // ====== Private: Streaming ======

  private async runStream(gen: number): Promise<void> {
    // `consecutiveFailures` drives polling fallback in 'auto'; `consecutiveRebootstraps`
    // bounds a tight cursor_expired loop with backoff. Both reset on real progress.
    let consecutiveFailures = 0;
    let consecutiveRebootstraps = 0;

    while (gen === this.generation && this.transportMode !== 'poll') {
      const controller = new AbortController();
      this.streamController = controller;
      let madeProgress = false;
      let disposition: StreamDisposition;

      try {
        disposition = await this.streamConnection(gen, controller.signal, () => {
          madeProgress = true;
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
      if (madeProgress) {
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

      // 'reconnect'
      if (!madeProgress) consecutiveFailures++;
      if (this.shouldFallBack(consecutiveFailures)) {
        this.fallBackToPolling(gen);
        return;
      }
      await this.delay(this.reconnectBackoffMs(consecutiveFailures), controller.signal);
      if (gen !== this.generation) return;
    }
  }

  /** Consume one SSE connection. Returns the disposition for the reconnect loop. */
  private async streamConnection(gen: number, signal: AbortSignal, onProgress: () => void): Promise<StreamDisposition> {
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
        onProgress();
        await this.applyStreamPage(msg.page);
      } else if (msg.type === 'heartbeat') {
        onProgress();
        // Heartbeats keep the connection alive and expose freshness; they do
        // NOT advance the cursor.
        this.observeFreshness(msg.heartbeat.freshness);
      } else {
        // 'error' — the server closes the stream after this frame.
        if (msg.error.error === 'cursor_expired') {
          return 'rebootstrap';
        }
        const error = new Error(
          `registry feed stream error: ${msg.error.error}${msg.error.message ? ` (${msg.error.message})` : ''}`
        );
        this.emit('error', { error });
        this.errorHandler?.(error);
        return 'reconnect';
      }
    }

    // Stream closed cleanly by the server — reconnect from the last cursor.
    return 'reconnect';
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
    const payload = event.payload as Record<string, unknown>;

    switch (event.event_type) {
      case 'agent.discovered':
      case 'agent.profile_updated': {
        if (!this.indexAgents) break;
        const existing = this.agents.get(event.entity_id);
        if (existing && payload.inventory_profile) {
          this.agents.set(event.entity_id, {
            ...existing,
            inventory_profile: payload.inventory_profile as AgentSearchResult['inventory_profile'],
          });
        } else if (!existing) {
          // New agent: use payload data or create stub
          this.agents.set(event.entity_id, {
            url: event.entity_id,
            name: (payload.name as string) ?? event.entity_id,
            type: (payload.type as AgentSearchResult['type']) ?? 'unknown',
            inventory_profile: (payload.inventory_profile as AgentSearchResult['inventory_profile']) ?? {
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
            },
            match: { score: 0, matched_filters: [] },
          });
        }
        break;
      }

      case 'agent.removed': {
        if (this.indexAgents) this.agents.delete(event.entity_id);
        if (this.indexAuthorizations) this.authByAgent.delete(event.entity_id);
        break;
      }

      case 'authorization.granted': {
        if (!this.indexAuthorizations) break;
        const entry = payload as unknown as AuthorizationEntry;
        if (!entry.agent_url || !entry.publisher_domain || !entry.authorization_type) break;

        const domainEntries = this.authByDomain.get(entry.publisher_domain) ?? [];
        if (
          !domainEntries.some(e => e.agent_url === entry.agent_url && e.authorization_type === entry.authorization_type)
        ) {
          domainEntries.push(entry);
          this.authByDomain.set(entry.publisher_domain, domainEntries);
        }

        const agentEntries = this.authByAgent.get(entry.agent_url) ?? [];
        if (
          !agentEntries.some(
            e => e.publisher_domain === entry.publisher_domain && e.authorization_type === entry.authorization_type
          )
        ) {
          agentEntries.push(entry);
          this.authByAgent.set(entry.agent_url, agentEntries);
        }
        break;
      }

      case 'authorization.revoked': {
        if (!this.indexAuthorizations) break;
        const agentUrl = payload.agent_url as string;
        const domain = payload.publisher_domain as string;
        const authType = payload.authorization_type as string | undefined;
        if (!agentUrl || !domain) break;

        const domainEntries = this.authByDomain.get(domain);
        if (domainEntries) {
          const filtered = domainEntries.filter(
            e => !(e.agent_url === agentUrl && (!authType || e.authorization_type === authType))
          );
          if (filtered.length > 0) this.authByDomain.set(domain, filtered);
          else this.authByDomain.delete(domain);
        }

        const agentEntries = this.authByAgent.get(agentUrl);
        if (agentEntries) {
          const filtered = agentEntries.filter(
            e => !(e.publisher_domain === domain && (!authType || e.authorization_type === authType))
          );
          if (filtered.length > 0) this.authByAgent.set(agentUrl, filtered);
          else this.authByAgent.delete(agentUrl);
        }
        break;
      }

      case 'agent.compliance_changed': {
        if (this.indexAgents) {
          const existing = this.agents.get(event.entity_id);
          const summary = payload.compliance_summary;
          if (
            existing &&
            summary &&
            typeof summary === 'object' &&
            'status' in summary &&
            typeof (summary as Record<string, unknown>).status === 'string'
          ) {
            this.agents.set(event.entity_id, {
              ...existing,
              compliance_summary: summary as AgentSearchResult['compliance_summary'],
            });
          }
        }
        this.emit('compliance_changed', {
          agentUrl: event.entity_id,
          previousStatus: (typeof payload.previous_status === 'string'
            ? payload.previous_status
            : 'unknown') as AgentCompliance['status'],
          currentStatus: (typeof payload.current_status === 'string'
            ? payload.current_status
            : 'unknown') as AgentCompliance['status'],
        });
        break;
      }

      // Property and publisher events: no-op for v1 (no property index yet)
      default:
        break;
    }
  }

  // ====== Private: Helpers ======

  private clearIndexes(): void {
    this.agents.clear();
    this.authByDomain.clear();
    this.authByAgent.clear();
  }

  private setState(next: RegistrySyncState): void {
    const from = this._state;
    if (from === next) return;
    this._state = next;
    this.emit('stateChange', { from, to: next });
  }
}
