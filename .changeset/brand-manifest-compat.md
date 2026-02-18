---
"@adcp/client": minor
---

Add backwards compatibility layer for BrandManifest -> BrandReference migration. The AdCP protocol replaced inline `brand_manifest` (BrandManifest object) with `brand` (BrandReference domain pointer). This release:

- Exports deprecated `BrandManifest`, `BrandManifestReference`, and `AssetContentType` types from `@adcp/client/types/compat`
- Exports `brandManifestToBrandReference()` conversion utility
- Adds `brand?: BrandReference` to `TestOptions` (replaces `brand_manifest`)
- Updates all internal testing scenarios and adapters to use the new `brand` field
