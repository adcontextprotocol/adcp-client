import type { AdcpErrorInfo } from '../core/ConversationTypes';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import type { AccountReference } from '../types';
import type {
  LegacyWholesaleFeedEvent,
  LegacyWholesaleFeedWebhook,
  LegacyWholesaleProduct,
  LegacyWholesaleSignal,
} from './protocol-types';
import type {
  WholesaleFeedSyncClient,
  WholesaleFeedSyncConfig,
  WholesaleFeedSyncEvents,
  WholesaleFeedSyncMode,
  WholesaleFeedSyncState,
  ProductFilter,
  ResolvedCapabilities,
  SignalFilter,
  WholesaleFeedSyncPersistedState,
} from './types';
import {
  refreshWholesaleFeed,
  InMemoryWholesaleFeedMirrorStore,
  applyWholesaleFeedEvent,
  diffWholesaleFeed,
} from './mirror';
import { assertLegacyWholesaleFeedRepresentation } from './webhook-notification';

type Product = LegacyWholesaleProduct;
type Signal = LegacyWholesaleSignal;
type FeedMetadata = {
  wholesaleFeedVersion: string | undefined;
  pricingVersion: string | undefined;
  cacheScope: 'public' | 'account';
};
type BootstrapFeedResult<T> = {
  failure?: { error: Error; adcpError?: AdcpErrorInfo };
  cancelled: boolean;
  unchanged: boolean;
  items: Map<string, T>;
  metadata: FeedMetadata;
};
const bootstrapReadFailures = new WeakSet<Error>();
function supersededRepairError(): Error {
  const error = new Error('WholesaleFeedSync: repair superseded repeatedly; retry webhook delivery.');
  bootstrapReadFailures.add(error);
  return error;
}

