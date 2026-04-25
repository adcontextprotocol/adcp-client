---
'@adcp/client': patch
---

fix(core): pollTaskCompletion now exits immediately on `rejected` status instead of spinning until timeout

`TaskExecutor.pollTaskCompletion` previously only exited the polling loop for `completed`, `failed`, and `canceled` statuses. When a server returned `rejected` (task refused before starting), the loop would spin until the caller's timeout. The `rejected` status is now treated as terminal — consistent with how `handleAsyncResponse` handles it — and returns `{ success: false, status: 'failed' }` immediately.

Also fixes the error-message fallback: the polling path now checks `status.message` before falling back to the generic `"Task rejected"` string, matching the behavior of the synchronous dispatch path. `TaskInfo` gains an optional `message` field for this. `TaskStatus` now includes `'rejected'` and `'canceled'` for metadata fidelity.
