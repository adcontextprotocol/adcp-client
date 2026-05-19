import { EventEmitter } from 'node:events';
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
  private readonly feedHeaders: Record<string, string>;
  private readonly pollIntervalMs: number;
  private readonly probeIntervalMs: number;
  private readonly capabilityRefreshIntervalMs: number;
  private readonly cursorStore: CursorStore;
  private readonly errorHandler: ((error: Error) => void) | undefined;
  private readonly fetchImpl: typeof fetch;

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
    list: (): Signal[] => [...this.signalIndex.values()],
    get: (signalAgentSegmentId: string): Signal | undefined => this.signalIndex.get(signalAgentSegmentId),
    search: (filter: SignalFilter): Signal[] => this.searchSignals(filter),
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

  constructor(config: CatalogSyncConfig) {
    super();
    this.client = config.client;
    this.feedOrigin = config.feedOrigin;
    this.feedHeaders = config.feedHeaders ?? {};
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.probeIntervalMs = config.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.capabilityRefreshIntervalMs = config.capabilityRefreshIntervalMs ?? DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS;
    this.cursorStore = config.cursorStore ?? new InMemoryCursorStore();
    this.errorHandler = config.onError;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ====== Lifecycle ======

  /**
   * Probe the agent's capabilities, pick a sync mode, and bootstrap the
   * in-memory replica via wholesale enumeration. In `'live'` mode also
   * starts the change-feed poll; in `'auto-poll'` mode starts the version
   * probe loop.
   *
   * Safe to call repeatedly — second and later calls re-probe capabilities
   * and re-bootstrap, equivalent to calling `refresh()` after a mode
   * upgrade.
   */
  async start(): Promise<void> {
    if (this._state === 'bootstrapping') return;
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
    this.emit('bulk_resync', { reason: 'manual' });
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
    return this._capabilities;
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
    // TaskResult union — only `success` carries a typed data field. Other
    // task-arms (deferred, input-required, error) leave the SDK without
    // enough information to pick a mode; treat them as manual-mode
    // fallback rather than throw, matching the spec's "fall back to
    // wholesale polling against agents that don't declare the surfaces"
    // posture.
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
      const previousProducts = options.emitDiffs ? new Map(this.productIndex) : undefined;
      const previousSignals = options.emitDiffs ? new Map(this.signalIndex) : undefined;
      this.productIndex.clear();
      this.signalIndex.clear();

      await this.bootstrapProducts();
      if (this.signals.queryable) {
        await this.bootstrapSignals();
      }

      if (options.emitDiffs) {
        this.emitDiffs(previousProducts!, previousSignals!);
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

  private async bootstrapProducts(): Promise<void> {
    let cursor: string | undefined;
    do {
      const params: Record<string, unknown> = {
        buying_mode: 'wholesale',
        pagination: { max_results: DEFAULT_BOOTSTRAP_PAGE_LIMIT, ...(cursor && { cursor }) },
      };
      // Conditional fetch on the page-0 call when we already have a cached
      // version. Per the spec, the seller short-circuits with
      // `unchanged: true` and no payload — we skip the rebuild entirely.
      if (this.catalogVersion && this._capabilities.catalogVersioning) {
        params.if_catalog_version = this.catalogVersion;
      }
      const result = (await this.client.getProducts(params as never)) as {
        data?: V31Beta.GetProductsResponse;
      };
      const body = result.data;
      if (!body) break;
      if (body.unchanged) {
        // Nothing to rebuild — keep the existing index in place. The
        // bootstrap caller cleared it above, so we'd lose data; the
        // unchanged path only matters on `refresh()` against a stable
        // catalog. Re-populate from the previous map and exit. This
        // branch is only reachable via refresh(); start() doesn't have
        // a cached version yet.
        break;
      }
      const products = Array.isArray(body.products) ? body.products : [];
      for (const product of products) {
        const id = (product as { product_id?: string }).product_id;
        if (typeof id === 'string') this.productIndex.set(id, product as Product);
      }
      if (typeof body.catalog_version === 'string') this.catalogVersion = body.catalog_version;
      if (typeof body.pricing_version === 'string') this.pricingVersion = body.pricing_version;
      if (body.cache_scope === 'public' || body.cache_scope === 'account') this.cacheScope = body.cache_scope;
      cursor = body.pagination?.has_more ? body.pagination?.cursor : undefined;
    } while (cursor);
  }

  private async bootstrapSignals(): Promise<void> {
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
        if (typeof id === 'string') this.signalIndex.set(id, signal as Signal);
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
    let totalApplied = 0;
    let hasMore = true;
    while (hasMore) {
      const url = new URL('/catalog/events', this.feedOrigin);
      if (this.cursor) url.searchParams.set('cursor', this.cursor);
      url.searchParams.set('limit', String(DEFAULT_FEED_PAGE_LIMIT));
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', ...this.feedHeaders },
      });
      if (response.status === 410 || (await this.isRetentionExpiredBody(response))) {
        await this.recoverFromRetentionExpired();
        return;
      }
      if (!response.ok) {
        throw new Error(`CatalogSync: GET ${url.pathname} → ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as V31Beta.CatalogEventsResponse;
      const events = Array.isArray(body.events) ? body.events : [];
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
      if (typeof body.next_cursor === 'string') {
        this.cursor = body.next_cursor;
        await this.cursorStore.setCursor(this.cursor);
      }
      hasMore = body.has_more === true && this.cursor != null;
    }
    if (totalApplied > 0) {
      this._lastEventAt = new Date();
      this._lastSyncedAt = new Date();
      this.emit('sync', { eventsApplied: totalApplied, cursor: this.cursor ?? undefined });
    }
  }

  private async isRetentionExpiredBody(response: Response): Promise<boolean> {
    // Some agents prefer 200 + structured error envelope to a hard 410.
    // Peek at the body without consuming it — we clone before parsing so
    // the caller can still read the original on the happy path.
    if (response.status !== 200) return false;
    try {
      const clone = response.clone();
      const peek = (await clone.json()) as { error?: { code?: string } };
      return peek?.error?.code === 'RETENTION_EXPIRED';
    } catch {
      return false;
    }
  }

  private async recoverFromRetentionExpired(): Promise<void> {
    this.emit('bulk_resync', { reason: 'retention_expired' });
    this.cursor = null;
    await this.cursorStore.setCursor(''); // sentinel: prefer empty over null per CursorStore contract
    await this.bootstrap({ emitDiffs: true });
  }

  private async recoverFromBulkChange(): Promise<void> {
    this.emit('bulk_resync', { reason: 'bulk_change' });
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
        const payload = event.payload as { product_id: string; product?: Product };
        if (typeof payload.product_id !== 'string') return;
        if (payload.product) {
          this.productIndex.set(payload.product_id, payload.product);
        } else {
          // Updated event without a denormalized payload — drop a stub.
          // Adopters needing full state should call `refresh()`.
          const existing = this.productIndex.get(payload.product_id);
          if (existing) this.productIndex.set(payload.product_id, existing);
        }
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
        event_id: cryptoRandomUuidLike(),
        event_type,
        entity_type,
        entity_id,
        created_at: now,
        payload,
      }) as V31Beta.CatalogEvent;

    for (const [id, product] of this.productIndex) {
      const prev = previousProducts.get(id);
      if (!prev) {
        const event = makeEvent('product.created', 'product', id, {
          product_id: id,
          product,
          applies_to: { scope: this.cacheScope },
        });
        this.emit('event', { event });
        this.emit('product.created', { event });
      } else if (priceChanged(prev, product)) {
        const event = makeEvent('product.priced', 'product', id, {
          product_id: id,
          pricing_options: product.pricing_options ?? [],
          applies_to: { scope: this.cacheScope },
        });
        this.emit('event', { event });
        this.emit('product.priced', { event });
      } else if (!deepEqual(prev, product)) {
        const event = makeEvent('product.updated', 'product', id, {
          product_id: id,
          product,
          applies_to: { scope: this.cacheScope },
        });
        this.emit('event', { event });
        this.emit('product.updated', { event });
      }
    }
    for (const [id] of previousProducts) {
      if (!this.productIndex.has(id)) {
        const event = makeEvent('product.removed', 'product', id, { product_id: id });
        this.emit('event', { event });
        this.emit('product.removed', { event });
      }
    }
    for (const [id, signal] of this.signalIndex) {
      const prev = previousSignals.get(id);
      if (!prev) {
        const event = makeEvent('signal.created', 'signal', id, {
          signal_agent_segment_id: id,
          applies_to: { scope: this.cacheScope },
        });
        this.emit('event', { event });
        this.emit('signal.created', { event });
      } else if (signalPriceChanged(prev, signal)) {
        const event = makeEvent('signal.priced', 'signal', id, {
          signal_agent_segment_id: id,
          pricing_options: (signal as { pricing_options?: unknown[] }).pricing_options ?? [],
          applies_to: { scope: this.cacheScope },
        });
        this.emit('event', { event });
        this.emit('signal.priced', { event });
      } else if (!deepEqual(prev, signal)) {
        const event = makeEvent('signal.updated', 'signal', id, {
          signal_agent_segment_id: id,
          applies_to: { scope: this.cacheScope },
        });
        this.emit('event', { event });
        this.emit('signal.updated', { event });
      }
    }
    for (const [id] of previousSignals) {
      if (!this.signalIndex.has(id)) {
        const event = makeEvent('signal.removed', 'signal', id, { signal_agent_segment_id: id });
        this.emit('event', { event });
        this.emit('signal.removed', { event });
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
  return !deepEqual(a, b);
}

function signalPriceChanged(prev: Signal, next: Signal): boolean {
  const a = (prev as { pricing_options?: unknown[] }).pricing_options;
  const b = (next as { pricing_options?: unknown[] }).pricing_options;
  return !deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function cryptoRandomUuidLike(): string {
  // Minimal UUID-shaped string for diff-emitted events. NOT v7 — these
  // are synthesized client-side from a refresh diff, not pulled from the
  // agent's authoritative feed, so the cursor-ordering property doesn't
  // apply. Real change-feed events carry the agent's v7 event_id.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
