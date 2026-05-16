---
'@adcp/sdk': minor
---

feat(testing): bake source coordinates into every `AdvisoryObservation` (#1746)

`AdvisoryObservation` gains a required `source: ObservationSource` field carrying the rule code and (when applicable) the storyboard/step coordinates that produced the finding. The discriminated-union shape covers the four ways the evaluator can fire:

- `storyboard_step` — observation tied to a specific step in a specific storyboard. Carries `storyboard_id` + `step_id`, so a triager can `grep` the storyboard YAML directly from the JSON report. Most evaluator advisories fall here (slow response, missing `valid_actions`, zero products, …).
- `storyboard` — observation aggregates across a storyboard's scenarios (e.g. the lifecycle scenario revealed missing pause/resume). Carries `storyboard_id` and the step that first surfaced the gap.
- `profile` — observation derived from the agent's discovered capability profile rather than any storyboard step (e.g. "agent declares v2", "agent does not implement `get_adcp_capabilities`"). No storyboard coordinates apply.
- `probe` — observation came from a network probe outside the storyboard pipeline (e.g. auth-failure detection on a 401 capability-discovery response). No storyboard coordinates apply.

Every emission site in `src/lib/testing/compliance/comply.ts` is populated: 17 sites in `collectObservations`, 4 in `complyImpl` (tool-discovery, capabilities-probe-error / -missing / no-supported-protocols), and 2 in `detectAuthRejection`. The regression test in `test/lib/comply-advisory-rule-source.test.js` exercises a representative cross-section of tracks and asserts every observation has a structurally-valid `source` (validates `kind`, `code`, and `storyboard_id` / `step_id` when the kind requires them). A future contributor adding a `observations.push({...})` without a `source` fails the build.

Text output gains a `↳ source: (code · storyboard_id/step_id)` line beneath each advisory; JSON output already includes the field by structural recursion. Triagers reading the report can jump straight to the storyboard YAML that fired the rule, closing the gap that #1736 surfaced (hard-coded `confirmed_at` / `revision` advisories that fired with no backing rule).

Type-only change for consumers reading the field; no runtime behavior change. The new `ObservationSource` type is exported from `@adcp/sdk/testing`.

Closes #1746.
