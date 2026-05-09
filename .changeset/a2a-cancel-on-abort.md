---
"@adcp/sdk": minor
---

feat(comply): fire-and-forget A2A tasks/cancel when pollTaskCompletion aborts (adcp-client#1617)

When `comply()` or `waitForCompletion()` is aborted via `AbortSignal` against an A2A seller, the SDK now dispatches a `tasks/cancel` JSON-RPC call to the seller before returning the failed `TaskResult`. This prevents orphan tasks from continuing to run (and billing the seller) after the buyer has given up.

Per A2A 0.3.0 §7.4. Cancel failure is non-fatal — network errors, `TaskNotCancelableError`, and terminal-state races are swallowed. The caller's `TaskResult` is unchanged (`{ status: 'failed', error: '...cancelled' }`).
