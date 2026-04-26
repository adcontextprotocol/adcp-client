---
"@adcp/client": patch
---

fix(grader): repair undici lookup callback shape in request-signing probe

`adcp grade request-signing` failed with "Invalid IP address: undefined" against any endpoint behind Cloudflare or an anycast load balancer. On Node 22+ with HTTPS targets, undici calls the `connect.lookup` function with `{ all: true }` and expects the array form of the callback (`cb(null, [{address, family}])`), but the probe was using the single-value form (`cb(null, address, family)`). The fix aligns the callback with the pattern already used in `ssrf-fetch.ts` and preserves DNS-rebinding protection.
