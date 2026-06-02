import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type * as V31Beta from '../types/v3-1-beta';
import type {
  WholesaleFeedSyncClient,
  WholesaleFeedSyncConfig,
  WholesaleFeedSyncEvents,
  WholesaleFeedSyncMode,
  WholesaleFeedSyncState,
  ProductFilter,
  ResolvedCapabilities,
  SignalFilter,
} from './types';

type Product = V31Beta.Product;
// `signals` is an inline array type on GetSignalsResponse (no top-level
// Signal export in the generated bundle). Extract the element type so
// the index map and search helpers stay strongly-typed.
type Signal = NonNullable<V31Beta.GetSignalsResponse['signals']>[number];
type FeedMetadata = {
  wholesaleFeedVersion: string | undefined;
  pricingVersion: string | undefined;
  cacheScope: 'public' | 'account';
};
type BootstrapFeedResult<T> = {
  cancelled: boolean;
  unchanged: boolean;
  items: Map<string, T>;
  metadata: FeedMetadata;
};

const DEFAULT_PROBE_INTERVAL_MS = 600_000;
const DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS = 86_400_000;
const DEFAULT_BOOTSTRAP_PAGE_LIMIT = 100;
const VERSION_MISMATCH_RECOVERY_ATTEMPTS = 3;
const VERSION_MISMATCH_RECOVERY_BACKOFF_MS = 5;

/**
 * In-memory mirror of an AdCP agent's wholesale product and signal feeds.
 *
 * Discovers the agent's wholesale-feed capabilities at `start()`, picks the
 * highest-capability sync strategy the agent supports, and maintains a
 * local index for zero-latency lookups. Falls back gracefully to manual
 * bootstrap when the agent does not advertise conditional-fetch tokens.
 *
 * @example
 * ```ts
 * import { AdCPClient } from '@adcp/sdk';
 * import { WholesaleFeedSync } from '@adcp/sdk/wholesale-feed-sync';
 *
 * const client = new AdCPClient({ agentUrl, adcpVersion: '3.1-beta' });
 * const sync = new WholesaleFeedSync({ client });
 *
 * sync.on('product.priced', ({ event }) => {
 *   const p = event.payload as { product_id: string; pricing_options: unknown[] };
 *   console.log('reprice:', p.product_id);
 * });
 *
 * await sync.start();
 * // sync.mode is 'auto-poll' / 'manual' depending on the agent
 * console.log(`syncing ${sync.products.count} products via ${sync.mode} mode`);
 * ```
 */
export class WholesaleFeedSync extends EventEmitter<WholesaleFeedSyncEvents> {
  private readonly client: WholesaleFeedSyncClient;
  private readonly account: V31Beta.AccountReference | undefined;
  private readonly webhookScope: NonNullable<WholesaleFeedSyncConfig['webhookScope']> | undefined;
  private readonly webhookDedupStore: WholesaleFeedSyncConfig['webhookDedupStore'] | undefined;
  private readonly probeIntervalMs: number;
  private readonly capabilityRefreshIntervalMs: number;
  private readonly errorHandler: ((error: Error) => void) | undefined;
  private startPromise: Promise<void> | null = null;
  private startPromiseEpoch: number | null = null;
  private signalsQueryableWarned = false;
  private readonly processedWebhookKeys = new Set<string>();
  private readonly processedWebhookEventKeys = new Set<string>();
  private lastWebhookEventId: string | undefined;

  private _state: WholesaleFeedSyncState = 'idle';
  private _mode: WholesaleFeedSyncMode = 'manual';
  private _capabilities: ResolvedCapabilities = {
    wholesaleFeedVersioning: false,
    webhooks: false,
    eventTypes: [],
  };
  private _lastSyncedAt: Date | undefined;
  private _lastEventAt: Date | undefined;

  private productIndex = new Map<string, Product>();
  private signalIndex = new Map<string, Signal>();

