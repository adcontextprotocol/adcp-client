# Task registry scope migration

Task registry reads, writes, and background waits now require the account and
authenticated owner scope that created the task. This prevents a known task ID
from crossing account or principal boundaries.

```ts
const scope = { accountId: account.id, ownerScope: `api_key:${keyId}` };

await registry.getTask(taskId, scope);
await registry.updateProgress(taskId, scope, progress);
await registry.complete(taskId, scope, result);
await registry.fail(taskId, scope, error, failureArtifact);
await registry.awaitTask(taskId, scope);
```

Custom `TaskRegistry` implementations must apply every scope component in the
storage query. Do not derive `ownerScope` from request parameters; use the
authenticated server context. Set `scopeVersion: 1` only after migrating those
method signatures; the platform factory rejects unmarked legacy registries so
an old `(taskId, result)` write cannot mistake the new scope argument for a
result.

`DecisioningAdcpServer.getTaskState()` and `.awaitTask()` accept the same scope.
Administrative and test code that intentionally has no buyer context can use
the explicitly named `getTaskStateUnsafe()` and `awaitTaskUnsafe()` helpers.
Unsafe reads return `null` when the same public task ID exists in more than one
scope.

PostgreSQL registries additionally require a trusted deployment or tenant
namespace:

```ts
const taskRegistryNamespace = 'tenant:my-agent';
createPostgresTaskRegistry({
  pool,
  namespace: taskRegistryNamespace,
});
```

Run the migration with that same namespace before deploying the new registry:

```ts
await pool.query(
  getDecisioningTaskRegistryMigration({ namespace: taskRegistryNamespace })
);
```

It backfills legacy rows to the supplied registry namespace and account fallback
owner scope, then migrates the primary key to
`(registry_namespace, account_id, owner_scope, task_id)`. The namespace must be
stable across deploys and unique for every hosted tenant. A single in-memory
registry instance must likewise not be shared across tenants unless the host
includes tenant identity in both `accountId` and `ownerScope`.

The legacy table did not store a tenant identifier. If multiple hosted tenants
previously shared one legacy table, the SDK cannot infer which tenant owns each
row: the first migration would otherwise assign every legacy row to its supplied
namespace. Before migrating, drain in-flight tasks or explicitly map legacy rows
to tenant namespaces in an operator-managed migration. Do not run separate
tenant migrations over an ambiguous shared legacy table.
