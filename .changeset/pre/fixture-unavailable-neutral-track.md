---
'@adcp/sdk': patch
---

fix(compliance): a `fixture_unavailable` skip no longer makes its track `partial` (#3596). The skip means the runner's test kit could not build a creative asset the seller's format requires, for example a required `alt_text` slot. The runner-output contract grades that storyboard `not_applicable` and says it is not a grading signal about the agent. `comply()` still graded the track `partial`, which made `overall_status` `partial` and showed agents as degraded with zero failing steps. The track now grades from the steps that ran, the same way `fixture_unsatisfied` and `fixture_seed_unsupported` already did. A real failure next to the gap still grades `partial` or `fail`. Unverified request-signing coverage still holds its track `partial`. The gap stays visible in the step's `skip_reason` and detail, in `summary.skipped_by_reason`, and as a coverage gap in the specialism bundle result.
