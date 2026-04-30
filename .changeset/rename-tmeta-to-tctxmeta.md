---
"@adcp/sdk": patch
---

Rename generic type parameter `TMeta → TCtxMeta` across all v6.0 server-platform interfaces (`DecisioningPlatform`, `SalesPlatform`, `AccountStore`, `Account`, and all specialism interfaces). Non-breaking — TypeScript generic parameter names are positional; no adopter code references `TMeta` by name. Aligns the parameter name with the `ctx_metadata` field it parameterizes, resolving IDE-hover ambiguity introduced by the `Account.metadata → Account.ctx_metadata` rename in 5a490534.
