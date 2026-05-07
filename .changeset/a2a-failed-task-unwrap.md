---
'@adcp/sdk': patch
---

Unwrap A2A failed-task DataPart so storyboard `error_code` validators read `adcp_error.code` from the artifact instead of falling back to `Task.status.state`. Per AdCP transport-errors §A2A Binding, failed tasks carry the same `result.artifacts[].parts[].data` envelope as completed tasks (with `adcp_error` keyed in the DataPart); the unwrapper now extracts that payload for any terminal state (`completed`, `failed`, `rejected`, `canceled`) and only rejects genuinely intermediate states (`working`, `submitted`, `input-required`, `auth-required`). Fixes spec-compliant A2A errors being mis-reported as `Expected error code "<code>", got "Task failed"`. (#1571)
