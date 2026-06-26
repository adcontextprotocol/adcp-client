---
"@adcp/sdk": patch
---

Add `assetType` to `resolveCanonicalFormatKind` and `canonicalDeclarationFromBareId` so under-specified bare format ids can be disambiguated with the asset type adopters already store. `assetTypeHint` remains accepted as a backwards-compatible alias.
