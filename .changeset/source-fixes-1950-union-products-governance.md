---
'@adcp/sdk': patch
---

fix: three source-side regressions surfaced by #1949's cluster-3 sweep (#1950 items 2, 3, 4)

**`getBestUnionErrors` walks `ZodIntersection` arms** (`src/lib/utils/union-errors.ts`). AdCP 3.1.0-beta.3 reshaped several response unions from bare `z.union([...])` to `z.object({...envelope...}).passthrough().and(z.union([...]))` — the required envelope-status fields became an outer object intersected with the union. The disambiguator previously looked for `_def.options` only on the top-level schema, so the intersection-wrapped form silently fell back to "Invalid input". Now unwraps one level of intersection (right arm first, then left) before walking variants. Affected tools: `create_media_buy`, `activate_signal`, `build_creative`, and any other response union that gained the envelope wrapper.

**`filterInvalidProducts` unwraps `ZodOptional<ZodArray>`** (`src/lib/utils/response-unwrapper.ts`). `get_products`'s `products` field is now optional (the `unchanged: true` wholesale-feed branch legitimately omits it) so the schema shape is `ZodOptional<ZodArray<...>>` rather than the bare `ZodArray<...>` we used to see. The helper's `instanceof ZodArray` guard failed, silently disabling the feature. Now unwraps `ZodOptional` / `ZodNullable` before the array check.

**`sync_governance` builder drops `categories` on `governance_agents[]`** (`src/lib/testing/storyboard/request-builder.ts`). 3.1.0-beta.3 tightened the items to `additionalProperties: false` and removed the deprecated `categories` array (single-agent-owns-full-lifecycle clarification). Storyboard fallback no longer emits the forbidden field.

**Source-side issue NOT fixed here**: schema-loader ambiguous-ref on bundled vs standalone `core/*` schemas (#1950 item 1) — needs careful design around Ajv's `$id` registration semantics across the bundled/standalone trees. Filed as a focused follow-up.

11 previously-skipped tests in `response-unwrapper.test.js`, `response-schema-validation.test.js`, and `request-builder-jsonschema-roundtrip.test.js` are flipped back on; the 2 tests still anchored to the old "non-union schema with required `products`" shape are repointed at `get_media_buy_delivery` (which still has required top-level fields).
