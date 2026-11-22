---
'@adcp/sdk': minor
---

Externally settled task handoffs accept `push_notification_config` (#3761). Pass `taskSettlementCoordinator: createPostgresTaskSettlementCoordinator({ registry, publisherScope, authenticationAdapter })` to `createAdcpServerFromPlatform`, on the same `createPostgresTaskRegistry` (with `storageId`) you pass as `taskRegistry`, and add the registry table's new `push_binding` column (new tables from `getDecisioningTaskRegistryBootstrap()` have it; upgrade an existing table with the new `getTaskPushBindingMigration({ tableName })`). A request with `push_notification_config` may then return `ctx.handoffToTask(fn, { settlement: 'external' })`. Before the producer runs and before the buyer gets `submitted`, the SDK stores the buyer's validated route on the task row, under its row lock: the URL, `operation_id`, signing profile, and the token, protected by the adapter. The task reports `has_webhook: true`. Run a webhook recovery worker for `coordinator.recovery`. The binding's location follows the registry identity in the task ref, so no coordinator setting (such as `publisherScope`) can make a worker miss it, and a bound task never falls back to a caller-supplied route. If the column is missing, the handoff fails with a migration message before any task is created.

A worker settles with the new `completeBoundPushTask(coordinator, taskRef, result)` / `failBoundPushTask` / `rejectBoundPushTask`, or with `applyTaskSettlementIntent(intent, { coordinator })` without `push`. These read the stored route, so the worker never supplies or changes the destination or token. Delivery uses the coordinator's existing outbox transaction and webhook recovery worker, with the same signing, retry and idempotency as the other push helpers.

`completeScopedPushTask` / `failScopedPushTask` / `rejectScopedPushTask` keep working for application-managed push tasks. On a bound task they throw the new `TaskPushBindingMismatchError` for any different URL, token, `operation_id`, signing profile or added transport authentication.

Without a coordinator (for example an in-memory registry), or with a token and no `authenticationAdapter`, the handoff is still refused at `ctx.handoffToTask(...)`, with a message that names the missing piece.

`TaskPushSettlementConfig` gains an optional `signingProfile`. A registry table without the `push_binding` column keeps working for application-managed push tasks. `WebhookAuthenticationContext.purpose` gains `'task_push_binding'` for bound tokens.
