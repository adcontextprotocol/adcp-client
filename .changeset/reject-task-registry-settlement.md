---
'@adcp/sdk': minor
---

Add non-breaking business-rejection settlement for decisioning tasks. `TaskRegistry.reject?()`, `taskCtx.reject(result, reason)`, and `rejectScopedTask()` record a `rejected` terminal artifact with an optional buyer-visible reason, distinct from structured execution failures. PostgreSQL registries and `rejectScopedPushTask()` preserve the same scoped, idempotent, atomic task/outbox protections as complete and fail settlement.

New PostgreSQL bootstraps accept all nine AdCP task statuses. Before using rejection on a table created by an earlier SDK, run `getDecisioningTaskRegistryStatusWidenV61Migration()` during a maintenance window. The idempotent helper uses bounded lock and statement timeouts, but its `ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock and can briefly block task reads and writes.
