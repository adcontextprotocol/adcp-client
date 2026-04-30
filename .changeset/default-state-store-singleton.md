---
'@adcp/sdk': patch
---

Fix `ctx.store` losing state across requests when adopters use the documented `serve(() => createAdcpServer({...}))` factory pattern.

**Root cause:** `createAdcpServer({stateStore = new InMemoryStateStore()})` evaluated the destructuring default per call. Since `serve()` invokes the factory on every incoming request, each request got a brand-new in-memory store — silently dropping every prior `ctx.store.put(...)`.

**Empirical evidence:** matrix run reproduced an LLM-built SI agent that put session state in `ctx.store.put('session', ...)` on `si_initiate_session` and got `RESOURCE_NOT_FOUND: Session not found` on the next request's `si_send_message`. The agent code was textbook-correct per the skill — the framework default was the bug.

**Fix:** the default `InMemoryStateStore` is now a module-singleton. Adopters who write the obvious code get cross-request persistence as the skills (creative, SI, etc.) explicitly promise. Multi-tenant adopters and production deployments still pass their own `stateStore` (Postgres, Redis, etc.) and are unaffected. Existing tests that need isolation already opt into a fresh store explicitly.

Also hardens the matrix harness's `killPort()` to sweep orphaned `tsx adcp-agent-*` zombies that survived a parent `pkill` against the matrix runner — needed to prevent cross-run port contamination.

Regression test added at `test/server-state-store-extensions.test.js`: two `createAdcpServer` factory invocations must share `ctx.store`, and a value put through one must be readable through the other.
