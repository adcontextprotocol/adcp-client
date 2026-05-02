---
"@adcp/sdk": minor
---

`listCreativeFormats?` added to `CreativeBuilderPlatform` and `CreativeAdServerPlatform`. Closes #1324.

Creative-agent adopters building against the v6 typed platform path can now wire `list_creative_formats` directly on the platform class, eliminating the need for the v5 escape hatch:

```ts
// Before — had to mix v6 typed + v5 untyped
creative: defineCreativeBuilderPlatform({
  buildCreative: async (req, ctx) => { ... },
}),
createAdcpServerFromPlatform(platform, {
  creative: { listCreativeFormats: async () => { ... } }, // untyped
});

// After — stays on the typed platform
creative: defineCreativeBuilderPlatform({
  buildCreative: async (req, ctx) => { ... },
  listCreativeFormats: async (req, ctx) => { ... }, // typed
}),
```

`listCreativeFormats` is optional — adopters who declare `creative_agents` in capabilities can omit it; the framework can discover formats from those references. The method carries a `⚠️ NO-ACCOUNT TOOL` JSDoc matching `SalesPlatform.listCreativeFormats`: the wire request carries no `account` field, so `ctx.account` may be `undefined` for `'explicit'`-resolution adopters.

Backwards-compatible: the method is optional (`?`) on both interfaces; existing adopters using the v5 escape hatch continue to work while they migrate.
