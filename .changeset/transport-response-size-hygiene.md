---
'@adcp/sdk': patch
---

transport.maxResponseBytes hygiene: thread per-call override through TaskExecutor secondary call sites, rename ResponseTooLargeError field, add MCP integration test. Closes #1177.

- `TaskExecutor.getTaskStatus`, `listTasksForAgent`, `listTasks`, `getTaskList`, `continueTaskWithInput`, and
  `pollTaskCompletion` now accept a per-call `transport?` override that beats the constructor-level cap.
  `SubmittedContinuation.track` exposes the per-call override; `waitForCompletion` inherits the
  transport cap from task-submission time (intentional — polling loops run an indefinite number of
  requests and a per-loop override would be a footgun).
- `ResponseTooLargeError.declaredContentLength` renamed to `contentLengthHeader` (pre-release fix;
  the field was introduced in the same release cycle and has zero published consumer surface).
- `test/unit/mcp-tool-size-limit.test.js` — end-to-end integration test proving the cap fires through
  `ProtocolClient.callTool` → `connectMCPWithFallbackImpl` → `wrapFetchWithSizeLimit` for the
  non-OAuth MCP path.
