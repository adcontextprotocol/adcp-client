---
'@adcp/sdk': patch
---

refactor(server): rename `TMeta` → `TCtxMeta` generic parameter across `DecisioningPlatform`, `SalesPlatform`, `AccountStore`, and per-specialism interfaces.

Type-only rename. The new name reads as "the type of the ctx_metadata blob" and aligns with the `Account.metadata → Account.ctx_metadata` rename that landed earlier in the 6.0 batch. No runtime impact; TypeScript inference at the call site (`class FooSeller implements DecisioningPlatform<Config, MyMeta>`) keeps working.

Closes #1083
