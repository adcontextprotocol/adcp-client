/**
 * Types for the seller wholesale catalogue service (`@adcp/sdk/wholesale-catalog`).
 *
 * @packageDocumentation
 */
import type { Account } from '../server/decisioning/account';
import type { RequestContext } from '../server/decisioning/context';
import type { DecisioningPlatform } from '../server/decisioning/platform';
import type { MediaBuyLifecyclePlatform, SalesPlatform } from '../server/decisioning/specialisms/sales';
import type { PersistentNotificationRuntime } from '../server/notification-subscriptions';
import type { CanonicalProduct } from '../v2/projection/creative-delivery';
import type { GetAdCPCapabilitiesResponse } from '../types/tools.generated';

/** A product as the service serves it: the URL-free canonical product, which the SDK projects for wholesale `get_products`. */
export type CatalogProduct = CanonicalProduct;

/**
 * Which copy of the catalogue a caller sees: the public catalogue, or one account's overlay. The service
 * only ever builds an account scope from the account the server resolved for the caller, never from an
 * identifier named in a request.
 */
export type CatalogScope = { cacheScope: 'public' } | { cacheScope: 'account'; accountId: string };

/** The wholesale feed event types the service emits. */
export type CatalogEventType =
  | 'product.created'
  | 'product.updated'
  | 'product.priced'
  | 'product.removed'
  | 'wholesale_feed.bulk_change';

/** One change to the catalogue, in the form the service stores until every subscriber has been told. */
export type CatalogEventV1 = {
  /** UUIDv7, so a receiver can order events by id. Stable across retries. */
  eventId: string;
  createdAt: string;
  /** The feed version before this event, when there was one, and the one a receiver holds once it has applied it. */
  previousVersion?: string;
  version: string;
  appliesTo: { scope: 'public' } | { scope: 'account'; accountIds: string[] };
} & (
  | { type: 'product.created' | 'product.updated'; productId: string; product: CatalogProduct }
  | { type: 'product.priced'; productId: string; pricingOptions: unknown[] }
  | { type: 'product.removed'; productId: string }
  | { type: 'wholesale_feed.bulk_change'; summary: string; affectedCount: number }
);

/** What one `update` found, kept until the notification runtime has accepted every delivery. */
export interface CatalogChangeV1 {
  changeId: string;
  fromVersion?: string;
  toVersion: string;
  /** The events, in order. Each carries the version a receiver holds after applying it. */
  events: CatalogEventV1[];
  /**
   * What a subscriber that registered the `legacy` product view gets when a changed product has no legacy
   * `format_ids` to carry: one bulk change that tells it to re-read, in place of the product events.
   */
  legacyResync?: CatalogEventV1;
  /**
   * The accounts still owed this change. A change to an account scope names that account. A change to the
   * public catalogue freezes every account known when it committed, so a crash cannot skip one.
   */
  accountIds: string[];
}

/** The stored state of one scope. Treated as immutable once read. */
export interface CatalogSnapshotV1 {
  scope: CatalogScope;
  /** Bumped by every write. The store's compare-and-set token. */
  revision: number;
  /** The products served. `null` marks an account that prices off the public catalogue. */
  products: readonly CatalogProduct[] | null;
  /** The feed version of `products`. Absent when `products` is `null`. */
  version?: string;
  updatedAt: string;
  /** Changes not yet delivered, oldest first. */
  pending: CatalogChangeV1[];
}

/**
 * Where snapshots live. The in-memory store (`memoryCatalogSnapshotStore()`) is for tests and development;
 * production passes a durable store of its own, so every instance serves and diffs the same snapshot.
 */
export interface CatalogSnapshotStoreV1 {
  /** `'durable'` only when a snapshot survives a restart and is shared by every instance. */
  readonly durability: 'process-local' | 'durable';
  /** The snapshot of a scope, or `undefined` when the service has never read it. The result is read-only. */
  get(scope: Readonly<CatalogScope>): Promise<CatalogSnapshotV1 | undefined>;
  /**
   * Compare-and-set: store `snapshot` only when the stored revision is `expectedRevision` (`undefined` when
   * the scope has no snapshot). Returns `false` when another writer got there first.
   */
  put(snapshot: CatalogSnapshotV1, expectedRevision: number | undefined): Promise<boolean>;
  /** Every scope the store holds. The reconcile timer and the public fan-out read it. */
  list(): Promise<readonly CatalogScope[]>;
}

/** What a seller writes. */
export interface WholesaleCatalogAdapterV1<TCtxMeta = Record<string, unknown>> {
  /**
   * The full list of products a caller in `scope` may see. For an account scope it may return `null` when
   * the account prices off the public catalogue, so the service serves it the public copy.
   * Called only with the public scope, or the account the server resolved for the caller.
   */
  readCatalog(scope: CatalogScope): readonly CatalogProduct[] | null | Promise<readonly CatalogProduct[] | null>;
  /**
   * Apply the selection a request names (`criteria`, or `filters` and the other `get_products` selectors).
   * Without it the service serves the whole feed and refuses a request that names a selection other than
   * `criteria.product_ids`, rather than return products the caller asked it to leave out.
   *
   * It must be a pure function of the products and the selection. The service gives every selection of a
   * scope the scope's own feed version, so a `buy_products` handler can check one version for the scope, and
   * a selection that changes without the catalogue changing would be reported as `unchanged`.
   */
  selectProducts?(
    products: readonly CatalogProduct[],
    request: CatalogSelectionRequest,
    ctx: RequestContext<Account<TCtxMeta>>
  ): readonly CatalogProduct[] | Promise<readonly CatalogProduct[]>;
  /**
   * The accounts to tell about a change to the public catalogue. Default: every account the service has
   * served or updated. Supply it when subscribers can exist for an account that has never read the catalogue.
   */
  listAccountIds?(): readonly string[] | Promise<readonly string[]>;
}

