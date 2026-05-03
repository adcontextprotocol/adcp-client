---
'@adcp/sdk': minor
---

feat(server): `instructions` accepts a function form (lazy / per-session)

`createAdcpServer` and `DecisioningPlatform.instructions` now accept either a static `string` (the historical form) or a `(ctx: SessionContext) => string | undefined` function. Under the canonical `serve({ reuseAgent: false })` flow (the default) the factory runs per HTTP request, so the function fires per session — adopters can surface tenant-shaped prose (per-buyer brand manifests, storefront-platform copy, "premium vs standard" partner guidance) without hand-rolling a `Map` shim outside the SDK.

Closes #1347.

**Surface:**

```ts
import { createAdcpServer, type SessionContext, type OnInstructionsError } from '@adcp/sdk/server';

createAdcpServer({
  // existing string form still works
  instructions: 'Publisher-wide brand safety: alcohol disallowed.',

  // or function form — re-evaluated per createAdcpServer invocation
  instructions: (ctx: SessionContext) => brandManifests.get(currentTenant)?.intro,

  // throw semantics — default 'skip' (best-effort prose; throws resolve to no instructions)
  onInstructionsError: 'skip', // or 'fail' (rethrow → MCP initialize transport-level failure)
});
```

**Three guardrails:**

1. **`reuseAgent: true` + function-form is refused.** The function would only fire once for the lifetime of the shared agent — silently degrading to "instructions are a constant after all" is worse than failing loud. `serve()` returns 500 with a message naming the workaround (drop `reuseAgent: true` or pass a static string).
2. **Async return is not yet supported.** A function returning a `Promise` throws `ConfigurationError` at construction; pre-resolve before invoking `createAdcpServer` if you need to fetch.
3. **`SessionContext` is reserved.** `authInfo` and `agent` are typed for forward compatibility but currently always `undefined` — the framework does not yet plumb auth/registry state into the factory before MCP `initialize`. Use closures captured in your factory's HTTP-scoped state for tenant identity today; the function body picks up populated fields when the framework wires them through.

**Throw semantics:**

- `'skip'` (default) — log server-side, treat as `undefined` (no instructions). Right for prose-of-flavor (brand manifests, marketing copy) where a registry fetch failure must not kill the buyer's session.
- `'fail'` — rethrow. The MCP `initialize` handshake then fails at the transport layer (this is NOT an `adcp_error` envelope — it kills the session). Right for adopters whose instructions carry load-bearing policy where stale/missing guidance is worse than a connection retry.

**New exports** from `@adcp/sdk/server`:

- `SessionContext` — slim `{ authInfo?, agent? }`, both reserved for now.
- `OnInstructionsError` — `'skip' | 'fail'`.
- `ADCP_INSTRUCTIONS_FN` — symbol marker `serve()` reads to refuse the `reuseAgent: true` combination.

Plumbed through `DecisioningPlatform.instructions` (v6 surface) and `createAdcpServer.instructions` (v5 escape hatch); platform wins when both are set, same precedence pattern as `agentRegistry`.
