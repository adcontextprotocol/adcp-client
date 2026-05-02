---
"@adcp/sdk": minor
---

New `accountStoreWithNoAccountFallback<TCtxMeta>({ noAccountFallback, resolve })` helper in `@adcp/sdk/server`. Builds an `AccountStore` whose `resolve(undefined, ctx)` is guaranteed to return a non-null `Account<TCtxMeta>` — fixes the no-account-tool footgun where `preview_creative` / `list_creative_formats` / `provide_performance_feedback` / `tasks_get` arrive without an `account` wire field and the typed handler signature (`ctx.account: Account<TCtxMeta>`, non-optional) crashed at runtime on `ctx.account.ctx_metadata` (#1327).

Also adds `defineAccountStore<TCtxMeta>(store)` — the type-level identity helper that pins `TCtxMeta` on inline `accounts: { resolve: ... }` literals, matching the existing `defineSalesPlatform` / `defineCreativeBuilderPlatform` pattern.

Adopters claiming `creative-template`, `creative-generative`, `creative-ad-server`, or `signal-marketplace` (any specialism that exercises a no-account tool) should wrap their `accounts` field with `accountStoreWithNoAccountFallback`. Adopters who don't claim those specialisms keep using `defineAccountStore` or a plain `AccountStore` literal — no change.
