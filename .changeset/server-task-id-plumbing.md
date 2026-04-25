---
'@adcp/client': patch
---

Fix `SubmittedContinuation.taskId` and the polling cycle to use the
server-assigned task handle instead of the SDK's runner-side
correlation UUID. Closes #966.

Pre-fix bug: `setupSubmittedTask` plumbed the local UUID generated at
request time (`TaskState.taskId`, used for the `activeTasks` map and
the `{operation_id}` webhook URL macro) through to the
`SubmittedContinuation`. `track()` and `waitForCompletion()` then
addressed `tasks/get` calls with that local UUID — which the seller
has never seen, so any spec-conformant seller would respond with
NOT_FOUND. Existing mock tests masked this because they ignored the
`taskId` parameter when stubbing the polling response.

Post-fix: `setupSubmittedTask` extracts the server-assigned handle via
`responseParser.getTaskId(response)` (which already walks both the
flat AdCP `response.task_id` shape and the A2A `result.kind === 'task'`
→ `result.id` shape) and uses it for both the buyer-facing
`SubmittedContinuation.taskId` field and the closures' polling calls.
The local UUID stays internal for `activeTasks` bookkeeping and the
webhook URL macro.

When a seller violates the spec and omits the task handle entirely,
the SDK falls back to the local UUID so callers still get a non-
undefined `taskId` field — pollers won't be able to locate the work,
but this matches the historical (broken) behavior surface and avoids
introducing a hard fail at a code path that's been silently wrong.

Updates `SubmittedContinuation.taskId` JSDoc to document that it
carries the server handle and is distinct from the runner-side
correlation id.

Adds `test/server-task-id-plumbing.test.js` — five regression tests
covering the conformant path, polling/track invocations addressing the
right id, the spec-violation fallback, and the A2A `result.kind: 'task'`
branch of `responseParser.getTaskId`.

Companion follow-up: #967 — fix the AdCP `tasks/get` request param
naming (`taskId` → `task_id`) and the response-shape mapping. This PR
plumbs the right ID; #967 wires it into a spec-conformant request and
parses the spec-conformant response.
