---
'@adcp/sdk': patch
---

Select sized canonical creatives by the dimensions declared in catalog-backed legacy format IDs when the seller omits explicit `width` and `height` on its format references. This fixes `sync_creatives` and inline media-buy creative delivery to sellers listing one legacy ID per size, while preserving the seller's original format reference. Explicit reference dimensions remain authoritative. Missing size information on multi-size catalogs, unmatched sizes, and ambiguous selections still fail before dispatch; a single reference that contradicts the creative's dimensions is also refused.
