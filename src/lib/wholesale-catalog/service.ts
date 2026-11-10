/**
 * The seller wholesale catalogue service.
 *
 * A seller writes `readCatalog(scope)`. The service answers `list_products` and wholesale `get_products`
 * from one stored snapshot per scope, pages it, versions it, answers a conditional read with `unchanged`,
 * and, when the seller calls `update(scope)` (or the reconcile timer does), sends the `product.*` and
 * `wholesale_feed.bulk_change` events that tell subscribed buyers what changed. It is built like
 * `createReliableReportingService`: an adapter, a storage interface with an in-memory store, `install`,
 * and `start`/`stop`.
 *
 * @packageDocumentation
 */
import { isDeepStrictEqual } from 'node:util';
import { AdcpError } from '../server/decisioning/async-outcome';
import { PlatformConfigError } from '../server/decisioning/runtime/validate-platform';
import type { DecisioningPlatform } from '../server/decisioning/platform';
import type { RequestContext } from '../server/decisioning/context';
import type { Account } from '../server/decisioning/account';
import type { NotificationFanoutResult } from '../server/notification-subscriptions';
import { canonicalJsonSha256 } from '../utils/jcs';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  assertCatalogProducts,
  bulkChangeEvent,
  catalogVersion,
  decodeCursor,
  diffCatalogs,
  encodeCursor,
  legacyRepresentable,
  uuidV7,
  wireEvent,
  type ProductPayloadView,
} from './catalog';
import { catalogScopeKey, memoryCatalogSnapshotStore } from './memory-store';
import type {
  CatalogChangeV1,
  CatalogEventV1,
  CatalogProduct,
  CatalogScope,
  CatalogSnapshotStoreV1,
  CatalogSnapshotV1,
  CreateWholesaleCatalogServiceOptionsV1,
  WholesaleCatalogSchedulerOptionsV1,
  WholesaleCatalogServiceV1,
  WholesaleCatalogUpdateResultV1,
} from './types';

const PUBLIC: CatalogScope = Object.freeze({ cacheScope: 'public' }) as CatalogScope;
const EVENT_TYPES = [
  'product.created',
  'product.updated',
  'product.priced',
  'product.removed',
  'wholesale_feed.bulk_change',
] as const;
/** `get_products` request fields that narrow which products come back. */
const GET_PRODUCTS_SELECTORS = [
  'filters',
  'targeting_overlay',
  'media_buy_frequency_cap',
  'required_overlay_support',
  'required_media_buy_support',
  'property_list',
  'catalog',
  'required_policies',
  'preferred_delivery_types',
] as const;
const CAS_ATTEMPTS = 8;

type Task = 'list_products' | 'get_products';
type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;
type Loose = Record<string, unknown>;
/** A snapshot that holds products, and so a version. */
type ServedSnapshot = CatalogSnapshotV1 & { products: readonly CatalogProduct[]; version: string };

