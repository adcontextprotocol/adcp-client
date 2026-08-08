---
'@adcp/sdk': major
---

**Breaking:** Compliance results no longer serialize scenarios twice.

`ComplianceResult.tested_tracks` is now `TestedTrackEntry[]`. Reference entries retain track identity, status, label, observations, duration, mode, and `_view: 'reference'`, but no longer carry `scenarios` or `skipped_scenarios`; those arrays live only on canonical `ComplianceResult.tracks` entries. Full `--json` output therefore serializes each scenario once.

Consumers reading `tested_tracks[n].scenarios` must iterate `tracks` instead. Custom fixtures that used `_view: 'reference'` on `TrackResult` must use `TestedTrackEntry`; `TrackResult._view` now accepts only `'canonical'`. CI consumers that need a stable, compact report should use `buildComplianceSummary()` from `@adcp/sdk/testing` (also re-exported by `@adcp/sdk/compliance`) or `--summary-output`. The new `TestedTrackEntry` type is exported from both package paths.
