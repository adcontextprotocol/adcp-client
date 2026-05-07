---
"@adcp/sdk": patch
---

fix(a2a): reroute SDK polling-path terminal-state errors through unwrap pipeline

When `@a2a-js/sdk` polls a task to completion on the blocking/SSE path, it
annotates `result.error` with "Task X is in terminal state: 3" for failed
tasks — but the `result.artifacts` DataPart still carries the spec-canonical
`adcp_error`. `callA2AToolImpl` was throwing immediately on `result.error`,
discarding the artifacts. Now it detects terminal-failed tasks with artifacts
(`kind: 'task'`, non-empty `artifacts`, state in `failed/rejected/canceled`)
and returns the full response so `handleAsyncResponse` can extract `adcp_error`
via `unwrapA2AResponse`. Fixes #1575.

Also exports `TERMINAL_FAILURE_A2A_STATES` from `response-unwrapper` so the
state membership check is maintained in one place.