export function createWholesaleCatalogService<TCtxMeta = Record<string, unknown>>(
  options: CreateWholesaleCatalogServiceOptionsV1<TCtxMeta>
): WholesaleCatalogServiceV1<TCtxMeta> {
  const { adapter, notifications } = options;
  if (typeof adapter?.readCatalog !== 'function') {
    throw new PlatformConfigError('createWholesaleCatalogService needs adapter.readCatalog(scope).', {
      configField: 'adapter.readCatalog',
    });
  }
  const store = options.snapshots ?? defaultStore();
  const developmentEnvironment = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (store.durability !== 'durable' && !developmentEnvironment) {
    throw new PlatformConfigError(
      'The wholesale catalogue keeps its snapshots in process memory, which neither survives a restart nor is shared by ' +
        'your instances, so each instance would send its own copy of every change. Pass snapshots: a durable ' +
        'CatalogSnapshotStoreV1, or set NODE_ENV=development to run in memory.',
      { code: 'WHOLESALE_CATALOG_STORAGE_NOT_DURABLE', configField: 'snapshots' }
    );
  }
  const overlays = options.accountOverlays === true;
  const fraction = options.bulkChange?.fraction ?? 0.05;
  const maxProducts = options.bulkChange?.maxProducts ?? 100;
  if (!(fraction > 0 && fraction <= 1) || !Number.isSafeInteger(maxProducts) || maxProducts < 1) {
    throw new PlatformConfigError(
      'bulkChange.fraction must be in (0, 1] and bulkChange.maxProducts a positive integer.',
      {
        configField: 'bulkChange',
      }
    );
  }
  const now = options.now ?? (() => new Date());

  const capabilities: WholesaleCatalogServiceV1<TCtxMeta>['capabilities'] = {
    wholesale_feed_versioning: { supported: true, pricing_version_separate: false, cache_scope_account: overlays },
    ...(notifications && { wholesale_feed_webhooks: { supported: true, event_types: [...EVENT_TYPES] } }),
  };

  // -- locking and error reporting ---------------------------------------------------------------------

  const locks = new Map<string, Promise<unknown>>();
  /** Run `work` after every earlier piece of work under `key` in this process has finished. */
  function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  async function report(error: unknown): Promise<void> {
    try {
      await options.onError?.(error);
    } catch {
      // A failing error hook must not take the scheduler down with it.
    }
  }

  // -- snapshots ---------------------------------------------------------------------------------------

  async function readSource(scope: CatalogScope): Promise<readonly CatalogProduct[] | null> {
    if (scope.cacheScope === 'account' && !overlays) {
      throw new TypeError(
        'This service was created without accountOverlays, so an account has no catalogue of its own to update. ' +
          'Pass accountOverlays: true, or update({ cacheScope: "public" }).'
      );
    }
    const products = await adapter.readCatalog(structuredClone(scope));
    if (products === null && scope.cacheScope === 'public') {
      throw new TypeError('readCatalog may return null only for an account scope; the public catalogue is a list.');
    }
    if (products !== null) assertCatalogProducts(products, scope);
    return products;
  }

  /** The ids of the accounts a change to the public catalogue is owed to. */
  async function knownAccountIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const scope of await store.list()) if (scope.cacheScope === 'account') ids.add(scope.accountId);
    for (const id of (await adapter.listAccountIds?.()) ?? []) ids.add(id);
    return [...ids];
  }

  async function tenantFor(accountId: string): Promise<string> {
    const tenantId = notifications!.tenantId;
    return typeof tenantId === 'string' ? tenantId : tenantId(accountId);
  }

  /** What the move from `previous` to `next` is, as events: none when a receiver would learn nothing. */
  async function buildChange(
    scope: CatalogScope,
    previous: CatalogSnapshotV1,
    next: readonly CatalogProduct[] | null,
    version: string | undefined,
    at: Date
  ): Promise<CatalogChangeV1 | undefined> {
    let events: CatalogEventV1[];
    let toVersion: string;
    if (previous.products !== null && next !== null && version !== undefined) {
      toVersion = version;
      events = diffCatalogs(scope, previous.products, next, previous.version!, version, {
        fraction,
        maxProducts,
        now: at,
      });
    } else if (previous.products === null && next !== null && version !== undefined) {
      toVersion = version;
      events = [bulkChangeEvent(scope, undefined, version, 'The account now has its own catalogue', next.length, at)];
    } else if (previous.products !== null && next === null) {
      // The account follows the public catalogue again. Its receivers re-read and see `cache_scope: public`.
      toVersion = (await store.get(PUBLIC))?.version ?? previous.version!;
      events = [
        bulkChangeEvent(
          scope,
          previous.version,
          toVersion,
          'The account now follows the public catalogue',
          previous.products.length,
          at
        ),
      ];
    } else {
      return undefined;
    }
    if (events.length === 0) return undefined;
    const legacyResync = events.every(legacyRepresentable)
      ? undefined
      : bulkChangeEvent(scope, previous.version, toVersion, 'Products changed', events.length, at);
    return {
      changeId: uuidV7(at.getTime()),
      ...(previous.version !== undefined && { fromVersion: previous.version }),
      toVersion,
      events,
      ...(legacyResync && { legacyResync }),
      accountIds: scope.cacheScope === 'account' ? [scope.accountId] : await knownAccountIds(),
    };
  }

  /**
   * Store what the source holds now. The first read of a scope is a baseline and tells nobody anything;
   * after that, a change is stored together with the events it owes, in one compare-and-set, so a crash
   * between "stored" and "told" loses nothing.
   */
  async function commit(
    scope: CatalogScope,
    next: readonly CatalogProduct[] | null
  ): Promise<WholesaleCatalogUpdateResultV1> {
    const version = next === null ? undefined : catalogVersion(scope, next);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const previous = await store.get(scope);
      if (previous && previous.version === version && isDeepStrictEqual(previous.products, next)) {
        return { scope, changed: false, version: version ?? null, previousVersion: version ?? null, events: 0 };
      }
      const at = now();
      const change =
        previous && notifications && previous.version !== version
          ? await buildChange(scope, previous, next, version, at)
          : undefined;
      const snapshot: CatalogSnapshotV1 = {
        scope: structuredClone(scope),
        revision: (previous?.revision ?? 0) + 1,
        products: next,
        ...(version !== undefined && { version }),
        updatedAt: at.toISOString(),
        pending: [...(previous?.pending ?? []), ...(change ? [change] : [])],
      };
      if (!(await store.put(snapshot, previous?.revision))) continue;
      return {
        scope,
        changed: previous !== undefined && previous.version !== version,
        version: version ?? null,
        previousVersion: previous?.version ?? null,
        events: change?.events.length ?? 0,
      };
    }
    throw new Error(`The snapshot of ${catalogScopeKey(scope)} kept changing under this writer; try again.`);
  }

  async function update(scope: CatalogScope, cascade: boolean): Promise<WholesaleCatalogUpdateResultV1> {
    assertScope(scope);
    const result = await exclusive(`update:${catalogScopeKey(scope)}`, async () =>
      commit(scope, await readSource(scope))
    );
    await flush(scope);
    if (cascade && scope.cacheScope === 'public' && result.changed && overlays) {
      // An account price can be derived from the public one, so a public change may move account catalogues.
      for (const known of await store.list()) {
        if (known.cacheScope !== 'account') continue;
        const snapshot = await store.get(known);
        if (snapshot?.products !== null) await update(known, false);
      }
    }
    return result;
  }

  /** The snapshot of `scope`, read from the source the first time. */
  async function ensure(scope: CatalogScope): Promise<CatalogSnapshotV1> {
    const stored = await store.get(scope);
    if (stored) return stored;
    await exclusive(`update:${catalogScopeKey(scope)}`, async () => {
      if (!(await store.get(scope))) await commit(scope, await readSource(scope));
    });
    const created = await store.get(scope);
    if (!created) throw new Error(`The snapshot of ${catalogScopeKey(scope)} was not stored.`);
    return created;
  }

  /** Record that an account has read the catalogue, so a public change reaches it. Only needed without overlays. */
  const rememberedAccounts = new Set<string>();
  async function rememberAccount(accountId: string): Promise<void> {
    if (rememberedAccounts.has(accountId)) return;
    const scope: CatalogScope = { cacheScope: 'account', accountId };
    if (!(await store.get(scope))) {
      await store.put({ scope, revision: 1, products: null, updatedAt: now().toISOString(), pending: [] }, undefined);
    }
    rememberedAccounts.add(accountId);
  }

  /**
   * The snapshot a caller is served: its own account's when it has one, the public one otherwise. With
   * `create: false` nothing is read from the source, and a scope the service has never read has no snapshot.
   */
  async function effective(
    accountId: string | undefined,
    wantsAccount: boolean,
    create: boolean
  ): Promise<{ scope: CatalogScope; snapshot: CatalogSnapshotV1 | undefined }> {
    if (wantsAccount && accountId !== undefined) {
      const scope: CatalogScope = { cacheScope: 'account', accountId };
      const own = create ? await ensure(scope) : await store.get(scope);
      if (own?.products) return { scope, snapshot: own };
    } else if (create && accountId !== undefined && !overlays) {
      await rememberAccount(accountId);
    }
    return { scope: PUBLIC, snapshot: create ? await ensure(PUBLIC) : await store.get(PUBLIC) };
  }

  // -- serving -----------------------------------------------------------------------------------------

  async function serve(task: Task, request: Loose, ctx: Ctx<TCtxMeta>): Promise<Loose> {
    // The account is the one the server resolved for the caller. A request that names an account no
    // different from the resolved one changes nothing, and one that names another never reaches this far.
    const accountId = (ctx as { account?: { id?: unknown } } | undefined)?.account?.id;
    const resolvedAccount = typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
    const wantsAccount = overlays && request.account !== undefined && resolvedAccount !== undefined;

    const ifVersion = task === 'list_products' ? request.if_feed_version : request.if_wholesale_feed_version;
    if (request.if_pricing_version !== undefined && ifVersion === undefined) {
      throw new AdcpError('INVALID_REQUEST', {
        message: `if_pricing_version is valid only with ${task === 'list_products' ? 'if_feed_version' : 'if_wholesale_feed_version'}.`,
        field: 'if_pricing_version',
        recovery: 'correctable',
      });
    }
    const { productIds, selection } = selectionOf(task, request);
    if (Object.keys(selection).length > 0 && adapter.selectProducts === undefined) {
      const field = Object.keys(selection)[0]!;
      throw new AdcpError('INVALID_REQUEST', {
        message:
          `This catalogue serves its whole feed and does not apply ${JSON.stringify(field)}. ` +
          (task === 'list_products'
            ? 'Select products with criteria.product_ids, or omit the selection.'
            : 'Omit the selection.'),
        field,
        recovery: 'correctable',
      });
    }

    const { scope, snapshot: served } = await effective(resolvedAccount, wantsAccount, true);
    const snapshot = served as ServedSnapshot;
    const { version } = snapshot;
    const cacheScope = scope.cacheScope;
    const selectionKey =
      productIds === undefined && Object.keys(selection).length === 0
        ? catalogScopeKey(scope)
        : `${catalogScopeKey(scope)}|${canonicalJsonSha256({ productIds: productIds ? [...productIds].sort() : null, selection }).slice(0, 16)}`;

    const cursorInput = task === 'list_products' ? request.cursor : (request.pagination as Loose | undefined)?.cursor;
    const cursorField = task === 'list_products' ? 'cursor' : 'pagination.cursor';
    let offset = 0;
    if (cursorInput !== undefined) {
      const decoded = typeof cursorInput === 'string' ? decodeCursor(cursorInput, selectionKey) : undefined;
      if (decoded === undefined) {
        throw new AdcpError('INVALID_REQUEST', {
          message:
            'The cursor is not one this catalogue issued for this scope and selection. Start again without a cursor.',
          field: cursorField,
          recovery: 'correctable',
        });
      }
      offset = decoded;
    } else if (ifVersion === version && !asksForForecast(request)) {
      // A token minted for another scope hashes differently, so it can never be `unchanged` here.
      return task === 'list_products'
        ? { outcome: 'unchanged', feed_version: version, cache_scope: cacheScope }
        : { unchanged: true, wholesale_feed_version: version, cache_scope: cacheScope };
    }

    let products = snapshot.products;
    if (productIds !== undefined) products = products.filter(product => productIds.has(product.product_id));
    if (Object.keys(selection).length > 0) {
      products = await adapter.selectProducts!(products, { task, selection }, ctx);
    }
    const requested =
      task === 'list_products' ? request.max_results : (request.pagination as Loose | undefined)?.max_results;
    const size = Math.min(
      MAX_PAGE_SIZE,
      typeof requested === 'number' && requested >= 1 ? Math.floor(requested) : DEFAULT_PAGE_SIZE
    );
    // The page is a copy: the framework strips internal fields from what a handler returns, in place.
    const page = structuredClone(products.slice(offset, offset + size));
    const hasMore = offset + size < products.length;
    const next = hasMore ? encodeCursor(selectionKey, offset + size, version) : undefined;

    return task === 'list_products'
      ? {
          outcome: 'listed',
          products: page,
          feed_version: version,
          cache_scope: cacheScope,
          ...(next !== undefined && { next_cursor: next }),
        }
      : {
          products: page,
          wholesale_feed_version: version,
          cache_scope: cacheScope,
          pagination: { has_more: hasMore, ...(next !== undefined && { cursor: next }), total_count: products.length },
        };
  }

  // -- change delivery ---------------------------------------------------------------------------------

  /** One event, to one account's subscribers, in the view each of them registered. */
  async function emitEvent(
    change: CatalogChangeV1,
    event: CatalogEventV1,
    accountId: string,
    audience: ProductPayloadView | 'all',
    tenantId: string
  ): Promise<boolean> {
    const runtime = notifications!.runtime;
    const isProduct = event.type.startsWith('product.');
    // `all` events carry no product, so the view only chooses who receives them.
    const view: ProductPayloadView = audience === 'canonical' ? 'canonical' : 'legacy';
    const result: NotificationFanoutResult = await runtime.emit({
      emissionId: `wholesale-catalog:${change.changeId}:${event.eventId}:${audience}:${accountId}`,
      notificationId: event.eventId,
      notificationType: event.type,
      anchor: 'account',
      tenantId,
      accountId,
      freezeRecipients: async candidates => {
        if (audience === 'all') return candidates;
        const wanted: (typeof candidates)[number][] = [];
        for (const candidate of candidates) {
          const set = await runtime.store.get(candidate.scope);
          const registered = set?.subscriptions.find(
            item => item.subscriberId === candidate.subscriberId
          )?.productPayloadView;
          // AdCP: a subscriber that names no view gets the legacy one.
          if ((registered ?? 'legacy') === audience) wanted.push(candidate);
        }
        return wanted;
      },
      payload: {
        fired_at: event.createdAt,
        wholesale_feed_version: event.version,
        ...(event.previousVersion !== undefined && { previous_wholesale_feed_version: event.previousVersion }),
        cache_scope: event.appliesTo.scope,
        ...(isProduct && { product_payload_view: view }),
        event: wireEvent(event, view),
      },
    });
    // A terminal failure (a retired subscriber, an exhausted retry horizon) can never succeed; the rest retries.
    return !result.deliveries.some(
      delivery =>
        (delivery.failure !== undefined && delivery.failure.terminal !== true) ||
        (delivery.result !== undefined && !delivery.result.delivered && delivery.result.terminal !== true)
    );
  }

  async function deliver(change: CatalogChangeV1, accountId: string): Promise<boolean> {
    const tenantId = await tenantFor(accountId);
    let delivered = true;
    for (const event of change.events) {
      if (event.type === 'wholesale_feed.bulk_change') {
        delivered = (await emitEvent(change, event, accountId, 'all', tenantId)) && delivered;
        continue;
      }
      delivered = (await emitEvent(change, event, accountId, 'canonical', tenantId)) && delivered;
      if (!change.legacyResync)
        delivered = (await emitEvent(change, event, accountId, 'legacy', tenantId)) && delivered;
    }
    if (change.legacyResync) {
      delivered = (await emitEvent(change, change.legacyResync, accountId, 'legacy', tenantId)) && delivered;
    }
    return delivered;
  }

  /** Tell every account its subscribers are owed about the oldest undelivered change, then the next. */
  function flush(scope: CatalogScope): Promise<void> {
    if (!notifications) return Promise.resolve();
    return exclusive(`flush:${catalogScopeKey(scope)}`, async () => {
      for (;;) {
        const snapshot = await store.get(scope);
        const change = snapshot?.pending[0];
        if (!snapshot || !change) return;
        let remaining = change.accountIds;
        for (const accountId of change.accountIds) {
          let delivered: boolean;
          try {
            delivered = await deliver(change, accountId);
          } catch (error) {
            await report(error);
            delivered = false;
          }
          if (!delivered) continue;
          remaining = remaining.filter(id => id !== accountId);
          if (!(await recordProgress(scope, change.changeId, remaining))) break;
        }
        if (remaining.length > 0) return; // retried on the next reconcile
        if (!(await recordProgress(scope, change.changeId, remaining))) continue;
      }
    });
  }

  /** Persist who is still owed `changeId`; the change leaves the queue when nobody is. `false`: lost a race, reload. */
  async function recordProgress(scope: CatalogScope, changeId: string, remaining: string[]): Promise<boolean> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const snapshot = await store.get(scope);
      const index = snapshot?.pending.findIndex(item => item.changeId === changeId) ?? -1;
      if (!snapshot || index === -1) return true; // another instance finished it
      const pending = [...snapshot.pending];
      if (remaining.length === 0) pending.splice(index, 1);
      else pending[index] = { ...pending[index]!, accountIds: remaining };
      if (await store.put({ ...snapshot, revision: snapshot.revision + 1, pending }, snapshot.revision)) return true;
    }
    return false;
  }

  // -- the service -------------------------------------------------------------------------------------

  async function reconcile(): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(() => update(PUBLIC, false));
    for (const scope of await store.list()) {
      if (scope.cacheScope !== 'account') continue;
      // An account that follows the public catalogue has nothing of its own to re-read.
      const snapshot = await store.get(scope);
      await attempt(() => (overlays && snapshot?.products !== null ? update(scope, false) : flush(scope)));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, `${failures.length} catalogue scopes failed to reconcile`);
  }

  let loop: Promise<void> | undefined;
  let stopLoop: AbortController | undefined;

  const installed = new WeakSet<object>();

  return {
    capabilities,
    get running() {
      return loop !== undefined;
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    install<TPlatform extends DecisioningPlatform<any, TCtxMeta>>(platform: TPlatform) {
      if (installed.has(platform))
        throw new TypeError('This wholesale catalogue service is already installed on the platform.');
      if (platform.mediaBuyLifecycle?.listProducts) {
        throw new PlatformConfigError(
          'The wholesale catalogue service answers list_products itself; remove mediaBuyLifecycle.listProducts, or serve the catalogue from it and skip the service.',
          { configField: 'mediaBuyLifecycle.listProducts' }
        );
      }
      const hasBriefPath =
        platform.sales?.getProducts != null ||
        platform.proposalManager != null ||
        platform.mediaBuyLifecycle?.requestProposals != null ||
        platform.mediaBuyLifecycle?.refineProposals != null;

      const lifecycle = (platform.mediaBuyLifecycle ??= {});
      lifecycle.listProducts = async (request, ctx) => (await serve('list_products', request as Loose, ctx)) as never;

      const sales = (platform.sales ??= {});
      const existing = sales.getProducts?.bind(sales);
      sales.getProducts = async (request, ctx) => {
        if (request.buying_mode === 'wholesale') return (await serve('get_products', request as Loose, ctx)) as never;
        if (existing) return existing(request, ctx);
        throw new AdcpError('UNSUPPORTED_FEATURE', {
          message: `This seller serves buying_mode "wholesale" only; it does not answer "${request.buying_mode}".`,
          field: 'buying_mode',
          recovery: 'correctable',
        });
      };

      const declared = platform.capabilities as unknown as Loose;
      // Installing getProducts must not make a catalogue-only seller advertise a brief path it does not have.
      if (!hasBriefPath && declared.buyingModes === undefined) declared.buyingModes = ['wholesale'];
      const overrides = (declared.overrides ??= {}) as Loose;
      for (const [key, value] of Object.entries(capabilities))
        if (overrides[key] === undefined) overrides[key] = structuredClone(value);

      installed.add(platform);
      return platform as never;
    },

    update: scope => update(scope, true),
    reconcile,

    async isCurrent(scope, version) {
      assertScope(scope);
      const { snapshot } = await effective(
        scope.cacheScope === 'account' ? scope.accountId : undefined,
        scope.cacheScope === 'account' && overlays,
        false
      );
      return snapshot?.version === version;
    },

    async assertCurrent(scope, version) {
      if (await this.isCurrent(scope, version)) return;
      throw new AdcpError('CONFLICT', {
        message:
          'The feed_version is no longer current: the offers changed since the catalogue was read. Read it again and retry.',
        field: 'feed_version',
      });
    },

    start(scheduler: WholesaleCatalogSchedulerOptionsV1) {
      if (loop) throw new Error('The wholesale catalogue scheduler is already running');
      const interval = parseInterval(scheduler.reconcileEvery);
      const abort = new AbortController();
      stopLoop = abort;
      loop = (async () => {
        while (!abort.signal.aborted) {
          try {
            await reconcile();
          } catch (error) {
            await report(error);
          }
          await sleep(interval, abort.signal);
        }
      })().finally(() => {
        loop = undefined;
        stopLoop = undefined;
      });
    },

    async stop() {
      const running = loop;
      stopLoop?.abort();
      if (running) await running;
    },
  };

  function defaultStore(): CatalogSnapshotStoreV1 {
    return memoryCatalogSnapshotStore();
  }
}