  private productWholesaleFeedVersion: string | undefined;
  private productPricingVersion: string | undefined;
  private productCacheScope: 'public' | 'account' = 'public';
  private signalWholesaleFeedVersion: string | undefined;
  private signalPricingVersion: string | undefined;
  private signalCacheScope: 'public' | 'account' = 'public';

  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private capabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleEpoch = 0;

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
    get mode(): WholesaleFeedSyncMode {
      // Per-entity mode is the lowest mode for which the agent declares
      // the entity's event family. Future extension: when capability vectors
      // diverge per entity, return the entity-specific resolution here. v1
      // mirrors the top-level mode.
      return this._mode;
    },
    // Allow the inline getter `mode` to reach private state without binding.
    // Assigned in the constructor below.
    _mode: 'manual' as WholesaleFeedSyncMode,
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
    get mode(): WholesaleFeedSyncMode {
      return this._mode;
    },
    _mode: 'manual' as WholesaleFeedSyncMode,
    /**
     * `true` when the agent supports `discovery_mode: 'wholesale'` on
     * `get_signals` (i.e., signals are browsable). When `false`, the
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
      `[WholesaleFeedSync] signals.list()/search() returned an empty replica because the agent does not declare ` +
        `signals.discovery_modes: ["wholesale"]. Brief-mode signal discovery isn't mirrored — call ` +
        `client.getSignals({ signal_spec, ... }) with your brief instead, or omit this surface for this agent.`
    );
  }

  constructor(config: WholesaleFeedSyncConfig) {
    super();
    this.client = config.client;
    this.account = config.account;
    this.webhookScope = config.webhookScope;
    this.webhookDedupStore = config.webhookDedupStore;
    this.probeIntervalMs = config.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.capabilityRefreshIntervalMs = config.capabilityRefreshIntervalMs ?? DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS;
    this.errorHandler = config.onError;
  }

  // ====== Lifecycle ======

  /**
   * Probe the agent's capabilities, pick a sync mode, and bootstrap the
   * in-memory replica via wholesale enumeration. In `'auto-poll'` mode
   * starts the conditional wholesale-feed version probe loop.
   *
   * Safe to call repeatedly — concurrent calls await the in-flight
   * bootstrap and return when it completes (no duplicate bootstrap, no
   * silent drop). Sequential calls re-probe capabilities and re-bootstrap,
   * equivalent to calling `refresh()` after a mode upgrade.
   */
  async start(): Promise<void> {
    if (this.startPromise && this.startPromiseEpoch === this.lifecycleEpoch) return this.startPromise;
    const promise = this.startInner().finally(() => {
      if (this.startPromise === promise) {
        this.startPromise = null;
        this.startPromiseEpoch = null;
      }
    });
    this.startPromise = promise;
    this.startPromiseEpoch = this.lifecycleEpoch;
    return promise;
  }

  private async startInner(): Promise<void> {
    this.stop();
    const epoch = this.lifecycleEpoch;
    if (!(await this.resolveMode(epoch))) return;
    if (!(await this.bootstrap({ epoch }))) return;
    if (this._mode === 'auto-poll') {
      this.scheduleProbe(epoch);
    }
    if (this.capabilityRefreshIntervalMs > 0) {
      this.scheduleCapabilityRefresh(epoch);
    }
  }

