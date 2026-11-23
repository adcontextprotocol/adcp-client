---
'@adcp/sdk': patch
---

Fix the request-signing capability cache missing on every call for a client that sends per-call correlation headers. `capabilityPrincipalScope` hashed every agent header into the cache key, so a fresh `traceparent`, `x-request-id` or `x-<vendor>-debug-id` on each call gave each call its own key and re-read `get_adcp_capabilities` before every signed request, while the shared discovery cache, which already leaves those headers out, hit. The signing scope now leaves out the headers `isCorrelationHeader` matches, the same rule the discovery cache uses. Credential and tenant/routing headers still split the key, so one principal never reuses another's signing policy. Refs #3718.
