---
'@adcp/client': minor
---

Add a cross-step assertion registry to the storyboard runner
(adcontextprotocol/adcp#2639). Storyboards now accept a top-level
`invariants: [id, ...]` array that references assertions registered via
`registerAssertion(spec)` from `@adcp/client/testing`. The runner resolves
the ids at start (fails fast on unknowns), fires `onStart` → `onStep`
(per step) → `onEnd` (once at the end), routes step-scoped failures into
the step's `validations[]` as `check: "assertion"`, and records every
result on a new `StoryboardResult.assertions[]` field. A failed assertion
flips `overall_passed` — assertions are gating conformance signal, not
advisory output.

New public exports from `@adcp/client/testing`: `registerAssertion`,
`getAssertion`, `listAssertions`, `clearAssertionRegistry`,
`resolveAssertions`, and types `AssertionSpec`, `AssertionContext`,
`AssertionResult`.

Assertions encode cross-step properties that per-step checks can't
express cleanly: governance denial never mutates, idempotency dedup
across replays, context never echoes secrets on error, status
transitions monotonic, and so on. The registry ships the framework;
concrete assertion modules live alongside the specialisms that own them.

No behavior change for storyboards that don't set `invariants`.