  /** Stop all background activity. Preserves in-memory state and version tokens. */
  stop(): void {
    this.lifecycleEpoch++;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.capabilityTimer) clearTimeout(this.capabilityTimer);
    this.probeTimer = null;
    this.capabilityTimer = null;
    if (this._state === 'syncing' || this._state === 'bootstrapping') this.setState('idle');
  }

  /**
   * Stop, clear all indexes and version tokens. Call `start()` again to
   * re-bootstrap from scratch.
   */
  async reset(): Promise<void> {
    this.stop();
    this.productIndex.clear();
    this.signalIndex.clear();
    this.productWholesaleFeedVersion = undefined;
    this.productPricingVersion = undefined;
    this.productCacheScope = 'public';
    this.signalWholesaleFeedVersion = undefined;
    this.signalPricingVersion = undefined;
    this.signalCacheScope = 'public';
    this._lastSyncedAt = undefined;
    this._lastEventAt = undefined;
    this.setState('idle');
  }

  /**
   * Force a manual re-bootstrap. Available in all modes. Fires diff events
   * for changes detected between the current replica and the freshly
   * fetched wholesale feed.
   */
  async refresh(): Promise<void> {
    const epoch = this.lifecycleEpoch;
    this.emit('resyncing', { reason: 'manual' });
    await this.bootstrap({ emitDiffs: true, epoch });
  }

  /**
   * Apply one beta-3 account-level wholesale feed webhook to the local mirror.
   * Call this from your HTTP webhook receiver after signature/auth validation.
   * Stale or out-of-order deliveries repair through conditional wholesale
   * reads instead of applying a suspect delta.
   */
  async applyWebhook(webhook: V31Beta.WholesaleFeedWebhook): Promise<void> {
    const epoch = this.lifecycleEpoch;
    const event = webhook.event;
    if (!event || webhook.notification_type !== event.event_type) {
      throw new Error('WholesaleFeedSync: wholesale feed webhook notification_type does not match event.event_type.');
    }
    if (webhook.notification_id !== event.event_id) {
      throw new Error('WholesaleFeedSync: wholesale feed webhook notification_id does not match event.event_id.');
    }
    this.assertWebhookScope(webhook);

    const payloadScope = (event.payload as { applies_to?: { scope?: string } }).applies_to?.scope;
    if (payloadScope && payloadScope !== webhook.cache_scope) {
      throw new Error(
        'WholesaleFeedSync: wholesale feed webhook cache_scope does not match event.payload.applies_to.scope.'
      );
    }
    const payloadAccountIds = (event.payload as { applies_to?: { account_ids?: unknown } }).applies_to?.account_ids;
    const expectedAccountId = this.expectedWebhookAccountId();
    if (
      webhook.cache_scope === 'account' &&
      expectedAccountId &&
      Array.isArray(payloadAccountIds) &&
      !payloadAccountIds.includes(expectedAccountId)
    ) {
      throw new Error(
        'WholesaleFeedSync: wholesale feed webhook account overlay does not include this mirror account.'
      );
    }
    const dedupeKey = this.webhookDedupeKey(webhook);
    const eventDedupeKey = this.webhookEventDedupeKey(webhook);
    if (await this.hasProcessedWebhook(dedupeKey, eventDedupeKey)) return;
    if (!this.isLifecycleCurrent(epoch)) return;

    if (this.lastWebhookEventId && compareUuidV7(event.event_id, this.lastWebhookEventId) <= 0) {
      if (!(await this.recoverFromVersionMismatch(event, epoch))) return;
      await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
      return;
    }

    let currentVersion: string | undefined;
    try {
      currentVersion = this.currentWholesaleFeedVersionForEvent(event);
    } catch (err) {
      await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
      this.rememberLastWebhookEventId(event.event_id);
      throw err;
    }
    if (
      webhook.previous_wholesale_feed_version &&
      currentVersion &&
      webhook.previous_wholesale_feed_version !== currentVersion
    ) {
      if (!(await this.recoverFromVersionMismatch(event, epoch))) return;
      await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
      return;
    }

    if (event.event_type === 'wholesale_feed.bulk_change') {
      this.emit('wholesale_feed.bulk_change', { event });
      try {
        if (!(await this.recoverFromBulkChange(event, epoch))) return;
      } catch (err) {
        await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
        this.rememberLastWebhookEventId(event.event_id);
        throw err;
      }
      await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
      this.rememberLastWebhookEventId(event.event_id);
      return;
    }

    this.applyEvent(event);
    this.rememberWebhookVersion(webhook);
    this.emit('event', { event });
    this.emitTypedEvent(event);
    await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
    this.rememberLastWebhookEventId(event.event_id);
    this._lastEventAt = new Date();
    this._lastSyncedAt = new Date();
    this.emit('sync', { eventsApplied: 1 });
  }

  // ====== Public state ======

  get state(): WholesaleFeedSyncState {
    return this._state;
  }
  get mode(): WholesaleFeedSyncMode {
    return this._mode;
  }
  get capabilities(): Readonly<ResolvedCapabilities> {
    // Return a fresh clone — `Readonly<T>` is shallow, and an adopter
    // mutating `sync.capabilities.eventTypes` (a JS array) would
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

  private async resolveMode(epoch = this.lifecycleEpoch): Promise<boolean> {
    const caps = await this.client.getAdcpCapabilities({});
    if (!this.isLifecycleCurrent(epoch)) return false;
    // TaskResult union — only `success` carries a typed `data` field.
    // Other task-arms (`deferred`, `input-required`, `error`) leave us
    // without enough info to pick a mode confidently. Spec says we MAY
    // fall back to manual wholesale reads against agents that don't
    // declare the surfaces — but that masks real auth/config
    // failures (e.g., a 401 returned via the `error` arm). Surface the
    // condition via an `error` event so adopters see it, then fall back.
    const status = (caps as { status?: string }).status;
    if (typeof status === 'string' && status !== 'success' && status !== 'completed') {
      const message =
        (caps as { error?: { message?: string } }).error?.message ?? `get_adcp_capabilities returned status=${status}`;
      const err = new Error(`WholesaleFeedSync: capability probe returned non-success status: ${message}`);
      this.errorHandler?.(err);
      this.emit('error', { error: err });
      // Fall through to the empty-stanza path below so the sync still
      // boots in manual mode.
    }
    const data = (caps as { data?: unknown }).data;
    const stanza = (data ?? {}) as {
      wholesale_feed_webhooks?: {
        supported?: boolean;
        event_types?: string[];
      };
      wholesale_feed_versioning?: { supported?: boolean };
      signals?: { discovery_modes?: string[] };
    };
    const wholesaleFeedVersioning = stanza.wholesale_feed_versioning?.supported === true;
    const webhooks = stanza.wholesale_feed_webhooks?.supported === true;
    const eventTypes = Array.isArray(stanza.wholesale_feed_webhooks?.event_types)
      ? [...stanza.wholesale_feed_webhooks!.event_types!]
      : [];
    const wholesaleSignals = stanza.signals?.discovery_modes?.includes('wholesale') ?? false;

    const resolved: ResolvedCapabilities = {
      wholesaleFeedVersioning,
      webhooks,
      eventTypes,
    };

    const mode: WholesaleFeedSyncMode = wholesaleFeedVersioning ? 'auto-poll' : 'manual';
    this._capabilities = resolved;
    this._mode = mode;
    this.products._mode = mode;
    this.signals._mode = mode;
    this.signals.queryable = wholesaleSignals;
    this.emit('mode_resolved', { mode, capabilities: resolved });
    return true;
  }

  // ====== Private: bootstrap (wholesale enumeration) ======

  private async bootstrap(
    options: { emitDiffs?: boolean; entities?: 'products' | 'signals' | 'all'; epoch?: number } = {}
  ): Promise<boolean> {
    const epoch = options.epoch ?? this.lifecycleEpoch;
    if (!this.isLifecycleCurrent(epoch)) return false;
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
      let productResult: BootstrapFeedResult<Product> | undefined;
      let signalResult: BootstrapFeedResult<Signal> | undefined;
      const entities = options.entities ?? 'all';
      const refreshProducts = entities !== 'signals';
      const refreshSignals = entities !== 'products' && this.signals.queryable;

      if (refreshProducts) {
        productResult = await this.bootstrapProducts(epoch);
        if (productResult.cancelled) return false;
      }
      if (refreshSignals) {
        signalResult = await this.bootstrapSignals(epoch);
        if (signalResult.cancelled) return false;
      }

      if (!this.isLifecycleCurrent(epoch)) return false;

      if (refreshProducts && productResult) {
        this.commitProductMetadata(productResult.metadata);
        if (!productResult.unchanged) {
          this.productIndex = productResult.items;
        }
      }
      if (refreshSignals && signalResult) {
        this.commitSignalMetadata(signalResult.metadata);
        if (!signalResult.unchanged) {
          this.signalIndex = signalResult.items;
        }
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
      return true;
    } catch (err) {
      if (!this.isLifecycleCurrent(epoch)) return false;
      this.setState('error');
      const error = err instanceof Error ? err : new Error(String(err));
      this.errorHandler?.(error);
      this.emit('error', { error });
      throw error;
    }
  }

  /** Returns `true` when the seller short-circuited with `unchanged: true`. */
  private async bootstrapProducts(epoch: number): Promise<BootstrapFeedResult<Product>> {
    let cursor: string | undefined;
    const into = new Map<string, Product>();
    let metadata = this.currentProductMetadata();
    do {
      const params: Record<string, unknown> = {
        buying_mode: 'wholesale',
        pagination: { max_results: DEFAULT_BOOTSTRAP_PAGE_LIMIT, ...(cursor && { cursor }) },
        ...(this.account && { account: this.account }),
      };
      // Conditional fetch on the page-0 call when we already have a cached
      // version. Per the spec, the seller short-circuits with
      // `unchanged: true` and no payload — caller keeps the previous index.
      if (!cursor && metadata.wholesaleFeedVersion && this._capabilities.wholesaleFeedVersioning) {
        params.if_wholesale_feed_version = metadata.wholesaleFeedVersion;
        if (metadata.pricingVersion) params.if_pricing_version = metadata.pricingVersion;
      }
      const result = (await this.client.getProducts(params as never)) as {
        data?: V31Beta.GetProductsResponse;
      };
      if (!this.isLifecycleCurrent(epoch)) return { cancelled: true, unchanged: false, items: into, metadata };
      const body = result.data;
      if (!body) return { cancelled: false, unchanged: false, items: into, metadata };
      if (body.unchanged) {
        // Echo any newer pricing_version / cache_scope the seller
        // returned alongside the unchanged signal, then tell the caller
        // to keep the existing index.
        metadata = mergeFeedMetadata(metadata, body);
        return { cancelled: false, unchanged: true, items: into, metadata };
      }
      const products = Array.isArray(body.products) ? body.products : [];
      for (const product of products) {
        const id = (product as { product_id?: string }).product_id;
        if (typeof id === 'string') into.set(id, product as Product);
      }
      metadata = mergeFeedMetadata(metadata, body);
      cursor = body.pagination?.has_more ? body.pagination?.cursor : undefined;
    } while (cursor);
    return { cancelled: false, unchanged: false, items: into, metadata };
  }

  private async bootstrapSignals(epoch: number): Promise<BootstrapFeedResult<Signal>> {
    let cursor: string | undefined;
    const into = new Map<string, Signal>();
    let metadata = this.currentSignalMetadata();
    do {
      const params: Record<string, unknown> = {
        discovery_mode: 'wholesale',
        pagination: { max_results: DEFAULT_BOOTSTRAP_PAGE_LIMIT, ...(cursor && { cursor }) },
        ...(this.account && { account: this.account }),
      };
      if (!cursor && metadata.wholesaleFeedVersion && this._capabilities.wholesaleFeedVersioning) {
        params.if_wholesale_feed_version = metadata.wholesaleFeedVersion;
        if (metadata.pricingVersion) params.if_pricing_version = metadata.pricingVersion;
      }
      const result = (await this.client.getSignals(params as never)) as {
        data?: V31Beta.GetSignalsResponse;
      };
      if (!this.isLifecycleCurrent(epoch)) return { cancelled: true, unchanged: false, items: into, metadata };
      const body = result.data;
      if (!body) return { cancelled: false, unchanged: false, items: into, metadata };
      if (body.unchanged) {
        metadata = mergeFeedMetadata(metadata, body);
        return { cancelled: false, unchanged: true, items: into, metadata };
      }
      const signals = Array.isArray(body.signals) ? body.signals : [];
      for (const signal of signals) {
        const id = (signal as { signal_agent_segment_id?: string }).signal_agent_segment_id;
        if (typeof id === 'string') into.set(id, signal as Signal);
      }
      metadata = mergeFeedMetadata(metadata, body);
      cursor = body.pagination?.has_more ? body.pagination?.cursor : undefined;
    } while (cursor);
    return { cancelled: false, unchanged: false, items: into, metadata };
  }

  private async recoverFromBulkChange(
    event: V31Beta.WholesaleFeedEvent,
    epoch = this.lifecycleEpoch
  ): Promise<boolean> {
    this.emit('resyncing', { reason: 'bulk_change' });
    const affected = this.bulkChangeAffectedEntityType(event);
    if (affected === 'signal' && !this.signals.queryable) {
      throw new Error(
        'WholesaleFeedSync: signal bulk_change cannot repair because the agent does not declare wholesale signal discovery.'
      );
    }
    const entities = affected === 'product' ? 'products' : 'signals';
    return this.bootstrap({ emitDiffs: true, entities, epoch });
  }

  private async recoverFromVersionMismatch(
    event: V31Beta.WholesaleFeedEvent,
    epoch = this.lifecycleEpoch
  ): Promise<boolean> {
    this.emit('resyncing', { reason: 'version_mismatch' });
    const feed = this.feedLabelForEvent(event);
    const beforeVersion = this.currentWholesaleFeedVersionForEvent(event);
    for (let attempt = 1; attempt <= VERSION_MISMATCH_RECOVERY_ATTEMPTS; attempt++) {
      const recovered = await this.bootstrap({ emitDiffs: true, epoch });
      if (!recovered) return false;
      const afterVersion = this.currentWholesaleFeedVersionForEvent(event);
      if (afterVersion !== beforeVersion) return true;
      if (attempt < VERSION_MISMATCH_RECOVERY_ATTEMPTS) {
        await sleep(VERSION_MISMATCH_RECOVERY_BACKOFF_MS * attempt);
        if (!this.isLifecycleCurrent(epoch)) return false;
      }
    }
    throw new Error(
      `WholesaleFeedSync: version mismatch recovery did not advance ${feed} wholesale_feed_version after ${VERSION_MISMATCH_RECOVERY_ATTEMPTS} attempts.`
    );
  }

  // ====== Private: auto-poll mode version probe ======

  private scheduleProbe(epoch = this.lifecycleEpoch): void {
    if (!this.isLifecycleCurrent(epoch)) return;
    this.probeTimer = setTimeout(() => this.probeLoop(epoch), this.probeIntervalMs);
  }

  private async probeLoop(epoch: number): Promise<void> {
    if (!this.isLifecycleCurrent(epoch)) return;
    try {
      await this.probeVersion(epoch);
    } catch (err) {
      if (!this.isLifecycleCurrent(epoch)) return;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      this.errorHandler?.(error);
    }
    if (this.isLifecycleCurrent(epoch) && this._state === 'syncing' && this._mode === 'auto-poll') {
      this.scheduleProbe(epoch);
    }
  }

  private async probeVersion(epoch: number): Promise<void> {
    await this.bootstrap({ emitDiffs: true, epoch });
  }

  // ====== Private: capability refresh ======

  private scheduleCapabilityRefresh(epoch = this.lifecycleEpoch): void {
    if (!this.isLifecycleCurrent(epoch)) return;
    this.capabilityTimer = setTimeout(() => this.capabilityRefreshLoop(epoch), this.capabilityRefreshIntervalMs);
  }

  private async capabilityRefreshLoop(epoch: number): Promise<void> {
    if (!this.isLifecycleCurrent(epoch)) return;
    try {
      const previousMode = this._mode;
      if (!(await this.resolveMode(epoch))) return;
      if (this._mode !== previousMode) {
        // Capability upgrade or downgrade — re-establish background sync.
        await this.startInner();
        return;
      }
    } catch (err) {
      if (!this.isLifecycleCurrent(epoch)) return;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      this.errorHandler?.(error);
    }
    if (this.isLifecycleCurrent(epoch) && this._state === 'syncing' && this.capabilityRefreshIntervalMs > 0) {
      this.scheduleCapabilityRefresh(epoch);
    }
  }

  // ====== Private: event application ======

  private currentWholesaleFeedVersionForEvent(event: V31Beta.WholesaleFeedEvent): string | undefined {
    if (event.event_type.startsWith('product.')) return this.productWholesaleFeedVersion;
    if (event.event_type.startsWith('signal.')) return this.signalWholesaleFeedVersion;
    const affected = this.bulkChangeAffectedEntityType(event);
    return affected === 'signal' ? this.signalWholesaleFeedVersion : this.productWholesaleFeedVersion;
  }

  private bulkChangeAffectedEntityType(event: V31Beta.WholesaleFeedEvent): 'product' | 'signal' {
    const affected = (event.payload as { affected_entity_type?: string }).affected_entity_type;
    if (affected === 'product' || affected === 'signal') return affected;
    throw new Error(
      'WholesaleFeedSync: wholesale_feed.bulk_change payload missing or invalid required affected_entity_type.'
    );
  }

  private feedLabelForEvent(event: V31Beta.WholesaleFeedEvent): 'product' | 'signal' {
    if (event.event_type.startsWith('product.')) return 'product';
    if (event.event_type.startsWith('signal.')) return 'signal';
    return this.bulkChangeAffectedEntityType(event);
  }

  private currentProductMetadata(): FeedMetadata {
    return {
      wholesaleFeedVersion: this.productWholesaleFeedVersion,
      pricingVersion: this.productPricingVersion,
      cacheScope: this.productCacheScope,
    };
  }

  private currentSignalMetadata(): FeedMetadata {
    return {
      wholesaleFeedVersion: this.signalWholesaleFeedVersion,
      pricingVersion: this.signalPricingVersion,
      cacheScope: this.signalCacheScope,
    };
  }

  private commitProductMetadata(metadata: FeedMetadata): void {
    this.productWholesaleFeedVersion = metadata.wholesaleFeedVersion;
    this.productPricingVersion = metadata.pricingVersion;
    this.productCacheScope = metadata.cacheScope;
  }

  private commitSignalMetadata(metadata: FeedMetadata): void {
    this.signalWholesaleFeedVersion = metadata.wholesaleFeedVersion;
    this.signalPricingVersion = metadata.pricingVersion;
    this.signalCacheScope = metadata.cacheScope;
  }

  private rememberWebhookVersion(webhook: V31Beta.WholesaleFeedWebhook): void {
    const event = webhook.event;
    if (event.event_type.startsWith('product.')) {
      this.productWholesaleFeedVersion = webhook.wholesale_feed_version;
      this.productCacheScope = webhook.cache_scope;
      return;
    }
    if (event.event_type.startsWith('signal.')) {
      this.signalWholesaleFeedVersion = webhook.wholesale_feed_version;
      this.signalCacheScope = webhook.cache_scope;
    }
  }

  private assertWebhookScope(webhook: V31Beta.WholesaleFeedWebhook): void {
    const expectedAccountId = this.expectedWebhookAccountId();
    if (expectedAccountId && webhook.account_id !== expectedAccountId) {
      throw new Error('WholesaleFeedSync: wholesale feed webhook account_id does not match this mirror.');
    }
    if (this.webhookScope?.subscriberId && webhook.subscriber_id !== this.webhookScope.subscriberId) {
      throw new Error('WholesaleFeedSync: wholesale feed webhook subscriber_id does not match this mirror.');
    }
  }

  private expectedWebhookAccountId(): string | undefined {
    if (this.webhookScope?.accountId) return this.webhookScope.accountId;
    return this.account && 'account_id' in this.account ? this.account.account_id : undefined;
  }

  private webhookDedupeKey(webhook: V31Beta.WholesaleFeedWebhook): string {
    return [
      this.webhookScope?.senderId ?? 'default',
      webhook.account_id,
      webhook.subscriber_id,
      webhook.idempotency_key,
    ].join(':');
  }

  private webhookEventDedupeKey(webhook: V31Beta.WholesaleFeedWebhook): string {
    return [
      this.webhookScope?.senderId ?? 'default',
      webhook.account_id,
      webhook.subscriber_id,
      webhook.event.event_id,
    ].join(':');
  }

  private async hasProcessedWebhook(dedupeKey: string, eventDedupeKey: string): Promise<boolean> {
    if (this.processedWebhookKeys.has(dedupeKey) || this.processedWebhookEventKeys.has(eventDedupeKey)) return true;
    if (!this.webhookDedupStore) return false;
    return (await this.webhookDedupStore.has(dedupeKey)) || (await this.webhookDedupStore.has(eventDedupeKey));
  }

  private async markWebhookProcessed(dedupeKey: string, eventDedupeKey: string): Promise<void> {
    this.processedWebhookKeys.add(dedupeKey);
    this.processedWebhookEventKeys.add(eventDedupeKey);
    await this.webhookDedupStore?.add(dedupeKey);
    await this.webhookDedupStore?.add(eventDedupeKey);
  }

  private rememberLastWebhookEventId(eventId: string): void {
    if (!isUuidV7(eventId)) return;
    if (!this.lastWebhookEventId || compareUuidV7(eventId, this.lastWebhookEventId) > 0) {
      this.lastWebhookEventId = eventId;
    }
  }

  private applyEvent(event: V31Beta.WholesaleFeedEvent): void {
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
          signal?: Signal;
        };
        if (typeof payload.signal_agent_segment_id !== 'string') return;
        if (payload.signal) {
          this.signalIndex.set(payload.signal_agent_segment_id, payload.signal);
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
      case 'wholesale_feed.bulk_change':
        // Bulk change events trigger re-bootstrap in applyWebhook before
        // reaching this method.
        return;
    }
  }

  private emitTypedEvent(event: V31Beta.WholesaleFeedEvent): void {
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
      case 'wholesale_feed.bulk_change':
        // Already emitted in applyWebhook before recovery.
        return;
    }
  }

  // ====== Private: diff emission (auto-poll / manual refresh) ======

  private emitDiffs(previousProducts: Map<string, Product>, previousSignals: Map<string, Signal>): void {
    const now = new Date().toISOString();
    const makeEvent = (
      event_type: V31Beta.WholesaleFeedEvent['event_type'],
      entity_type: V31Beta.WholesaleFeedEvent['entity_type'],
      entity_id: string,
      payload: object
    ): V31Beta.WholesaleFeedEvent =>
      ({
        // crypto.randomUUID() emits a v4 UUID, NOT v7. Synthetic events
        // are flagged via `synthetic: true` on the emit envelope so
        // adopters writing event_ids to a dedupe table know not to
        // treat the ID as seller-authored. Real webhook events carry the
        // agent's authoritative event_id.
        event_id: randomUUID(),
        event_type,
        entity_type,
        entity_id,
        created_at: now,
        payload,
      }) as V31Beta.WholesaleFeedEvent;
    const emit = (channel: keyof WholesaleFeedSyncEvents, event: V31Beta.WholesaleFeedEvent): void => {
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
            applies_to: { scope: this.productCacheScope },
          })
        );
      } else if (priceChanged(prev, product)) {
        emit(
          'product.priced',
          makeEvent('product.priced', 'product', id, {
            product_id: id,
            pricing_options: product.pricing_options ?? [],
            applies_to: { scope: this.productCacheScope },
          })
        );
      } else if (!isDeepStrictEqual(prev, product)) {
        emit(
          'product.updated',
          makeEvent('product.updated', 'product', id, {
            product_id: id,
            product,
            applies_to: { scope: this.productCacheScope },
          })
        );
      }
    }
    for (const [id] of previousProducts) {
      if (!this.productIndex.has(id)) {
        emit(
          'product.removed',
          makeEvent('product.removed', 'product', id, {
            product_id: id,
            applies_to: { scope: this.productCacheScope },
          })
        );
      }
    }
    for (const [id, signal] of this.signalIndex) {
      const prev = previousSignals.get(id);
      if (!prev) {
        emit(
          'signal.created',
          makeEvent('signal.created', 'signal', id, {
            signal_agent_segment_id: id,
            signal,
            applies_to: { scope: this.signalCacheScope },
          })
        );
      } else if (signalPriceChanged(prev, signal)) {
        emit(
          'signal.priced',
          makeEvent('signal.priced', 'signal', id, {
            signal_agent_segment_id: id,
            pricing_options: (signal as { pricing_options?: unknown[] }).pricing_options ?? [],
            applies_to: { scope: this.signalCacheScope },
          })
        );
      } else if (!isDeepStrictEqual(prev, signal)) {
        emit(
          'signal.updated',
          makeEvent('signal.updated', 'signal', id, {
            signal_agent_segment_id: id,
            signal,
            applies_to: { scope: this.signalCacheScope },
          })
        );
      }
    }
    for (const [id] of previousSignals) {
      if (!this.signalIndex.has(id)) {
        emit(
          'signal.removed',
          makeEvent('signal.removed', 'signal', id, {
            signal_agent_segment_id: id,
            applies_to: { scope: this.signalCacheScope },
          })
        );
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

  private setState(next: WholesaleFeedSyncState): void {
    const from = this._state;
    if (from === next) return;
    this._state = next;
    this.emit('stateChange', { from, to: next });
  }

  private isLifecycleCurrent(epoch: number): boolean {
    return epoch === this.lifecycleEpoch;
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

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function compareUuidV7(a: string, b: string): number {
  if (!isUuidV7(a) || !isUuidV7(b)) return 1;
  const normalizedA = a.toLowerCase();
  const normalizedB = b.toLowerCase();
  return normalizedA === normalizedB ? 0 : normalizedA > normalizedB ? 1 : -1;
}

function mergeFeedMetadata(
  current: FeedMetadata,
  body: {
    wholesale_feed_version?: unknown;
    pricing_version?: unknown;
    cache_scope?: unknown;
  }
): FeedMetadata {
  return {
    wholesaleFeedVersion:
      typeof body.wholesale_feed_version === 'string' ? body.wholesale_feed_version : current.wholesaleFeedVersion,
    pricingVersion: typeof body.pricing_version === 'string' ? body.pricing_version : current.pricingVersion,
    cacheScope: body.cache_scope === 'public' || body.cache_scope === 'account' ? body.cache_scope : current.cacheScope,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
