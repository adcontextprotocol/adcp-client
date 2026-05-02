---
"@adcp/sdk": minor
---

`CreativeBuilderPlatform.listCreativeFormats?` and `CreativeAdServerPlatform.listCreativeFormats?` are now modeled on the typed v6 platform interfaces and dispatched through `buildCreativeHandlers`. Closes adcp-client#1324 — pre-fix, every `creative-template` / `creative-generative` / `creative-ad-server` adopter that owned a format catalog had to drop down to the v5 escape hatch (`opts.creative.listCreativeFormats`) because the typed-platform path didn't carry the surface.

The dispatch is no-account: the framework calls `accounts.resolve(undefined)` for the request (the wire schema doesn't carry an `account` field), so the typed signature uses `NoAccountCtx<TCtxMeta>` (see the #1327 changeset) — adopters who read `ctx.account.ctx_metadata` get a compile-time error and must narrow.

Adopters who delegate format definitions via `capabilities.creative_agents` continue to omit the method; the framework returns `UNSUPPORTED_FEATURE` to buyers, same as before.
