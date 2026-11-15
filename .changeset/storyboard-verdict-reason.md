---
'@adcp/sdk': minor
---

A failing storyboard now says why it failed, even when no step did (adcontextprotocol/adcp#8576). Before, a storyboard whose verdict failed without a counted failed step surfaced only as a synthetic `<storyboard_id>/storyboard` scenario reading "storyboard-level verdict failed".

`runStoryboard()` sets three fields on every failing `StoryboardResult`:

- `verdict_reason`: the primary cause. One of `step_failed`, `assertion_failed`, `controller_prerequisite_unmet`, `required_phase_not_executed`, `no_executed_steps`, `fixture_error`, `coverage_unverified`, `runner_error`, `unexplained`. `runner_error` separates a runner or host refusal from an agent failure.
- `verdict_detail`: one line of runner-authored text.
- `verdict_contributing[]`: the steps, assertions, phases and requirements behind the verdict, with skip reasons, unmet requirements and pass indexes.

These fields also reach:

- comply()'s synthetic `<storyboard_id>/storyboard` scenario. It carries the same fields, and its `summary` appends the detail after "storyboard-level verdict failed".
- `ComplianceResult.verdict_explanations[]`: one entry per failing storyboard, with a `fix_command`. `storyboard_level: true` marks the ones no `failures[]` row explains.
- The compliance summary's `incomplete_storyboards[].verdict_reason`.
- The human output of `adcp storyboard run` and comply, which print the reason, and the `--summary-file` Markdown.

Use `explainStoryboardVerdict(result)` to explain a result from an older runner. Use `attachStoryboardVerdictExplanation(result, storyboard)` after regrading one.

The fields only explain the verdict. `overall_passed`, the step counts, `failures[]`, and every track and bundle grade are unchanged.
