---
"@adcp/sdk": patch
---

fix(normalizer): throw ValidationError on pre-3.0 PackageRequest shapes instead of silently passing them through

`normalizePackageParams` now throws `ValidationError` (code: `VALIDATION_ERROR`) when it encounters `packages[].product_ids` (plural array, pre-3.0) or `packages[].budget` as an object (pre-3.0 `{ total, currency }` shape). Both shapes cannot be translated to AdCP 3.0 equivalents without data loss (`product_ids[]→product_id`: which id wins? `budget:object→number`: which currency?). Previously they silently reached 3.0-strict sellers and caused `INVALID_REQUEST` rejections. Now callers get an early, actionable error at the client boundary.

Also fixes a TypeScript-only cast in `request-builder.ts` (`baseSample.budget as number | undefined`) that did not guard at runtime — replaced with `typeof baseSample.budget === 'number'` check so storyboard fixtures with object budgets are correctly dropped in favour of discovery-derived values.

v2 sunset policy: v2 unsupported as of 3.0 GA (April 2026); no translation obligation.
