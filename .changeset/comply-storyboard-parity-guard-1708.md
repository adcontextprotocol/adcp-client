---
'@adcp/sdk': patch
---

test(comply): regression guard for storyboard-runner ↔ comply aggregation parity (#1708)

Locks the post-7.1.0 attribution invariants so future refactors of
`comply()`'s `extractFailures` aggregation can't silently reintroduce the
BidMachine misattribution shape (adcp#4419).

What's locked:

- A storyboard step carrying both a synthesized `response_schema` failure
  (prepended by the runner per #1709 / PR #1712) and an `assertion` entry
  surfaces `validation.check === 'response_schema'` in
  `ComplianceResult.failures` — never `'assertion'`. This is the
  attribution that was silently broken pre-7.1.0 (Zod rejects fell
  through to the next invariant, canonically `context.no_secret_echo`).

- Skipped-invariant markers (`passed: true` entries the runner emits when
  short-circuiting invariants downstream of a schema failure per #1712)
  are correctly filtered out — only failed validations surface in
  `failures`. A future change that included `passed: true` entries would
  crowd out the real failure.

- A clean BidMachine-shape response (structured `authorization` field on
  passing `no_secret_echo` per #1713 / PR #1714) produces zero failures
  through the aggregation layer.

- Multi-storyboard aggregation preserves per-storyboard
  `(storyboard_id, step_id, validation.check)` tuples — A failed, B clean,
  C failed produces exactly two `failures` entries with stable attribution.

API change (minor): `extractFailures` (previously file-internal) is now
`export`-ed from `src/lib/testing/compliance/comply.ts` so the regression
test can call it directly with synthetic `StoryboardResult` fixtures.
Functionally identical; just visibility.

Scope correction relative to the original #1708 framing: the
"cross-evaluator divergence" symptom was version-driven (different
`@adcp/sdk` versions hitting #1713 and #1709 differently), not a true
parity gap between `comply()` and `runStoryboard()`. Both root causes
shipped in 7.1.0; this test is the durable guard for the
aggregation-layer invariants those fixes depend on.
