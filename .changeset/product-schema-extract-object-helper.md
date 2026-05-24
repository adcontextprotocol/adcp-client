---
"@adcp/sdk": minor
---

Export `ProductObjectSchema` and `extractObjectSchema` to restore `.extend()` / `.omit()` / `.pick()` for consumers affected by the 8.1.0 `ProductSchema` shape change from `ZodObject` to `ZodIntersection`.

`ProductSchema` in 8.1.0-beta.* became a `ZodIntersection` (to accommodate V1/V2 format variants), which drops the `.extend()` / `.omit()` / `.pick()` methods that `ZodObject` exposes. Two additive exports restore the lost ergonomics without changing any existing schema shapes:

- **`ProductObjectSchema`** — a concrete `ZodObject` export for the most common case (`ProductSchema.extend(...)` → `ProductObjectSchema.extend(...)`).
- **`extractObjectSchema(schema)`** — a generic helper that extracts the right-side `ZodObject` from any `ZodIntersection<L, ZodObject<R>>` produced by the codegen, for the other 96 intersection-shaped schemas in 8.1+.

Also fixes the broken `ProductSchema.extend(...)` example in `docs/ZOD-SCHEMAS.md`.
