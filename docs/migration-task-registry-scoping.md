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
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalizeTaskSettlementIntent,
  completeScopedTask,
  failScopedTask,
  type DurableTaskSettlementRef,
} from '@adcp/sdk/server';

return ctx.handoffToTask(async taskCtx => {
  // The queue transaction must durably store the complete taskRef before the
  // submitted response is sent. Persisting only taskCtx.id is unsafe.
  await approvals.enqueue({ taskRef: taskCtx.taskRef, request: approvalInput });
}, { settlement: 'external' });

// A different process after restart:
const item = await approvals.claim();
const taskRef = item.taskRef as DurableTaskSettlementRef;
const intent = canonicalizeTaskSettlementIntent(
  item.approved
    ? { taskRef, action: 'complete', result: item.result }
    : {
        taskRef,
        action: 'fail',
        error: item.error,
        result: item.failureArtifact,
      }
);
const outcome =
  intent.action === 'complete'
    ? await completeScopedTask(registry, taskRef, intent.result)
    : await failScopedTask(registry, taskRef, intent.error, intent.result);

if (outcome.outcome === 'not_found_in_scope') {
  // Do not acknowledge: unknown id, namespace mismatch, account mismatch,
  // owner mismatch, and deleted rows deliberately share this result.
  await approvals.retryOrDeadLetter(item, 'registry scope did not match');
} else if (outcome.outcome === 'already_terminal') {
  const stored = await registry.getTask(taskRef.taskId, taskRef);
  let storedIntent;
  if (stored?.status === 'completed' && Object.hasOwn(stored, 'result')) {
    storedIntent = canonicalizeTaskSettlementIntent({
      taskRef,
      action: 'complete',
      result: stored.result,
    });
  } else if (stored?.status === 'failed' && stored.error) {
    storedIntent = canonicalizeTaskSettlementIntent({
      taskRef,
      action: 'fail',
      error: stored.error,
      ...(Object.hasOwn(stored, 'result') && { result: stored.result }),
    });
  }
  const exactArtifact = storedIntent !== undefined && isDeepStrictEqual(storedIntent, intent);

  if (exactArtifact) {
    await approvals.ack(item);
  } else {
    // Matching status alone is insufficient: a different terminal artifact is
    // a conflict and must remain available for reconciliation/dead-lettering.
    await approvals.retryOrDeadLetter(item, 'conflicting terminal artifact');
  }
} else {
  // Only the mutation applied by this worker is safe to acknowledge directly.
  await approvals.ack(item);
}
```

The direct `completeScopedTask()` / `failScopedTask()` path is polling-only and
continues to reject push-enabled tasks. A registry write by itself cannot
durably promise the terminal webhook.

For application-managed push settlement, use the transactional PostgreSQL
coordinator. This lower-level path is for integrations that independently
create and own both the task and protected push registration outside the
framework `TaskHandoff` path. It writes the terminal task row and webhook
recovery outbox entry in one transaction, then lets the ordinary webhook
recovery worker publish it. Both tables must use the same `pg.Pool` and
database/schema:

```ts
import {
  completeScopedPushTask,
  createPostgresTaskRegistry,
  createPostgresTaskSettlementCoordinator,
  createWebhookEmitter,
  getWebhookDeliveryMigration,
  getWebhookDeliveryRecoveryMigration,
  pgWebhookDeliveryStore,
  pollWebhookDeliveryRecovery,
  TaskPushSettlementConfigurationError,
} from '@adcp/sdk/server';

// Integration sketch: pool, approvals, applicationCreatedTask, approvalInput,
// seal/openPushRoute, the KMS adapter, and signerKey are application-owned.
// The application must have durably created the task and protected push route
// before it schedules this worker path.

await pool.query(getWebhookDeliveryRecoveryMigration({
  tableName: 'my_agent_task_webhook_outbox',
}));
await pool.query(getWebhookDeliveryMigration({
  tableName: 'my_agent_webhook_bindings',
}));

const registry = createPostgresTaskRegistry({
  pool,
  namespace: 'tenant:my-agent',
  storageId: 'prod-eu1:primary-db',
});
const settlements = createPostgresTaskSettlementCoordinator({
  registry,
  publisherScope: 'my-agent',
  outbox: { tableName: 'my_agent_task_webhook_outbox' },
  authenticationAdapter: kmsWebhookAuthenticationAdapter,
});

