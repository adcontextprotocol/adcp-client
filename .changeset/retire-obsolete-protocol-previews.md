---
'@adcp/sdk': patch
---

Retire the obsolete AdCP 3.1 beta type side-bundle before the 14.0 GA release. The beta-only `@adcp/sdk/types/v3-1-beta` subpath and its schema/codegen pipeline are removed; use the primary `@adcp/sdk/types` 3.2 surface for current protocol types. For the legacy `get_products` mirror shape, import `LegacyWholesaleProduct` from `@adcp/sdk/wholesale-feed-sync` (or derive `NonNullable<GetProductsResponse['products']>[number]`) rather than using the canonical root `Product`. Wholesale feed sync keeps its documented legacy product-view behavior through current, narrowed types. Publishing now fails closed if a superseded protocol beta/RC cache, type bundle, export, or compatibility alias enters the npm artifact.
