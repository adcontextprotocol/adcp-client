---
"@adcp/client": patch
---

Fixed `pollTaskCompletion` using the client-minted local UUID instead of the server-assigned task ID when polling `tasks/get` (#966).

`setupSubmittedTask` now extracts the server-assigned task ID from the initial response via `responseParser.getTaskId()` and passes it to the polling closures. The buyer-facing `SubmittedContinuation.taskId` field now holds the server-assigned ID (matching its JSDoc), while the new `SubmittedContinuation.operationId` field carries the SDK-internal local UUID used for webhook URL macros and activity events. Before this fix, every `submitted.track()` and `submitted.waitForCompletion()` call against a spec-conformant seller returned NOT_FOUND.
