---
'@adcp/client': patch
---

Fix `TaskExecutor.getTaskStatus` to dispatch the AdCP `tasks/get` tool
spec-conformantly. Closes #967.

**Pre-fix bugs**:

1. **Wrong request param**: SDK passed `{ taskId }` (camelCase). AdCP
   3.0 schema (`schemas/cache/3.0.0/bundled/core/tasks-get-request.json`)
   requires `{ task_id }` (snake_case). Conformant sellers reject as
   INVALID_PARAMS.
2. **Wrong response shape mapping**: SDK read `(response.task as TaskInfo)` —
   expects a non-spec nested wrapper with camelCase fields. AdCP-spec
   responses are flat snake_case (`{ task_id, task_type, status,
created_at, updated_at, ... }`); real spec-conformant responses
   produced `taskId: undefined` everywhere on the polled `TaskInfo`.
3. **Wrong primary path**: SDK tried MCP `experimental.tasks.getTask`
   first for MCP agents and fell through to the AdCP tool on
   capability-missing. The MCP-experimental path tracks
   transport-call lifecycle (the MCP analog of A2A `Task.state`),
   not AdCP work lifecycle. For polling submitted-arm tasks (which
   is what `pollTaskCompletion` does) we need work status; the two
   interfaces are not substitutes (per protocol-expert review on
   #966/#967).

**Fix**:

- Drop the MCP-experimental.tasks first attempt. Always dispatch the
  AdCP `tasks/get` tool over the agent's transport.
- Pass the request param as `task_id` (snake_case).
- Map the response via a new `mapTasksGetResponseToTaskInfo` helper
  that walks the transport-level wrappers (MCP `structuredContent`,
  A2A `result.artifacts[0].parts[0].data`, legacy `{ task: ... }`
  nested wrapper) and the AdCP-spec flat shape, then projects to the
  internal `TaskInfo`.
- Bypass `extractResponseData` for `tasks/get` — the generic
  AdCP-error-arm detection misinterprets the spec's informational
  `error: { code, message }` block as an error envelope and shreds
  the response into `{ errors: [...] }`. The new helper handles
  unwrapping directly.
- Pass through `result` / `task_data` from `additionalProperties: true`
  so completion data round-trips when sellers add it. (Note: AdCP
  3.0 doesn't define a typed completion-payload field on `tasks/get`;
  see adcp#3123 for the upstream clarification issue. Forward-compat
  with all three possible spec resolutions.)

**Behavior change**: MCP sellers that supported `experimental.tasks`
but did NOT register an AdCP `tasks/get` tool will now see polling
fail rather than silently use the wrong-lifecycle interface. This is
deliberate — the previous behavior was incorrect (returned transport
status, not work status). Sellers should register `tasks/get` as an
AdCP tool to support buyer-side polling.

Adds `test/server-tasks-get-spec-shape.test.js` with six regression
tests:

- Request param naming (snake_case `task_id`, no camelCase `taskId`)
- AdCP-spec flat response mapping (incl. ISO 8601 timestamps)
- Result-data passthrough via additionalProperties
- Error-block mapping (failed status with `error: { code, message }`)
- Legacy `{ task: ... }` nested-shape backward compat
- No MCP-experimental.tasks first attempt

Companion of #966 (server-task-id plumbing). With both PRs landed,
MCP submitted-arm polling works end-to-end against spec-conformant
sellers. A2A submitted-arm polling still has additional bugs at the
parser layer (`getStatus` reads transport state, `getTaskId` extracts
A2A Task.id instead of `artifact.metadata.adcp_task_id`); tracked in
adcp-client#973.
