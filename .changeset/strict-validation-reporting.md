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

The runner aggregates the verdicts into a new
`StoryboardResult.strict_validation_summary`:

```ts
{
  checked: number;  // response_schema checks with an AJV validator available
  passed: number;   // of checked, how many the agent passed under strict semantics
  failed: number;   // checked - passed
  delta: number;    // lenient-pass ∧ strict-fail — the agent's strictness gap
}
```

`delta` is the signal agent developers need: responses that cleared Zod
passthrough but fail AJV's `format: uri`, pattern, and other keywords Zod
doesn't enforce on generated schemas. A green lenient run with `delta > 0`
tells the developer their agent isn't yet production-ready for strict
dispatchers, even though it passes today's test suite.

Helper `summarizeStrictValidation(phases)` is exported from
`@adcp/client/testing` so dashboards and CI formatters can compute the
same summary over a filtered subset of phases without re-running
validation.

Absent when a run has no AJV-checkable `response_schema` validations —
typical for storyboards dominated by `field_present` / `error_code` /
`assertion` checks, and for tasks whose schema ships outside the
`bundled/` tree the AJV loader walks today (notably brand-rights and
governance schemas).
