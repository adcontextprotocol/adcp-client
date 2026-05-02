---
"@adcp/sdk": minor
---

`AccountStore.upsert` and `AccountStore.list` now receive an optional `ResolveContext` second argument. Closes #1310.

The framework forwards `authInfo`, `toolName`, and `agent` (when an `agentRegistry` is configured) — the same shape already threaded to `accounts.resolve`, `reportUsage`, and `getAccountFinancials`. Adopters can implement principal-keyed gates on `sync_accounts` / `list_accounts` (e.g. the spec's `BILLING_NOT_PERMITTED_FOR_AGENT` per-buyer-agent gate from adcontextprotocol/adcp#3851) without re-deriving identity from the request.

```ts
accounts: {
  upsert: async (refs, ctx) => {
    if (!agentMayBillVia(ctx?.agent, refs[0].billing)) {
      throw new AdcpError('BILLING_NOT_PERMITTED_FOR_AGENT', { recovery: 'terminal' });
    }
    // ...
  },
  list: async (filter, ctx) => {
    // Scope the listing to the calling agent's accounts.
    return db.accounts(filter, { agentUrl: ctx?.agent?.agent_url });
  },
}
```

Backwards-compatible at the type level: `ctx` is optional on the platform side, so existing implementations that don't accept the second arg keep compiling.

**Security-relevant migration note for multi-tenant adopters.** Pre-this-release, adopters had no way to scope `accounts.list` per-principal — implementations either returned all accounts (over-disclosure) or rejected the operation. Post-this-release, scoping becomes possible. **This is opt-in, not automatic.** Multi-tenant adopters should add principal scoping in the upgrade:

```ts
list: async (filter, ctx) => {
  // Scope to the calling agent's accounts. Without this, every authenticated
  // caller sees every account.
  return db.listAccounts(filter, { agentUrl: ctx?.agent?.agent_url });
},
```
