# Task registry scope migration

Task registry reads, writes, and background waits now require the account and
authenticated owner scope that created the task. This prevents a known task ID
from crossing account or principal boundaries.

```ts
const taskRef = await registry.create({
  tool: 'create_media_buy',
  accountId: account.id,
  ownerScope: `api_key:${keyId}`,
});

await registry.getTask(taskRef.taskId, taskRef);
await registry.updateProgress(taskRef.taskId, taskRef, progress);
await completeScopedTask(registry, taskRef, result);
await failScopedTask(registry, taskRef, error, failureArtifact);
await registry.awaitTask(taskRef.taskId, taskRef);
```

Custom `TaskRegistry` implementations must apply every scope component in the
storage query. Do not derive `ownerScope` from request parameters; use the
authenticated server context. Set `scopeVersion: 1` only after migrating those
method signatures; the platform factory rejects unmarked legacy registries so
an old `(taskId, result)` write cannot mistake the new scope argument for a
result.

`DecisioningAdcpServer.getTaskState()` and `.awaitTask()` accept the same scope.
The former unscoped `getTaskStateUnsafe()` / `_getTaskUnsafe()` lookup is no
longer part of the public production API. Persist the issued `ScopedTaskRef`
instead of recovering authority from a public task ID.

## Out-of-process settlement

`TaskRegistry.create()` returns a serializable `ScopedTaskRef` containing
`taskId`, `accountId`, `ownerScope`, and an opaque `registryId` that binds the
handle to the issuing registry partition. Framework-created HITL work exposes
the same value as `taskCtx.taskRef`. This is trusted internal authorization
state: persist the complete object, and never include it in the submitted
envelope, webhook payload, logs, or any other buyer-visible surface.

```ts
import {
  completeScopedTask,
  failScopedTask,
  type ScopedTaskRef,
} from '@adcp/sdk/server';

return ctx.handoffToTask(async taskCtx => {
  // The queue transaction must durably store the complete taskRef before the
  // producer acknowledges this write. Persisting only taskCtx.id is unsafe.
  await approvals.enqueue({ taskRef: taskCtx.taskRef, request: approvalInput });
  return await approvals.waitForResult(taskCtx.taskRef.taskId);
});

// A different process after restart:
const item = await approvals.claim();
const taskRef = item.taskRef as ScopedTaskRef;
const outcome = item.approved
  ? await completeScopedTask(registry, taskRef, item.result)
  : await failScopedTask(registry, taskRef, item.error, item.failureArtifact);

if (outcome.outcome === 'not_found_in_scope') {
  // Do not acknowledge: unknown id, namespace mismatch, account mismatch,
  // owner mismatch, and deleted rows deliberately share this result.
  await approvals.retryOrDeadLetter(item, 'registry scope did not match');
} else if (
  outcome.outcome === 'already_terminal' &&
  outcome.status !== (item.approved ? 'completed' : 'failed')
) {
  // The task reached a different terminal disposition. Do not acknowledge the
  // requested settlement as successful; reconcile or dead-letter it.
  await approvals.retryOrDeadLetter(item, `conflicting terminal state: ${outcome.status}`);
} else {
  // `applied`, or an already-terminal result with the intended disposition,
  // is safe to acknowledge idempotently.
  await approvals.ack(item);
}
```

This direct helper path is polling-only. It rejects tasks created with buyer
push notifications because a registry write alone cannot durably deliver the
terminal webhook after the request process restarts. For a request carrying
`push_notification_config`, keep the handoff live and return the eventual
result through its function so the framework owns both settlement and webhook
delivery. Do not race a terminal scoped worker helper against that live
handoff. `updateScopedTaskProgress()` remains available for push-enabled tasks
because progress does not create a terminal delivery obligation.

The framework owns normal in-process handoff settlement. The direct registry
surface is specifically for trusted webhook/queue workers and explicit
adopter-created tasks. Lifecycle mutations return `applied`,
`already_terminal`, or `not_found_in_scope`; the last outcome never reveals
whether the public task ID exists under another trusted scope.
Custom beta.13 registries that still return `void` remain accepted for
in-process compatibility, but the ref-based worker helpers fail closed until
those registries implement the discriminated outcomes and a stable
`registryId`; a durable worker must not infer `applied` from an absent result.

