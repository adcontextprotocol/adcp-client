---
'@adcp/sdk': minor
---

Reverts #1142, removing `storyboardContext?: StoryboardContext` from `AssertionContext` and the per-step / final-step shallow-copy threading in the runner.

The field was preemptive surface with no consumer. None of the bundled invariants (`status.monotonic`, `idempotency.conflict_no_payload_leak`, `context.no_secret_echo`, `governance.denial_blocks_mutation`) read it; programmatic assertions already accumulate cross-step state through `ctx.state` (which is exactly how `status.monotonic`'s `history` works). Issue #1140 was about YAML validators (the `check:` clause), not assertion handlers — that scope is fully covered by #1141 (`field_less_than` / `field_equals_context` reading from `ValidationContext.storyboardContext`). The asymmetry is correct: declarative validators need context exposure, imperative assertions don't.

Custom invariants that need cross-step state should continue using `ctx.state` (set in `onStart`, mutated in `onStep`, read in `onEnd`).

Breaking-shape change to a public optional field, shipped as minor while 6.x is still in its breaking phase. Window-of-removal is hours old — the field landed in 6.4.0, no docs advertised it, no third-party consumer has had time to depend on it.
