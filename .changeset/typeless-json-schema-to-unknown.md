---
'@adcp/client': patch
---

Generator: typeless JSON Schema properties now emit `unknown` instead of `Record<string, unknown>`.

JSON Schema properties declared with only a `description` (no `type`, `$ref`, combinator, enum, or structural keyword) are defined by the spec to accept any JSON value — scalar or object. `json-schema-to-typescript` defaults these to `{ [k: string]: unknown }`, which downstream Zod generation then narrowed to `z.record(z.string(), z.unknown())`. That schema rejected scalar values the spec legitimately allows, e.g. a number returned for `check_governance` `conditions[].required_value`.

`enforceStrictSchema` in `scripts/generate-types.ts` now annotates schema nodes whose keys are all metadata-only (`description`, `title`, `$comment`, `examples`, `default`, `deprecated`, `readOnly`, `writeOnly`, `$id`, `$anchor`, `$schema`) with `tsType: 'unknown'` before handing them to `json-schema-to-typescript`, so the emitted TS is `unknown` and the Zod mirror is `z.unknown()`. Validation-only keywords like `required` (common in `anyOf` branches on request schemas) are not metadata, so constraints still compose. The recursion now also reaches `patternProperties`, schema-valued `additionalProperties`, `not`, `if`/`then`/`else`, `contains`, `propertyNames`, `unevaluatedItems`/`unevaluatedProperties`, and schema-valued `dependencies`/`dependentSchemas`.

Side fix: `removeNumberedTypeDuplicates` now iterates passes (up to 10) until no further collapses occur. Nested numbered references (e.g. `CatalogFieldMapping2` references `ExtensionObject32`) previously caused the outer duplicate to fail body comparison and stay in the output; they now collapse once the inner reference resolves on an earlier pass.

Regenerated affected types in `src/lib/types/*.generated.ts`. Notable corrections:

- `CheckGovernanceResponse.conditions[].required_value`: `Record<string, unknown>` → `unknown`.
- `CatalogFieldMapping.value` / `.default`: `Record<string, unknown>` → `unknown`.
- `Response.data`: `Record<string, unknown>` → `unknown`.

If you narrowed one of these fields with `as Record<string, unknown>`, replace with a value-shape assertion appropriate to the spec.
