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

Backwards-compatible: `ctx` is optional on the platform side, so existing implementations that don't accept the second arg keep working.
