---
"@adcp/sdk": minor
---

feat(conformance): expose per-step accumulated context in AssertionContext for cross-step comparison validators

Adds `storyboardContext?: StoryboardContext` to `AssertionContext`. The runner
now threads the accumulated context (all prior steps' `context_outputs` and
convention-extracted values) into every assertion's context object before each
`onStep` call, using the Option 2 / context-outputs style (same key namespace
as `$context.*` placeholders and `context_outputs` entries).

Assertion implementations can now read `ctx.storyboardContext?.['my_key']` to
compare values from a prior step against the current step's result. Missing
keys return `undefined`; individual assertion handlers decide whether to skip
or fail on absence.

Implements the runner side of adcp-client#1140 / adcontextprotocol/adcp#2642.
