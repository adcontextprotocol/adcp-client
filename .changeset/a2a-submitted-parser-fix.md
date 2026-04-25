---
'@adcp/client': patch
---

Fix `ProtocolResponseParser.getStatus` and `getTaskId` to read AdCP
work-layer fields from A2A wrapped Task responses instead of the
transport-layer fields. Closes #973.

Per #899's two-lifecycle contract, A2A `Task.state` reflects the
HTTP-call lifecycle (always `'completed'` for AdCP submitted arms —
the call returned with a queued AdCP task), and `Task.id` is the
SDK-generated transport handle (pinned to one HTTP call). The AdCP
work lifecycle and work handle live on the artifact:
`artifact.parts[0].data.status` and `artifact.metadata.adcp_task_id`
respectively.

**Pre-fix behavior**:

- `getStatus` for an A2A submitted-arm response returned
  `'completed'` (read from `result.status.state`), preventing
  `TaskExecutor.handleAsyncResponse` from ever entering the
  SUBMITTED branch. Buyers thought async operations finished
  synchronously — `result.submitted` was undefined; no
  `SubmittedContinuation` was issued.
- `getTaskId` returned the A2A Task.id, which the seller's AdCP
  `tasks/get` tool would not recognize (the seller knows the AdCP
  task handle, not the transport id).

**Fix**: when `result.kind === 'task'` AND the artifact's first
DataPart carries an AdCP payload, prefer the AdCP-layer fields:

- `getStatus`: read `artifact.parts[0].data.status` if it's an
  `ADCP_STATUS` enum value; fall back to `result.status.state`.
- `getTaskId`: read `artifact.metadata.adcp_task_id` if present and
  passes the session-id safety guard; fall back to `result.id`.

Non-AdCP A2A responses (no artifact, no DataPart, or `data.status`
not in the AdCP enum) keep the previous behavior — the transport-
layer fields are authoritative.

**End-to-end consequence**: combined with #966 (server-task-id
plumbing) and #967 (AdCP `tasks/get` request/response shape), A2A
submitted-arm polling now works end-to-end against any
`createA2AAdapter`-backed seller. Probe before this PR:

```
result.status = completed   ← WRONG, treated as sync completion
result.submitted = undefined
result.metadata.serverTaskId = <random A2A UUID>
```

After:

```
result.status = submitted
result.submitted.taskId = tk_seller_handle_99   ← AdCP work handle
```

**Tests**:

- `test/lib/protocol-response-parser-a2a-submitted.test.js` — 15
  unit tests covering AdCP-layer reads (submitted/working/failed),
  fallback paths (no artifact, no DataPart, malformed status, no
  metadata), interaction with MCP `structuredContent` (untouched),
  and session-id safety guards.
- `test/server-a2a-submitted-end-to-end.test.js` — full submitted →
  working → working → completed roundtrip against a real
  `createA2AAdapter`. Asserts (1) SDK classifies as submitted,
  (2) `SubmittedContinuation.taskId` is the AdCP handle, (3)
  polling dispatches `tasks/get` with snake_case `task_id`, (4)
  the spec-shape `tasks/get` response resolves
  `waitForCompletion()` with `result.media_buy_id`.

This is the third and final landmark of the A2A submitted-arm
polling story (#966 → #967 → #973). With it, A2A buyers can drive
guaranteed-buy / IO-signing / governance-review / batch-processing
flows end-to-end through the SDK without webhook-only fallbacks.
