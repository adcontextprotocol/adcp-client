---
'@adcp/sdk': minor
---

feat(server): BuyerAgentRegistry — Phase 1 Stage 3 (credential synthesis + ResolvedAuthInfo migration)

Phase 1 Stage 3 of #1269 — wires the kind-discriminated `AdcpCredential` from Stage 1 through the auth pipeline so `BuyerAgentRegistry` factory functions actually route on real credentials.

**Authenticators stamp `credential` on `AuthPrincipal`:**

- `verifyApiKey` → `{ kind: 'api_key', key_id: token }` (preserves an adopter-provided credential when present)
- `verifyBearer` → `{ kind: 'oauth', client_id, scopes, expires_at }`
- `verifySignatureAsAuthenticator` → `{ kind: 'http_sig', keyid, agent_url, verified_at }` when the verifier resolved an `agent_url` from the keyid; otherwise omitted

`serve.ts:attachAuthInfo` propagates `credential` into `info.extra.credential` so it round-trips through MCP's `AuthInfo` shape. The dispatcher hoists `extra.credential` onto top-level `ctx.authInfo.credential` and passes it to `agentRegistry.resolve` — `signingOnly`, `bearerOnly`, and `mixed` factories now route on actual credentials instead of returning `null` for every request.

**`ResolvedAuthInfo` migration shim** — additive, two-minor cycle:

- N (this release): `credential?: AdcpCredential`, `agent_url?: string` (informational, post-resolution), `operator?: string` added alongside legacy `token` / `clientId` / `scopes`. Legacy fields tagged `@deprecated` in JSDoc; framework continues to populate them for adopter compatibility.
- N+1: framework warns once per process when adopter `authenticate` returns the legacy shape without `credential`.
- N+2: legacy fields removed.

Adopters with custom `authenticate` callbacks can stamp `credential` directly on the returned `AuthPrincipal` to opt in. Custom callbacks that don't migrate see `BuyerAgentRegistry.resolve` return `null` (no credential = no known agent) — preserving the strict-opt-in invariant from Stage 2.

When `BuyerAgentRegistry` resolves an agent, the framework also stamps the informational top-level `ctx.authInfo.agent_url` so adopters reading it see the registry's canonical view. Security-relevant decisions MUST still read from `credential.agent_url` (verified, `http_sig`-only) — the top-level field is informational per the spec semantics in adcontextprotocol/adcp#3831.

`HandlerContext.authInfo` (v5 surface) and `ResolveContext.authInfo` (v6) both extended with the new fields. v6 `RequestContext` does not expose `authInfo` directly — handlers see `ctx.account` and `ctx.agent`; per-request credential identity flows to `accounts.resolve` and registry resolution.

9 new tests cover: each authenticator's credential synthesis (verifyApiKey static + dynamic + adopter-credential preservation); dispatcher hoist; live registry routing for signingOnly / bearerOnly / mixed; legacy shape continues to work without `credential`. Full suite: 7299 pass, 0 fail.

Phase 2 (#1292) — framework-level billing-capability enforcement and AdCP-3.1 error-code emission — is still gated on the SDK's 3.1 cutover.
