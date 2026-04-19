---
'@adcp/client': patch
---

refactor: thread signing context via AsyncLocalStorage

Flattens the `signingContext` parameter that PR #593 pushed through nine function signatures in the MCP and A2A transports. Top-level entries (`callMCPTool`, `callMCPToolRaw`, `callMCPToolWithTasks`, `callA2ATool`) now push the context onto a new `signingContextStorage` AsyncLocalStorage for the duration of the call, and the internal helpers (`withCachedConnection`, `getOrCreateConnection`, `connectMCPWithFallback`, `getOrCreateA2AClient`, `createA2AClient`, `buildFetchImpl`) read it from storage instead of receiving it as a parameter. The public entry-point signatures are unchanged, so external callers and integration tests continue to pass `signingContext` explicitly.

Adds tests that fire interleaved concurrent `callTool`s with distinct signing identities to verify each sees its own context, and that a signing call followed by a non-signing call in the same async chain does not leak the stale context.
