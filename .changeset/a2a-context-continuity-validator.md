---
'@adcp/client': minor
---

Storyboard runner: add `a2a_context_continuity` validation check for
multi-step A2A storyboards. Closes the sibling regression class to
adcp-client#952 — sellers that bypass the `@a2a-js/sdk`
`DefaultRequestHandler` and stamp their own `contextId` on the response
Task (instead of echoing the buyer-supplied value) will now fail the
storyboard suite.

A2A 0.3.0 §7.1 lets buyers pass `params.message.contextId` to bind a
follow-up send to an existing server-side context; the server must echo
the same value on the response Task. The SDK handles this automatically
via `createA2AAdapter`'s `requestContext.contextId` forwarding, so SDK-
based sellers pass silently. Sellers that bypass the SDK are only
detectable on multi-step storyboards — this validator is that gate.

Runner plumbing:
- `ExecutionState.lastA2aContextId` accumulates the contextId from each
  A2A step's response Task. Before each A2A dispatch, the current value
  is forwarded as `TaskOptions.contextId` (which rides on
  `params.message.contextId` on the wire via `TaskExecutor`). After
  dispatch, the response Task's contextId updates the state for the next
  step.
- `outboundA2aContextId` is captured before dispatch and passed to
  `ValidationContext` so the validator can compare "what was sent" to
  "what came back" — avoiding the tautology of asserting against a value
  the runner never actually forwarded.
- `executeStoryboardTask` accepts a `contextId` in its opts argument and
  threads it through `TaskOptions`, which `SingleAgentClient` and
  `TaskExecutor` already forward to `callA2ATool`.

Validator behavior:
- Self-skips with `not_applicable` when: no `outboundA2aContextId`
  (first A2A step, non-A2A run, or prior step had no contextId),
  no `a2aEnvelope` (capture miss), or a JSON-RPC error envelope (no
  Task returned, so continuity is not verifiable).
- Fails when response `Task.contextId` ≠ `outboundA2aContextId`, or
  when response `Task.contextId` is absent/empty on a follow-up send.

9 unit tests added. Refs adcp-client#962.
