---
"@adcp/sdk": patch
---

fix(a2a): stop pollTaskCompletion spinning indefinitely on unrecognized tasks/get responses

Four-part fix for the A2A comply() 180s timeout (issue #1612):

1. `pollTaskCompletion` now exits immediately with a `failed` `TaskResult` when
   `mapTasksGetResponseToTaskInfo` returns `status: 'unknown'` — i.e., when the
   seller's `tasks/get` response does not conform to any recognised envelope shape
   (flat AdCP, MCP `structuredContent`, or A2A DataPart artifact). Previously the
   loop fell through to `sleep(pollInterval)` and retried forever until the outer
   comply() timeout fired.

2. `pollTaskCompletion` and `SubmittedContinuation.waitForCompletion` now accept an
   optional `AbortSignal` (5th / 2nd parameter respectively). The storyboard runner
   passes `AbortSignal.timeout(timeoutMs)` so the inner polling loop exits as soon
   as the outer 30-second step race timer fires. Previously the loop kept issuing
   `tasks/get` A2A calls in the background, accumulating until the full comply()
   budget was exhausted. Buyers using the public `waitForCompletion()` API also
   benefit — pass `AbortSignal.timeout(ms)` to bound the polling lifetime.

3. `unwrapTasksGetEnvelope` now falls back to the A2A transport-layer
   `result.status.state` (and `result.id` task handle) when an A2A Task carries
   no DataPart artifacts. This allows terminal states (`completed`, `failed`, etc.)
   to surface correctly for sellers that return A2A transport states without an
   AdCP DataPart artifact.

4. A second `signal?.aborted` check after `sleep(pollInterval)` limits abort
   latency to one sleep interval rather than one full poll cycle.
