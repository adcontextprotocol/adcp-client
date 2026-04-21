---
'@adcp/client': minor
---

Fix A2A multi-turn session continuity + add `pendingTaskId` retention for HITL flows. Mirrors [adcp-client-python#251](https://github.com/adcontextprotocol/adcp-client-python/pull/251).

**The bug.** The A2A adapter (`callA2ATool`) never put `contextId` or `taskId` on the Message envelope — every send opened a fresh server-side session regardless of caller state. `AgentClient` compounded the error by storing `result.metadata.taskId` into `currentContextId` on every success, so the field that was supposed to carry the conversation id was actually carrying a per-task correlation id. Multi-turn A2A conversations against sellers that key state off `contextId` (ADK-based agents, session-scoped reasoning, any HITL flow) silently fell back to new-session-every-call.

**The fix.**

- `callA2ATool` takes a new `session` arg and injects `contextId` / `taskId` onto the Message per the @a2a-js/sdk type.
- `ProtocolClient.callTool` threads session ids through to the A2A branch (MCP unaffected — no session concept there).
- `TaskExecutor` stops aliasing `options.contextId` to the client-minted correlation `taskId`. The local `taskId` is now always a fresh UUID; the caller's `contextId` rides on the wire envelope only.
- `TaskResultMetadata` gains `contextId` (server-returned A2A session id) and `serverTaskId` (server-tracked task id), populated from the response by `ProtocolResponseParser.getContextId` / `getTaskId`.
- `AgentClient` retains `contextId` across sends (auto-adopted from server responses so ADK-style id rewriting is transparent) and tracks `pendingTaskId` only while the last response was non-terminal (`input-required` / `working` / `submitted` / `auth-required` / `deferred`). Terminal states clear `pendingTaskId` so the next call starts fresh.

**Public API (AgentClient).**

```ts
client.getContextId();     // read retained contextId
client.getPendingTaskId(); // read pending server taskId (HITL resume)
client.resetContext();     // wipe session state
client.resetContext(id);   // rehydrate persisted contextId across process restart
```

`setContextId(id)` and `clearContext()` still exist for backwards compatibility (`clearContext` now delegates to `resetContext()`).

**One AgentClient per conversation.** Sharing an instance across concurrent conversations interleaves session ids (last-write-wins) — create a fresh `AgentClient` or call `resetContext()` per logical conversation. Callers needing resume-across-process-restart should persist `getContextId()` / `getPendingTaskId()` after non-terminal responses and seed them back via `resetContext(id)` + direct `setContextId` on rehydration.

**Behavior change to note.** `TaskOptions.contextId` no longer overrides the client-minted correlation `taskId` (which was its unintended side effect). Callers who were reading `result.metadata.taskId` expecting to see their caller-supplied `contextId` should now read `result.metadata.contextId`.