// -- request helpers -------------------------------------------------------------------------------------

/**
 * The part of a request that selects products. `criteria.product_ids` is applied here; whatever else the
 * request names goes to the adapter's `selectProducts`, or is refused when the adapter has none.
 */
function selectionOf(task: Task, request: Loose): { productIds?: Set<string>; selection: Loose } {
  const selection: Loose = {};
  let productIds: Set<string> | undefined;
  if (task === 'list_products') {
    const criteria = request.criteria;
    if (criteria && typeof criteria === 'object') {
      const { product_ids, ...rest } = criteria as Loose;
      if (Array.isArray(product_ids))
        productIds = new Set(product_ids.filter((id): id is string => typeof id === 'string'));
      if (nonEmpty(rest)) selection.criteria = rest;
    }
  } else {
    for (const key of GET_PRODUCTS_SELECTORS) if (nonEmpty(request[key])) selection[key] = request[key];
  }
  return { ...(productIds && { productIds }), selection };
}

function nonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value as Loose).some(nonEmpty);
  return true;
}

/** A forecast is computed per request, so a request for one is never answered `unchanged`. */
function asksForForecast(request: Loose): boolean {
  return Array.isArray(request.fields) && request.fields.includes('forecast');
}

function assertScope(scope: CatalogScope): void {
  if (scope?.cacheScope === 'public') return;
  if (scope?.cacheScope === 'account' && typeof scope.accountId === 'string' && scope.accountId.length > 0) return;
  throw new TypeError('A catalogue scope is { cacheScope: "public" } or { cacheScope: "account", accountId }.');
}

/** Milliseconds from a number or a string such as `'30s'`, `'15m'` or `'1h'`. */
export function parseInterval(value: number | string): number {
  const match = typeof value === 'string' ? /^(\d+)\s*(ms|s|m|h)$/.exec(value.trim()) : undefined;
  const ms =
    typeof value === 'number'
      ? value
      : match
        ? Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h']
        : NaN;
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new TypeError(
      `reconcileEvery must be a positive number of milliseconds or a string such as '30s', '15m' or '1h'; got ${JSON.stringify(value)}`
    );
  }
  return ms;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
