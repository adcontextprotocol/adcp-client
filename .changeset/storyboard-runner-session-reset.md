---
'@adcp/sdk': patch
---

Fix A2A "Task not found" on first call of every storyboard after the first when running batch compliance suites (#1585).

`comply()` shares one `AgentClient` across every storyboard for transport reuse. The client retains `pendingTaskId` from non-terminal responses (`submitted` / `working` / `input-required`) and auto-threads it into every subsequent A2A `message/send`. Without a per-storyboard reset, a stale `task_id` from a prior storyboard's HITL or working step rode into the next storyboard's first call (typically `get_products`), and spec-compliant sellers correctly returned "Task &lt;uuid&gt; not found" because the buyer was referencing a task it never opened against this seller.

The runner now calls `client.resetContext()` on every shared client at the start of `executeStoryboardPass`, re-establishing the documented one-AgentClient-per-conversation boundary at the storyboard boundary. MCP transports are unaffected (no session ids on the wire). Sibling of #1571, #1575, #1579 — the previous fixes addressed unwrap-layer drops; this one addresses the upstream session-leak that caused the lookups in the first place.
