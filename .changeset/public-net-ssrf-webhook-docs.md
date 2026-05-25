---
'@adcp/sdk': minor
---

Re-export SSRF-safe networking helpers from the package root and the new
`@adcp/sdk/net` public subpath. This includes `ssrfSafeFetch`,
`SsrfRefusedError`, `SSRF_TRANSIENT_CODES`, `decodeBodyAsJsonOrText`,
`isPrivateIp`, `isAlwaysBlocked`, and `isLikelyPrivateUrl`.

Docs add the 8.0 -> 8.1 migration guide and a recipe for verifying inbound
webhooks with RFC 9421, per-agent isolation, multi-replica replay storage, and
legacy HMAC handling.
