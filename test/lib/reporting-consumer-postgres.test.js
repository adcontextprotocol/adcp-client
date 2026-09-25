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

    const rows = await pool.query('SELECT key_sha256, value::text FROM adcp_reporting_consumer_checkpoints');
    assert.equal(rows.rows.length, 1);
    assert.match(rows.rows[0].key_sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      rows.rows[0].value.includes(key.consumerScope),
      false,
      'seller/principal scope is indexed only by digest and never stored in the checkpoint body'
    );
  });

  test('replaces an unconfirmed status claim and clears only after confirmation', async () => {
    const key = {
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
    const reclaimed = await runtime.workLeases.claim({
      key,
      ownerToken: 'buyer-worker-one',
      leaseMilliseconds: 30_000,
    });
    assert.ok(reclaimed);
    assert.equal(reclaimed.generation, first.generation + 1);
    assert.equal(await runtime.workLeases.release(first), false, 'the stale generation cannot release its successor');
    assert.equal(await runtime.workLeases.release(reclaimed), true);
    assert.ok(
      await runtime.workLeases.claim({
        key,
        ownerToken: 'buyer-worker-two',
        leaseMilliseconds: 30_000,
      })
    );
  });
});
