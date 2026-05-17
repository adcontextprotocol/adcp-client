---
'@adcp/sdk': minor
---

feat(testing): `AssertionResult.status` carries `'silent'` / `'pass'` / `'fail'` on observation-bearing invariants

`status.monotonic` and `impairment.coherence` now stamp `status: 'silent'` on the `onEnd` summary record when zero lifecycle resources were observed, and `status: 'pass'` once at least one was. Downstream renderers (the spec-side grader at adcp#2834, Addie, the CLI summary) can read this per-assertion enum directly rather than inferring from `observation_count === 0` — which had no first-class field to branch on.

The track-level `TrackStatus: 'silent'` rollup (`computeTrackStatus` in `storyboard-tracks.ts`) is unchanged; this fills in the per-assertion analog so wired-but-not-observed assertions don't render identically to real passes.

Additive: existing consumers that only read `passed` and `observation_count` keep working. Closes #1797.
