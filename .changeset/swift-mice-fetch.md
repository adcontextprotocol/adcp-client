---
'@adcp/sdk': minor
---

feat(testing): runner detects `force_scenario_unsupported` per AdCP 3.0.12 runner-output-contract

When a `comply_test_controller` step targets a `force_*` scenario that the agent advertises the controller for but does not implement (response `{success: false, error: 'UNKNOWN_SCENARIO'}`), the runner now grades the step `not_applicable` with detail `force_scenario_unsupported` BEFORE applying the step's authored validations. Previously the step failed its declared `success: true` check and the coverage gap looked like a real agent fault.

- New `RunnerDetailedSkipReason` variant `force_scenario_unsupported` (`src/lib/testing/storyboard/types.ts`), mapped onto canonical `not_applicable` via `DETAILED_SKIP_TO_CANONICAL`.
- Detection in `src/lib/testing/storyboard/runner.ts` before the early-exit unsupported-tool skip path, keyed on the tuple `(step.task === 'comply_test_controller', resolved scenario starts with 'force_', response.success === false, response.error === 'UNKNOWN_SCENARIO')`.
- Companion to `fixture_seed_unsupported` (seeding.ts) — same shape but for `force_*` scenarios in step phases, not `seed_*` scenarios in the fixtures phase.

Spec source: `compliance/cache/3.0.12/universal/runner-output-contract.yaml` > `skip_result.reasons.force_scenario_unsupported`. Closes #1805.
