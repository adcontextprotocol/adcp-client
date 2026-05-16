---
'@adcp/sdk': patch
---

fix(codegen): pre-merge `allOf: [{ $ref }]` siblings into parent shape (#1756)

`json-schema-to-typescript` mishandles JSON Schema objects that combine `properties` / `required` at their own level with an `allOf: [{ $ref }]` sibling — instead of emitting `BaseFields & { variant-specific }` it emits a broken union `( BaseFields | { variant-specific + duplicated base fields } )`. This is most visible inside `oneOf` discriminator variants, where the success arm of `get_content_standards` collapsed to bare `ContentStandards`, silently dropping the variant's own `context` and `ext` fields.

`enforceStrictSchema` now pre-merges any `allOf` member that is a single `$ref` into the parent schema when the parent already declares its own `properties` / `required` — variant-level fields win on collision, and the base schema's `additionalProperties` is inherited only when the variant didn't override it. Refs we can't resolve through the cache (local `#/$defs/...` fragments, missing schemas) are left in place for jsts to handle as before. The `vendor-pricing-option`-style schemas — allOf-only at root, no sibling properties — are intentionally untouched.

Side effects on existing emitted types:

- `BriefAsset` and `CatalogAsset` change from `CreativeBrief & { asset_type: 'brief' }` / `Catalog & { asset_type: 'catalog' }` aliases to flat interfaces with the merged shape. Field set is identical; the named base reference is gone. Tracked as option 2 in the adcp#4510 acceptance criteria.
- `GetContentStandardsResponse` success variant now correctly includes its own `context?` and `ext?` fields alongside the merged `ContentStandards` shape (the bug this PR fixes).
- `CreativeBrief` is no longer transitively pulled into `tools.generated.ts` (it's still emitted in `core.generated.ts`); `src/lib/index.ts` re-exports it from `core.generated` instead.

Unblocks adcp#4510 (schema dedup spike), which the spec team reverted on the bug surfaced by this codegen path.
