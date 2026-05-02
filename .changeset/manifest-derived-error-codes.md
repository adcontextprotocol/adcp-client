---
"@adcp/sdk": patch
---

feat(codegen): derive `STANDARD_ERROR_CODES` from `manifest.json`

AdCP 3.0.4 ships `/schemas/{version}/manifest.json` (adcp#3738, closes adcp#3725) — a single canonical artifact carrying 51+ tools with `protocol`/`mutating`/specialism mappings, 45 error codes with structured `recovery`/`description`/`suggestion`, and an `error_code_policy.default_unknown_recovery` block.

This is the first stage of #1192 (manifest adoption). Replaces the hand-curated `STANDARD_ERROR_CODES` table in `src/lib/types/error-codes.ts` (45 entries, condensed from prose) with one derived directly from the manifest. Drift between SDK and spec is now impossible by construction — re-running `npm run generate-manifest-derived` regenerates the table from the cache.

What landed:

- New `scripts/generate-manifest-derived.ts` reads `schemas/cache/{version}/manifest.json` and emits `src/lib/types/manifest.generated.ts` with `STANDARD_ERROR_CODES_FROM_MANIFEST`, per-protocol `*_TOOLS_FROM_MANIFEST` arrays, `SPECIALISM_REQUIRED_TOOLS`, and `DEFAULT_UNKNOWN_RECOVERY`. Wired into `npm run generate-types`.
- `src/lib/types/error-codes.ts` now imports from the generated file. Public API unchanged: `STANDARD_ERROR_CODES`, `StandardErrorCode`, `ErrorRecovery`, `ErrorCodeInfo`, `isStandardErrorCode`, `getErrorRecovery` all retain their previous shape. New export: `DEFAULT_UNKNOWN_ERROR_RECOVERY`.
- The `satisfies Record<StandardErrorCode, ErrorCodeInfo>` assertion is preserved; CI catches any drift at typecheck.
- Pre-existing drift test (`test/lib/standard-error-codes-drift.test.js`) continues to pass.

Cross-checked: the manifest's 45 codes match the previous hand-curated 45 exactly (no missing codes, no recovery mismatches). Every entry now also exposes `suggestion` where the spec provides one — surfaced through `STANDARD_ERROR_CODES[code].suggestion`.

What's NOT in this stage (tracked in #1192):

- Migrating `*_TOOLS` arrays in `src/lib/utils/capabilities.ts` to manifest-derived. The hand-curated arrays cross-list multi-protocol tools (e.g., `list_creative_formats` in both `MEDIA_BUY_TOOLS` and `CREATIVE_TOOLS`); the manifest assigns each tool a single primary `protocol`. Stage 2 needs a design pass on whether to derive cross-listing from `specialisms` or keep manual.
- Compile-time `RequiredPlatformsFor<S>` extension for specialism→required-tools enforcement.
