---
"@adcp/sdk": minor
---

`AccountStore.syncGovernance` — typed `sync_governance` surface promoted to v6 platform. Closes one of the items tracked in #1387.

Buyers register governance agent endpoints per-account via `sync_governance`; the seller persists the binding and consults the registered agents during media buy lifecycle events via `check_governance`. Pre-this-release, adopters wired this through the v5 escape-hatch (`opts.accounts.syncGovernance`), which forced `as any` casts to satisfy the framework's merge-seam types. Now it's a typed method on `AccountStore` symmetric with `upsert` / `list`:

```ts
accounts: AccountStore<TenantMeta> = {
  resolve: async (ref, ctx) => { /* ... */ },
  upsert: async (refs, ctx) => { /* sync_accounts */ },
  syncGovernance: async (entries, ctx) => {
    // Per-entry tenant-isolation gate. ctx.agent is the auth-resolved
    // BuyerAgent — assert each entry's account.operator maps to the same
    // tenant before persisting. Per-entry rejection (vs. operation-level
    // throw) so a single bad entry doesn't fail the whole batch.
    const homeTenantId = ctx?.agent ? BUYER_HOME_TENANT.get(ctx.agent.agent_url) : undefined;
    return entries.map(entry => {
      const tenantId = OPERATOR_TO_TENANT.get(entry.account.operator);
      if (!homeTenantId || tenantId !== homeTenantId) {
        return {
          account: entry.account,
          status: 'failed',
          errors: [{ code: 'PERMISSION_DENIED', message: '...' }],
        };
      }
      // persist binding...
      return { account: entry.account, status: 'synced', governance_agents: [...] };
    });
  },
};
```

The signature takes the wire entries (`SyncGovernanceRequest['accounts']`) directly — each entry pairs an `AccountReference` with its `governance_agents[]`. Framework strips `idempotency_key` / `adcp_major_version` / `context` / `ext` (already deduped) and wraps the returned rows in `{ accounts: rows }` for the wire response.

**Security: write-only credentials are stripped at the wire boundary.** Per spec, each `governance_agents[i].authentication.credentials` is the bearer the seller will present on outbound `check_governance` calls — the buyer sends it, the seller persists it, but it MUST NOT echo back. The framework now strips `authentication` from every `governance_agents[i]` of every row before serialization, in both `syncGovernanceResponse` (the wire-emit boundary that covers v5 escape-hatch adopters) and the v6 dispatcher (`toWireSyncGovernanceRow`). Adopters can return loosely-typed rows or spread the input agent without leaking credentials over the wire OR into the idempotency replay cache. Defense-in-depth — TypeScript narrowing alone is insufficient because excess-property checks don't fire on assigned variables and the response Zod schema uses `.passthrough()`.

Backwards-compatible: `syncGovernance` is optional on `AccountStore`. Adopters using the v5 escape-hatch (`opts.accounts.syncGovernance`) keep working unchanged — the v6 typed surface takes precedence when both are set. Adopters who haven't wired `sync_governance` at all continue to see the framework's `UNSUPPORTED_FEATURE` envelope.
