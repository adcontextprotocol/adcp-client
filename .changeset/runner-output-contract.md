---
'@adcp/client': minor
---

Conform the storyboard runner and `comply()` output to the universal
runner-output contract (adcontextprotocol/adcp PR #2364 / issue #2352).
Failure results are now actionable: the implementor can self-diagnose
a validation failure from the runner output alone, without re-running
the step by hand.

**New on every `ValidationResult`:**

- `json_pointer` — RFC 6901 pointer to the failing field
- `expected` / `actual` — machine-readable values (schema `$id`,
  allowed enums, observed value, etc.)
- `schema_id` / `schema_url` — set on `response_schema` checks so the
  implementor can re-validate locally against the same artifact
- `request` / `response` — exact bytes the runner sent and observed,
  attached on failure (not echoed on passing checks)
- For `response_schema` failures, `actual` is now an AJV-shaped
  `{ instance_path, schema_path, keyword, message }[]` instead of a
  flat message string.

**New on every `StoryboardStepResult`:**

- `extraction: { path: "structured_content" | "text_fallback" | "error" | "none" }`
  — records which MCP extraction path produced the parsed response so
  runner extraction bugs are separable from agent bugs. The response
  unwrapper and raw MCP probe stamp the provenance as a non-enumerable
  `_extraction_path` tag on the unwrapped `AdCPResponse`; the runner reads
  it via `readExtractionPath()` and surfaces it here. All four values are
  emitted in practice (previously `text_fallback` was unreachable).
- `request` / `response_record` — the full transport-level exchange
  (omitted for synthetic / skipped steps).
- `storyboard_id` — each step is self-describing.
- `skip: { reason, detail }` — structured skip result with
  human-readable explanation (agent tools, prerequisite step id, etc.).

**Spec-aligned skip reasons.** The narrow
`"not_testable" | "dependency_failed" | "missing_test_harness" | "missing_tool"`
enum is replaced by the six contract reasons:

| Reason | When it fires |
|---|---|
| `not_applicable` | Agent did not declare the protocol / specialism |
| `no_phases` | Storyboard is a placeholder with no executable phases |
| `prerequisite_failed` | Prior step or context variable did not produce a value |
| `missing_tool` | Agent did not advertise a required tool |
| `missing_test_controller` | Deterministic-testing phase needs `comply_test_controller` |
| `unsatisfied_contract` | A test-kit harness contract is out of scope |

**Top-level summary gains:**

- `total_steps`, `steps_passed`, `steps_failed`, `steps_skipped`
- `schemas_used: Array<{ schema_id, schema_url }>` — deduplicated list
  of schemas applied across the run so implementors can re-validate
  locally.

**`ComplianceFailure` carries the first failed validation's
machine-readable detail** (`json_pointer`, `expected`, `actual`,
`schema_id`, `schema_url`) under a `validation` field, and the terminal
formatter now renders `At:` / `Expected:` / `Actual:` / `Schema:` for
each failure instead of the single generic line
`"Check agent capabilities"`.

**Security hardening.** Request and response payloads echoed on failed
validations run through a recursive redactor that replaces values at
keys matching `/^(authorization|credentials?|token|api[_-]?key|…)$/i`
with `'[redacted]'`. Response headers are allowlisted — only
`content-type`, `content-length`, `content-encoding`,
`www-authenticate`, `location`, `retry-after`, `x-request-id`,
`x-correlation-id` pass through; `set-cookie`, `authorization`,
`x-internal-*`, `x-amz-*` etc. are dropped so a hostile agent cannot
bait the runner into publishing internal state in a shared compliance
report. Agent-controlled `error` / `validation.actual` strings in the
terminal formatter output are wrapped in the existing
`fenceAgentText()` nonce so downstream LLM summarizers can't be
hijacked by hostile error messages.

**Migration.** The changes are additive on `ValidationResult` /
`StepResult` / `ComplianceFailure`. The skip-reason enum is a
breaking rename. Call sites that pattern-match on the old values
(`"not_testable"`, `"dependency_failed"`, `"missing_test_harness"`)
need to migrate to the spec-aligned names above. The bundled CLI
(`bin/adcp.js`) is updated in-tree; the only user-visible surface
that still needs a migration is third-party automation that reads
`StoryboardStepResult.skip_reason` from the `--json` output.
