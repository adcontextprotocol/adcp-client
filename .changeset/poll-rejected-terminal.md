---
'@adcp/client': patch
---

`TaskExecutor.pollTaskCompletion`: handle every non-progressing AdCP
task status. Closes #977 (both halves).

**Pre-fix**: `pollTaskCompletion` only exited on `completed`, `failed`,
and `canceled`. Three non-progressing statuses caused the loop to spin
until the caller's timeout:

- **`rejected`** — definitively terminal per the AdCP `task-status`
  enum ("Task was rejected by the agent and was not started"). Now
  collapses onto the same `failed`/`canceled` exit branch with
  `{ success: false, status: 'failed' }`.
- **`input-required`** — paused state. Polling alone can't advance it;
  the buyer must satisfy the paused condition (supply input) and
  retry the original tool call. Now returns a
  `TaskResultIntermediate` with `status: 'input-required'`,
  `success: true` (mirrors the synchronous `handleInputRequired`
  no-handler path).
- **`auth-required`** — paused state. Same handling as
  `input-required`. Also added to `TaskResultIntermediate`'s status
  union and the `TaskStatus` type.

**Error fallback**: the polling path now checks `status.message`
before the generic `Task <status>` template, matching the
synchronous dispatch path. `TaskInfo` gains an optional `message`
field; the `tasks/get` response mapper preserves the top-level
`message` field through to it.

**Side fixes** caught by review:

- `mcp-tasks.mapMCPTaskToTaskInfo`: the `statusMessage → error`
  projection now checks against the AdCP-mapped status (post-
  `mapMCPTaskStatus`) instead of the MCP-side raw status. The prior
  check used `['failed', 'rejected', 'canceled']` against the
  pre-mapping string — but MCP Tasks emits `'cancelled'` (British)
  and never `'rejected'` as a standard status, so MCP-cancelled
  tasks weren't surfacing `statusMessage` as `error`.
- `onTaskEvents`: `'canceled'` was falling through to
  `onTaskUpdated`. Now joins `'failed'` and `'rejected'` on the
  `onTaskFailed` branch.
- `TaskStatus` union: adds `'rejected'`, `'canceled'`, and
  `'auth-required'` for metadata fidelity.

**Tests**: `test/lib/poll-task-completion-terminal-states.test.js`
covers all three new exit paths plus regressions for `failed` /
`canceled`. 9 tests; mocks dispatch via `protocol: 'a2a'` so polls
route directly through `ProtocolClient.callTool` without the MCP
Tasks protocol fast path.

**adcp#3126 alignment** (typed `tasks/get` result field):
adcontextprotocol/adcp#3126 closed the spec ambiguity flagged in
adcp#3123 by adding a typed `result` field on `tasks/get` responses
(gated by `include_result: true` on the request, populated when
`status: 'completed'`). The SDK now sets `include_result: true` on
every polling request so spec-conformant 3.1.0+ sellers populate
the typed field; pre-3.1.0 sellers ignore the unknown request
field, and the response mapper continues to read `result` (the
typed and informal paths share the same field name). Dropped the
informal `task_data` alias from the mapper — `result` is the
canonical name.
