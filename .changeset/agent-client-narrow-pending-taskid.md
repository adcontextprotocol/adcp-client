---
'@adcp/sdk': patch
---

Narrow `AgentClient.withSession()` so the retained server-side `pendingTaskId` only auto-threads onto the next call when the call is plausibly a continuation of the SAME task — same skill name AND same effective `contextId`. A different skill or a switched contextId signals new work, and the retained handle is stale; sending it produces "Task not found" against spec-compliant A2A sellers (per A2A 0.3.0 §3.4 — `Message.taskId` continues the parent task). Closes #1590.

Defense in depth on top of the storyboard-runner reset shipped in #1588 (#1585). The runner-level fix protects `comply()`-style harnesses that own client lifecycle; this SDK-level narrowing protects every adopter who reuses one `AgentClient` across logically distinct conversations without an explicit `resetContext()` boundary.

HITL flows (e.g., `createMediaBuy` → `input-required` → `createMediaBuy` resume) match same-skill same-context and continue to thread as before. Caller-supplied `options.taskId` always wins, regardless of skill match.

Internally pairs `pendingTask` with the `(contextId, taskName)` it was retained under. `getPendingTaskId()` surface unchanged; `resetContext()` clears the handle as before.
