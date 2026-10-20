---
'@adcp/sdk': minor
---

Add `SingleAgentClient.trackTask()` and `AgentClient.trackTask()` to observe persisted seller tasks through the existing continuation polling path. Polls share one operation ID and emit terminal lifecycle activity without creating a new protocol activity record for each status read. Add `TaskOptions.operationId` to pin the caller's correlation ID, and expose `server_task_id` on response, status, and webhook activity alongside the runner's `operation_id`.

Reject operation-ID collisions, fence stale polling handles, and allow matching same-client work to be tracked again. Local observation failures do not publish seller failures; A2A seller cancellation requires explicit opt-in.
