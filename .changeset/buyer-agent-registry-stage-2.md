---
'@adcp/sdk': minor
---

feat(server): BuyerAgentRegistry — Phase 1 Stage 2 (resolve seam + ctx threading)

Phase 1 Stage 2 of #1269 — wires the `BuyerAgentRegistry` into the dispatcher between authentication and account resolution. The resolved `BuyerAgent` is threaded through `ctx.agent` to `resolveAccount`, `resolveAccountFromAuth`, `resolveSessionKey`, the v6 `RequestContext`, and the v6 `AccountStore.resolve` ctx.

Strict opt-in: when `agentRegistry` is unset on `AdcpServerConfig` (or `DecisioningPlatform.agentRegistry` for v6 adopters), `ctx.agent` stays `undefined` and the framework's request flow is unchanged.

Behavior:

- Registry returns a `BuyerAgent` → framework freezes the record (and its `billing_capabilities` Set's own properties) and sets `ctx.agent`. Note: `Object.freeze` on a `Set` does NOT protect the internal `[[SetData]]` slot — `.add()` / `.delete()` / `.clear()` still mutate. `ReadonlySet` is a TypeScript-only contract; adopters MUST NOT rely on freeze preventing membership changes at runtime.
- Registry returns `null` → `ctx.agent` stays undefined; dispatch continues. Status enforcement (`suspended` / `blocked`) and per-agent billing rejection are Stage 4 / Phase 2 (#1292) work.
- Registry throws → framework returns `SERVICE_UNAVAILABLE`. Inner error logged server-side.

The resolve seam runs **before** account resolution and the idempotency-key shape gate, so:

- `resolveAccount(ref, { agent })` and `resolveAccountFromAuth({ agent })` see the resolved buyer agent.
- `accounts.resolve(ref, { agent })` on the v6 `AccountStore` receives it through `ResolveContext.agent`.
- `resolveSessionKey({ agent })` sees it.
- The v6 `RequestContext.agent` is populated for specialism handlers via `buildRequestContext`.

Stage 3 will populate `ResolvedAuthInfo.credential` (kind-discriminated variant) so the factory functions (`signingOnly` / `bearerOnly` / `mixed` from Stage 1) actually route. Until then, the seam is structurally present but factories return `null` for `credential === undefined`, so Stage 2 alone is functionally inert for adopters who haven't synthesized credentials themselves.
