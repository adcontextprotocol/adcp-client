---
"@adcp/sdk": patch
---

fix(a2a): handle stale pendingTaskId causing "Task not found" in batch storyboard runs

When multiple storyboard scenarios share a single `AgentClient` instance, the client's
`pendingTaskId` can be left set from a prior scenario's async working-state response if
the poll path (via `waitForCompletion`) bypasses `absorbServerSideMetadata`. The next
scenario then includes this stale task ID in its `message/send` call; if the seller has
already completed and evicted that task (A2A 0.3.x defines no minimum retention TTL),
the agent returns "Task <uuid> not found" and the scenario fails.

Three fixes:

1. **Root cause** — `AgentClient.clearPendingTask()` (`src/lib/core/AgentClient.ts`) +
   `task-map.ts` `finally` block: after `waitForCompletion` resolves, `clearPendingTask()`
   is called so the stale `pendingTaskId` is cleared before the next scenario starts.
   This is the primary fix; the two below are defense-in-depth.

2. `callA2AToolImpl` (`src/lib/protocols/a2a.ts`): when a "Task not found" error is
   returned and `session.taskId` is set, retry once without the stale task ID so the
   call starts a fresh server-side task. (Guard is self-limiting: the retry passes
   `taskId: undefined`, so the guard cannot fire a second time.)

3. `pollTaskCompletion` (`src/lib/core/TaskExecutor.ts`): when explicit polling
   (`tasks/get`) receives a "Task not found" error, return a descriptive `failed`
   `TaskResult` with an actionable error message rather than letting the error
   propagate as an uncaught exception.
