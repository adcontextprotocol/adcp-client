---
'@adcp/sdk': minor
---

Add buyer-side creative delivery helpers for sellers without a creative library. `supportsSyncCreatives(caps)` now keys off `creative.has_creative_library`, and `inlineCreativesForPackages()` projects creative assets into package-scoped `packages[].creatives` payloads for create/update media-buy fallback flows.