// The application-managed task creation flow has already persisted the
// complete scoped handle and encrypted push route. Queue only opaque protected
// route state; never copy credentials into task results, logs, or dead letters.
await approvals.enqueue({
  taskRef: applicationCreatedTask.taskRef,
  push: applicationCreatedTask.protectedPushRoute,
  request: approvalInput,
});

// A different process, including after the request process restarted:
const item = await approvals.claim();
const openedPush = await openPushRoute(item.push);
const legacyScheme = openedPush.authentication?.schemes[0];
let outcome;
try {
  outcome = await completeScopedPushTask(
    settlements,
    item.taskRef,
    {
      url: openedPush.url,
      operationId: openedPush.operationId,
      servedAdcpVersion: openedPush.servedAdcpVersion,
      token: openedPush.token,
      authentication:
        legacyScheme === 'Bearer'
          ? { type: 'bearer', token: openedPush.authentication.credentials }
          : legacyScheme === 'HMAC-SHA256'
            ? { type: 'hmac_sha256', secret: openedPush.authentication.credentials }
            : null,
    },
    item.result,
  );
} catch (error) {
  if (error instanceof TaskPushSettlementConfigurationError || error instanceof TypeError) {
    await approvals.deadLetterAndAlert(item, error); // immutable bad route/config
  } else {
    await approvals.retry(item, error); // transaction/infrastructure failure
  }
  return;
}

if (
  outcome.outcome === 'applied' ||
  (outcome.outcome === 'already_terminal' && outcome.compatibility === 'compatible')
) {
  await approvals.ack(item);
} else {
  // A scope miss or conflicting terminal result must not be acknowledged as
  // success. Apply the queue's bounded retry/dead-letter policy and alert.
  await approvals.retryOrDeadLetter(item, outcome);
}

// Publish/recover outside the database transaction. The outbox lease is
// fenced; a crash before publish or before acknowledgement is retryable.
await pollWebhookDeliveryRecovery({
  recovery: settlements.recovery,
  deliver: async lease => {
    const emitter = createWebhookEmitter({
      signerKey,
      publisherScope: lease.key.publisherScope,
      tenantScope: lease.key.tenantScope,
      deliveryStore: pgWebhookDeliveryStore(pool, {
        tableName: 'my_agent_webhook_bindings',
      }),
      deliveryRecovery: settlements.recovery,
    });
    const result = await emitter.emitRecovered(lease);
    return result.delivered
      ? { disposition: 'delivered' }
      : result.terminal
        ? { disposition: 'terminal' }
        : { disposition: 'retry', retryAfterMs: 1_000 };
  },
});
```

`TaskPushSettlementOutcome` reports the two independent state machines. Task
mutation is `applied`, compatible/conflicting `already_terminal`, or the
non-enumerating `not_found_in_scope`. Delivery is `durably_bound`,
`recoverable`, `delivered`, or `terminal`; scope misses and conflicting
settlements report `not_applicable` and never create an outbox entry. Retries
reuse one deterministic delivery identity and the first committed payload.

The settlement coordinator explicitly removes the top-level task-webhook
`token` from the JSON payload before persistence and protects it through
`authenticationAdapter`; generic recovery snapshots do not reinterpret a
field merely because it is named `token`. The adapter context has
`purpose: 'payload_token'` for that validation token. The context for legacy
transport authentication intentionally leaves `purpose` undefined so pending
snapshots encrypted by older SDK versions keep the same KMS AAD.
Include a key version in `protectedValue`; retain old decrypt-only key versions
until every pending delivery using them has settled and the configured retry
horizon has elapsed. Rotate by writing with the new version while continuing
to resolve old versions. Never store cleartext push tokens in the approval
queue, task result, logs, metrics, or dead-letter metadata.

`updateScopedTaskProgress()` remains available for push-enabled tasks because
progress does not create a terminal delivery obligation. Use
`{ settlement: 'external' }` only for polling-only framework handoffs; omit
`push_notification_config`. Its registry must declare `durability: 'durable'`
and issue a stable `registryId`; the built-in in-memory registry is process-local
and is rejected before the producer runs or the buyer receives `submitted`. Its
producer callback may enqueue work but cannot return a terminal artifact; even
if that callback throws, the framework rejects the initial invocation, leaves
the task internally submitted, and writes no webhook. The buyer never receives
an acknowledgment before recoverable work exists. The push coordinator helpers
above are instead for application-managed tasks and protected registrations;
they do not make an external framework handoff push-capable.

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
