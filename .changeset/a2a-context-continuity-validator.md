---
'@adcp/client': minor
---

Storyboard runner: add the `a2a_context_continuity` validation check
plus cross-step A2A envelope tracking. Closes #962.

A2A 0.3.0 §7.1 binds follow-up `message/send` calls to a server-side
conversation via `Message.contextId`; the server MUST echo it on the
response Task. The `@a2a-js/sdk`'s `DefaultRequestHandler` does this
automatically — `createA2AAdapter` (#899) passes through
`requestContext.contextId`, so a passing seller built on the SDK
won't trip a single-call check. The regression class is sellers that
bypass the SDK's request handler and stamp their own `contextId` on
the response, breaking buyer-side correlation across multi-turn flows
(proposal refinement, IO signing, async approval). This kind of bug
is only surface-able on **multi-step** storyboards where step N+1
sends with the contextId returned by step N.

The new check runs at step N+1 and compares
`a2aEnvelope.result.contextId` against the most recent prior step's
captured envelope. Skip semantics:

- Non-A2A run (no envelope captured) → skip with `not_applicable`
  observation
- First A2A step in a run (no prior to compare) → skip
- Either envelope has no extractable `contextId` → skip
- JSON-RPC error envelope (transport rejection) → skip — continuity
  is undefined when the call didn't reach the work layer
- Skip cases tag the observation so triage can distinguish
  "validator self-skipped" from "validator passed because contexts
  matched"

Failure cases:

- Current step's response has no `contextId` (empty/missing) on a
  non-first send → fail with a pointer to `/result/contextId`
- Current step's response `contextId` differs from prior step's →
  fail with both values surfaced and the prior step id named in
  the diagnostic

**Runner-side plumbing**: per-step A2A envelopes are now tracked in
a long-lived `priorA2aEnvelopes` map on `ExecutionState`, populated
after each capture. The validator reads the most recent insertion-
order entry as the comparison baseline. Probe steps, MCP steps, and
capture-bypass paths don't insert, so cross-step comparisons walk
back to the most recent A2A step automatically.

Suggested by the ad-tech-protocol-expert review on #952. Filed as
#962, scoped as a separate validator since the failure mode and
fix surface are distinct from `a2a_submitted_artifact`'s single-call
wire-shape check.

**Coverage**:

- 10 unit tests against `validateA2AContextContinuity` (synthetic
  envelopes covering match, divergence, missing contextId, every
  skip path)
- 2 integration tests against `runStoryboard` driving multi-step
  storyboards: one against a conformant `createA2AAdapter` (passes),
  one against a hand-rolled regressed adapter that stamps a fresh
  contextId per send (fails)
