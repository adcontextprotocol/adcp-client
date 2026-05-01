---
'@adcp/sdk': minor
---

Adds a warn-only post-adapter validation pass against the v2.5 schema bundle. After `adaptRequestForServerVersion` rewrites a v3 request into v2 wire format for a v2-detected agent, `SingleAgentClient` calls `executor.validateAdaptedRequestAgainstV2(taskName, adaptedParams)` which validates the adapted shape against the cached v2.5 schemas in warn mode. Symmetric counterpart to the existing pre-adapter v3 pass: that one catches "user wrote bad v3", this one catches "adapter produced bad v2.5".

Always warn-only — adapter bugs shouldn't break user requests, and the v3 pre-send pass already vouched for the user-facing input shape. The pass surfaces drift via `debugLogs` (when callers pass an array; SDK-internal call sites currently don't, so warnings are silent in production until the upcoming adapter-conformance test suite consumes them as CI signal).

Skips silently for tasks without a v2.5 schema (custom tools, tasks added since 2.5.3) and when the v2.5 bundle isn't cached. Caller in `SingleAgentClient` gates on `serverVersion === 'v2'` so v3-targeted traffic doesn't pay the validation cost.

Initial baseline against the canonical adapter outputs surfaced two real drift items worth tracking separately: `adaptCreateMediaBuyRequestForV2` doesn't emit `buyer_ref` (v2.5 requires it top-level + per-package), and `adaptSyncCreativesRequestForV2`'s `assets.video` shape fails a `oneOf` in v2.5. These will be addressed alongside the adapter-conformance test suite.

`TaskExecutor.validateAdaptedRequestAgainstV2(taskName, adaptedParams, debugLogs?)` is the public seam; mirrors the shape of `validateRequest`.
