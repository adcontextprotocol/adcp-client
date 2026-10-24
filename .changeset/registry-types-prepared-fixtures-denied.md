---
'@adcp/sdk': patch
---

Refresh generated registry API types to match the published OpenAPI schema: the `runStoryboardStep` 403 response can now carry a `PREPARED_FIXTURES_DENIED` body (`code` plus `refusal_code`) alongside the generic `Error`.
