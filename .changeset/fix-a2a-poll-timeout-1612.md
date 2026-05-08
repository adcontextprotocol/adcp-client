---
"@adcp/sdk": patch
---

fix(a2a): stop pollTaskCompletion spinning indefinitely on unrecognized tasks/get responses

Three-part fix for the A2A comply() 180s timeout (issue #1612):

1. `pollTaskCompletion` now exits immediately with a `failed` `TaskResult` when
   `mapTasksGetResponseToTaskInfo` returns `status: 'unknown'` — i.e., when the
   seller's `tasks/get` response does not conform to any recognised envelope shape
   (flat AdCP, MCP `structuredContent`, or A2A DataPart artifact). Previously the
   loop fell through to `sleep(pollInterval)` and retried forever until the outer
   comply() timeout fired.

2. `pollTaskCompletion` now accepts an optional `AbortSignal` (5th parameter). The
   storyboard runner passes `AbortSignal.timeout(timeoutMs)` so the inner polling
   loop exits as soon as the outer 30-second step race timer fires. Previously the
   loop kept issuing `tasks/get` A2A calls in the background, accumulating until
   the full comply() budget was exhausted.

3. `unwrapTasksGetEnvelope` now falls back to the A2A transport-layer
   `result.status.state` when an A2A Task carries no DataPart artifacts. This
   allows terminal states (`completed`, `failed`, etc.) to surface correctly for
   sellers that implement the A2A native `tasks/get` JSON-RPC method but do not
   embed an AdCP DataPart in the response artifact.
