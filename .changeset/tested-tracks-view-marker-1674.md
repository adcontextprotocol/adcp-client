---
'@adcp/sdk': minor
---

fix(testing): label canonical vs reference `TrackResult` views in `ComplianceResult` (#1674)

`ComplianceResult.tested_tracks` is a `.filter()` of `ComplianceResult.tracks` — every passing/failing/partial/silent track appears in both arrays as the same JS object reference. JSON output therefore serializes each scenario twice, which is structurally correct but visually identical to "the runner executed the scenario twice." Triagers grepping `--json` reports wasted multi-hour debug cycles on the false hypothesis (cf. #1658 — defensible hardening but filed on a wrong premise; salesagent#331 — closed as not-a-seller-bug after this duplication was identified as the real cause).

Conservative fix: every `TrackResult` now carries an optional `_view: 'canonical' | 'reference'` marker.

- `tracks[n]._view === 'canonical'` — the source of truth. Iterate this array for a deduplicated view.
- `tested_tracks[n]._view === 'reference'` — the filtered subset. Same scenarios as the canonical entry; the marker signals "this is a re-projection, not a re-run."

JSON consumers can dedupe with `result.tracks.flatMap(t => t.scenarios)` or filter on `_view === 'canonical'`. CI pipelines that want a dedupe-by-design surface should keep reading `buildComplianceSummary()` / `--summary-output` instead — those have always been the stable contract.

The duplication remains for back-compat. The breaking type-split that fully removes it — `TestedTrackEntry` without `scenarios`/`skipped_scenarios`, requiring consumer migration — is tracked at #1791, slated for bundling with the AdCP 3.1 adoption umbrella (#1580).

Both construction sites in `src/lib/testing/compliance/comply.ts` are updated (the main `complyImpl` path and `runWithDegradedProfile`). The marker is set via shallow copy on the `tested_tracks` side, preserving nested `scenarios` array reference identity (no deep clone — memory cost stays flat). Regression test `test/lib/comply-tested-tracks-view.test.js` pins the canonical/reference labeling, the shallow-copy invariant, and the documented dedup recipe.