/** The selection part of a request, as the service hands it to `selectProducts`. */
export interface CatalogSelectionRequest {
  task: 'list_products' | 'get_products';
  /** The request fields that select products, with every absent field left out. */
  selection: Readonly<Record<string, unknown>>;
}

/** Where change events go. */
export interface WholesaleCatalogNotificationsV1 {
  /** The persistent notification runtime that holds the buyers' subscriptions. */
  runtime: PersistentNotificationRuntime;
  /** The tenant the account subscriptions are stored under. */
  tenantId: string | ((accountId: string) => string | Promise<string>);
}

export interface WholesaleCatalogBulkChangeV1 {
  /** A change touching more than this share of the feed is sent as one `wholesale_feed.bulk_change`. Default 0.05. */
  fraction?: number;
  /** A change touching more than this many products is sent as one `wholesale_feed.bulk_change`. Default 100. */
  maxProducts?: number;
}

export interface CreateWholesaleCatalogServiceOptionsV1<TCtxMeta = Record<string, unknown>> {
  adapter: WholesaleCatalogAdapterV1<TCtxMeta>;
  /**
   * Snapshot storage. Defaults to `memoryCatalogSnapshotStore()` when `NODE_ENV` is `test` or `development`;
   * production must pass a durable store (`WHOLESALE_CATALOG_STORAGE_NOT_DURABLE`).
   */
  snapshots?: CatalogSnapshotStoreV1;
  /** Without it the service versions and serves the catalogue but sends no events. */
  notifications?: WholesaleCatalogNotificationsV1;
  /**
   * Whether accounts can have a catalogue of their own. When `false` (the default) every read is public and
   * the service never calls `readCatalog` with an account scope.
   */
  accountOverlays?: boolean;
  bulkChange?: WholesaleCatalogBulkChangeV1;
  /** Called with anything the background work (reconcile, delivery) fails on. The work is retried on the next pass. */
  onError?: (error: unknown) => void | Promise<void>;
  /** Test seam. */
  now?: () => Date;
}

export interface WholesaleCatalogSchedulerOptionsV1 {
  /** How often `reconcile()` runs, as milliseconds or a string such as `'30s'`, `'15m'` or `'1h'`. */
  reconcileEvery: number | string;
}

export interface WholesaleCatalogUpdateResultV1 {
  scope: CatalogScope;
  /** `false` when the catalogue has the content the snapshot already holds, or this was the first read. */
  changed: boolean;
  /** The version now served for the scope, or `null` for an account that follows the public catalogue. */
  version: string | null;
  previousVersion: string | null;
  /** How many events the change produced. */
  events: number;
}

export interface WholesaleCatalogServiceV1<TCtxMeta = Record<string, unknown>> {
  /** The capability blocks the service declares. `install` puts them on the platform. */
  readonly capabilities: Pick<GetAdCPCapabilitiesResponse, 'wholesale_feed_versioning' | 'wholesale_feed_webhooks'>;
  readonly running: boolean;
  /**
   * Add `mediaBuyLifecycle.listProducts`, and wholesale `sales.getProducts` (wrapping an existing handler,
   * which keeps answering the other buying modes), and declare the capabilities. Returns the same object.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  install<TPlatform extends DecisioningPlatform<any, TCtxMeta>>(
    platform: TPlatform
  ): TPlatform & { mediaBuyLifecycle: MediaBuyLifecyclePlatform<TCtxMeta>; sales: SalesPlatform<TCtxMeta> };
  /**
   * Re-read a scope after a known change, compare it with the stored snapshot and tell subscribers. The first
   * read of a scope only stores the baseline. A change to the public catalogue also re-checks the accounts
   * that have a catalogue of their own.
   */
  update(scope: CatalogScope): Promise<WholesaleCatalogUpdateResultV1>;
  /** Run `update` for the public scope and every scope the store holds, and retry undelivered changes. */
  reconcile(): Promise<void>;
  /**
   * Whether `version` is the version currently served to `scope`. A `buy_products` handler calls it with the
   * request's `feed_version`: `false` means the offer changed since the buyer read it, so answer `CONFLICT`.
   */
  isCurrent(scope: CatalogScope, version: string): Promise<boolean>;
  /** Throw the `CONFLICT` a stale `feed_version` deserves. */
  assertCurrent(scope: CatalogScope, version: string): Promise<void>;
  start(options: WholesaleCatalogSchedulerOptionsV1): void;
  stop(): Promise<void>;
}
