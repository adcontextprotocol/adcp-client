# Durable task settlement

Human approvals and provider callbacks often commit outside the request that
created an AdCP task. There are three distinct durability boundaries:

1. Commit the business outcome and an exact task-settlement intent together.
2. Apply that intent to the SDK task registry (and, for push-enabled tasks,
   atomically checkpoint the terminal webhook).
3. Deliver the terminal webhook with at-least-once recovery.

`createPostgresTaskSettlementIntentQueue()` protects the first boundary.
`createPostgresTaskSettlementCoordinator()` protects the second. The webhook
delivery recovery worker protects the third.

The same coordinator serves two kinds of push task:

- **External framework handoffs.** `ctx.handoffToTask(producer, { settlement: 'external' })`
  on a request that carries `push_notification_config`. The SDK stores the
  buyer's route against the task, and the worker settles with the bound helpers.
  See [External framework handoffs with push](#external-framework-handoffs-with-push).
- **Application-managed push tasks.** The application owns both task creation
  and protected push-route registration outside `createAdcpServerFromPlatform`'s
  `TaskHandoff` flow, and passes the route at settlement.

A polling-only external handoff (no `push_notification_config`) needs no
coordinator. Its producer durably queues the complete scoped reference, and
workers settle it with `completeScopedTask()` / `failScopedTask()`.

## External framework handoffs with push

A handler that hands work to a durable worker, for example one that proxies to a
remote agent, can accept the buyer's `push_notification_config`. The SDK owns the
push route: it is bound to the task before the buyer is told the task was
submitted, and the worker never supplies (and so cannot change) the destination
or token.

### Storage requirement

This works only when the task state and the binding are durable:

- `taskRegistry: createPostgresTaskRegistry({ pool, namespace, storageId })`.
  The `storageId` gives refs a stable registry identity across processes.
- `taskSettlementCoordinator: createPostgresTaskSettlementCoordinator({ registry, ... })`
  on that same registry instance.
- The webhook outbox (`getWebhookDeliveryRecoveryMigration()`) on the registry's
  database, and the registry table's `push_binding` column. New tables created by
  `getDecisioningTaskRegistryBootstrap()` already have the column. Upgrade an
  existing table once with `getTaskPushBindingMigration({ tableName })`. If the
  column is missing, the first push handoff fails with a migration message before
  any task is created.
- A webhook recovery worker that polls `taskSettlementCoordinator.recovery` (for
  example through the server's `webhooks.deliveryRecovery` and the recovery
  poller). `has_webhook: true` is a promise that this worker keeps.
- An `authenticationAdapter` on the coordinator if buyers send
  `push_notification_config.token`. The token is stored only in adapter-protected
  form. Without an adapter, a request with a token is refused.

With an in-memory registry, without a coordinator, or with a coordinator bound to
another registry, the handoff is refused at `ctx.handoffToTask(...)` with
`UNSUPPORTED_FEATURE` on `push_notification_config`. Polling-only external
handoffs keep working. A mismatched coordinator fails at server construction.

```ts
import {
  createAdcpServerFromPlatform,
  createPostgresTaskRegistry,
  createPostgresTaskSettlementCoordinator,
  getDecisioningTaskRegistryBootstrap,
  getTaskPushBindingMigration,
  getWebhookDeliveryRecoveryMigration,
} from '@adcp/sdk/server';

await pool.query(getDecisioningTaskRegistryBootstrap({ namespace: 'seller-prod' }));
await pool.query(getWebhookDeliveryRecoveryMigration());
// Existing registry tables only; the bootstrap above already has the column.
await pool.query(getTaskPushBindingMigration());

const taskRegistry = createPostgresTaskRegistry({
  pool,
  namespace: 'seller-prod',
  storageId: 'prod-eu1:seller-tasks',
});
const taskSettlementCoordinator = createPostgresTaskSettlementCoordinator({
  registry: taskRegistry,
  publisherScope: 'my-seller',
  authenticationAdapter: kmsAdapter,
});

const server = createAdcpServerFromPlatform(platform, {
  name: 'my-seller',
  version: '1.0.0',
  taskRegistry,
  taskSettlementCoordinator,
  webhooks: {
    /* signing key, deliveryStore, deliveryRecovery: taskSettlementCoordinator.recovery, ... */
  },
});
```

### Hand off, then settle from the worker

```ts
requestProposals: async (req, ctx) => {
  // Refused here, before the remote call, if this request cannot be accepted.
  const availability = ctx.canHandoffToTask({ settlement: 'external' });
  if (!availability.ok) throw availability.error;
  const ack = await callRemoteAgent(req);
  if (ack.status !== 'submitted') return ack;
  return ctx.handoffToTask(async taskCtx => db.enqueuePending(taskCtx.taskRef, ack.task_id), {
    settlement: 'external',
  });
};
```

Before the producer runs, the framework creates the task with `has_webhook: true`
and stores the buyer's validated URL, `operation_id`, signing profile and
protected token against it. If storing the binding fails, the producer is not
called and the buyer gets an error, not `submitted`.

The worker, in this or any later process, holds only the queued `taskRef`:

```ts
import { completeBoundPushTask, failBoundPushTask, rejectBoundPushTask } from '@adcp/sdk/server';

await completeBoundPushTask(taskSettlementCoordinator, taskRef, result);
// or: await failBoundPushTask(taskSettlementCoordinator, taskRef, structuredError);
// or: await rejectBoundPushTask(taskSettlementCoordinator, taskRef, artifact, 'Inventory sold out');
```

With the intent queue, call `applyTaskSettlementIntent(intent, { coordinator })`
and omit `push`. The coordinator reads the bound route.

Settlement takes the same path as every coordinator push settlement. The task
transition and the terminal webhook checkpoint commit in one transaction, and
the webhook recovery worker delivers the checkpoint with the emitter's RFC 9421
signing, retries and idempotency key. Retrying a settlement is idempotent and
produces at most one terminal webhook.

Pass the worker's result in the server's AdCP release, as a handler returns it.
The binding records that release and the release the request was served at, so
the webhook result (and its `errors[]`) reaches a buyer pinned to an older
release in that release's shape, exactly as a framework-settled task's webhook
does. The task row keeps the result in the server's release; a
`get_task_status` poll converts it on read.

The SDK packages one preview per minor line, and previews are not additive
over each other. If the server ran a preview and the worker runs a later SDK
that no longer packages it, the result has no faithful conversion for an older
buyer, so settlement throws `TaskPushSettlementConfigurationError` and writes
nothing, rather than send the buyer a result its release cannot express. Settle
such tasks from a worker on an SDK that packages the recorded preview (or drain
them before upgrading). A stable release always resolves to its minor line's
packaged bundle. An exact retry of a settlement whose webhook is already
checkpointed still returns `already_terminal`.

### What a worker cannot do

- **Supply a destination or token.** The bound helpers take no route.
- **Change the route with the older helpers.** `completeScopedPushTask()` /
  `failScopedPushTask()` / `rejectScopedPushTask()` still work on a bound task,
  but only when the route matches the binding exactly. A different URL, token,
  `operation_id` or signing profile, or added transport authentication, throws
  `TaskPushBindingMismatchError` and writes nothing.
- **Rebind the task.** A binding is immutable.
- **Skip the webhook.** Registry-only `completeScopedTask()` / `failScopedTask()`
  reject a push-enabled task.

The binding lives on the task row, in the registry's `push_binding` column. Its
location is fixed by the registry identity in the `taskRef` (storage id, table,
namespace), not by any coordinator setting. A worker whose coordinator uses a
different `publisherScope`, or no adapter, still finds the binding. It then
either delivers to the bound route or fails. It never falls back to a route the
worker passed. A coordinator over another registry cannot address the task. A
binding is read under the task's row lock during settlement. A consistency
fingerprint, an unkeyed hash, is checked on every read. It catches a corrupted
or partially edited binding, but it is not tamper-proof. As with the outbox,
anyone with write access to the task table is outside the threat model. Do not
drop the `push_binding` column while bound tasks are still open: on a table
without the column, every task reads as unbound.

Retention: a binding is part of its task row and is removed when the row is
purged. A reused `overrideTaskId` starts with a fresh, unbound row. The binding
keeps the adapter-protected token so a retried settlement can prove it names the
same route. Keep the adapter's decrypt keys for as long as bound tasks can still
be settled, plus your settlement intents' replay horizon.

Settle with a coordinator that uses the same outbox and `publisherScope` as
your recovery worker, so the worker picks up the checkpoint.

## Provision the queue

Run the bootstrap SQL during database provisioning:

```ts
import { getTaskSettlementIntentMigration } from '@adcp/sdk/server';

await pool.query(
  getTaskSettlementIntentMigration({
    tableName: 'seller_task_settlement_intents',
  })
);
```

Then construct one queue per trusted deployment or tenant namespace:

```ts
import {
  createPostgresTaskSettlementIntentQueue,
  TASK_SETTLEMENT_INTENT_IDEMPOTENCY_HORIZON_MS,
} from '@adcp/sdk/server';

const settlementIntents = createPostgresTaskSettlementIntentQueue({
  db: pool,
  namespace: 'seller-prod',
  tableName: 'seller_task_settlement_intents',
  // Keep this at least as long as every upstream retry/replay window.
  idempotencyHorizonMs: TASK_SETTLEMENT_INTENT_IDEMPOTENCY_HORIZON_MS,
});
```

The namespace and complete `DurableTaskSettlementRef` form the isolation key.
The queue requires `registryId`, `accountId`, and `ownerScope`; a public
`task_id` alone is not a safe worker credential. `ScopedTaskRef.registryId`
remains optional for legacy custom registries, so narrow a framework-issued
handle before building an intent:

```ts
import type { DurableTaskSettlementRef } from '@adcp/sdk/server';

if (!taskRef.registryId) {
  throw new Error('Durable settlement requires a registry-bound task handle');
}
const durableTaskRef: DurableTaskSettlementRef = {
  ...taskRef,
  registryId: taskRef.registryId,
};
```

## Commit the domain decision and intent together

Pass the application's active transaction client to `enqueue`. An exact retry
returns the same checkpoint. Reusing the same scoped task for a changed result
or error throws `TaskSettlementIntentConflictError`, including after
acknowledgement: acknowledgement turns the row into a fingerprint tombstone
for `idempotencyHorizonMs` (seven days by default). Set that horizon to at least
the longest application, provider, or transport retry/replay window. Recovery
compacts the acknowledged row so it no longer retains the result/error payload
and prunes expired tombstones in bounded batches; an expired tombstone may also
be atomically replaced by a newly enqueued intent.

```ts
import {
  applyTaskSettlementIntent,
  canonicalizeTaskSettlementIntent,
  type TaskSettlementIntent,
} from '@adcp/sdk/server';

const intent: TaskSettlementIntent = canonicalizeTaskSettlementIntent({
  taskRef: durableTaskRef,
  action: 'complete',
  result: { media_buy_id: mediaBuyId, media_buy_status: 'active' },
});

const checkpoint = await withTransaction(async tx => {
  await approvals.markApproved(tx, approvalId);
  return settlementIntents.enqueue(intent, { db: tx });
});
```

After commit, a polling-only task can try settlement immediately. Acknowledge
only after the intended terminal state is proven:

```ts
await applyTaskSettlementIntent(intent, { registry: taskRegistry });
await settlementIntents.acknowledge(checkpoint);
```

If the process dies between those calls, recovery safely repeats the same
idempotent settlement.

## Settle polling-only tasks safely

For a polling-only task, `applyTaskSettlementIntent()` handles both terminal
actions and proves that an `already_terminal` outcome contains the exact
artifact from the intent. It deliberately throws for a scope miss or
conflicting terminal write so the queue retains the intent.

Build the immediate-path object with `canonicalizeTaskSettlementIntent()` as
shown above. `enqueue` applies the same clone, validation, and wire sanitizer,
so both paths compare the same artifact. Recovery verifies the immutable
fingerprint against the exact stored payload before applying the current wire
sanitizer, so intents written by an older SDK remain compatible with the
current task registry after an upgrade.

```ts
import {
  applyTaskSettlementIntent,
  canonicalizeTaskSettlementIntent,
  type TaskRegistry,
  type TaskSettlementIntent,
} from '@adcp/sdk/server';

await applyTaskSettlementIntent(intent, { registry });
```

This registry form is only for tasks without push notifications.
`completeScopedTask()` and `failScopedTask()` reject registry-only settlement
for a push-enabled task.

## Settle application-managed push tasks safely

For an application-managed push task, persist the original push route and its
protected authentication configuration in durable application state in the same
domain transaction as the intent. Recovery must reconstruct that configuration;
an in-memory callback route can disappear in the exact crash this queue
protects. An external framework handoff does not need this: its route is
already bound by the SDK (see above).

Use the PostgreSQL settlement coordinator instead of the polling helper. Its
compatible `already_terminal` outcome proves both the exact task artifact and
the immutable webhook checkpoint:

```ts
import { applyTaskSettlementIntent } from '@adcp/sdk/server';

await applyTaskSettlementIntent(intent, { coordinator, push });
```

Never return `settled` for `not_found_in_scope`, a conflicting terminal state,
or a push-settlement compatibility conflict.

After the domain transaction commits, use the push helper before acknowledging
the same checkpoint:

```ts
const push = await protectedPushRoutes.load(intent.taskRef);
if (!push) throw new Error('Durable push configuration was not found');

await applyTaskSettlementIntent(intent, {
  coordinator: settlementCoordinator,
  push,
});
await settlementIntents.acknowledge(checkpoint);
```

## Recover intents

Run `recover` from a scheduled worker. The callback must be idempotent and
must return the literal `settled` only after it proves the intended state.
Thrown errors are retried with exponential backoff and eventually retained as
dead letters. Only the error class name is persisted; use `onError` for
application observability.

```ts
const metrics = await settlementIntents.recover({
  workerId: `settlement-worker:${process.pid}`,
  // Maximum callbacks handled by this invocation. Each row is claimed only
  // when its callback is ready to start, so earlier work does not age its lease.
  batchSize: 25,
  async settle(intent, claim) {
    // Renew again during work that can exceed leaseMs.
    if (!(await claim.extendLease())) throw new Error('Settlement intent lease lost');
    return applyTaskSettlementIntent(intent, { registry: taskRegistry });
  },
  onError(error, context) {
    telemetry.captureException(error, context);
  },
});
```

For application-managed push recovery, load the protected push configuration by
the full `intent.taskRef` and call `applyTaskSettlementIntent()` with
`{ coordinator, push }` instead. Run multiple
workers for concurrency; each worker should use a stable, unique `workerId`.
Throwing keeps the intent recoverable and reports through `onError` until the
underlying configuration is corrected.

## Inspect, monitor, and requeue dead letters

The queue intentionally has no broad administrative mutation API. Use the full
namespace, registry, account, owner, task, and fingerprint binding for every
operator write. The examples below use `psql` variables; replace the table name
if you configured a different one.

Inspect one intent without selecting its potentially sensitive payload:

```sql
\set queue_namespace 'seller-prod'
\set registry_id 'prod-eu1:seller-tasks'
\set account_id 'account-42'
\set owner_scope 'api_key:buyer-7'
\set task_id 'task-01JQ8V8YMBXQ1TQ9G1K9V0P4N7'

SELECT queue_namespace, registry_id, account_id, owner_scope, task_id,
       scope_fingerprint, action, intent_fingerprint, state, attempt_count, next_attempt_at,
       lease_owner, lease_expires_at, last_error, retain_until, created_at, updated_at,
       pg_column_size(payload) AS payload_bytes
FROM seller_task_settlement_intents
WHERE queue_namespace = :'queue_namespace'
  AND registry_id = :'registry_id'
  AND account_id = :'account_id'
  AND owner_scope = :'owner_scope'
  AND task_id = :'task_id';
```

Monitor one trusted namespace:

```sql
\set queue_namespace 'seller-prod'

SELECT count(*) FILTER (WHERE state = 'pending') AS pending_count,
       count(*) FILTER (WHERE state = 'dead_letter') AS dead_letter_count,
       count(*) FILTER (WHERE state = 'acknowledged') AS acknowledged_tombstone_count,
       clock_timestamp() - min(created_at)
         FILTER (WHERE state = 'pending') AS oldest_pending_age,
       sum(pg_column_size(payload)) AS payload_bytes
FROM seller_task_settlement_intents
WHERE queue_namespace = :'queue_namespace';

SELECT pg_size_pretty(
  pg_total_relation_size('seller_task_settlement_intents')
) AS total_table_size;
```

Schedule pruning independently of recovery traffic. Each call is bounded and
returns the number of deleted, already-expired acknowledgement tombstones:

```ts
const deleted = await settlementIntents.pruneAcknowledged({ limit: 1000 });
```

After correcting the cause, requeue exactly one inspected dead letter. Copy
the fingerprint from the inspection result and require `UPDATE 1`; zero rows
means the binding or state changed and must be inspected again.

```sql
\set intent_fingerprint '6b45e3f3eb04a98b68eaf96e186f57d5904b55074738109f131b26b0a82b2d2c'
\set scope_fingerprint '98723053ca67c0248a142b3fe5d7e610201089a322b649219cac9f4a05616bde'

BEGIN;
UPDATE seller_task_settlement_intents
SET state = 'pending',
    attempt_count = 0,
    next_attempt_at = clock_timestamp(),
    lease_owner = NULL,
    lease_claim_id = NULL,
    lease_version = lease_version + 1,
    lease_expires_at = NULL,
    last_error = NULL,
    updated_at = clock_timestamp()
WHERE queue_namespace = :'queue_namespace'
  AND registry_id = :'registry_id'
  AND account_id = :'account_id'
  AND owner_scope = :'owner_scope'
  AND task_id = :'task_id'
  AND scope_fingerprint = :'scope_fingerprint'
  AND intent_fingerprint = :'intent_fingerprint'
  AND state = 'dead_letter'
RETURNING queue_namespace, registry_id, account_id, owner_scope, task_id,
          intent_fingerprint, state, attempt_count;
COMMIT;
```

For retention, archive an exact, aged dead letter before deleting it. Protect
the archive as application data because `archived_row` contains the terminal
result or error. Provision the archive table once:

```sql
CREATE TABLE IF NOT EXISTS seller_task_settlement_intents_archive (
  queue_namespace TEXT NOT NULL,
  registry_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_scope TEXT NOT NULL,
  task_id TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL,
  intent_fingerprint TEXT NOT NULL,
  archived_row JSONB NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    queue_namespace, scope_fingerprint,
    intent_fingerprint
  )
);
```

Then archive and remove only the inspected row after the retention cutoff:

```sql
\set retain_before '2026-07-01T00:00:00Z'

BEGIN;
INSERT INTO seller_task_settlement_intents_archive (
  queue_namespace, registry_id, account_id, owner_scope, task_id,
  scope_fingerprint, intent_fingerprint, archived_row
)
SELECT queue_namespace, registry_id, account_id, owner_scope, task_id,
       scope_fingerprint, intent_fingerprint, to_jsonb(q)
FROM seller_task_settlement_intents AS q
WHERE queue_namespace = :'queue_namespace'
  AND registry_id = :'registry_id'
  AND account_id = :'account_id'
  AND owner_scope = :'owner_scope'
  AND task_id = :'task_id'
  AND scope_fingerprint = :'scope_fingerprint'
  AND intent_fingerprint = :'intent_fingerprint'
  AND state = 'dead_letter'
  AND updated_at < :'retain_before'::timestamptz
ON CONFLICT DO NOTHING;

DELETE FROM seller_task_settlement_intents AS q
WHERE q.queue_namespace = :'queue_namespace'
  AND q.registry_id = :'registry_id'
  AND q.account_id = :'account_id'
  AND q.owner_scope = :'owner_scope'
  AND q.task_id = :'task_id'
  AND q.scope_fingerprint = :'scope_fingerprint'
  AND q.intent_fingerprint = :'intent_fingerprint'
  AND q.state = 'dead_letter'
  AND q.updated_at < :'retain_before'::timestamptz
  AND EXISTS (
    SELECT 1
    FROM seller_task_settlement_intents_archive AS a
    WHERE a.queue_namespace = q.queue_namespace
      AND a.registry_id = q.registry_id
      AND a.account_id = q.account_id
      AND a.owner_scope = q.owner_scope
      AND a.task_id = q.task_id
      AND a.scope_fingerprint = q.scope_fingerprint
      AND a.intent_fingerprint = q.intent_fingerprint
  )
RETURNING q.queue_namespace, q.registry_id, q.account_id, q.owner_scope,
          q.task_id, q.intent_fingerprint;
COMMIT;
```

## Operational contract

- Settlement delivery is at least once. The settlement callback must be
  idempotent.
- Claims use `FOR UPDATE SKIP LOCKED`, leases, and fencing tokens so multiple
  workers can share the queue. Each row is claimed immediately before its
  callback. Slow callbacks can call `extendLease()` and should stop work if it
  reports that fencing ownership was lost.
- Recovery loads at most one capped payload into a worker at a time, even when
  a large recovery batch is requested.
- Acknowledgement retains the exact intent fingerprint through the configured
  idempotency horizon while discarding the no-longer-needed payload. Each
  recovery invocation prunes at most `batchSize` expired acknowledgement
  tombstones; schedule `pruneAcknowledged()` as well if recovery can be idle.
- Results are sanitized with the same wire sanitizer as the task registry;
  `ctx_metadata` and `implementation_config` are not persisted.
- Do not place credentials or application-private secrets in custom result or
  error fields. The queue strips known SDK server-only fields; it cannot infer
  which arbitrary application fields are confidential.
- Payloads are canonicalized, fingerprinted, and capped at 4 MiB.
- `probe()` verifies that the configured table and columns are reachable.
- Dead letters remain in the table for operator inspection. Requeue them only
  with the exact scoped and fingerprinted operator update above after
  correcting the cause; an exact `enqueue` does not reset a dead letter.
- Monitor pending, dead-letter, and acknowledged-tombstone row counts and table
  size; set alerts for oldest pending age; and apply admission limits before
  untrusted callers can create unbounded asynchronous work. Archive or remove
  resolved dead letters under an application-owned retention policy.
