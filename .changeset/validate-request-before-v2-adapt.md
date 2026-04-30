---
'@adcp/sdk': patch
---

Run pre-send AJV schema validation on the unadapted v3 request shape, before `adaptRequestForServerVersion` rewrites it for v2 wire format.

Previously the check ran inside `TaskExecutor.executeTask` against the post-adaptation params. The v2 adapters (`adaptGetProductsRequestForV2`, `adaptCreateMediaBuyRequestForV2`, `adaptUpdateMediaBuyRequestForV2`, `adaptSyncCreativesRequestForV2`) strip v3-only required fields like `buying_mode` and `account` so the request matches the v2 wire contract. The bundled schemas are v3, so strict mode was throwing `ValidationError: Validation failed for field '/buying_mode'` (and similar) on every v2-detected agent, even though the user wrote a valid v3 request.

The check now runs on `SingleAgentClient` (both `executeTaskWithHandler` and `executeTask` paths) against the user-facing v3 shape before any wire-format adaptation. Validation coverage is preserved for v2 traffic — including tasks like `update_media_buy` that have no Zod schema in `SingleAgentClient.validateRequest` and previously relied entirely on the AJV pass.

`TaskExecutor.validateRequest(taskName, params, debugLogs?)` is now the public seam; the inline call inside `executeTask` is gone.
