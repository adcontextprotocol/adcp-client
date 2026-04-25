---
'@adcp/client': minor
---

Strict discriminator types for creative assets, vendor pricing, and sync rows.

The codegen produces strict per-variant interfaces (`ImageAsset`, `CpmPricing`, etc.) but doesn't emit canonical discriminated unions over them. This release adds three hand-authored unions on top of the generated bases so handler authors can opt into compile-time discriminator checking instead of runtime schema validation:

- **`AssetInstance`** — discriminated union of every creative asset instance (`ImageAsset | VideoAsset | AudioAsset | TextAsset | HTMLAsset | URLAsset | CSSAsset | JavaScriptAsset | MarkdownAsset | VASTAsset | DAASTAsset | BriefAsset | CatalogAsset | WebhookAsset`), keyed on `asset_type`. Use as the value type for `creative_manifest.assets[<key>]`. Omitting `asset_type` or returning a plain `{ url, width, height }` against this type fails to compile.
- **`AssetInstanceType`** — the `asset_type` discriminator value union (`'image' | 'video' | …`). Useful for exhaustive switch-case helpers.
- **`SyncAccountsResponseRow`** — extracted named type for one row in `SyncAccountsSuccess.accounts[]`. Forces the `action` literal-union discriminator (`'created' | 'updated' | 'unchanged' | 'failed'`) and the `status` enum on every row at compile time.
- **`SyncGovernanceResponseRow`** — same pattern for `SyncGovernanceSuccess.accounts[]`. Forces the `status: 'synced' | 'failed'` discriminator.
- **Vendor-pricing exports completed** — `PerUnitPricing`, `CustomPricing`, `VendorPricing`, `VendorPricingOption` are now re-exported from `@adcp/client` (previously only `CpmPricing`, `PercentOfMediaPricing`, `FlatFeePricing` were).
- **Product-pricing exports completed** — `CPMPricingOption`, `VCPMPricingOption`, `CPCPricingOption`, `CPCVPricingOption`, `CPVPricingOption`, `CPPPricingOption`, `FlatRatePricingOption`, `TimeBasedPricingOption` re-exported (the union type `PricingOption` and `CPAPricingOption` were already exported).

Type tests in `src/lib/types/asset-instances.type-checks.ts` use `// @ts-expect-error` to lock in the constraints — if a future codegen regression loosens any discriminator (e.g., makes `asset_type` optional), `tsc --noEmit` fails on a now-unexpected error. The file uses the `.type-checks.ts` suffix (not `.test.ts`) so it participates in the project's normal `npm run typecheck` pass; explicitly excluded from `tsconfig.lib.json` so it doesn't ship in `dist/`.

Drift class this catches at compile time:

```ts
// Before: this slipped past TS, was caught only by runtime validator.
const asset: Record<string, unknown> = { url: '...', width: 1920, height: 1080 };
return { creative_manifest: { format_id, assets: { hero: asset } } };

// After: typed as AssetInstance, missing asset_type is a compile error.
const asset: AssetInstance = { url: '...', width: 1920, height: 1080 };
//                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// error TS2353: Object literal may only specify known properties, and
// 'url' does not exist in type 'AssetInstance'. Property 'asset_type'
// is missing.
```

This is dx-expert priority #3 from the matrix-v18 review (CI defenses #1 and #2 shipped in #945 and #957).
