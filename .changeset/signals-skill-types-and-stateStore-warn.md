---
'@adcp/sdk': patch
---

Two follow-ups to the state-store singleton fix:

**Signals skill example fully typechecks.** The previous baseline accepted 5 type errors masked by a syntax error: `accounts.upsert/list` signatures (now omitted — they're optional on `AccountStore`), `activateSignal` returning `adcpError(...)` (replaced with `throw new AdcpError(...)` matching the success-arm-only return type), `ctx.store.put` (replaced with a publisher-internal `Map` — v6 `RequestContext` has no `store` field; persistence is the publisher's responsibility unless they wire a `CtxMetadataStore`). LLMs reading this skill now scaffold v6-correct code on first try. Baseline tightened (207 → 202 entries).

**Multi-tenant footgun warning on default `stateStore`.** `createAdcpServer` now emits a one-time `logger.warn` when the module-singleton default in-memory store is used. Single-tenant adopters (everything the skills demonstrate) see the message once at process start and ignore it; multi-tenant deployments see the warning and either pin an explicit per-tenant store or wire `PostgresStateStore`. Process-scoped guard so `serve(() => createAdcpServer({...}))` doesn't spam logs every request.

v6.0.1 will upgrade the warning to a `NODE_ENV=production` hard refusal, mirroring `buildDefaultTaskRegistry`'s task-registry policy — adopters set `ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1` to opt in explicitly. Tracked separately.
