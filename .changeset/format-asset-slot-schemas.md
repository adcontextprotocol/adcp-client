---
"@adcp/sdk": minor
---

Add Zod schemas for format asset slot shapes: `FormatAssetSlotSchema`, `IndividualAssetSlotSchema`, `RepeatableGroupSlotSchema`, all 14 per-type individual slot schemas (`IndividualImageAssetSlotSchema`, `IndividualVideoAssetSlotSchema`, …), and matching group slot schemas. These are hand-authored companions to the existing TS types in `format-asset-slots.ts`, enabling runtime validation of `Format.assets[]` from `listCreativeFormats()` without consumers having to maintain their own Zod union.
