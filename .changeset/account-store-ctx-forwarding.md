---
"@adcp/sdk": patch
---

Forward `authInfo`, `agent`, and `toolName` from request context to `AccountStore.upsert` and `AccountStore.list`. Adds optional `ctx?: ResolveContext` second parameter to both methods (non-breaking — existing implementations compile and run unchanged). Also fixes the same `ctx.agent` omission in the existing `reportUsage` and `getAccountFinancials` dispatchers. Unblocks adopter-side principal-based billing gates on `sync_accounts` (adcp#3831); framework-level enforcement lands in Phase 2 (#1292).
