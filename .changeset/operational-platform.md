---
'@adcp/sdk': minor
---

Add `OperationalPlatform` interface and `defineOperationalPlatform` factory for in-process consumers (price-optimization pollers, audience-sync task pollers, scheduled jobs, storefront fan-out paths) that don't carry an MCP request. Distinct from `DecisioningPlatform` (buyer-facing dispatch with `RequestContext`).

Five-method surface: `extractContext` (synthesize per-call context from a stored token), `updateMediaBuy` (required), `getMediaBuyDelivery` (required, takes `mediaBuyIds: readonly string[]` matching the wire-spec plural field), `pollAudienceStatuses` (optional, returns `Map<string, AudienceStatus>` aligned with `AudiencePlatform.pollAudienceStatuses`), `getProducts` (optional). Methods throw `AdcpError` for structured rejection, matching `DecisioningPlatform`'s convention.

Type parameter `OperationalPlatform<TCtx extends OperationalContext>` carries adopter-specific context fields (advertiser id, sandbox mode, region) through every method without escape hatches.

The named contract eliminates the seam every operational adopter would otherwise reinvent. v5 adapters duck-type-satisfy `extractContext`'s shape (signature matches v5 `PlatformAdapter.extractContext`); methods that returned `Result<T, E>` in v5 / shim code need a `Result`-to-throw migration during adoption — replace `if (r.err) handle(r.err)` with `try { ... } catch (e) { if (e instanceof AdcpError) handle(e); }`. See #1530.
