---
'@adcp/client': minor
---

`resolveAccount` now receives auth context, `checkGovernance` parses MCP envelope shapes correctly, and the seller skill documents alternative transports.

**`resolveAccount(ref, ctx)` now receives `{ toolName, authInfo }`.** Adapters that front an upstream platform API (Snap, Meta, TikTok, retail media networks) need the caller's OAuth token to look up the upstream account. Previously `authInfo` was only available inside handlers, forcing resolvers to return a thin stub and re-resolve the platform account on every handler call. Single-arg resolvers (`async (ref) => ...`) remain valid — TypeScript allows a shorter parameter list.

**`dispatchTestRequest(request, { authInfo })`.** Test harnesses can simulate the `authInfo` that `serve({ authenticate })` would populate, so `resolveAccount` and handler tests cover auth-sensitive paths without spinning up HTTP. Never mount this behind an HTTP route — `extras.authInfo` bypasses `authenticate`.

**`checkGovernance` now extracts from `structuredContent` or `content[0].text` before falling back to top-level fields.** Fixes a latent bug where the helper returned "missing required fields" when the governance agent responded with a conformant MCP `CallToolResult` envelope rather than spreading the payload at the root. The single-agent JSDoc example no longer references a fabricated `ctx.account.governanceAgentUrl` field — it now shows the real `sync_governance` → `Account.governance_agents[]` flow.

**Multi-agent governance helper is deferred** pending spec resolution on adcontextprotocol/adcp#3010 — `sync_governance` allows up to 10 governance agents per account but the `check_governance` request and the protocol envelope only thread a single `governance_context` per lifecycle. The SDK will ship an aggregation helper once the spec picks an interpretation.

**Skill docs.** `skills/build-seller-agent/SKILL.md` gains an Alternative Transports section covering the `createAdcpServer().connect(transport)` pattern — multi-host HTTP on a single process and stdio — for cases where `serve()`'s single-`publicUrl`-per-process model doesn't fit.
