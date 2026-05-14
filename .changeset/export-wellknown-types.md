---
'@adcp/sdk': minor
---

Re-export `BrandJson`, `AdagentsJson`, and their Zod schemas (`BrandJsonSchema`, `AdagentsJsonSchema`) from `@adcp/sdk`. Adopters resolving brand.json / adagents.json can now derive types directly from the canonical schemas instead of hand-rolling interfaces that drift from the spec (e.g. `type BrandDefinition = Extract<BrandJson, { brands: unknown[] }>['brands'][number]`). Closes #1739.
