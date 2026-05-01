---
"@adcp/sdk": patch
---

fix(testing): export `evaluateGraderOutput` — pass/fail predicate for `adcp storyboard run --json` output that correctly handles `overall_status:'partial'` with all-silent tracks (steps_failed=0, tracks_failed=0, tracks_partial=0, tracks_silent>0)
