---
"@adcp/client": minor
---

Add `MonotonicViolationHint` to `StoryboardStepHint` taxonomy (issue #948).

When the `status.monotonic` cross-step assertion detects a lifecycle-status regression, it now emits a structured `MonotonicViolationHint` into `StoryboardStepResult.hints[]` alongside the existing prose `AssertionResult`. The hint carries `task`, `step_id`, `resource_type`, `resource_id`, `previous_status`, `observed_status`, and `enum_schema_url` so renderers (Addie, CLI, JUnit) can build deterministic fix plans without parsing the prose error string.

Also adds an optional `getStepHints?(ctx, step): StoryboardStepHint[]` hook to `AssertionSpec` — the runner calls it after `onStep` so assertions can emit non-fatal structured hints as a side channel without changing the `AssertionResult[]` return type.
