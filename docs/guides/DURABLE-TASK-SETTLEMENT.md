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
import { createPostgresTaskSettlementIntentQueue } from '@adcp/sdk/server';

const settlementIntents = createPostgresTaskSettlementIntentQueue({
  db: pool,
  namespace: 'seller-prod',
  tableName: 'seller_task_settlement_intents',
});
```

The namespace and complete `ScopedTaskRef` form the isolation key. The queue
requires `registryId`, `accountId`, and `ownerScope`; a public `task_id` alone
is not a safe worker credential.

## Commit the domain decision and intent together

Pass the application's active transaction client to `enqueue`. An exact retry
returns the same checkpoint. Reusing the same scoped task for a changed result
or error throws `TaskSettlementIntentConflictError`.

```ts
const checkpoint = await withTransaction(async tx => {
  await approvals.markApproved(tx, approvalId);

  return settlementIntents.enqueue(
    {
      taskRef,
      action: 'complete',
      result: { media_buy_id: mediaBuyId, media_buy_status: 'active' },
    },
    { db: tx }
  );
});
```

After commit, try the normal settlement path immediately. Acknowledge only
after the intended terminal state is proven:

```ts
await applySettlementIntent(intent);
await settlementIntents.acknowledge(checkpoint);
```

If the process dies between those calls, recovery safely repeats the same
idempotent settlement.

For push-enabled tasks, persist the original push route and protected
authentication configuration in durable application state in the same domain
transaction. Recovery must reconstruct the push settlement from that durable
state; an in-memory callback route can disappear in the exact crash this queue
is designed to recover.

## Recover intents

Run `recover` from a scheduled worker. The callback must be idempotent and
must return the literal `settled` only after it proves the intended state.
Thrown errors are retried with exponential backoff and eventually retained as
dead letters. Only the error class name is persisted; use `onError` for
application observability.

```ts
const metrics = await settlementIntents.recover({
  workerId: `settlement-worker:${process.pid}`,
  async settle(intent, claim) {
    // For unusually slow KMS/provider calls, renew before the lease expires.
    if (!(await claim.extendLease())) throw new Error('Settlement intent lease lost');
    await applySettlementIntent(intent);
    return 'settled';
  },
  onError(error, context) {
    telemetry.captureException(error, context);
  },
});
```

For polling-only tasks, `applySettlementIntent` can call
`completeScopedTask()` or `failScopedTask()`. Accept `applied` directly. For
`already_terminal`, read the scoped task and compare its stored terminal
result or error with the exact intent before acknowledging it; status alone
does not prove that a competing terminal write had the same artifact. For
push-enabled tasks, use `completeScopedPushTask()` or `failScopedPushTask()`
with the original push configuration. Those helpers route through the
PostgreSQL settlement coordinator so the task transition and terminal webhook
checkpoint commit in one transaction.

Never return `settled` for `not_found_in_scope`, a conflicting terminal state,
or a push-settlement compatibility conflict. Throw so the intent remains
recoverable (and alerts through `onError`) until the underlying configuration
is corrected.

## Operational contract

- Settlement delivery is at least once. The settlement callback must be
  idempotent.
- Claims use `FOR UPDATE SKIP LOCKED`, leases, and fencing tokens so multiple
  workers can share the queue. Slow callbacks can call `extendLease()`; they
  should stop work if it reports that fencing ownership was lost.
- Claims return bounded metadata and load at most one capped payload into the
  worker at a time, even when a large recovery batch is requested.
- Results are sanitized with the same wire sanitizer as the task registry;
  `ctx_metadata` and `implementation_config` are not persisted.
- Do not place credentials or application-private secrets in custom result or
  error fields. The queue strips known SDK server-only fields; it cannot infer
  which arbitrary application fields are confidential.
- Payloads are canonicalized, fingerprinted, and capped at 4 MiB.
- `probe()` verifies that the configured table and columns are reachable.
- Dead letters remain in the table for operator inspection. Requeue them only
  after correcting the cause; an exact `enqueue` does not silently reset a
  dead letter.
- Monitor pending/dead-letter row counts and table size, set alerts for oldest
  pending age, and apply admission limits before untrusted callers can create
  unbounded asynchronous work. Archive or remove resolved dead letters under
  an application-owned retention policy.
