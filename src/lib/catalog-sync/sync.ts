import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { CursorStore } from '../registry/cursor-store';
import { InMemoryCursorStore } from '../registry/cursor-store';
import type * as V31Beta from '../types/v3-1-beta';
import type {
  CatalogSyncClient,
  CatalogSyncConfig,
  CatalogSyncEvents,
  CatalogSyncMode,
  CatalogSyncState,
  ProductFilter,
  ResolvedCapabilities,
  SignalFilter,
} from './types';

type Product = V31Beta.Product;
// `signals` is an inline array type on GetSignalsResponse (no top-level
// Signal export in the generated bundle). Extract the element type so
// the index map and search helpers stay strongly-typed.
type Signal = NonNullable<V31Beta.GetSignalsResponse['signals']>[number];

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_PROBE_INTERVAL_MS = 600_000;
const DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS = 86_400_000;
const DEFAULT_FEED_PAGE_LIMIT = 1000;
const DEFAULT_BOOTSTRAP_PAGE_LIMIT = 100;
const DEFAULT_MAX_FEED_RESPONSE_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * In-memory replica of an AdCP agent's product and signal catalog.
 *
 * Discovers the agent's catalog-sync capabilities at `start()`, picks the
 * highest-capability sync strategy the agent supports, and maintains a
 * local index for zero-latency lookups. Falls back gracefully to manual
 * bootstrap when the agent advertises neither the change feed nor
 * conditional-fetch tokens.
 *
 * @example
 * ```ts
 * import { AdCPClient } from '@adcp/sdk';
 * import { CatalogSync } from '@adcp/sdk/catalog-sync';
 *
 * const client = new AdCPClient({ agentUrl, adcpVersion: '3.1-beta' });
 * const catalog = new CatalogSync({
 *   client,
 *   feedOrigin: agentUrl,
 *   feedHeaders: { Authorization: `Bearer ${token}` },
 * });
 *
 * catalog.on('product.priced', ({ event }) => {
 *   const p = event.payload as { product_id: string; pricing_options: unknown[] };
 *   console.log('reprice:', p.product_id);
 * });
 *
 * await catalog.start();
 * // catalog.mode is 'live' / 'auto-poll' / 'manual' depending on the agent
 * console.log(`syncing ${catalog.products.count} products via ${catalog.mode} mode`);
 * ```
 */
export class CatalogSync extends EventEmitter<CatalogSyncEvents> {
  private readonly client: CatalogSyncClient;
  private readonly feedOrigin: string | undefined;
  private readonly feedHeadersInput: CatalogSyncConfig['feedHeaders'];
  private readonly pollIntervalMs: number;
  private readonly probeIntervalMs: number;
  private readonly capabilityRefreshIntervalMs: number;
  private readonly maxFeedResponseBytes: number;
  private readonly cursorStore: CursorStore;
  private readonly errorHandler: ((error: Error) => void) | undefined;
  private readonly fetchImpl: typeof fetch;
  private startPromise: Promise<void> | null = null;
  private signalsQueryableWarned = false;

  private _state: CatalogSyncState = 'idle';
  private _mode: CatalogSyncMode = 'manual';
  private _capabilities: ResolvedCapabilities = {
    changeFeed: false,
    catalogVersioning: false,
    webhooks: false,
    eventTypes: [],
  };
  private _lastSyncedAt: Date | undefined;
  private _lastEventAt: Date | undefined;

  private productIndex = new Map<string, Product>();
  private signalIndex = new Map<string, Signal>();

  private catalogVersion: string | undefined;
  private pricingVersion: string | undefined;
  private cursor: string | null = null;
  private cacheScope: 'public' | 'account' = 'public';

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private capabilityTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Read-only view of the in-memory product index. The `mode` reflects the
   * sync strategy for product events specifically — in mixed-capability
   * agents (products-feed + signals-wholesale-only, or vice versa) this
   * may differ from `signals.mode`.
   */
  readonly products = {
    list: (): Product[] => [...this.productIndex.values()],
    get: (productId: string): Product | undefined => this.productIndex.get(productId),
    search: (filter: ProductFilter): Product[] => this.searchProducts(filter),
    get count(): number {
      return this.list().length;
    },
    get mode(): CatalogSyncMode {
      // Per-entity mode is the lowest mode for which the agent declares
      // the entity's event family. Future extension: when capability vectors
      // diverge per entity, return the entity-specific resolution here. v1
      // mirrors the top-level mode.
      return this._mode;
    },
    // Allow the inline getter `mode` to reach private state without binding.
    // Assigned in the constructor below.
    _mode: 'manual' as CatalogSyncMode,
  };

