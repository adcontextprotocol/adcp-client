# Seller wholesale catalogue service

`@adcp/sdk/wholesale-catalog` lets a seller that sells a wholesale catalogue write one function, `readCatalog(scope)`, and leave the rest to the SDK:

- answers `list_products` and wholesale `get_products` (`buying_mode: 'wholesale'`) from one stored snapshot per scope;
- pages the catalogue with a cursor;
- versions each scope, and answers a conditional read with `unchanged`;
- sends `product.created`, `product.updated`, `product.priced`, `product.removed` and `wholesale_feed.bulk_change` events when the seller signals a change;
- declares `wholesale` in `media_buy.buying_modes`, `wholesale_feed_versioning` and (with a notification runtime) `wholesale_feed_webhooks`.

It is shaped like `createReliableReportingService`: an adapter, a snapshot store with an in-memory implementation you replace in production, `install(platform)`, and `start`/`stop`. The buyer half is [`@adcp/sdk/wholesale-feed-sync`](../../src/lib/wholesale-feed-sync/index.ts).

```ts
import { createWholesaleCatalogService } from '@adcp/sdk/wholesale-catalog';

const catalog = createWholesaleCatalogService({
  adapter: {
    // { cacheScope: 'public' } | { cacheScope: 'account', accountId }
    readCatalog: scope => productsFor(scope), // canonical products, e.g. from buildProduct()
  },
  accountOverlays: true, // accounts can have a catalogue of their own
  snapshots: postgresCatalogSnapshotStore(pool), // your CatalogSnapshotStoreV1
  notifications: { runtime: notificationRuntime, tenantId: 'seller' },
});

const platform = catalog.install(mySalesPlatform);
catalog.start({ reconcileEvery: '15m' });

await catalog.update({ cacheScope: 'public' }); // after a known change
```

## Scopes and isolation

A scope is the public catalogue or one account. The service calls `readCatalog({ cacheScope: 'account', accountId })` only with the account the server resolved for the caller (`ctx.account.id`), never with an identifier named in a request, and only when the request names an `account`. A request with no account always reads the public catalogue.

Return `null` from `readCatalog` for an account that prices off the public catalogue; the service then serves that account the public copy with `cache_scope: 'public'`. Without `accountOverlays: true` every read is public and the service never calls `readCatalog` with an account scope.

The scope and the account id are part of the version hash, and a cursor is bound to its scope, so a token or cursor from one account never works for another.

## Versions, paging and conditional reads

The feed version is `sha256:` plus the RFC 8785 hash of the scope, the account (for an account scope) and the products as served, in the order served. `ctx_metadata` is not part of it. It is stable for unchanged content and changes when content changes. Every selection of a scope shares the scope's version, so a `buy_products` handler can check one version: `await catalog.assertCurrent(scope, request.feed_version)` throws `CONFLICT` when the offer changed since the buyer read it.

A matching `if_feed_version` (`list_products`) or `if_wholesale_feed_version` (`get_products`) answers `outcome: 'unchanged'` or `unchanged: true` with no products. A request for `forecast` is never answered `unchanged`. `if_pricing_version` without a feed token is refused. The service does not version pricing separately (`pricing_version_separate: false`).

Pages come from the stored snapshot, 50 products by default and at most 100. Each page carries the current version, so a buyer that sees the version move mid-walk restarts, as AdCP requires. The service stores no per-walk state.

Selections: `criteria.product_ids` is applied by the service. Any other selection (`criteria` fields, `filters`, `targeting_overlay` and the other `get_products` selectors) is refused with `INVALID_REQUEST` unless the adapter supplies `selectProducts(products, request, ctx)`, which must be a pure function of the products and the selection.

## Change events

The snapshot is what the service serves, and it changes when `update(scope)` runs (you call it after a change) or when the reconcile timer runs the same comparison as a backstop. A forgotten `update` delays a change; it does not lose it. The first read of a scope stores a baseline and sends nothing.

`update` compares the new catalogue with the snapshot by `product_id`: a new product is `product.created`, a gone one `product.removed`, a product whose only change is `pricing_options` is `product.priced`, any other change is `product.updated` with the whole product. When more than 5% of the feed or 100 products changed (configurable with `bulkChange`), or an account gains or loses its own catalogue, the service sends one `wholesale_feed.bulk_change` instead.

Each event carries the version a receiver holds after applying it. One change from version A to version B is a chain A → s1 → B, where the last link is the real version B and the steps are tokens that match no catalogue state, so a receiver following the events in order stays in step with the version it would read.

- A change to an account scope goes only to that account's subscribers, with `applies_to.account_ids` naming that account.
- A change to the public catalogue goes to the subscribers of every account the service has served or updated (or `adapter.listAccountIds()`), frozen when the change is stored.
- Each subscriber gets the product view it registered: `canonical` (`canonical_product`, `canonical_pricing_options`) or `legacy` (`product`, `pricing_options`; the default). When a changed product has no legacy `format_ids`, a legacy subscriber gets one `wholesale_feed.bulk_change` in place of the product events.
- A change is stored together with the events it owes in one compare-and-set, delivered through `runtime.emit`, and retried by the next `update` or reconcile with the same event and emission ids until the runtime accepts it. The runtime's own outbox handles retries after that point.

Register buyers' subscriptions on your accounts task (`sync_accounts` `notification_configs`) with the same runtime; the service does not touch registration.

## Storage

`snapshots` is a `CatalogSnapshotStoreV1`: `get(scope)`, `put(snapshot, expectedRevision)` (compare-and-set) and `list()`. `memoryCatalogSnapshotStore()` is for tests and development; outside `NODE_ENV=test|development` the service refuses a process-local store (`WHOLESALE_CATALOG_STORAGE_NOT_DURABLE`), because each instance would send its own copy of every change. A snapshot holds the whole catalogue of a scope and `get` is called on each read, so a production store should cache.

## Conformance

[`examples/storyboards/wholesale-catalog.yaml`](../../examples/storyboards/wholesale-catalog.yaml) checks paging, `unchanged` and scope isolation against [`examples/wholesale-catalog-seller/seller.mjs`](../../examples/wholesale-catalog-seller/seller.mjs). The storyboard runner cannot change a seller's catalogue or host a webhook receiver, so change delivery is covered by `test/lib/wholesale-catalog.test.js`, which also runs the buyer mirror (`refreshWholesaleFeed`, `applyWholesaleFeedWebhook`) against the service.
