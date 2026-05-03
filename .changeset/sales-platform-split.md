---
"@adcp/sdk": minor
---

`SalesPlatform` methods are now optional individually; per-specialism enforcement of the core media-buy lifecycle moves up to `RequiredPlatformsFor<S>`. Two new named subset types:

- **`SalesCorePlatform<TCtxMeta>`** — bidding + media-buy lifecycle (`getProducts`, `createMediaBuy`, `updateMediaBuy`, `getMediaBuyDelivery`, `getMediaBuys`). Required for `sales-non-guaranteed` / `sales-guaranteed` / `sales-broadcast-tv` / `sales-catalog-driven`.
- **`SalesIngestionPlatform<TCtxMeta>`** — asset ingestion (`syncCreatives`, `syncCatalogs`, `syncEventSources`, `logEvent`, `listCreativeFormats`, `listCreatives`, `providePerformanceFeedback`). Required for `sales-social`. Optional individually.

`SalesPlatform = SalesCorePlatform & SalesIngestionPlatform` is preserved as a structural-compatibility alias. `RequiredPlatformsFor<'sales-social'>` now requires only `SalesIngestionPlatform`, dropping ~40 lines of stub-throw boilerplate from walled-garden adopters that don't accept inbound media buys (Meta CAPI, Snap CAPI, TikTok Events, etc.). `RequiredPlatformsFor<'sales-proposal-mode'>` requires only `getProducts` plus optional ingestion. Closes #1341.

Two new helpers in `@adcp/sdk/server`: `defineSalesCorePlatform<TCtxMeta>(platform)` and `defineSalesIngestionPlatform<TCtxMeta>(platform)` — companions to the existing `defineSalesPlatform` for adopters wiring core or ingestion in isolation.

**Migration: adopters claiming a sales specialism with required core methods.** If you currently write:

```ts
sales: SalesPlatform<Meta> = defineSalesPlatform<Meta>({
  /* all 5 core methods */
});
```

…the explicit `: SalesPlatform<Meta>` field annotation now widens the inferred shape to all-optional after the split, so `RequiredPlatformsFor<'sales-guaranteed'>` (etc.) rejects the platform with "Property 'getProducts' is optional in type 'SalesPlatform<Meta>' but required in type 'Required<Pick<SalesPlatform<any>, …>>'". Two clean migrations:

```ts
// Pattern A — explicit field annotation (recommended; shortest)
sales: SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta> = {
  getProducts: async (req, ctx) => { … },
  createMediaBuy: async (req, ctx) => { … },
  updateMediaBuy: async (id, patch, ctx) => { … },
  getMediaBuyDelivery: async (filter, ctx) => { … },
  getMediaBuys: async (req, ctx) => { … },
  // …optional ingestion methods (syncCreatives, etc.)…
};

// Pattern B — spread the new sub-helpers (when you want the methods grouped)
sales = {
  ...defineSalesCorePlatform<Meta>({ getProducts, createMediaBuy, updateMediaBuy, getMediaBuyDelivery, getMediaBuys }),
  ...defineSalesIngestionPlatform<Meta>({ syncCreatives, syncCatalogs, logEvent }),
};
```

Both patterns are exercised as type-only regression tests in `decisioning.type-checks.ts` (`_sales_guaranteed_field_annotation_pattern`, `_sales_guaranteed_spread_helpers_pattern`) so future helper changes can't silently break the migration path. The `defineSalesPlatform` helper is preserved for source compat — it still returns `SalesPlatform<TCtxMeta>` (now all-optional) and is appropriate for `sales-social` adopters and similar specialisms whose `RequiredPlatformsFor<S>` doesn't enforce core-method presence. The `examples/hello_seller_adapter_guaranteed.ts` reference adapter demonstrates Pattern A.

Runtime: the dispatcher in `from-platform.ts` now conditionally registers core handlers based on method presence, so omitting `getProducts` from a `sales-social` platform doesn't crash; the buyer receives `METHOD_NOT_FOUND` for unsupported tools (or the merge-seam handler fills in via `opts.mediaBuy.X`). The runtime `validateSpecialismRequiredTools` check still warns / throws when a claimed specialism's required tools aren't implemented anywhere on the platform.