  /** Read-only view of the in-memory signal index. */
  readonly signals = {
    list: (): Signal[] => {
      this.warnIfSignalsNotQueryable();
      return [...this.signalIndex.values()];
    },
    get: (signalAgentSegmentId: string): Signal | undefined => this.signalIndex.get(signalAgentSegmentId),
    search: (filter: SignalFilter): Signal[] => {
      this.warnIfSignalsNotQueryable();
      return this.searchSignals(filter);
    },
    get count(): number {
      return this.list().length;
    },
    get mode(): CatalogSyncMode {
      return this._mode;
    },
    _mode: 'manual' as CatalogSyncMode,
    /**
     * `true` when the agent supports `discovery_mode: 'wholesale'` on
     * `get_signals` (i.e., catalogs are browsable). When `false`, the
     * agent only supports brief-mode discovery — `signals.list()` will
     * be empty until adopters call into the agent with their own briefs.
     */
    queryable: true,
  };

  /**
   * One-shot console warning when adopters call `signals.list()` or
   * `signals.search()` against an agent that doesn't support wholesale
   * signal enumeration. Without this, empty results read as "no signals
   * match" rather than "the agent doesn't browse, only briefs."
   */
  private warnIfSignalsNotQueryable(): void {
    if (this.signals.queryable || this.signalsQueryableWarned) return;
    if (this._state === 'idle' || this._state === 'bootstrapping') return; // pre-start; nothing to warn about
    this.signalsQueryableWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[CatalogSync] signals.list()/search() returned an empty replica because the agent does not declare ` +
        `signals.discovery_modes: ["wholesale"]. Brief-mode signal discovery isn't mirrored — call ` +
        `client.getSignals({ signal_spec, ... }) with your brief instead, or omit this surface for this agent.`
    );
  }

  constructor(config: CatalogSyncConfig) {
    super();
    this.client = config.client;
    // Validate the change-feed origin scheme at construction so a
    // misconfigured tenant config (or hostile injection) can't turn the
    // poll loop into an SSRF primitive that forwards `feedHeaders` to a
    // file:// / data:// / blob: target. Adopters loading `feedOrigin`
    // from external config SHOULD additionally enforce an allowlist;
    // HTTPS to internal/metadata addresses is the agent operator's
    // responsibility to refuse, not the SDK's.
    if (config.feedOrigin !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(config.feedOrigin);
      } catch {
        throw new Error(`CatalogSync: feedOrigin is not a valid URL: ${JSON.stringify(config.feedOrigin)}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
          `CatalogSync: feedOrigin protocol must be http: or https: (got ${parsed.protocol}). ` +
            `Non-HTTP schemes (file:, data:, blob:, ...) are rejected as SSRF defense.`
        );
      }
    }
    this.feedOrigin = config.feedOrigin;
    this.feedHeadersInput = config.feedHeaders;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.probeIntervalMs = config.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.capabilityRefreshIntervalMs = config.capabilityRefreshIntervalMs ?? DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS;
    this.maxFeedResponseBytes = config.maxFeedResponseBytes ?? DEFAULT_MAX_FEED_RESPONSE_BYTES;
    this.cursorStore = config.cursorStore ?? new InMemoryCursorStore();
    this.errorHandler = config.onError;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Resolve the headers to send with the next change-feed poll. Static
   * records are returned verbatim; function forms are awaited so token
   * rotation can land asynchronously.
   */
  private async resolveFeedHeaders(): Promise<Record<string, string>> {
    if (this.feedHeadersInput === undefined) return {};
    if (typeof this.feedHeadersInput === 'function') {
      return await this.feedHeadersInput();
    }
    return this.feedHeadersInput;
  }

  // ====== Lifecycle ======

  /**
   * Probe the agent's capabilities, pick a sync mode, and bootstrap the
   * in-memory replica via wholesale enumeration. In `'live'` mode also
   * starts the change-feed poll; in `'auto-poll'` mode starts the version
   * probe loop.
   *
   * Safe to call repeatedly — concurrent calls await the in-flight
   * bootstrap and return when it completes (no duplicate bootstrap, no
   * silent drop). Sequential calls re-probe capabilities and re-bootstrap,
   * equivalent to calling `refresh()` after a mode upgrade.
   */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInner().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInner(): Promise<void> {
    this.stop();
    await this.resolveMode();
    await this.bootstrap();
    if (this._mode === 'live') {
      this.cursor = (await this.cursorStore.getCursor()) ?? null;
      this.schedulePoll();
    } else if (this._mode === 'auto-poll') {
      this.scheduleProbe();
    }
    if (this.capabilityRefreshIntervalMs > 0) {
      this.scheduleCapabilityRefresh();
    }
  }

  /** Stop all background activity. Preserves in-memory state and cursor. */
  stop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.capabilityTimer) clearTimeout(this.capabilityTimer);
    this.pollTimer = null;
    this.probeTimer = null;
    this.capabilityTimer = null;
    if (this._state === 'syncing') this.setState('idle');
  }

  /**
   * Stop, clear all indexes and the cursor. Call `start()` again to
   * re-bootstrap from scratch.
   */
  async reset(): Promise<void> {
    this.stop();
    this.productIndex.clear();
    this.signalIndex.clear();
    this.catalogVersion = undefined;
    this.pricingVersion = undefined;
    this.cursor = null;
    this._lastSyncedAt = undefined;
    this._lastEventAt = undefined;
    this.setState('idle');
  }

  /**
   * Force a manual re-bootstrap. Available in all modes. Fires diff events
   * for changes detected between the current replica and the freshly
   * fetched catalog, then re-establishes the background sync (poll or
   * probe) appropriate to the current mode.
   */
  async refresh(): Promise<void> {
    this.emit('resyncing', { reason: 'manual' });
    await this.bootstrap({ emitDiffs: true });
  }

  // ====== Public state ======

  get state(): CatalogSyncState {
    return this._state;
  }
  get mode(): CatalogSyncMode {
    return this._mode;
  }
  get capabilities(): Readonly<ResolvedCapabilities> {
    // Return a fresh clone — `Readonly<T>` is shallow, and an adopter
    // mutating `catalog.capabilities.eventTypes` (a JS array) would
    // otherwise corrupt internal state. Deep-clone is cheap (a handful
    // of primitives + one string array).
    return structuredClone(this._capabilities);
  }
  get lastSyncedAt(): Date | undefined {
    return this._lastSyncedAt;
  }
  get lastEventAt(): Date | undefined {
    return this._lastEventAt;
  }

  // ====== Private: capability resolution ======

  private async resolveMode(): Promise<void> {
    const caps = await this.client.getAdcpCapabilities({});
    // TaskResult union — only `success` carries a typed `data` field.
    // Other task-arms (`deferred`, `input-required`, `error`) leave us
    // without enough info to pick a mode confidently. Spec says we MAY
    // fall back to manual-mode wholesale polling against agents that
    // don't declare the surfaces — but that masks real auth/config
    // failures (e.g., a 401 returned via the `error` arm). Surface the
    // condition via an `error` event so adopters see it, then fall back.
    const status = (caps as { status?: string }).status;
    if (typeof status === 'string' && status !== 'success' && status !== 'completed') {
      const message =
        (caps as { error?: { message?: string } }).error?.message ?? `get_adcp_capabilities returned status=${status}`;
      const err = new Error(`CatalogSync: capability probe returned non-success status: ${message}`);
      this.errorHandler?.(err);
      this.emit('error', { error: err });
      // Fall through to the empty-stanza path below so the sync still
      // boots in manual mode.
    }
    const data = (caps as { data?: unknown }).data;
    const stanza = (data ?? {}) as {
      catalog_change_feed?: {
        supported?: boolean;
        retention_window_days?: number;
        webhooks_supported?: boolean;
        event_types?: string[];
      };
      catalog_versioning?: { supported?: boolean };
      signals?: { discovery_modes?: string[] };
    };
    const changeFeed = stanza.catalog_change_feed?.supported === true;
    const catalogVersioning = stanza.catalog_versioning?.supported === true;
    const webhooks = stanza.catalog_change_feed?.webhooks_supported === true;
    const eventTypes = Array.isArray(stanza.catalog_change_feed?.event_types)
      ? [...stanza.catalog_change_feed!.event_types!]
      : [];
    const retentionWindowDays = stanza.catalog_change_feed?.retention_window_days;
    const wholesaleSignals = stanza.signals?.discovery_modes?.includes('wholesale') ?? false;

    const resolved: ResolvedCapabilities = {
      changeFeed,
      catalogVersioning,
      webhooks,
      eventTypes,
      ...(typeof retentionWindowDays === 'number' && { retentionWindowDays }),
    };

    const mode: CatalogSyncMode = changeFeed ? 'live' : catalogVersioning ? 'auto-poll' : 'manual';
    this._capabilities = resolved;
    this._mode = mode;
    this.products._mode = mode;
    this.signals._mode = mode;
    this.signals.queryable = wholesaleSignals;
    this.emit('mode_resolved', { mode, capabilities: resolved });
  }

  // ====== Private: bootstrap (wholesale enumeration) ======

  private async bootstrap(options: { emitDiffs?: boolean } = {}): Promise<void> {
    this.setState('bootstrapping');
    try {
      // Build into local maps and atomically swap on success. The previous
      // implementation cleared the live indexes BEFORE fetching, so an
      // `unchanged: true` short-circuit on the conditional-fetch path
      // would wipe the replica (the seller correctly tells us "no
      // change," and we lose every product). Build-then-swap guarantees
      // the in-memory replica is never in a torn state and is only
      // mutated on a successful, fresh fetch.
      const previousProducts = new Map(this.productIndex);
      const previousSignals = new Map(this.signalIndex);
      const incomingProducts = new Map<string, Product>();
      const incomingSignals = new Map<string, Signal>();
      let productsUnchanged = false;

      productsUnchanged = await this.bootstrapProducts(incomingProducts);
      if (this.signals.queryable) {
        await this.bootstrapSignals(incomingSignals);
      }

      if (productsUnchanged) {
        // Seller confirmed our cached version is current. Keep the
        // existing index intact; don't swap with the empty incoming.
      } else {
        this.productIndex = incomingProducts;
      }
      if (this.signals.queryable) {
        this.signalIndex = incomingSignals;
      }

      if (options.emitDiffs) {
        this.emitDiffs(previousProducts, previousSignals);
      }

      this.setState('syncing');
      this._lastSyncedAt = new Date();
      this.emit('bootstrap', {
        productCount: this.productIndex.size,
        signalCount: this.signalIndex.size,
        mode: this._mode,
      });
    } catch (err) {
      this.setState('error');
      const error = err instanceof Error ? err : new Error(String(err));
      this.errorHandler?.(error);
      this.emit('error', { error });
      throw error;
    }
  }

  /** Returns `true` when the seller short-circuited with `unchanged: true`. */
  private async bootstrapProducts(into: Map<string, Product>): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const params: Record<string, unknown> = {
        buying_mode: 'wholesale',
        pagination: { max_results: DEFAULT_BOOTSTRAP_PAGE_LIMIT, ...(cursor && { cursor }) },
      };
      // Conditional fetch on the page-0 call when we already have a cached
      // version. Per the spec, the seller short-circuits with
      // `unchanged: true` and no payload — caller keeps the previous index.
      if (this.catalogVersion && this._capabilities.catalogVersioning) {
        params.if_catalog_version = this.catalogVersion;
      }
      const result = (await this.client.getProducts(params as never)) as {
        data?: V31Beta.GetProductsResponse;
      };
      const body = result.data;
      if (!body) return false;
      if (body.unchanged) {
        // Echo any newer pricing_version / cache_scope the seller
        // returned alongside the unchanged signal, then tell the caller
        // to keep the existing index.
        if (typeof body.pricing_version === 'string') this.pricingVersion = body.pricing_version;
        if (body.cache_scope === 'public' || body.cache_scope === 'account') this.cacheScope = body.cache_scope;
        return true;
      }
      const products = Array.isArray(body.products) ? body.products : [];
      for (const product of products) {
        const id = (product as { product_id?: string }).product_id;
        if (typeof id === 'string') into.set(id, product as Product);
      }
      if (typeof body.catalog_version === 'string') this.catalogVersion = body.catalog_version;
      if (typeof body.pricing_version === 'string') this.pricingVersion = body.pricing_version;
      if (body.cache_scope === 'public' || body.cache_scope === 'account') this.cacheScope = body.cache_scope;
      cursor = body.pagination?.has_more ? body.pagination?.cursor : undefined;
    } while (cursor);
    return false;
  }

  private async bootstrapSignals(into: Map<string, Signal>): Promise<void> {
    let cursor: string | undefined;
    do {
      const params: Record<string, unknown> = {
        discovery_mode: 'wholesale',
        pagination: { max_results: DEFAULT_BOOTSTRAP_PAGE_LIMIT, ...(cursor && { cursor }) },
      };
      const result = (await this.client.getSignals(params as never)) as {
        data?: V31Beta.GetSignalsResponse;
      };
      const body = result.data;
      if (!body) break;
      if (body.unchanged) break;
      const signals = Array.isArray(body.signals) ? body.signals : [];
      for (const signal of signals) {
        const id = (signal as { signal_agent_segment_id?: string }).signal_agent_segment_id;
        if (typeof id === 'string') into.set(id, signal as Signal);
      }
      cursor = body.pagination?.has_more ? body.pagination?.cursor : undefined;
    } while (cursor);
  }

  // ====== Private: live-mode change-feed poll ======

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => this.pollLoop(), this.pollIntervalMs);
  }

  private async pollLoop(): Promise<void> {
    try {
      await this.pollFeed();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      this.errorHandler?.(error);
    }
    if (this._state === 'syncing' && this._mode === 'live') {
      this.schedulePoll();
    }
  }

  private async pollFeed(): Promise<void> {
    if (!this.feedOrigin) {
      throw new Error(
        `CatalogSync: 'live' mode requires feedOrigin to be configured (target: GET <feedOrigin>/catalog/events).`
      );
    }
    const headers = await this.resolveFeedHeaders();
    let totalApplied = 0;
    let hasMore = true;
    while (hasMore) {
      const url = new URL('/catalog/events', this.feedOrigin);
      if (this.cursor) url.searchParams.set('cursor', this.cursor);
      url.searchParams.set('limit', String(DEFAULT_FEED_PAGE_LIMIT));
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
      });
      if (response.status === 410) {
        await this.recoverFromRetentionExpired();
        return;
      }
      if (!response.ok) {
        throw new Error(`CatalogSync: GET ${url.pathname} → ${response.status} ${response.statusText}`);
      }
      // Read the body with a size cap so a hostile or runaway agent can't
      // OOM the mirror by streaming an unbounded chunked response.
      const body = await this.readFeedBody(response);
      // Some agents prefer 200 + structured error envelope to a hard 410.
      // Detect on the parsed body — no clone-then-parse double-buffer.
      if (
        body !== null &&
        typeof body === 'object' &&
        'error' in body &&
        typeof (body as { error?: { code?: string } }).error?.code === 'string' &&
        (body as { error: { code: string } }).error.code === 'RETENTION_EXPIRED'
      ) {
        await this.recoverFromRetentionExpired();
        return;
      }
      const parsed = body as V31Beta.CatalogEventsResponse;
      const events = Array.isArray(parsed.events) ? parsed.events : [];
      // Advance the cursor BEFORE processing events. Required so that a
      // bulk_change event on the page doesn't loop forever: the post-
      // recovery re-bootstrap resumes polling from the cursor PAST the
      // bulk_change, not from the cursor that delivered it.
      if (typeof parsed.next_cursor === 'string') {
        this.cursor = parsed.next_cursor;
        await this.cursorStore.setCursor(this.cursor);
      }
      for (const event of events) {
        if (event.event_type === 'catalog.bulk_change') {
          this.emit('event', { event });
          this.emit('catalog.bulk_change', { event });
          await this.recoverFromBulkChange();
          return;
        }
        this.applyEvent(event);
        this.emit('event', { event });
        this.emitTypedEvent(event);
        totalApplied++;
      }
      hasMore = parsed.has_more === true && this.cursor != null;
    }
    if (totalApplied > 0) {
      this._lastEventAt = new Date();
      this._lastSyncedAt = new Date();
      this.emit('sync', { eventsApplied: totalApplied, cursor: this.cursor ?? undefined });
    }
  }

  /**
   * Read the change-feed response body with a configurable byte cap.
   * Avoids `response.clone()` + `response.json()` double-buffering by
   * reading the underlying stream once and parsing the buffered bytes.
   * Throws when `maxFeedResponseBytes > 0` and the body exceeds the cap
   * before the parse — the partial buffer is discarded.
   */
  private async readFeedBody(response: Response): Promise<unknown> {
    if (this.maxFeedResponseBytes <= 0) {
      return await response.json();
    }
    const reader = response.body?.getReader();
    if (!reader) {
      // No stream (mock or non-streaming runtime). Fall back to .json()
      // and rely on the test harness to keep bodies reasonable.
      return await response.json();
    }
    const cap = this.maxFeedResponseBytes;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        // Cancel the reader to release the connection and surface a
        // typed error that adopters can branch on.
        try {
          await reader.cancel();
        } catch {
          /* best-effort */
        }
        throw new Error(
          `CatalogSync: change-feed response exceeded maxFeedResponseBytes (${cap}). ` +
            `Increase the cap or investigate the agent (this is a DoS guard).`
        );
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
    const text = buffer.toString('utf8');
    if (text.length === 0) return null;
    return JSON.parse(text);
  }

  private async recoverFromRetentionExpired(): Promise<void> {
    this.emit('resyncing', { reason: 'retention_expired' });
    this.cursor = null;
    await this.cursorStore.clearCursor();
    await this.bootstrap({ emitDiffs: true });
  }

  private async recoverFromBulkChange(): Promise<void> {
    this.emit('resyncing', { reason: 'bulk_change' });
    await this.bootstrap({ emitDiffs: true });
  }

  // ====== Private: auto-poll mode version probe ======

  private scheduleProbe(): void {
    this.probeTimer = setTimeout(() => this.probeLoop(), this.probeIntervalMs);
  }

  private async probeLoop(): Promise<void> {
    try {
      await this.probeVersion();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      this.errorHandler?.(error);
    }
    if (this._state === 'syncing' && this._mode === 'auto-poll') {
      this.scheduleProbe();
    }
  }

  private async probeVersion(): Promise<void> {
    if (!this.catalogVersion) {
      // No baseline to compare against; fall through to a refresh which
      // bootstraps and captures the first version.
      await this.refresh();
      return;
    }
    const result = (await this.client.getProducts({
      buying_mode: 'wholesale',
      if_catalog_version: this.catalogVersion,
      pagination: { max_results: 1 },
    } as never)) as { data?: V31Beta.GetProductsResponse };
    const body = result.data;
    if (!body || body.unchanged) {
      this._lastSyncedAt = new Date();
      return; // catalog is current
    }
    // Version moved — diff-emit by re-bootstrapping.
    await this.refresh();
  }

  // ====== Private: capability refresh ======

  private scheduleCapabilityRefresh(): void {
    this.capabilityTimer = setTimeout(() => this.capabilityRefreshLoop(), this.capabilityRefreshIntervalMs);
  }

  private async capabilityRefreshLoop(): Promise<void> {
    try {
      const previousMode = this._mode;
      await this.resolveMode();
      if (this._mode !== previousMode) {
        // Capability upgrade or downgrade — re-establish background sync.
        this.stop();
        await this.start();
        return;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      this.errorHandler?.(error);
    }
    if (this._state === 'syncing' && this.capabilityRefreshIntervalMs > 0) {
      this.scheduleCapabilityRefresh();
    }
  }

  // ====== Private: event application ======

  private applyEvent(event: V31Beta.CatalogEvent): void {
    switch (event.event_type) {
      case 'product.created':
      case 'product.updated': {
        const payload = event.payload as {
          product_id: string;
          product?: Product;
          changed_fields?: string[];
          [k: string]: unknown;
        };
        if (typeof payload.product_id !== 'string') return;
        if (payload.product) {
          // Full denorm — replace the entry entirely.
          this.productIndex.set(payload.product_id, payload.product);
          return;
        }
        // Partial update without a denormalized `product`. Spec
        // (`core/catalog-event.json`) declares `payload.additionalProperties:
        // true` and treats `changed_fields` as advisory. Merge any
        // top-level fields the agent sent on the payload (beyond the
        // protocol-defined `product_id` / `changed_fields` / `applies_to`)
        // into the existing entry rather than silently dropping the
        // delta. Without this merge, an agent emitting a sparse update
        // (e.g., `{ product_id, changed_fields: ['name'], name: 'New' }`)
        // would have its change discarded.
        const existing = this.productIndex.get(payload.product_id);
        if (!existing) return;
        const RESERVED_KEYS = new Set(['product_id', 'product', 'changed_fields', 'applies_to']);
        const overlay: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(payload)) {
          if (RESERVED_KEYS.has(key)) continue;
          overlay[key] = value;
        }
        if (Object.keys(overlay).length === 0) {
          // Truly empty update — no `product`, no overlay fields. Keep
          // existing intact; adopters needing full state can `refresh()`.
          return;
        }
        this.productIndex.set(payload.product_id, { ...existing, ...overlay } as Product);
        return;
      }
      case 'product.priced': {
        const payload = event.payload as {
          product_id: string;
          pricing_options?: unknown[];
        };
        const existing = this.productIndex.get(payload.product_id);
        if (existing && Array.isArray(payload.pricing_options)) {
          this.productIndex.set(payload.product_id, {
            ...existing,
            pricing_options: payload.pricing_options as Product['pricing_options'],
          });
        }
        return;
      }
      case 'product.removed': {
        const payload = event.payload as { product_id: string };
        if (typeof payload.product_id === 'string') this.productIndex.delete(payload.product_id);
        return;
      }
      case 'signal.created':
      case 'signal.updated': {
        const payload = event.payload as {
          signal_agent_segment_id: string;
          signal_id?: unknown;
        };
        if (typeof payload.signal_agent_segment_id !== 'string') return;
        const existing = this.signalIndex.get(payload.signal_agent_segment_id);
        if (existing) {
          // Updated event — merge known fields.
          this.signalIndex.set(payload.signal_agent_segment_id, {
            ...existing,
            ...(payload as Partial<Signal>),
          });
        } else if (payload.signal_id) {
          // Created event with enough fields to seed the index.
          this.signalIndex.set(payload.signal_agent_segment_id, payload as unknown as Signal);
        }
        return;
      }
      case 'signal.priced': {
        const payload = event.payload as {
          signal_agent_segment_id: string;
          pricing_options?: unknown[];
        };
        const existing = this.signalIndex.get(payload.signal_agent_segment_id);
        if (existing && Array.isArray(payload.pricing_options)) {
          this.signalIndex.set(payload.signal_agent_segment_id, {
            ...existing,
            pricing_options: payload.pricing_options as Signal['pricing_options'],
          });
        }
        return;
      }
      case 'signal.removed': {
        const payload = event.payload as { signal_agent_segment_id: string };
        if (typeof payload.signal_agent_segment_id === 'string') {
          this.signalIndex.delete(payload.signal_agent_segment_id);
        }
        return;
      }
      case 'catalog.bulk_change':
        // Bulk change events trigger re-bootstrap in pollFeed before
        // reaching this method.
        return;
    }
  }

  private emitTypedEvent(event: V31Beta.CatalogEvent): void {
    // event_type is the discriminator; every value maps to a typed listener
    // name. The switch keeps TypeScript honest about exhaustiveness.
    switch (event.event_type) {
      case 'product.created':
        this.emit('product.created', { event });
        return;
      case 'product.updated':
        this.emit('product.updated', { event });
        return;
      case 'product.priced':
        this.emit('product.priced', { event });
        return;
      case 'product.removed':
        this.emit('product.removed', { event });
        return;
      case 'signal.created':
        this.emit('signal.created', { event });
        return;
      case 'signal.updated':
        this.emit('signal.updated', { event });
        return;
      case 'signal.priced':
        this.emit('signal.priced', { event });
        return;
      case 'signal.removed':
        this.emit('signal.removed', { event });
        return;
      case 'catalog.bulk_change':
        // Already emitted in pollFeed before recovery.
        return;
    }
  }

  // ====== Private: diff emission (auto-poll / manual refresh) ======

  private emitDiffs(previousProducts: Map<string, Product>, previousSignals: Map<string, Signal>): void {
    const now = new Date().toISOString();
    const makeEvent = (
      event_type: V31Beta.CatalogEvent['event_type'],
      entity_type: V31Beta.CatalogEvent['entity_type'],
      entity_id: string,
      payload: object
    ): V31Beta.CatalogEvent =>
      ({
        // crypto.randomUUID() emits a v4 UUID, NOT v7. Synthetic events
        // are flagged via `synthetic: true` on the emit envelope so
        // adopters writing event_ids to a dedupe table know not to
        // treat the ID as cursor-orderable. Real change-feed events
        // carry the agent's authoritative v7 event_id.
        event_id: randomUUID(),
        event_type,
        entity_type,
        entity_id,
        created_at: now,
        payload,
      }) as V31Beta.CatalogEvent;
    const emit = (channel: keyof CatalogSyncEvents, event: V31Beta.CatalogEvent): void => {
      this.emit('event', { event, synthetic: true });
      this.emit(channel as 'product.created', { event, synthetic: true });
    };

    for (const [id, product] of this.productIndex) {
      const prev = previousProducts.get(id);
      if (!prev) {
        emit(
          'product.created',
          makeEvent('product.created', 'product', id, {
            product_id: id,
            product,
            applies_to: { scope: this.cacheScope },
          })
        );
      } else if (priceChanged(prev, product)) {
        emit(
          'product.priced',
          makeEvent('product.priced', 'product', id, {
            product_id: id,
            pricing_options: product.pricing_options ?? [],
            applies_to: { scope: this.cacheScope },
          })
        );
      } else if (!isDeepStrictEqual(prev, product)) {
        emit(
          'product.updated',
          makeEvent('product.updated', 'product', id, {
            product_id: id,
            product,
            applies_to: { scope: this.cacheScope },
          })
        );
      }
    }
    for (const [id] of previousProducts) {
      if (!this.productIndex.has(id)) {
        emit('product.removed', makeEvent('product.removed', 'product', id, { product_id: id }));
      }
    }
    for (const [id, signal] of this.signalIndex) {
      const prev = previousSignals.get(id);
      if (!prev) {
        emit(
          'signal.created',
          makeEvent('signal.created', 'signal', id, {
            signal_agent_segment_id: id,
            applies_to: { scope: this.cacheScope },
          })
        );
      } else if (signalPriceChanged(prev, signal)) {
        emit(
          'signal.priced',
          makeEvent('signal.priced', 'signal', id, {
            signal_agent_segment_id: id,
            pricing_options: (signal as { pricing_options?: unknown[] }).pricing_options ?? [],
            applies_to: { scope: this.cacheScope },
          })
        );
      } else if (!isDeepStrictEqual(prev, signal)) {
        emit(
          'signal.updated',
          makeEvent('signal.updated', 'signal', id, {
            signal_agent_segment_id: id,
            applies_to: { scope: this.cacheScope },
          })
        );
      }
    }
    for (const [id] of previousSignals) {
      if (!this.signalIndex.has(id)) {
        emit('signal.removed', makeEvent('signal.removed', 'signal', id, { signal_agent_segment_id: id }));
      }
    }
  }

  // ====== Private: search ======

  private searchProducts(filter: ProductFilter): Product[] {
    const text = filter.text?.toLowerCase();
    return this.products.list().filter(product => {
      if (filter.product_ids?.length) {
        const id = (product as { product_id?: string }).product_id;
        if (!id || !filter.product_ids.includes(id)) return false;
      }
      if (filter.delivery_types?.length) {
        const dt = (product as { delivery_type?: string }).delivery_type;
        if (!dt || !filter.delivery_types.includes(dt)) return false;
      }
      if (filter.format_ids?.length) {
        const formats = (product as { format_ids?: Array<{ id?: string }> | string[] }).format_ids;
        const ids = (Array.isArray(formats) ? formats : []).map(f => (typeof f === 'string' ? f : (f?.id ?? '')));
        if (!filter.format_ids.some(want => ids.includes(want))) return false;
      }
      if (text) {
        const haystack = [(product as { name?: string }).name, (product as { description?: string }).description]
          .filter((s): s is string => typeof s === 'string')
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }

  private searchSignals(filter: SignalFilter): Signal[] {
    const text = filter.text?.toLowerCase();
    const provider = filter.data_provider?.toLowerCase();
    return this.signals.list().filter(signal => {
      const s = signal as {
        signal_agent_segment_id?: string;
        signal_type?: string;
        data_provider?: string;
        name?: string;
        description?: string;
      };
      if (filter.signal_agent_segment_ids?.length) {
        if (!s.signal_agent_segment_id || !filter.signal_agent_segment_ids.includes(s.signal_agent_segment_id))
          return false;
      }
      if (filter.signal_types?.length) {
        if (!s.signal_type || !filter.signal_types.includes(s.signal_type)) return false;
      }
      if (provider) {
        if (!s.data_provider || !s.data_provider.toLowerCase().includes(provider)) return false;
      }
      if (text) {
        const haystack = [s.name, s.description]
          .filter((v): v is string => typeof v === 'string')
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }

  // ====== Private: state ======

  private setState(next: CatalogSyncState): void {
    const from = this._state;
    if (from === next) return;
    this._state = next;
    this.emit('stateChange', { from, to: next });
  }
}

// ====== Diff helpers ======

function priceChanged(prev: Product, next: Product): boolean {
  const a = (prev as { pricing_options?: unknown[] }).pricing_options;
  const b = (next as { pricing_options?: unknown[] }).pricing_options;
  return !isDeepStrictEqual(a, b);
}

function signalPriceChanged(prev: Signal, next: Signal): boolean {
  const a = (prev as { pricing_options?: unknown[] }).pricing_options;
  const b = (next as { pricing_options?: unknown[] }).pricing_options;
  return !isDeepStrictEqual(a, b);
}
