---
'@adcp/sdk': patch
---

Forward `ResolveContext` to `AccountStore.upsert()` and `AccountStore.list()` (#1272).

Both methods now accept an optional `ctx?: ResolveContext` second argument, giving
multi-tenant adopters access to `ctx.authInfo` (the buyer's OAuth principal) at write
and read time — the same context already available in `resolve()` and `reportUsage()`.
The framework builds and forwards the context automatically; no call-site change is
needed for existing adopters who ignore the argument.

Without this, the only workaround was leaving `accounts.upsert` undefined (forcing
`UNSUPPORTED_FEATURE` on `sync_accounts`). Instance-field stashing and AsyncLocalStorage
both fail under the SDK's long-lived store contract.
