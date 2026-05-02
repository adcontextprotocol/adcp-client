---
"@adcp/sdk": patch
---

Forward `authInfo`, `agent`, and `toolName` from request context to `AccountStore.upsert` and `AccountStore.list`. Adds optional `ctx?: ResolveContext` second parameter to both methods (non-breaking — existing implementations compile and run unchanged). Also fixes the same `ctx.agent` omission in the existing `reportUsage` and `getAccountFinancials` dispatchers. Unblocks principal-based billing gates on `sync_accounts` (adcp spec PR #3851).
