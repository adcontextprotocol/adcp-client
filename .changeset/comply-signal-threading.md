---
"@adcp/sdk": patch
---

fix(conformance): thread complyImpl AbortSignal through runStoryboard into per-phase and per-step execution

`comply()` built a combined `AbortSignal` (from `timeout_ms` and/or an external signal) but only checked it between storyboards (`signal?.throwIfAborted()` before each `runStoryboard` call), not inside them. On agents with many storyboards, a single long-running `runStoryboard` call could consume the entire timeout budget without the signal ever firing mid-storyboard — the exact failure mode causing `storyboard run` to time out at pre-flight on both MCP and A2A transports against healthy agents.

Fixes the binding constraint in three changes:

- `StoryboardRunOptions` gains an optional `signal?: AbortSignal` field.
- `complyImpl` threads its combined signal into the `runOptions` passed to every `runStoryboard` call.
- `executeStoryboardPass` checks `options.signal?.throwIfAborted()` at the start of each phase loop iteration and each step loop iteration so the abort fires at the next phase/step boundary rather than waiting for the current storyboard to finish.

`runMultiPass` gains the same per-pass check for consistency.

Existing callers of `runStoryboard()` directly are unaffected — `signal` is optional and defaults to no-op.
