---
"@adcp/sdk": patch
---

fix(conformance): grade storyboards not_applicable when required_tools are missing from agent toolset

`comply()` was attempting every capability-resolved storyboard even when the agent's discovered toolset was missing one or more tools declared in the storyboard's `required_tools` field. The cascading step-level skips caused the storyboard to grade `partial`, which propagated to the track as a false failure — particularly visible for governance storyboards run against non-governance agents.

Fix: before running each storyboard, check its `required_tools` against the agent's discovered tools. If any are missing, push the storyboard to `notApplicable` (with reason `missing required_tools: <list>`) and skip execution. The `not_applicable` synthetic result keeps the track row accurate and carries `overall_passed: true`, consistent with the existing version-gating behavior.

Also corrects `storyboards_executed`, `groupByTrack`, and `extractFailures` to reference the filtered runnable set rather than the full expanded set.
