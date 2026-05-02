---
'@adcp/sdk': patch
---

fix(server): apply credential redactor to tenant-registry wire-projected reasons (closes #1330)

Stage 4 of #1269 introduced `redactCredentialPatterns` and applied it to the dispatcher's `err.message → details.reason` projections. Code-reviewer flagged additional sites in `tenant-registry.ts` that bypass the redactor — the `TenantStatus.reason` field flows to the wire via the admin router (`GET /tenants/:id`, `POST /tenants/:id/recheck`), and three sites projected upstream `err.message` into the reason without scrubbing.

Fixes four sites:
- `src/lib/server/decisioning/tenant-registry.ts:399` — JWKS fetch failure (network errors can echo basic-auth-bearing URLs).
- `src/lib/server/decisioning/tenant-registry.ts:416` — JSON parse failure on JWKS body.
- `src/lib/server/decisioning/tenant-registry.ts:834` — adopter validator throw (custom validators may include credential bytes in their error messages).
- `src/lib/server/decisioning/admin-router.ts:94` — `recheck` route's catch-all 500 handler.

The redactor scrubs Bearer tokens, JSON-quoted credential properties, unquoted credential properties, URL-embedded basic-auth, and long token-shaped strings. Already-redacted strings pass through unchanged (idempotent), so propagation paths that concatenate upstream reasons (`tenant-registry.ts:850, 856`) are safe automatically.

4 new tests at `test/server-decisioning-tenant-registry-redaction.test.js` cover Bearer-token redaction, labeled-credential redaction, URL-embedded credential redaction, and benign-error pass-through.

No behavior change for adopters whose validators don't carry credentials in error messages.
