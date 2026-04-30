---
'@adcp/sdk': patch
---

Skip strict-mode pre-send schema validation when the request was adapted for a v2 server. The v2 adapters (`adaptGetProductsRequestForV2`, `adaptCreateMediaBuyRequestForV2`, `adaptUpdateMediaBuyRequestForV2`, `adaptSyncCreativesRequestForV2`) strip v3-only required fields like `buying_mode` and `account` so the request matches the v2 wire contract; the bundled schemas are v3, so AJV strict validation against the adapted shape would falsely throw `ValidationError: Validation failed for field '/buying_mode'` (and similar) on every v2-detected agent.

Required-field violations on the unadapted request are still caught by `SingleAgentClient.validateRequest` (Zod) before adaptation runs, and strict mode continues to validate v3-detected and version-unknown requests against the v3 schema. No behavior change for v3 or version-unknown agents, or for `requests: 'warn' | 'off'`.
