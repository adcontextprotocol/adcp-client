---
"@adcp/sdk": minor
---

`SalesPlatform` methods are now optional individually; per-specialism enforcement of the core media-buy lifecycle moves up to `RequiredPlatformsFor<S>`. Two new named subset types:

- **`SalesCorePlatform<TCtxMeta>`** — bidding + media-buy lifecycle (`getProducts`, `createMediaBuy`, `updateMediaBuy`, `getMediaBuyDelivery`, `getMediaBuys`). Required for `sales-non-guaranteed` / `sales-guaranteed` / `sales-broadcast-tv` / `sales-catalog-driven`.
- **`SalesIngestionPlatform<TCtxMeta>`** — asset ingestion (`syncCreatives`, `syncCatalogs`, `syncEventSources`, `logEvent`, `listCreativeFormats`, `listCreatives`, `providePerformanceFeedback`). Required for `sales-social`. Optional individually.

`SalesPlatform = SalesCorePlatform & SalesIngestionPlatform` is preserved as a backwards-compatible alias — adopters who implement the full surface continue to compile unchanged. `RequiredPlatformsFor<'sales-social'>` now requires only `SalesIngestionPlatform`, dropping ~40 lines of stub-throw boilerplate from walled-garden adopters that don't accept inbound media buys (Meta CAPI, Snap CAPI, TikTok Events, etc.). `RequiredPlatformsFor<'sales-proposal-mode'>` requires only `getProducts` plus optional ingestion. Closes #1341.

Two new helpers in `@adcp/sdk/server`: `defineSalesCorePlatform<TCtxMeta>(platform)` and `defineSalesIngestionPlatform<TCtxMeta>(platform)` — companions to the existing `defineSalesPlatform` for adopters wiring core or ingestion in isolation.

Runtime: the dispatcher in `from-platform.ts` now conditionally registers core handlers based on method presence, so omitting `getProducts` from a `sales-social` platform doesn't crash; the buyer receives `METHOD_NOT_FOUND` for unsupported tools (or the merge-seam handler fills in via `opts.mediaBuy.X`). The runtime `validateSpecialismRequiredTools` check still warns / throws when a claimed specialism's required tools aren't implemented anywhere on the platform.
