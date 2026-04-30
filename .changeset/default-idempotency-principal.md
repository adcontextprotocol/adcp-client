---
'@adcp/sdk': minor
---

`createAdcpServerFromPlatform` now synthesizes a default `resolveIdempotencyPrincipal` when the adopter doesn't wire one explicitly. The v5 `createAdcpServer` surface treats this as a hard requirement and returns `SERVICE_UNAVAILABLE` on every mutating call when unwired — brutal first-30-minutes experience for v6 platform adopters who declared a typed platform but skipped the principal hook.

Default falls back through `ctx.authInfo?.clientId` (multi-tenant: each authenticated buyer gets its own idempotency namespace) → `ctx.sessionKey` → `ctx.account?.id` (single-tenant fallback). Adopters override by passing `resolveIdempotencyPrincipal` in opts; the spread keeps explicit values winning so adopters who want strict v5 semantics can opt back in.

Surfaced by Emma matrix v2 — first run after the path consolidation that actually got LLM-driven adopters reaching for `createAdcpServerFromPlatform`. Every mutating call returned `SERVICE_UNAVAILABLE` because Claude (correctly) didn't wire the principal hook. The framework should provide sane defaults for the common case.