PostgreSQL registries additionally require a trusted deployment or tenant
namespace:

```ts
const taskRegistryNamespace = 'tenant:my-agent';
createPostgresTaskRegistry({
  pool,
  namespace: taskRegistryNamespace,
  // Stable and unique to the physical database/schema. Required for refs
  // that an out-of-process worker will settle after restart.
  storageId: 'prod-eu1:primary-db',
});
```

The returned opaque `registryId` combines `storageId`, table, and namespace.
Without `storageId`, normal in-process and polling APIs remain compatible, but
the strict scoped worker helpers reject the unbound handle. Use the same
non-secret value on every process connected to that physical registry and a
different value for another database, schema, or environment. The `pool`
shortcut exposes the same setting as `taskRegistryStorageId`.

For a brand-new or empty registry, bootstrap with that same namespace before
deploying the new registry:

```ts
await pool.query(
  getDecisioningTaskRegistryBootstrap({ namespace: taskRegistryNamespace })
);
```

This helper only creates the already-scoped schema. It no longer upgrades a
populated legacy table at application boot. The namespace must be stable across
deploys and unique for every hosted tenant. A single in-memory registry instance
must likewise not be shared across tenants unless the host includes tenant
identity in both `accountId` and `ownerScope`.

## Populated PostgreSQL upgrade

Stop legacy writers and generate the versioned operator plan:

```ts
const upgrade = getDecisioningTaskRegistryScopeV1Upgrade({
  namespace: taskRegistryNamespace,
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 15 * 60_000,
});
```

Run the phases in this order:

1. Run `preflightSql` read-only and review the estimated row count/table size,
   current primary key, missing columns, null scopes, and duplicate target keys.
2. Confirm every legacy row belongs to the one configured namespace. The legacy
   schema did not persist tenant ownership, so this is an operator decision the
   SDK cannot infer.
3. Enter a maintenance window and stop reads and writes from pre-scope
   application instances. Scoped code may be deployed only after cutover
   succeeds.
4. Run `prepareSql`. It adds and backfills columns and validates non-null scope
   in one transaction with bounded `lock_timeout` and `statement_timeout`.
   PostgreSQL retains the `ACCESS EXCLUSIVE` locks taken by its `ALTER TABLE`
   statements until commit, so readers can block for the full backfill/scan;
   size this phase from the preflight estimate and keep traffic drained.
5. Run each `concurrentIndexSql` string as a separate database call with no
   surrounding transaction. This builds the composite unique index and owner
   lookup index with lower write blocking.
6. Run `cutoverSql` during a short maintenance window. PostgreSQL still needs an
   `ACCESS EXCLUSIVE` lock to drop the old primary key and attach the staged
   unique index as the new primary key; the configured lock timeout makes a busy
   deployment fail instead of waiting indefinitely.
7. Run `verifySql`, then deploy/start scoped writers.

Every transactional phase uses a table-specific advisory lock and is retryable
with the same namespace, including after valid scoped duplicates or additional
namespaces have been written. If concurrent index creation is interrupted,
inspect `pg_index.indisvalid` and the staged index definition; drop an invalid
or wrong-shape staged index with `DROP INDEX CONCURRENTLY` and rerun that
statement. A timeout rolls back only its current transactional phase. Never
retry an incomplete legacy backfill with a different namespace: `prepareSql`
refuses to reassign rows that already carry another namespace.

If multiple hosted tenants
previously shared one legacy table, the SDK cannot infer which tenant owns each
row: the first migration would otherwise assign every legacy row to its supplied
namespace. Before migrating, drain in-flight tasks or explicitly map legacy rows
to tenant namespaces in an operator-managed migration. Do not run separate
tenant migrations over an ambiguous shared legacy table.

Rollback to pre-scope code is possible only before scoped writers create IDs
that duplicate an existing public `task_id` in another scope. After that point,
the legacy single-column primary key cannot be restored without deleting,
renaming, or merging tasks. Treat cutover plus the first scoped write as the
rollback boundary and retain a database backup for operator-led recovery.
