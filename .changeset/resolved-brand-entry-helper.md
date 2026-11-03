---
'@adcp/sdk': minor
---

Expose the registry resolver's optional complete `brand` entry on `ResolvedBrand` and add `selectBrandEntry` for independently fetched or cached brand.json documents. Preserve localized names, taglines, fonts, tone, and other identity fields without flattening them. Selection requires a unique match and never falls back to the first portfolio entry. Export the helper from the package root, brand, and client entrypoints.
