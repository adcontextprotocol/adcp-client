---
"@adcp/sdk": minor
---

Tools whose wire request doesn't carry an `account` field — `preview_creative`, `list_creative_formats`, `provide_performance_feedback` — now use a new `NoAccountCtx<TCtxMeta>` request-context type whose `account` is `Account<TCtxMeta> | undefined`. Closes adcp-client#1327 — pre-fix, the typed handler signature claimed `ctx.account: Account<TCtxMeta>` (non-optional) while the framework dispatched these tools with `ctx.account === undefined` whenever `accounts.resolve(undefined)` returned null, producing runtime crashes (`Cannot read properties of undefined`) deep in adopter code. The narrow converts the runtime gate into a compile-time invariant — same shape as the `definePlatformWithCompliance` fix in #1262.

Affected interfaces:
- `CreativeBuilderPlatform.previewCreative?(req, ctx: NoAccountCtx<TCtxMeta>)`
- `CreativeBuilderPlatform.listCreativeFormats?(req, ctx: NoAccountCtx<TCtxMeta>)` (new in #1324)
- `CreativeAdServerPlatform.previewCreative(req, ctx: NoAccountCtx<TCtxMeta>)`
- `CreativeAdServerPlatform.listCreativeFormats?(req, ctx: NoAccountCtx<TCtxMeta>)` (new in #1324)
- `SalesPlatform.providePerformanceFeedback?(req, ctx: NoAccountCtx<TCtxMeta>)`
- `SalesPlatform.listCreativeFormats?(req, ctx: NoAccountCtx<TCtxMeta>)`

Migration for adopters: in handlers for these tools, narrow `ctx.account` before reading `ctx_metadata` / `id`. Three patterns:

```ts
// 1. Singleton fallback — return a non-null Account from accounts.resolve(undefined).
//    `ctx.account` is always defined; no narrow needed.

// 2. Auth-derived lookup — accounts.resolve(undefined, ctx) reads ctx.authInfo.clientId.

// 3. Defensive narrow inside the handler:
previewCreative: async (req, ctx) => {
  if (ctx.account == null) {
    throw new AdcpError('ACCOUNT_NOT_FOUND', { recovery: 'correctable', message: '...' });
  }
  const ws = ctx.account.ctx_metadata.workspace_id;
  // ...
}
```

This is a TypeScript-level breaking change for adopters who were dereferencing `ctx.account` unconditionally — the runtime behavior is unchanged. Adopters of `'derived'`-resolution stores that always return a singleton are unaffected at runtime, but the compiler will now require the narrow.
