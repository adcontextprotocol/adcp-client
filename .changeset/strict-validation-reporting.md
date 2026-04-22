---
'@adcp/client': minor
---

Storyboard runner: strict/lenient response-schema reporting (closes the
final proposal from #820).

`response_schema` validations now run the strict AJV path alongside the
existing lenient Zod check and record the strict verdict on each
`ValidationResult.strict` (new optional field). The step's pass/fail is
unchanged — it remains Zod-driven so existing tests and downstream
reporting stay backward-compatible. The strict verdict is additive
signal.

### Per-run summary

Every `StoryboardResult` now carries a `strict_validation_summary`:

```ts
{
  observable: boolean;         // false = no strict-eligible checks ran
  checked: number;             // response_schema checks with AJV coverage
  passed: number;              // of checked, how many cleared strict AJV
  failed: number;              // checked - passed
  strict_only_failures: number; // lenient-pass ∧ strict-fail — the #820 signal
  lenient_also_failed: number;  // failed - strict_only_failures
}
```

`strict_only_failures` is the actionable number. Responses that cleared
Zod passthrough but strict AJV rejected — typically `format: uri` or
pattern violations Zod's generated `z.string()` doesn't enforce. A green
lenient run with `strict_only_failures > 0` tells the developer their
agent isn't production-ready for strict dispatchers.

`observable: false` with zeroed counters signals "run had no
strict-eligible checks" (distinct from strict-clean). Dashboards and
JUnit formatters MUST check `observable` before rendering counts.

### New helpers exported from `@adcp/client/testing`

- `summarizeStrictValidation(phases)` — compute the summary over a
  filtered subset of phases (e.g. render per-phase rollups in a
  dashboard without re-running validation).
- `listStrictOnlyFailures(phases)` — flat drill-down list of every
  `strict_only_failure` with `{phase_id, step_id, task, variant,
  issues}` for triage. Direct path from `strict_only_failures: 7` to
  the seven offending responses without walking four levels of nested
  arrays.

### AJV coverage extended to flat-tree domains

The AJV schema loader now indexes `governance/`, `brand/`,
`content-standards/`, `account/`, `property/`, and `collection/`
alongside `bundled/`. This closes a coverage gap where
`strict_validation_summary` systematically under-reported for mutating
tasks whose schemas ship outside the bundled tree —
`check_governance`, `acquire_rights`, `creative_approval`,
`sync_governance`, `sync_plans`, CRUD on property_list / collection_list,
etc. Previously those validations returned `strict: undefined` and
didn't count toward `checked`; now they grade strict-eligible, so
`format: uri` violations on `caller` and `idempotency_key` pattern
mismatches (protocol-wide requirements per AdCP 3.0 GA) surface in the
strictness delta where they belong.

### Out of scope — tracked as follow-ups

- CLI summary line (`adcp storyboard run` prints the JSON field but no
  human-readable summary yet).
- `warning` field on strict-only failures so step-level output surfaces
  the top issue instead of only the nested `strict.issues[]`.
- Distinct signal when `selectResponseVariant` picks an async variant
  that has no schema and falls back to sync (protocol reviewer's
  follow-up #2).
- Per-field envelope validation (`replayed`, `operation_id`, `context`,
  `ext` value shapes) as a separate check type.
- Opt-in `--strict` CLI flag that gates CI on `strict_only_failures == 0`.
