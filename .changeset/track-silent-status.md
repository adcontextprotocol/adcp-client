---
'@adcp/sdk': minor
---

Adds `'silent'` to `TrackStatus` so the compliance grader can distinguish a track that observed real lifecycle transitions from one that ran with zero observations. Closes #1139, paired with adcontextprotocol/adcp#2834 on the grader-side rendering.

`status.monotonic` (and other observation-based invariants) today report `passed: true` whether they validated three transitions or none. That collapses two different states behind one icon: real protection vs. wired-but-not-exercised. Tracks like `property-lists`, `collection-lists`, and `content-standards` — where the invariant is wired eagerly but no current phase exercises a lifecycle-bearing resource — render as green checks even though no protection was actually asserted.

Three changes land together:

- `TrackStatus` widens to `'pass' | 'fail' | 'skip' | 'partial' | 'silent'`. A track is silent when every observation-bearing assertion record reports `observation_count: 0` and nothing failed. Skip/fail/partial precedence is preserved — silent only triggers on otherwise-clean runs.
- `AssertionResult.observation_count?: number` carries the run-level count from observation-based invariants. `status.monotonic` now defines an `onEnd` hook that emits a single record with `observation_count: history.size`, giving the rollup a deterministic signal whether to demote.
- `ComplianceSummary.tracks_silent` and an updated `formatComplianceResults` render silent rows distinctly (`🔇`, "no lifecycle observed") instead of the green check.

`computeOverallStatus` treats silent tracks as `attempted` (they ran) but never as unambiguously `passing` — a run with any silent track surfaces as `partial`. `computeOverallStatus` tolerates summaries serialized before this release (registry cache, fixtures) by defaulting `tracks_silent` to `0` when absent.

Why widen the union instead of adding `observable: boolean` on `AssertionResult` (the alternative the triage proposals settled on): a non-breaking optional field lets every grader keep mapping `{ passed: true, observation_count: 0 }` to a green check forever — exactly the bug we're fixing. The widened union forces consumers with exhaustive switches to make a deliberate decision about silent vs. pass, which is the protocol-correct outcome. Spec-side, adcontextprotocol/adcp#2834 can now adopt the same vocabulary verbatim.
