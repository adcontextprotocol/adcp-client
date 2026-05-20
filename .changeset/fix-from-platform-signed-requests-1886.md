---
"@adcp/sdk": patch
---

fix(server): forward `platform.capabilities.specialisms` and synthesize `request_signing` in `createAdcpServerFromPlatform`

`createAdcpServerFromPlatform` now correctly forwards `platform.capabilities.specialisms` into the inner `createAdcpServer` config. Previously, `projectedCapabilitiesConfig` only forwarded domain overrides (media_buy, brand, account, compliance_testing) and never included `specialisms`, so `createAdcpServer`'s boot-time guard always saw an empty specialisms list and threw when `signedRequests` was configured — even when `'signed-requests'` was declared in `platform.capabilities.specialisms`.

The fix also synthesizes `request_signing: { supported: true }` when `signed-requests` is in the specialism list, satisfying the parallel guard that requires both fields to be present together. `DecisioningCapabilities` has no `request_signing` field (it is implied by the specialism claim), so the synthesis happens at the projection layer.

Fixes #1886. Reported by @kapoost on behalf of Purrsonality (119/124 storyboards passing; this was the only remaining blocker for the `signed-requests` specialism claim).
