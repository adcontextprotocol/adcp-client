---
'@adcp/sdk': major
---

**BREAKING (pre-GA):** rename `Account.metadata` → `Account.ctx_metadata` for naming consistency across DecisioningPlatform resources.

Account is now consistent with Product / MediaBuy / Package / Creative / Audience / Signal / RightsGrant: every resource uses `ctx_metadata` for adapter-internal state. The TMeta generic still flows through `DecisioningPlatform<TConfig, TMeta>` — only the field name on Account changes.

```ts
// Before:
accounts: {
  resolve: async () => ({
    id: 'pub_main',
    operator: 'mypub',
    metadata: { networkId: '12345', advertiserId: 'adv_xyz' },
    authInfo,
  }),
}
async createMediaBuy(req, ctx) {
  const networkId = ctx.account.metadata.networkId;
}

// After:
accounts: {
  resolve: async () => ({
    id: 'pub_main',
    operator: 'mypub',
    ctx_metadata: { networkId: '12345', advertiserId: 'adv_xyz' },
    authInfo,
  }),
}
async createMediaBuy(req, ctx) {
  const networkId = ctx.account.ctx_metadata.networkId;
}
```

**Operational difference vs other resources still applies:** Account `ctx_metadata` is NOT round-tripped through the SDK store — `accounts.resolve()` is called per-request, so the publisher is the canonical source of truth on every call. The SDK only round-trips `ctx_metadata` for resources where there's a producer/consumer split (Product attached on getProducts, hydrated on createMediaBuy). Naming is consistent; semantics still differ. Documented in `Account.ctx_metadata` JSDoc.

Migration: search-replace `metadata:` → `ctx_metadata:` inside Account literals (typically alongside `operator:`), and `account.metadata` → `account.ctx_metadata` in handler bodies. Pre-GA window — adopters in the field today are a small handful of training/spike codebases.

223 tests passing on focused suite (no regressions from rename).