const DEFAULT_PROBE_INTERVAL_MS = 600_000;
const DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS = 86_400_000;
const DEFAULT_PERSISTENCE_TIMEOUT_MS = 30_000;
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
 * const client = new AdCPClient({ agentUrl });
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
  private readonly account: AccountReference | undefined;
  private readonly webhookScope: NonNullable<WholesaleFeedSyncConfig['webhookScope']> | undefined;
  private readonly webhookDedupStore: WholesaleFeedSyncConfig['webhookDedupStore'] | undefined;
  private readonly persistenceHooks: WholesaleFeedSyncConfig['persistenceHooks'] | undefined;
  private readonly persistenceTimeoutMs: number;
  private readonly probeIntervalMs: number;
  private readonly capabilityRefreshIntervalMs: number;
  private readonly errorHandler: ((error: Error) => void) | undefined;
  private startPromise: Promise<void> | null = null;
  private startPromiseEpoch: number | null = null;
  private signalsQueryableWarned = false;
  private readonly processedWebhookKeys = new Set<string>();
  private readonly processedWebhookEventKeys = new Set<string>();
  private lastWebhookEventId: string | undefined;
  private persistenceLoaded = false;
  private persistenceWriteTail: Promise<void> = Promise.resolve();

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
  private mirrorRevision = 0;

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
    this.persistenceHooks = config.persistenceHooks;
    this.persistenceTimeoutMs = config.persistenceTimeoutMs ?? DEFAULT_PERSISTENCE_TIMEOUT_MS;
    if (!Number.isFinite(this.persistenceTimeoutMs) || this.persistenceTimeoutMs <= 0) {
      throw new Error('WholesaleFeedSync: persistenceTimeoutMs must be a finite positive number.');
    }
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
    if (!(await this.restorePersistedState(epoch))) return;
    if (!(await this.resolveMode(epoch))) return;
    try {
      await this.bootstrapWithRetries({ epoch });
    } finally {
      if (this.isLifecycleCurrent(epoch)) {
        if (this._mode === 'auto-poll') this.scheduleProbe(epoch);
        if (this.capabilityRefreshIntervalMs > 0) this.scheduleCapabilityRefresh(epoch);
      }
    }
  }

  /** Stop all background activity. Preserves in-memory state and version tokens. */
  stop(): void {
    this.lifecycleEpoch++;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.capabilityTimer) clearTimeout(this.capabilityTimer);
    this.probeTimer = null;
    this.capabilityTimer = null;
    if (this._state === 'syncing' || this._state === 'bootstrapping' || this._state === 'degraded')
      this.setState('idle');
  }

  /**
   * Stop, clear all indexes and version tokens. Call `start()` again to
   * re-bootstrap from scratch.
   */
  async reset(): Promise<void> {
    this.stop();
    ++this.mirrorRevision;
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
    this.lastWebhookEventId = undefined;
    this.processedWebhookKeys.clear();
    this.processedWebhookEventKeys.clear();
    this.persistenceLoaded = true;
    this.setState('idle');
    await this.persistState();
  }

  /**
   * Force a manual re-bootstrap. Available in all modes. Fires diff events
   * for changes detected between the current replica and the freshly
   * fetched wholesale feed.
   */
  async refresh(): Promise<void> {
    const epoch = this.lifecycleEpoch;
    this.emit('resyncing', { reason: 'manual' });
    await this.bootstrapWithRetries({ emitDiffs: true, epoch, propagateFailure: true });
  }

  /**
   * Apply one legacy-view account-level wholesale feed webhook to the local mirror.
   * Call this from your HTTP webhook receiver after signature/auth validation.
   * Stale or out-of-order deliveries repair through conditional wholesale
   * reads instead of applying a suspect delta.
   */
  async applyWebhook(webhook: LegacyWholesaleFeedWebhook): Promise<void> {
    // JavaScript callers may cross this boundary with decoded `unknown`.
    // Validate before dedupe/version state changes so canonical list_products
    // payloads cannot be acknowledged by this legacy get_products mirror.
    assertLegacyWholesaleFeedRepresentation(webhook as unknown as Record<string, unknown>);
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
    if (!this._lastSyncedAt && event.event_type !== 'wholesale_feed.bulk_change') {
      if (!(await this.recoverFromVersionMismatch(event, epoch))) return;
      await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
      return;
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
        if (!(err instanceof Error && bootstrapReadFailures.has(err))) {
          await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
          this.rememberLastWebhookEventId(event.event_id);
        }
        throw err;
      }
      await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
      this.rememberLastWebhookEventId(event.event_id);
      await this.persistState();
      return;
    }

    this.applyEvent(event);
    this.rememberWebhookVersion(webhook);
    this.rememberLastWebhookEventId(event.event_id);
    this._lastEventAt = new Date();
    this._lastSyncedAt = new Date();
    await this.persistState();
    this.emit('event', { event });
    this.emitTypedEvent(event);
    await this.markWebhookProcessed(dedupeKey, eventDedupeKey);
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

  private async bootstrapWithRetries(options: {
    epoch: number;
    emitDiffs?: boolean;
    propagateFailure?: boolean;
  }): Promise<void> {
    for (let attempt = 0; attempt < VERSION_MISMATCH_RECOVERY_ATTEMPTS; attempt++) {
      const revision = this.mirrorRevision;
      if (await this.bootstrap({ ...options, conditional: attempt === 0 ? undefined : false })) return;
      if (!this.isLifecycleCurrent(options.epoch) || revision === this.mirrorRevision) return;
    }
    const error = new Error('WholesaleFeedSync: refresh superseded repeatedly; retry start or refresh.');
    this.handleBootstrapFailure({ error });
    throw error;
  }

  private async bootstrap(
    options: {
      emitDiffs?: boolean;
      entities?: 'products' | 'signals' | 'all';
      epoch?: number;
      propagateFailure?: boolean;
      conditional?: boolean;
    } = {}
  ): Promise<boolean> {
    const epoch = options.epoch ?? this.lifecycleEpoch;
    if (!this.isLifecycleCurrent(epoch)) return false;
    this.setState('bootstrapping');
    const previousLastSyncedAt = this._lastSyncedAt;
    const expectedRevision = this.mirrorRevision;
    let reportedFailure: Error | undefined;
    let committed = false;
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
      const previousProductMetadata = this.currentProductMetadata();
      const previousSignalMetadata = this.currentSignalMetadata();
      let productResult: BootstrapFeedResult<Product> | undefined;
      let signalResult: BootstrapFeedResult<Signal> | undefined;
      const entities = options.entities ?? 'all';
      const refreshProducts = entities !== 'signals';
      const refreshSignals = entities !== 'products' && this.signals.queryable;

      if (refreshProducts) {
        productResult = await this.bootstrapProducts(epoch, options.conditional);
        if (productResult.cancelled) return false;
        if (this.mirrorRevision !== expectedRevision) {
          this.setState(this._lastSyncedAt ? 'syncing' : 'idle');
          return false;
        }
        if (productResult.failure) {
          const failure = productResult.failure;
          reportedFailure = failure.error;
          this.handleBootstrapFailure(failure);
          if (options.propagateFailure) {
            bootstrapReadFailures.add(failure.error);
            if (failure.adcpError) Object.assign(failure.error, { adcpError: failure.adcpError });
            throw failure.error;
          }
          return false;
        }
      }
      if (refreshSignals) {
        signalResult = await this.bootstrapSignals(epoch, options.conditional);
        if (signalResult.cancelled) return false;
        if (this.mirrorRevision !== expectedRevision) {
          this.setState(this._lastSyncedAt ? 'syncing' : 'idle');
          return false;
        }
        if (signalResult.failure) {
          const failure = signalResult.failure;
          reportedFailure = failure.error;
          this.handleBootstrapFailure(failure);
          if (options.propagateFailure) {
            bootstrapReadFailures.add(failure.error);
            if (failure.adcpError) Object.assign(failure.error, { adcpError: failure.adcpError });
            throw failure.error;
          }
          return false;
        }
      }

      if (!this.isLifecycleCurrent(epoch)) return false;

      if (this.mirrorRevision !== expectedRevision) {
        this.setState(this._lastSyncedAt ? 'syncing' : 'idle');
        return false;
      }
      ++this.mirrorRevision;
      committed = true;
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

      this._lastSyncedAt = new Date();
      const productStateChanged =
        productResult !== undefined &&
        (!productResult.unchanged || !isDeepStrictEqual(previousProductMetadata, productResult.metadata));
      const signalStateChanged =
        signalResult !== undefined &&
        (!signalResult.unchanged || !isDeepStrictEqual(previousSignalMetadata, signalResult.metadata));
      if (productStateChanged || signalStateChanged) {
        await this.persistState();
        if (!this.isLifecycleCurrent(epoch)) return false;
      }

      if (options.emitDiffs) {
        this.emitDiffs(previousProducts, previousSignals);
      }

      this.setState('syncing');
      this.emit('bootstrap', {
        productCount: this.productIndex.size,
        signalCount: this.signalIndex.size,
        mode: this._mode,
      });
      return true;
    } catch (err) {
      if (!this.isLifecycleCurrent(epoch)) return false;
      if (!committed && this.mirrorRevision !== expectedRevision && err !== reportedFailure) return false;
      if (err === reportedFailure) throw err; // Already reported with its structured failure.
      this._lastSyncedAt = previousLastSyncedAt;
      this.setState(this._lastSyncedAt ? 'degraded' : 'error');
      const error = err instanceof Error ? err : new Error(String(err));
      this.errorHandler?.(error);
      if (this.listenerCount('error') > 0) this.emit('error', { error });
      if (options.propagateFailure) bootstrapReadFailures.add(error);
      throw error;
    }
  }

  private handleBootstrapFailure(failure: { error: Error; adcpError?: AdcpErrorInfo }): false {
    this.setState(this._lastSyncedAt ? 'degraded' : 'error');
    this.errorHandler?.(failure.error);
    // TaskResult failures are non-exceptional even when no error listener is installed.
    if (this.listenerCount('error') > 0) this.emit('error', failure);
    return false;
  }

  private bootstrapProducts(epoch: number, conditional?: boolean): Promise<BootstrapFeedResult<Product>> {
    return this.bootstrapFeed('product', epoch, conditional) as Promise<BootstrapFeedResult<Product>>;
  }
  private bootstrapSignals(epoch: number, conditional?: boolean): Promise<BootstrapFeedResult<Signal>> {
    return this.bootstrapFeed('signal', epoch, conditional) as Promise<BootstrapFeedResult<Signal>>;
  }
  private async bootstrapFeed(
    entity: 'product' | 'signal',
    epoch: number,
    conditional?: boolean
  ): Promise<BootstrapFeedResult<Product | Signal>> {
    // Stage each entity in memory. The shell swaps both only after all reads succeed.
    const store = new InMemoryWholesaleFeedMirrorStore();
    const scope = { agentUrl: 'shell', accountKey: 'shell', entity };
    const metadata = entity === 'product' ? this.currentProductMetadata() : this.currentSignalMetadata();
    const previous = entity === 'product' ? [...this.productIndex.values()] : [...this.signalIndex.values()];
    store.restore(scope, { revision: 0, items: previous, ...metadata });
    const outcome = await refreshWholesaleFeed({
      client: this.client,
      store,
      scope,
      account: this.account,
      conditional: conditional ?? this._capabilities.wholesaleFeedVersioning,
      isCurrent: () => this.isLifecycleCurrent(epoch),
    });
    if (outcome.outcome === 'superseded') return { cancelled: true, unchanged: false, items: new Map(), metadata };
    if (outcome.outcome === 'degraded')
      return {
        cancelled: false,
        unchanged: false,
        items: new Map(),
        metadata,
        failure: { error: outcome.cause, adcpError: outcome.error },
      };
    const snapshot = outcome.snapshot;
    return {
      cancelled: false,
      unchanged: outcome.outcome === 'unchanged',
      items: new Map(
        snapshot.items.map(item => [
          entity === 'product' ? (item as Product).product_id : (item as Signal).signal_agent_segment_id,
          item,
        ])
      ),
      metadata: {
        wholesaleFeedVersion: snapshot.wholesaleFeedVersion,
        pricingVersion: snapshot.pricingVersion,
        cacheScope: snapshot.cacheScope,
      },
    };
  }

  private async recoverFromBulkChange(event: LegacyWholesaleFeedEvent, epoch = this.lifecycleEpoch): Promise<boolean> {
    this.emit('resyncing', { reason: 'bulk_change' });
    const affected = this.bulkChangeAffectedEntityType(event);
    if (affected === 'signal' && !this.signals.queryable) {
      throw new Error(
        'WholesaleFeedSync: signal bulk_change cannot repair because the agent does not declare wholesale signal discovery.'
      );
    }
    const entities = affected === 'product' ? 'products' : 'signals';
    for (let attempt = 0; attempt < VERSION_MISMATCH_RECOVERY_ATTEMPTS; attempt++) {
      if (await this.bootstrap({ emitDiffs: true, entities, epoch, propagateFailure: true })) return true;
      if (!this.isLifecycleCurrent(epoch)) return false;
    }
    throw supersededRepairError();
  }

  private async recoverFromVersionMismatch(
    event: LegacyWholesaleFeedEvent,
    epoch = this.lifecycleEpoch
  ): Promise<boolean> {
    this.emit('resyncing', { reason: 'version_mismatch' });
    const beforeVersion = this.currentWholesaleFeedVersionForEvent(event);
    for (let attempt = 1; attempt <= VERSION_MISMATCH_RECOVERY_ATTEMPTS; attempt++) {
      const recovered = await this.bootstrap({ emitDiffs: true, epoch, propagateFailure: true });
      if (!recovered) {
        if (!this.isLifecycleCurrent(epoch)) return false;
        if (attempt === VERSION_MISMATCH_RECOVERY_ATTEMPTS) throw supersededRepairError();
        continue;
      }
      const afterVersion = this.currentWholesaleFeedVersionForEvent(event);
      if (afterVersion !== beforeVersion) return true;
      if (attempt < VERSION_MISMATCH_RECOVERY_ATTEMPTS) {
        await sleep(VERSION_MISMATCH_RECOVERY_BACKOFF_MS * attempt);
        if (!this.isLifecycleCurrent(epoch)) return false;
      }
    }
    // At-least-once delivery can replay stale webhooks after the mirror has
    // already caught up. If bounded conditional reads do not advance the
    // opaque version token, acknowledge the delivery instead of poisoning
    // the seller's retry queue.
    return true;
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
      // bootstrap already publishes failures; avoid duplicate events for thrown failures.
      if (this._state !== 'degraded' && this._state !== 'error') {
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleBootstrapFailure({ error });
      }
    }
    if (
      this.isLifecycleCurrent(epoch) &&
      (this._state === 'syncing' || this._state === 'degraded' || this._state === 'error') &&
      this._mode === 'auto-poll'
    ) {
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
    if (
      this.isLifecycleCurrent(epoch) &&
      (this._state === 'syncing' || this._state === 'degraded' || this._state === 'error') &&
      this.capabilityRefreshIntervalMs > 0
    ) {
      this.scheduleCapabilityRefresh(epoch);
    }
  }

  // ====== Private: event application ======

  private currentWholesaleFeedVersionForEvent(event: LegacyWholesaleFeedEvent): string | undefined {
    if (event.event_type.startsWith('product.')) return this.productWholesaleFeedVersion;
    if (event.event_type.startsWith('signal.')) return this.signalWholesaleFeedVersion;
    const affected = this.bulkChangeAffectedEntityType(event);
    return affected === 'signal' ? this.signalWholesaleFeedVersion : this.productWholesaleFeedVersion;
  }

  private bulkChangeAffectedEntityType(event: LegacyWholesaleFeedEvent): 'product' | 'signal' {
    const affected = (event.payload as { affected_entity_type?: string }).affected_entity_type;
    if (affected === 'product' || affected === 'signal') return affected;
    throw new Error(
      'WholesaleFeedSync: wholesale_feed.bulk_change payload missing or invalid required affected_entity_type.'
    );
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

  private rememberWebhookVersion(webhook: LegacyWholesaleFeedWebhook): void {
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

  private assertWebhookScope(webhook: LegacyWholesaleFeedWebhook): void {
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

  private webhookDedupeKey(webhook: LegacyWholesaleFeedWebhook): string {
    return [
      this.webhookScope?.senderId ?? 'default',
      webhook.account_id,
      webhook.subscriber_id,
      webhook.idempotency_key,
    ].join(':');
  }

  private webhookEventDedupeKey(webhook: LegacyWholesaleFeedWebhook): string {
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

  private applyEvent(event: LegacyWholesaleFeedEvent): void {
    ++this.mirrorRevision;
    const entity = event.event_type.startsWith('product.') ? 'product' : 'signal';
    const items = applyWholesaleFeedEvent(
      entity,
      entity === 'product' ? [...this.productIndex.values()] : [...this.signalIndex.values()],
      event
    );
    if (!items) return;
    if (entity === 'product') this.productIndex = new Map((items as Product[]).map(item => [item.product_id, item]));
    else this.signalIndex = new Map((items as Signal[]).map(item => [item.signal_agent_segment_id, item]));
  }

  private emitTypedEvent(event: LegacyWholesaleFeedEvent): void {
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
    const events = [
      ...diffWholesaleFeed(
        'product',
        [...previousProducts.values()],
        [...this.productIndex.values()],
        this.productCacheScope
      ),
      ...diffWholesaleFeed(
        'signal',
        [...previousSignals.values()],
        [...this.signalIndex.values()],
        this.signalCacheScope
      ),
    ];
    for (const event of events) {
      this.emit('event', { event, synthetic: true });
      this.emit(event.event_type as 'product.created', { event, synthetic: true });
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

  // ====== Private: persistence ======

  private async restorePersistedState(epoch: number): Promise<boolean> {
    if (this.persistenceLoaded || !this.persistenceHooks) return true;

    const loaded = await withTimeout(this.persistenceHooks.loadState(), this.persistenceTimeoutMs, 'loadState');
    if (!this.isLifecycleCurrent(epoch)) return false;
    if (loaded) {
      const state = normalizePersistedState(loaded);
      this.productIndex = new Map(state.products.items.map(product => [product.product_id, product]));
      this.signalIndex = new Map(state.signals.items.map(signal => [signal.signal_agent_segment_id, signal]));
      this.commitProductMetadata({
        wholesaleFeedVersion: state.products.wholesaleFeedVersion,
        pricingVersion: state.products.pricingVersion,
        cacheScope: state.products.cacheScope,
      });
      this.commitSignalMetadata({
        wholesaleFeedVersion: state.signals.wholesaleFeedVersion,
        pricingVersion: state.signals.pricingVersion,
        cacheScope: state.signals.cacheScope,
      });
      this._lastSyncedAt = parsePersistedDate(state.lastSyncedAt);
      this._lastEventAt = parsePersistedDate(state.lastEventAt);
      this.lastWebhookEventId = state.lastWebhookEventId;
    }
    this.persistenceLoaded = true;
    return true;
  }

  private persistedState(): WholesaleFeedSyncPersistedState {
    return structuredClone({
      version: 1,
      products: {
        items: [...this.productIndex.values()],
        ...(this.productWholesaleFeedVersion && {
          wholesaleFeedVersion: this.productWholesaleFeedVersion,
        }),
        ...(this.productPricingVersion && { pricingVersion: this.productPricingVersion }),
        cacheScope: this.productCacheScope,
      },
      signals: {
        items: [...this.signalIndex.values()],
        ...(this.signalWholesaleFeedVersion && {
          wholesaleFeedVersion: this.signalWholesaleFeedVersion,
        }),
        ...(this.signalPricingVersion && { pricingVersion: this.signalPricingVersion }),
        cacheScope: this.signalCacheScope,
      },
      ...(this._lastSyncedAt && { lastSyncedAt: this._lastSyncedAt.toISOString() }),
      ...(this._lastEventAt && { lastEventAt: this._lastEventAt.toISOString() }),
      ...(this.lastWebhookEventId && { lastWebhookEventId: this.lastWebhookEventId }),
    } satisfies WholesaleFeedSyncPersistedState);
  }

  private async persistState(): Promise<void> {
    if (!this.persistenceHooks) return;
    const snapshot = this.persistedState();
    const write = this.persistenceWriteTail.then(() => this.persistenceHooks!.saveState(snapshot));
    this.persistenceWriteTail = write.catch(() => undefined);
    await withTimeout(write, this.persistenceTimeoutMs, 'saveState');
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

function normalizePersistedState(value: unknown): WholesaleFeedSyncPersistedState {
  const invalid = (message: string): never => {
    throw new Error(`WholesaleFeedSync: invalid persisted state: ${message}`);
  };
  if (!isRecord(value)) return invalid('expected an object.');
  if (value.version !== 1) return invalid(`unsupported version ${String(value.version)}.`);
  if (!isRecord(value.products) || !Array.isArray(value.products.items)) {
    return invalid('products.items must be an array.');
  }
  if (!isRecord(value.signals) || !Array.isArray(value.signals.items)) {
    return invalid('signals.items must be an array.');
  }
  assertCacheScope(value.products.cacheScope, 'products.cacheScope', invalid);
  assertCacheScope(value.signals.cacheScope, 'signals.cacheScope', invalid);
  assertOptionalString(value.products.wholesaleFeedVersion, 'products.wholesaleFeedVersion', invalid);
  assertOptionalString(value.products.pricingVersion, 'products.pricingVersion', invalid);
  assertOptionalString(value.signals.wholesaleFeedVersion, 'signals.wholesaleFeedVersion', invalid);
  assertOptionalString(value.signals.pricingVersion, 'signals.pricingVersion', invalid);
  assertOptionalDate(value.lastSyncedAt, 'lastSyncedAt', invalid);
  assertOptionalDate(value.lastEventAt, 'lastEventAt', invalid);
  assertOptionalString(value.lastWebhookEventId, 'lastWebhookEventId', invalid);
  if (value.lastWebhookEventId !== undefined && !isUuidV7(value.lastWebhookEventId as string)) {
    return invalid('lastWebhookEventId must be a UUIDv7.');
  }

  const productIds = new Set<string>();
  for (const product of value.products.items) {
    if (!isRecord(product) || typeof product.product_id !== 'string' || product.product_id.length === 0) {
      return invalid('each product must have a non-empty product_id.');
    }
    if (productIds.has(product.product_id)) return invalid(`duplicate product_id ${product.product_id}.`);
    productIds.add(product.product_id);
  }
  const signalIds = new Set<string>();
  for (const signal of value.signals.items) {
    if (
      !isRecord(signal) ||
      typeof signal.signal_agent_segment_id !== 'string' ||
      signal.signal_agent_segment_id.length === 0
    ) {
      return invalid('each signal must have a non-empty signal_agent_segment_id.');
    }
    if (signalIds.has(signal.signal_agent_segment_id)) {
      return invalid(`duplicate signal_agent_segment_id ${signal.signal_agent_segment_id}.`);
    }
    signalIds.add(signal.signal_agent_segment_id);
  }

  return structuredClone(value) as unknown as WholesaleFeedSyncPersistedState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCacheScope(
  value: unknown,
  field: string,
  invalid: (message: string) => never
): asserts value is 'public' | 'account' {
  if (value !== 'public' && value !== 'account') invalid(`${field} must be "public" or "account".`);
}

function assertOptionalString(
  value: unknown,
  field: string,
  invalid: (message: string) => never
): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') invalid(`${field} must be a string when present.`);
}

function assertOptionalDate(
  value: unknown,
  field: string,
  invalid: (message: string) => never
): asserts value is string | undefined {
  assertOptionalString(value, field, invalid);
  if (value !== undefined && Number.isNaN(Date.parse(value))) invalid(`${field} must be a valid ISO-8601 timestamp.`);
}

function parsePersistedDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
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

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, hookName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`WholesaleFeedSync: persistence ${hookName} timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
