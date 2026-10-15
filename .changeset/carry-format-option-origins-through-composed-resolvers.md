---
'@adcp/sdk': minor
---

Add `carryFormatOptionOrigins(resolver, ...sources)` so a resolver composed around `canonicalFormatLegacyResolverFromRoutes()` keeps the stored `seller_declared` origin that `AgentClient` uses to rewrite format options the seller never declared on the canonical wire. Without it, wrapping the routes resolver (for example to try stored routes and then another source) produced a new function with no origin, and the client sent the SDK-minted `format_option_id` again. `canonicalFormatLegacyResolverFromCatalogSnapshots(snapshots, fallback)` now carries its fallback's origin automatically.
