/** PostgreSQL durability coverage for buyer-side Reliable Reporting state. */
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('Postgres reporting consumer runtime', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_consumer_${process.pid}`;
  let bootstrap;
  let pool;
  let reporting;
  let runtime;

  before(async () => {
    const { Pool } = require('pg');
    reporting = require('../../dist/lib/reporting/index.js');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    runtime = reporting.createPostgresReportingConsumerRuntimeV1({
      db: pool,
      namespace: 'buyer-production-v1',
    });
    await pool.query(runtime.migrations.persistence);
    await pool.query(runtime.migrations.persistence);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('probes every required durable table', async () => {
    await runtime.probe();
  });

  test('keeps the first immutable receipt checkpoint and replays it exactly', async () => {
    const key = {
      consumerScope: 'seller.example|buyer-agent.example',
      accountId: 'account-1',
      reportingObligationId: 'obligation-1',
      reportingRevisionId: 'revision-1',
      reportingMaterializationId: 'materialization-1',
      destinationRef: 'warehouse-1',
    };
    const checkpoint = {
      receipt: {
        reporting_receipt_id: 'receipt-1',
        reporting_obligation_id: 'obligation-1',
        reporting_revision_id: 'revision-1',
        reporting_materialization_id: 'materialization-1',
        status: 'accepted',
      },
      receiptSyncIdempotencyKey: 'receipt-sync-key-0001',
      contextFingerprint: 'a'.repeat(64),
    };
    assert.equal(await runtime.checkpointStore.get(key), undefined);
    await runtime.checkpointStore.put(key, checkpoint);
    await runtime.checkpointStore.put(key, structuredClone(checkpoint));
    assert.deepEqual(await runtime.checkpointStore.get(key), checkpoint);
    await assert.rejects(
      () =>
        runtime.checkpointStore.put(key, {
          ...checkpoint,
          receiptSyncIdempotencyKey: 'different-sync-key-0002',
        }),
      error => error?.name === 'ReportingConsumerPersistenceConflictError'
    );

    const replacementKey = { ...key, contextFingerprint: `v2:${'d'.repeat(64)}` };
    const replacement = {
      ...checkpoint,
      receiptSyncIdempotencyKey: 'replacement-sync-key-0003',
      contextFingerprint: 'd'.repeat(64),
    };
    await runtime.checkpointStore.put(replacementKey, replacement);
    assert.deepEqual(await runtime.checkpointStore.get(replacementKey), replacement);

    const rows = await pool.query('SELECT key_sha256, value::text FROM adcp_reporting_consumer_checkpoints');
    assert.equal(rows.rows.length, 2);
    assert.match(rows.rows[0].key_sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      rows.rows[0].value.includes(key.consumerScope),
      false,
      'seller/principal scope is indexed only by digest and never stored in the checkpoint body'
    );
  });

  test('keeps adjustment acknowledgements crash-safe and isolated by superseded leaf', async () => {
    const key = {
      consumerScope: 'seller.example|buyer-agent.example',
      accountId: 'account-1',
      reportingAdjustmentId: 'adjustment-1',
      adjustsReportingRevisionId: 'revision-1',
      supersedesReportingReceiptId: 'rejected-receipt-1',
    };
    const checkpoint = {
      adjustmentReceipt: {
        reporting_receipt_id: 'adjustment-receipt-accepted-1',
        reporting_adjustment_id: 'adjustment-1',
        adjusts_reporting_revision_id: 'revision-1',
        supersedes_reporting_receipt_id: 'rejected-receipt-1',
        status: 'accepted',
        observed_adjustment_sha256: 'a'.repeat(64),
        observed_at: '2026-09-02T01:00:00Z',
      },
      receiptSyncIdempotencyKey: 'adjustment-sync-key-0001',
      contextFingerprint: 'b'.repeat(64),
    };

    assert.equal(await runtime.checkpointStore.getAdjustment(key), undefined);
    await runtime.checkpointStore.putAdjustment(key, checkpoint);
    await runtime.checkpointStore.putAdjustment(key, structuredClone(checkpoint));
    assert.deepEqual(await runtime.checkpointStore.getAdjustment(key), checkpoint);
    assert.equal(
      await runtime.checkpointStore.getAdjustment({
        ...key,
        supersedesReportingReceiptId: 'rejected-receipt-2',
      }),
      undefined
    );
    await assert.rejects(
      () =>
        runtime.checkpointStore.putAdjustment(key, {
          ...checkpoint,
          receiptSyncIdempotencyKey: 'different-adjustment-sync-key',
        }),
      error => error?.name === 'ReportingConsumerPersistenceConflictError'
    );
  });

  test('replaces an unconfirmed status claim and clears only after confirmation', async () => {
    const key = {
      consumerScope: 'seller.example|buyer-agent.example',
      accountId: 'account-1',
      deliveryConfigId: 'delivery-1',
      deliveryConfigVersion: 1,
      reportDefinitionId: 'report-1',
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-01-02T00:00:00.000Z',
    };
    const first = {
      statement: { reporting_status_id: 'status-1', consumer_status: 'revision_missing' },
      claimFingerprint: 'b'.repeat(64),
    };
    const repaired = {
      statement: { reporting_status_id: 'status-2', consumer_status: 'received' },
      claimFingerprint: 'c'.repeat(64),
    };
    await runtime.pendingConsumerStatusStore.put(key, first);
    assert.deepEqual(await runtime.pendingConsumerStatusStore.get(key), first);
    assert.equal(
      await runtime.pendingConsumerStatusStore.get({
        ...key,
        consumerScope: 'other-seller.example|buyer-agent.example',
      }),
      undefined,
      'pending retries are isolated by authenticated seller/principal scope'
    );
    await runtime.pendingConsumerStatusStore.put(key, repaired);
    assert.deepEqual(await runtime.pendingConsumerStatusStore.get(key), repaired);
    await runtime.pendingConsumerStatusStore.clear(key);
    assert.equal(await runtime.pendingConsumerStatusStore.get(key), undefined);
  });

  test('advances opaque changes checkpoints with compare-and-set fencing', async () => {
    const key = { consumerScope: 'seller.example|buyer-agent.example', accountId: 'account-cursor' };
    assert.equal(await runtime.changesCheckpointStore.get(key), undefined);
    assert.equal(await runtime.changesCheckpointStore.compareAndSet(key, null, 'checkpoint-1'), 'applied');
    assert.deepEqual(await runtime.changesCheckpointStore.get(key), { checkpoint: 'checkpoint-1', generation: 1 });
    assert.equal(await runtime.changesCheckpointStore.compareAndSet(key, 'checkpoint-1', 'checkpoint-1'), 'unchanged');
    assert.deepEqual(await runtime.changesCheckpointStore.get(key), { checkpoint: 'checkpoint-1', generation: 1 });
    assert.equal(await runtime.changesCheckpointStore.compareAndSet(key, null, 'checkpoint-2'), 'conflict');
    assert.equal(await runtime.changesCheckpointStore.compareAndSet(key, 'checkpoint-1', 'checkpoint-2'), 'applied');
    assert.deepEqual(await runtime.changesCheckpointStore.get(key), { checkpoint: 'checkpoint-2', generation: 2 });
    assert.equal(await runtime.changesCheckpointStore.clear(key, 'checkpoint-stale'), false);
    assert.equal(await runtime.changesCheckpointStore.clear(key, 'checkpoint-2'), true);
    assert.equal(await runtime.changesCheckpointStore.get(key), undefined);
    const absent = { consumerScope: key.consumerScope, accountId: 'account-cursor-absent' };
    assert.equal(
      await runtime.changesCheckpointStore.compareAndSet(absent, 'checkpoint-never-written', 'checkpoint-2'),
      'conflict'
    );
    assert.equal(await runtime.changesCheckpointStore.get(absent), undefined);
  });

  test('fences concurrent buyer replicas with renewable per-account leases', async () => {
    const key = { consumerScope: 'seller.example|buyer-agent.example', accountId: 'account-lease' };
    const first = await runtime.workLeases.claim({
      key,
      ownerToken: 'buyer-worker-one',
      leaseMilliseconds: 30_000,
    });
    assert.ok(first);
    assert.equal(
      await runtime.workLeases.claim({
        key,
        ownerToken: 'buyer-worker-two',
        leaseMilliseconds: 30_000,
      }),
      null
    );
    const renewed = await runtime.workLeases.renew(first, 30_000);
    assert.ok(renewed);
    const duplicateOwner = await runtime.workLeases.claim({
      key,
      ownerToken: 'buyer-worker-one',
      leaseMilliseconds: 30_000,
    });
    assert.equal(duplicateOwner, null, 'a shared owner token cannot bypass mutual exclusion');
    assert.equal(await runtime.workLeases.release(first), true);
    const afterRelease = await runtime.workLeases.claim({
      key,
      ownerToken: 'buyer-worker-two',
      leaseMilliseconds: 30_000,
    });
    assert.ok(afterRelease);
    assert.equal(afterRelease.generation, first.generation + 1, 'release must not reset the fencing generation');
    assert.equal(await runtime.workLeases.renew(first, 30_000), null, 'a released lease cannot renew its successor');
    assert.equal(await runtime.workLeases.release(first), false, 'a released lease cannot release its successor');
    assert.equal(
      await runtime.changesCheckpointStore.compareAndSet(key, null, 'stale-writer', first),
      'conflict',
      'an expired lease generation cannot initialize the cursor'
    );
    assert.equal(
      await runtime.changesCheckpointStore.compareAndSet(key, null, 'current-writer', afterRelease),
      'applied'
    );
  });

  test('fences pending status replacement and confirmation across lease takeover', async () => {
    const leaseKey = {
      consumerScope: 'seller.example|buyer-agent.example',
      accountId: 'account-status-fence',
    };
    const statusKey = {
      ...leaseKey,
      deliveryConfigId: 'delivery-status-fence',
      deliveryConfigVersion: 1,
      reportDefinitionId: 'report-status-fence',
      periodStart: '2026-02-01T00:00:00.000Z',
      periodEnd: '2026-02-02T00:00:00.000Z',
    };
    const firstPending = {
      statement: { reporting_status_id: 'status-stale', consumer_status: 'revision_missing' },
      claimFingerprint: 'e'.repeat(64),
    };
    const successorPending = {
      statement: { reporting_status_id: 'status-current', consumer_status: 'received' },
      claimFingerprint: 'f'.repeat(64),
    };
    const firstLease = await runtime.workLeases.claim({
      key: leaseKey,
      ownerToken: 'buyer-status-worker-one',
      leaseMilliseconds: 30_000,
    });
    assert.ok(firstLease);
    await runtime.pendingConsumerStatusStore.put(statusKey, firstPending, firstLease);
    assert.equal(await runtime.workLeases.release(firstLease), true);
    const successorLease = await runtime.workLeases.claim({
      key: leaseKey,
      ownerToken: 'buyer-status-worker-two',
      leaseMilliseconds: 30_000,
    });
    assert.ok(successorLease);
    await runtime.pendingConsumerStatusStore.put(statusKey, successorPending, successorLease);

    await assert.rejects(
      () => runtime.pendingConsumerStatusStore.put(statusKey, firstPending, firstLease),
      error => error?.name === 'ReportingConsumerPersistenceConflictError'
    );
    await runtime.pendingConsumerStatusStore.clear(statusKey, firstPending, firstLease);
    assert.deepEqual(await runtime.pendingConsumerStatusStore.get(statusKey), successorPending);
    await runtime.pendingConsumerStatusStore.clear(statusKey, firstPending, successorLease);
    assert.deepEqual(
      await runtime.pendingConsumerStatusStore.get(statusKey),
      successorPending,
      'a current worker cannot clear a different exact retry statement'
    );
    await runtime.pendingConsumerStatusStore.clear(statusKey, successorPending, successorLease);
    assert.equal(await runtime.pendingConsumerStatusStore.get(statusKey), undefined);
  });

  test('serializes a blocked pending write before lease takeover', async () => {
    const leaseKey = {
      consumerScope: 'seller.example|buyer-agent.example',
      accountId: 'account-status-lock-order',
    };
    const statusKey = {
      ...leaseKey,
      deliveryConfigId: 'delivery-status-lock-order',
      deliveryConfigVersion: 1,
      reportDefinitionId: 'report-status-lock-order',
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-03-02T00:00:00.000Z',
    };
    const basePending = {
      statement: { reporting_status_id: 'status-lock-base', consumer_status: 'revision_missing' },
      claimFingerprint: '1'.repeat(64),
    };
    const stalePending = {
      statement: { reporting_status_id: 'status-lock-stale', consumer_status: 'unreadable' },
      claimFingerprint: '2'.repeat(64),
    };
    const successorPending = {
      statement: { reporting_status_id: 'status-lock-successor', consumer_status: 'received' },
      claimFingerprint: '3'.repeat(64),
    };
    const firstLease = await runtime.workLeases.claim({
      key: leaseKey,
      ownerToken: 'buyer-lock-worker-one',
      leaseMilliseconds: 1_000,
    });
    assert.ok(firstLease);
    await runtime.pendingConsumerStatusStore.put(statusKey, basePending, firstLease);

    const blocker = await pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query(
        `SELECT 1 FROM adcp_reporting_consumer_statuses
          WHERE namespace = $1 AND value->'statement'->>'reporting_status_id' = $2
          FOR UPDATE`,
        ['buyer-production-v1', 'status-lock-base']
      );
      const staleWrite = runtime.pendingConsumerStatusStore.put(statusKey, stalePending, firstLease);
      await new Promise(resolve => setTimeout(resolve, 1_100));
      const successorClaim = runtime.workLeases.claim({
        key: leaseKey,
        ownerToken: 'buyer-lock-worker-two',
        leaseMilliseconds: 30_000,
      });
      const claimState = await Promise.race([
        successorClaim.then(() => 'claimed'),
        new Promise(resolve => setTimeout(() => resolve('blocked'), 100)),
      ]);
      assert.equal(
        claimState,
        'blocked',
        'the pending mutation must retain the lease-row lock until its status write commits'
      );
      await blocker.query('COMMIT');
      blockerOpen = false;
      await staleWrite;
      const successorLease = await successorClaim;
      assert.ok(successorLease);
      await runtime.pendingConsumerStatusStore.put(statusKey, successorPending, successorLease);
      assert.deepEqual(await runtime.pendingConsumerStatusStore.get(statusKey), successorPending);
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  test('deduplicates processed notifications within authenticated scope', async () => {
    const identity = {
      consumerScope: 'seller.example|buyer-agent.example',
      accountId: 'account-notification',
      idempotencyKey: 'notification-key-0001',
      payloadSha256: 'd'.repeat(64),
    };
    assert.equal(await runtime.notifications.isProcessed(identity), false);
    await runtime.notifications.markProcessed(identity);
    await runtime.notifications.markProcessed(structuredClone(identity));
    assert.equal(await runtime.notifications.isProcessed(identity), true);
    assert.equal(
      await runtime.notifications.isProcessed({
        ...identity,
        consumerScope: 'other-seller.example|buyer-agent.example',
      }),
      false
    );
    await assert.rejects(
      () => runtime.notifications.isProcessed({ ...identity, payloadSha256: 'e'.repeat(64) }),
      error => error?.name === 'ReportingConsumerPersistenceConflictError'
    );
  });
});
