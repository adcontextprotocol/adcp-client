---
"@adcp/sdk": minor
---

`CreativeBuilderPlatform` and `CreativeAdServerPlatform` now expose an optional `listCreativeFormats` method, mirroring `SalesPlatform.listCreativeFormats`. Creative-template / creative-generative / creative-ad-server adopters that own a format catalog can wire it as a typed platform method instead of dropping to the v5 `opts.creative.listCreativeFormats` escape hatch (closes #1324).

Tool registration honours the existing precedence: when both `sales.listCreativeFormats` and `creative.listCreativeFormats` are wired on the same platform, the sales-side handler wins (mediaBuy domain registers before creative). Creative-only adopters get their wiring through the creative dispatcher.

The method is treated as a no-account tool (the wire request schema doesn't carry an `account` field) — adopters whose `accounts.resolve(undefined)` returns null receive `ctx.account === undefined` and must read defensively or use the new `accountStoreWithNoAccountFallback` helper (#1327).
