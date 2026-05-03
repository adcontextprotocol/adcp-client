---
'@adcp/sdk': minor
---

feat(adapters): `createOAuthPassthroughResolver` — factory for the canonical "Shape B" `accounts.resolve` pattern. Standardizes the `extract bearer → GET /me/adaccounts → match by id → return tenant with ctx_metadata` flow that every adapter wrapping a vendor OAuth + ad-account API (Snap, Meta, TikTok, LinkedIn, Reddit, Pinterest, etc.) re-derives by hand. Composes with `createUpstreamHttpClient`'s `dynamic_bearer.getToken` for per-buyer credential injection. Configurable `idField`, `rowsPath`, `getAuthContext`, and opt-in TTL cache (auth-context keyed so different buyers don't share entries). Closes #1363.
