---
"@adcp/sdk": patch
---

Add `examples/hello_creative_adapter_template.ts` — a worked, passing reference adapter for the `creative-template` specialism that wraps an upstream creative-template platform via HTTP. Companion to `hello_signals_adapter_marketplace`. Demonstrates the typed-platform `CreativeBuilderPlatform` shape (`buildCreative` + `previewCreative`), the v5 escape hatch for `list_creative_formats` (still pending on the v6 typed surface), the `accounts.resolve(undefined)` fallback for no-account tools, and the discriminated-union shape gotchas (`PreviewCreativeResponse` single-mode `previews[].renders[]` array, `Format.renders[]` `dimensions` object, `BuildCreativeReturn` 4-arm dispatch). Shipped with the same three-gate CI test (strict tsc / storyboard / upstream-traffic) as the signal-marketplace example.
