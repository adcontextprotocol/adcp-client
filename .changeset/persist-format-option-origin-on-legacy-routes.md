---
'@adcp/sdk': patch
---

Persisted canonical-to-legacy routes now remember whether the seller declared each format option. `legacyRoutesForProduct()` records `seller_declared` on routes built from `getProducts()` products and, for an option the SDK derived from a seller's legacy `format_ids`, the direct `canonical_selector` (`format_kind` + `params`). An `AgentClient` given a resolver from `canonicalFormatLegacyResolverFromRoutes()` (per call or configured) now applies the canonical-wire rewrite for such options in a process that never ran discovery: `createMediaBuy` and `updateMediaBuy` send the direct selector instead of the SDK-minted `format_option_id`, and `syncCreatives` drops creative pins to it. An undeclared option with no direct selector, such as a custom format, is refused before dispatch. Routes persisted without `seller_declared` behave as before.
