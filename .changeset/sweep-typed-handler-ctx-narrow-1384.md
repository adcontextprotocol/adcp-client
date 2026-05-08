---
'@adcp/sdk': patch
---

fix(framework): remove duplicate `listCreativeFormats` declarations on `CreativeBuilderPlatform` / `CreativeAdServerPlatform` (#1384)

Both interfaces previously declared `listCreativeFormats` twice — once correctly as `NoAccountCtx<TCtxMeta>` (matching the dispatch reality that no-account tools may receive `ctx.account === undefined`) and a second time as `Ctx<TCtxMeta>` (claiming `account` non-optional). TypeScript overload resolution on the implementation site preserved the narrow (so adopters were not silently exposed to the runtime crash #1327 fixed for `previewCreative`/`providePerformanceFeedback`), but the duplicate was a footgun for adopters reading the interface and a tripwire for future refactors.

Removed the `Ctx`-typed declaration on both interfaces, folded the precedence note into the surviving `NoAccountCtx` declaration on `CreativeBuilderPlatform`, and added regression locks in `decisioning.type-checks.ts` to prevent the duplicate from regressing.

This sweep also re-verified the rest of the typed-handler ctx surface introduced by #1327: `ctx.agent`, `ctx.ctxMetadata`, `ctx.recipes`, `ctx.handoffToTask`, `ctx.state.*`, and `ctx.resolve.*` all match their dispatch guarantees in `to-context.ts` / `from-platform.ts`. `ctx.authInfo`, `ctx.emitWebhook`, and `ctx.publishStatusChange` are not on `RequestContext` (they live on the legacy `HandlerContext` or as module-level exports) — out of scope for the typed-handler surface.
