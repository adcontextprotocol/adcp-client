---
'@adcp/sdk': patch
---

Restore `accepted_bases` and `accepted_verification_methods` on `DemographicTargetingIntent.age` as optional non-empty arrays of the existing age-determination and age-verification enums. Sellers can now inspect buyer provenance constraints using the generated TypeScript types. Add regression checks for bundled request fields, nested targeting properties, and age constraint typing.

Exclude schema-sync skill snapshots from published packages and account for approximately 5 KB of restored declarations in the compressed package-size budget.
