---
'@adcp/sdk': patch
---

Document stateless BYOK provider auth for single-account adapters. Adds the single-plane Bearer pattern (provider credential presented as the AdCP request credential) to the bundled `BUILD-AN-AGENT.md` guide and the account-resolution guide, covering token read paths (`ctx.account.authInfo?.token` with `ctx.authInfo.token` fallback), non-secret identity for cache/idempotency scoping, request-local handling guardrails, and when a separate dual-auth provider channel is warranted. Also corrects the protocol auth note: SDK clients send `Authorization: Bearer <token>` with legacy `x-adcp-auth` as a compatibility fallback.
