---
"@adcp/sdk": minor
---

`Account.authInfo` is now optional. Closes #1286.

Adopters who don't authorize against the principal in resource handlers can omit `authInfo` from the returned `Account` and pass strict typecheck. The field stays for adopters who *do* persist a principal — typically OAuth-style sellers who derive a tenant-scoped sub-principal from `ctx.authInfo` (`ResolvedAuthInfo`) and store it as `AuthPrincipal` on the Account.

Why optional rather than auto-attached: `Account.authInfo` is `AuthPrincipal` (the resolver's chosen persistence shape, with a `kind` discriminator), not `ResolvedAuthInfo` (the raw transport-level auth `serve({ authenticate })` extracts). The two types are intentionally distinct — the resolver decides which fields to keep / drop / re-shape. The framework can't cleanly auto-project one to the other. Adopters who want the principal threaded through set it explicitly:

```ts
accounts: {
  resolve: async (ref, ctx) => ({
    id: 'acct_123',
    name: 'Acme',
    status: 'active',
    ctx_metadata: { /* ... */ },
    // Optional. Set when handlers downstream need the principal:
    authInfo: ctx?.authInfo ? { kind: 'oauth', clientId: ctx.authInfo.clientId, ... } : undefined,
  }),
}
```

Backwards-compatible: existing adapters that already populate `authInfo` keep working; new/forked adapters omitting it now compile cleanly.
