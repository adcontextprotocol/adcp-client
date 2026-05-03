---
'@adcp/sdk': patch
---

ci(codegen): regression guard for `{ [k: string]: unknown | undefined }` leaking back into generated `oneOf` arms. Closes #1380.

`tightenMutualExclusionOneOf` (`scripts/generate-types.ts`, shipped via #1325) inlines parent `properties` into each arm of an `oneOf` with `required + not.required` clauses, so adopters' typed builders compose with `Format['renders']` and similar fields under `--strict --noUncheckedIndexedAccess`. The new `scripts/check-no-loose-oneof.ts` walks `core.generated.ts` and `tools.generated.ts` after codegen and fails the build if any union variant is exactly the bare blob shape — the canonical signal that the preprocessor missed a future `oneOf` regression.

Wired as `npm run ci:codegen-strict`, runs in CI between the schema-sync check and the skill-sync check, and is included in `ci:pre-push`. The check passes against current generated types (regression baseline). Five unit tests in `test/check-no-loose-oneof.test.js` lock the bug-pattern recognition: union arm flagged, freeform-blob alias allowed, nested property allowed, typed index signature allowed, interface property union flagged.

Allowlist mechanism present (currently empty) for cases where a bare-blob union arm is intentional — populate per-PR with rationale if any spec change ever genuinely needs it.
