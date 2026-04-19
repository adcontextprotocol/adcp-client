---
'@adcp/client': minor
---

Conform storyboard runner and `comply()` output to the universal runner-output contract (#599, adcontextprotocol/adcp#2364).

A failing storyboard validation is only actionable when the report names the offending field, the expected value, what the runner observed, and which schema artifact to re-validate against locally. Previously the runner emitted `FAILED: schema_validation/capability_discovery — "Check agent capabilities"` with no structured detail — an implementor whose local AJV passed couldn't tell whether the issue was a missing field, a schema mismatch, a transport extraction bug, or a genuine agent bug. This release closes that gap.

**`ValidationResult` now carries machine-readable failure detail.** Every validation result populates the contract's required-on-failure fields:

- `json_pointer` — RFC 6901 pointer to the failing field (`/adcp/idempotency` instead of `adcp.idempotency`).
- `expected` — the schema `$id` for `response_schema`, the expected value / allowed_values for field checks, the expected status for HTTP checks, etc.
- `actual` — the observed value; for `response_schema` an AJV-style array of `{ instance_path, keyword, message }` so consumers can pinpoint every violation, not just the first.
- `schema_id` — the `$id` applied when `check === 'response_schema'`, e.g. `/schemas/latest/protocol/get-adcp-capabilities-response.json`.
- `schema_url` — resolvable URL for local re-validation, e.g. `https://adcontextprotocol.org/schemas/latest/protocol/get-adcp-capabilities-response.json`.

The existing `error` string is preserved as a human-readable fallback so current consumers continue to render a one-line message.

**`StoryboardStepResult` now carries the exact request, response, and extraction path.** New optional fields:

- `request_record` — transport + operation + fully-resolved payload the runner sent (secrets redacted).
- `response_record` — transport + observed payload + HTTP status/headers when applicable.
- `extraction` — `{ path: 'structured_content' | 'text_fallback' | 'error' | 'none' }` so an implementor can distinguish a runner extraction bug from an agent bug per `docs/building/implementation/mcp-response-extraction`. `path` is classified from the task result; `text_fallback` fires when the response unwrapper synthesized an error from non-JSON text content.

**Skip reasons now map to the contract enum with detail strings.** Step results use the contract's skip reasons — `not_applicable`, `no_phases`, `prerequisite_failed`, `missing_tool`, `missing_test_controller`, `unsatisfied_contract` — each carrying a `skip_detail` string that cites the advertised tools, missing tool, prerequisite step id, or contract key. The legacy reason values (`not_testable`, `dependency_failed`, `missing_test_harness`) remain in the type union so existing consumers don't break; the runner now emits the contract names (`dependency_failed` → `prerequisite_failed`, `missing_test_harness` → `missing_test_controller`, `not_testable` → `missing_tool`).

**`ComplianceFailure` surfaces the contract fields.** Each failure in `ComplianceResult.failures` now includes the failing validations with their `json_pointer` / `expected` / `actual` / `schema_id` / `schema_url`, the step's `extraction` path, and the recorded `request` / `response`. The plain-text `comply()` formatter also surfaces the failing field pointer, schema URL, and extraction path in its "How to Fix" section so reports are actionable without `--json`.

**Orchestrator**: `getScenarioSkips()` is a new helper that returns contract-shaped skip records (`reason` + `detail`) for scenarios not applicable to the agent's tool list. `testAllScenarios()` populates `SuiteResult.scenarios_skipped_detail`, and the markdown formatter renders each skip with its reason + detail so reports distinguish "scenario not applicable" from "agent claims the protocol but lacks a required tool."
