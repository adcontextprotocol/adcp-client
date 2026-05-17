---
'@adcp/sdk': patch
---

fix(client): `SingleAgentClient.fetchA2ACanonicalUrl()` now honors `transport.maxResponseBytes`

Closes the second A2A discovery DoS surface flagged by the security review on PR #1802. `fetchA2ACanonicalUrl` runs implicitly before every `executeTask` / `listTools` / `getAgentInfo` call against an A2A agent whose canonical URL hasn't been resolved yet. Until this fix it called native `fetch` without composing through `wrapFetchWithSizeLimit`, so a hostile vendor could ship a 5 GB agent-card body on first discovery to blow memory before any application-layer parsing ran.

Same fix shape as #1799 (`getAgentInfo`): wrap the `A2AClient.fromCardUrl` call and the deferred `agentCardPromise` read in `withResponseSizeLimit`, and route the auth-stamping `fetchImpl` through `wrapFetchWithSizeLimit` so the active ALS slot fires on the wire call.

Regression test at `test/unit/fetch-a2a-canonical-url-size-limit.test.js` aborts an oversized canonical-URL discovery with `ResponseTooLargeError`.

Closes #1804.
