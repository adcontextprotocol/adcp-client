---
'@adcp/sdk': minor
---

Add `treatOptionalNullsAsAbsent` to `@adcp/sdk/schemas`, which reads an agent's explicit `null` as an omitted field wherever a generated schema declares the field optional and non-nullable, so one unreported hint no longer discards a whole response. Nullable fields keep their `null` as a value, required and `z.never()` fields keep their `null` and still fail validation, undeclared keys pass through, and the input payload is never mutated. The walk recurses through nested objects and arrays and consults both sides of the intersections that JSON Schema `allOf` projects into, so it covers 80 of the 87 generated `*ResponseSchema` roots; union-rooted schemas are left untouched. Removes the never-called `postProcessForNullish` transform from the Zod generator, which read as live behavior to anyone auditing it.
