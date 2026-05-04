---
'@adcp/sdk': minor
---

Add `OperationalPlatform` interface and `defineOperationalPlatform` factory for in-process consumers (price-optimization pollers, audience-sync task pollers, scheduled jobs, storefront fan-out paths) that don't carry an MCP request. Distinct from `DecisioningPlatform` (buyer-facing dispatch with `RequestContext`).

Five-method surface: `extractContext` (synthesize per-call context from a stored token), `updateMediaBuy` (required), `getMediaBuyDelivery` (required), `pollAudienceStatus` (optional), `getProducts` (optional). Methods throw `AdcpError` for structured rejection, matching `DecisioningPlatform`'s convention.

Type parameter `OperationalPlatform<TCtx extends OperationalContext>` carries adopter-specific context fields (advertiser id, sandbox mode, region) through every method without escape hatches.

The named contract eliminates the seam every operational adopter would otherwise reinvent. v5 adapters duck-type-satisfy the interface (`extractContext` signature matches v5 `PlatformAdapter.extractContext`) so migration is mechanical. See #1530.
