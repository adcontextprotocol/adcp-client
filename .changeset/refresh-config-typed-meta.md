---
'@adcp/sdk': patch
---

Decisioning: `RefreshConfig` propagates `TCtxMeta` to refresh hooks (#1168).

`AccountStore.refreshToken` is documented as receiving `Account<TCtxMeta>`, but the framework's internal `RefreshConfig` boxed the account through `Account<unknown>`, collapsing the parameterization at the `runWithTokenRefresh` boundary. Adopter hooks reading `account.ctx_metadata.upstreamRefreshToken` (etc.) saw `unknown` instead of their typed shape — the access compiled, but typo protection didn't surface.

Parameterized `RefreshConfig<TCtxMeta>` and threaded the generic through `runWithTokenRefresh<TCtxMeta, T>` and `projectSync<TResult, TWire, TCtxMeta>`. TypeScript now infers `TCtxMeta` from the dispatch site (`accounts.refreshToken.bind(accounts)` carries the AccountStore generic through), so adopter `refreshToken` impls receive a properly-typed Account.

Defaults to `unknown` for call sites that don't thread the generic — backward-compatible. Surfaced by code-reviewer on adcp-client#1165's review pass.
