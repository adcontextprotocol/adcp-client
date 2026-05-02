---
"@adcp/sdk": patch
---

`Format.renders[]` codegen now extracts each `oneOf` branch as a closed shape — `{ role; dimensions; ... }` and `{ role; parameters_from_format_id: true }` — instead of collapsing the first branch to `{ [k: string]: unknown }`. Closes adcp-client#1325. The SDK's typed render factories (`displayRender`, `parameterizedRender`, `templateRender`) now compose cleanly with `Format['renders']` under `--strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes`.

Implementation: a new `flattenMutualExclusiveOneOf` preprocess in `scripts/generate-types.ts` detects the JSON Schema "X xor Y" idiom (`oneOf` branches with `{ required: [X], not: { required: [Y] } }` and no other keys) and inlines the parent's `properties` into each branch with the excluded fields removed. The mutual-exclusivity constraint stays enforced at runtime by Ajv against the unstripped schema; the codegen pass only widens what TypeScript can express. Same fix applied to `sync_plans` plan budget (`reallocation_threshold` xor `reallocation_unlimited`), which had the identical loose-arm shape.

`RenderDimensions.unit` is now `DimensionUnit` (the schema enum: `'px' | 'dp' | 'inches' | 'cm' | 'mm' | 'pt'`) instead of an open `string` — adopters who passed `unit: 'feet'` or other off-spec strings will now see a TS error. Closes adcp-client#1325.
