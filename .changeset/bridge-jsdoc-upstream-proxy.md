---
'@adcp/sdk': patch
---

docs(server): clarify `testController` JSDoc — bridge is for upstream-proxy sellers only

JSDoc on `AdcpServerConfig.testController` now names the audience explicitly: the bridge is **test mode's adapter for upstream-proxy sellers** (DSPs proxying to Meta/Snap/TikTok, retail-media networks reading retailer catalogs, signals agents brokering third-party data marketplaces). State-local sellers (most SSPs, most creative agents) shouldn't wire it — `comply_test_controller` alone covers them because the seed→read loop closes locally. Cross-links the upstream taxonomy proposal at [`adcontextprotocol/adcp#4593`](https://github.com/adcontextprotocol/adcp/issues/4593) and the leaderboard policy at [`adcp-client#1782`](https://github.com/adcontextprotocol/adcp-client/issues/1782).

Also collapses a duplicate trust-boundary blurb (added by #1779 alongside the security-review note in #1786) into a single coherent section.
