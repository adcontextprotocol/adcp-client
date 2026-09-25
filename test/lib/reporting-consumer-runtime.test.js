const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const ACCOUNT_ID = 'buyer-account-1';

function page({ checkpoint, total = 0, cursor, hasMore = false, snapshot = checkpoint }) {
  return {
    status: 'completed',
    view: 'periods',
    ledger_snapshot_id: `snapshot-${snapshot}`,
    ledger_as_of: '2026-09-25T00:00:00.000Z',
    changes_checkpoint: checkpoint,
    account_id: ACCOUNT_ID,
    scope: {
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2027-01-01T00:00:00.000Z',
      all_accessible_media_buys: true,
      media_buy_ids: [],
      delivery_config_generations: [],
      feed_purposes: [],
      finality: [],
      scope_closed: true,
      coverage_complete: true,
    },
    periods: [],
    revisions: [],
    materializations: [],
    receipts: [],
    consumer_statuses: [],
    pagination: { total_count: total, has_more: hasMore, ...(cursor ? { cursor } : {}) },
  };
}

function memoryPersistence() {
  const cursors = new Map();
  const leases = new Map();
  const notifications = new Map();
  const id = key => `${key.consumerScope}|${key.accountId}`;
  return {
    checkpointStore: { async get() {}, async put() {} },
    pendingConsumerStatusStore: { async get() {}, async put() {}, async clear() {} },
    changesCheckpointStore: {
      async get(key) {
        return cursors.get(id(key));
      },
      async compareAndSet(key, expected, checkpoint) {
        const existing = cursors.get(id(key));
        if ((existing?.checkpoint ?? null) !== expected) return 'conflict';
        if (expected === checkpoint) return 'unchanged';
        cursors.set(id(key), { checkpoint, generation: (existing?.generation ?? 0) + 1 });
        return 'applied';
      },
    },
    workLeases: {
      async claim({ key, ownerToken }) {
        const keyId = id(key);
        if (leases.has(keyId)) return null;
        const lease = { scopeKey: keyId, ownerToken, generation: 1, expiresAt: '2099-01-01T00:00:00.000Z' };
        leases.set(keyId, lease);
        return lease;
      },
      async renew(lease) {
        return leases.get(lease.scopeKey) === lease ? lease : null;
      },
      async release(lease) {
        if (leases.get(lease.scopeKey) !== lease) return false;
        leases.delete(lease.scopeKey);
        return true;
      },
    },
    notifications: {
      async isProcessed(input) {
        const key = `${id(input)}|${input.idempotencyKey}`;
        const existing = notifications.get(key);
        if (existing && existing !== input.payloadSha256) throw new Error('notification identity conflict');
        return existing !== undefined;
      },
      async markProcessed(input) {
        const key = `${id(input)}|${input.idempotencyKey}`;
        const existing = notifications.get(key);
        if (existing && existing !== input.payloadSha256) throw new Error('notification identity conflict');
        notifications.set(key, input.payloadSha256);
      },
      async pruneProcessed() {
        return 0;
      },
    },
    cursors,
  };
}

function account(client) {
  return {
    consumerScope: 'seller.example|buyer-principal-1',
    accountId: ACCOUNT_ID,
    reconciliation: {
      client,
      request: { account: { account_id: ACCOUNT_ID } },
      expectedPeriods: [],
      inspect: async () => ({ rowCount: 0, controlTotals: [] }),
    },
  };
}

describe('Reliable Reporting buyer runtime', () => {
  test('drains every change page and returns only a fully consumed checkpoint', async () => {
    const { drainReportingChangesV1 } = require('../../dist/lib/reporting/index.js');
    const calls = [];
    const client = {
      async getReportingStatus(params) {
        calls.push(params);
        return params.pagination?.cursor
          ? page({ checkpoint: 'checkpoint-2', total: 2, snapshot: 'delta' })
          : page({ checkpoint: 'checkpoint-2', total: 2, cursor: 'next-page', hasMore: true, snapshot: 'delta' });
      },
    };
    const result = await drainReportingChangesV1({
      client,
      request: { account: { account_id: ACCOUNT_ID } },
      changesAfter: 'checkpoint-1',
    });
    assert.deepEqual(result, {
      changed: true,
      recordCount: 2,
      ledgerSnapshotId: 'snapshot-delta',
      ledgerAsOf: '2026-09-25T00:00:00.000Z',
      changesCheckpoint: 'checkpoint-2',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].changes_after, 'checkpoint-1');
    assert.equal(calls[1].changes_after, 'checkpoint-1');
  });

  test('bootstraps durably, repairs ledger notifications, and skips duplicate doorbells', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const persistence = memoryPersistence();
    let fullCheckpoint = 'checkpoint-1';
    let deltaCount = 1;
    const calls = [];
    const client = {
      async getReportingStatus(params) {
        calls.push(params);
        if (params.changes_after) return page({ checkpoint: fullCheckpoint, total: deltaCount, snapshot: 'delta' });
        return page({ checkpoint: fullCheckpoint, snapshot: `full-${fullCheckpoint}` });
      },
      async syncReportingReceipts() {
        return { status: 'completed', results: [] };
      },
    };
    const consumer = createReliableReportingConsumerV1({
      accounts: [account(client)],
      persistence,
      ownerToken: 'buyer-worker-1',
      runOnStart: false,
    });

    const bootstrap = await consumer.runAccount(ACCOUNT_ID);
    assert.equal(bootstrap.state, 'reconciled');
    assert.equal(bootstrap.changesCheckpoint, 'checkpoint-1');

    fullCheckpoint = 'checkpoint-2';
    const repaired = await consumer.handleAuthenticatedNotification({
      notification_type: 'reporting.ledger_changed',
      account_id: ACCOUNT_ID,
      idempotency_key: 'ledger-notification-0001',
    });
    assert.equal(repaired.state, 'reconciled');
    assert.equal(repaired.changesCheckpoint, 'checkpoint-2');
    assert.equal(calls.at(-2).changes_after, 'checkpoint-1', 'the doorbell is repaired from durable state');
    assert.equal(calls.at(-1).changes_after, undefined, 'changed data triggers an authoritative full reconcile');

    deltaCount = 0;
    const beforeDuplicate = calls.length;
    const duplicate = await consumer.handleAuthenticatedNotification({
      notification_type: 'reporting.delivery_ready',
      account_id: ACCOUNT_ID,
      idempotency_key: 'delivery-notification-0001',
    });
    assert.equal(duplicate.state, 'unchanged');
    assert.equal(calls.length, beforeDuplicate + 1, 'an empty delta avoids redundant destination work');

    const beforeStatus = calls.length;
    const status = await consumer.handleAuthenticatedNotification({
      notification_type: 'reporting.status_changed',
      account_id: ACCOUNT_ID,
      idempotency_key: 'status-notification-0001',
    });
    assert.equal(status.state, 'reconciled');
    assert.equal(calls.length, beforeStatus + 1, 'clock-driven health always performs a non-incremental read');
    const repeated = await consumer.handleAuthenticatedNotification({
      notification_type: 'reporting.status_changed',
      account_id: ACCOUNT_ID,
      idempotency_key: 'status-notification-0001',
    });
    assert.equal(repeated.state, 'duplicate');
    assert.equal(calls.length, beforeStatus + 1, 'a processed transport retry performs no ledger read');
    assert.equal(await consumer.handleAuthenticatedNotification({ notification_type: 'unrelated' }), null);
    await consumer.stop();
  });

  test('binds duplicate account IDs to the authenticated seller/principal scope', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const persistence = memoryPersistence();
    const calls = [];
    const client = scope => ({
      async getReportingStatus() {
        calls.push(scope);
        return page({ checkpoint: `checkpoint-${scope}` });
      },
      async syncReportingReceipts() {
        return { status: 'completed', results: [] };
      },
    });
    const left = account(client('left'));
    const right = { ...account(client('right')), consumerScope: 'other-seller.example|buyer-principal-1' };
    const consumer = createReliableReportingConsumerV1({
      accounts: [left, right],
      persistence,
      ownerToken: 'buyer-worker-scoped',
      runOnStart: false,
    });
    await assert.rejects(() => consumer.runAccount(ACCOUNT_ID), /consumerScope is required/);
    await assert.rejects(
      () =>
        consumer.handleAuthenticatedNotification({
          notification_type: 'reporting.ledger_changed',
          account_id: ACCOUNT_ID,
          idempotency_key: 'scope-notification-0001',
        }),
      /consumerScope is required/
    );
    const result = await consumer.handleAuthenticatedNotification(
      {
        notification_type: 'reporting.ledger_changed',
        account_id: ACCOUNT_ID,
        idempotency_key: 'scope-notification-0001',
      },
      { consumerScope: right.consumerScope }
    );
    assert.equal(result.state, 'reconciled');
    assert.deepEqual(calls, ['right']);
    await consumer.stop();
  });

  test('coalesces overlapping work and waits for it during graceful shutdown', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const persistence = memoryPersistence();
    let release;
    const blocked = new Promise(resolve => {
      release = resolve;
    });
    let calls = 0;
    const client = {
      async getReportingStatus() {
        calls += 1;
        await blocked;
        return page({ checkpoint: 'checkpoint-stop' });
      },
      async syncReportingReceipts() {
        return { status: 'completed', results: [] };
      },
    };
    const consumer = createReliableReportingConsumerV1({
      accounts: [account(client)],
      persistence,
      ownerToken: 'buyer-worker-stop',
      runOnStart: false,
    });
    const first = consumer.runAccount(ACCOUNT_ID);
    const second = consumer.runAccount(ACCOUNT_ID);
    const stopping = consumer.stop();
    await new Promise(resolve => setImmediate(resolve));
    let stopped = false;
    stopping.then(() => {
      stopped = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    assert.strictEqual(await first, await second);
    await stopping;
    assert.equal(calls, 1);
    assert.equal((await consumer.runAccount(ACCOUNT_ID)).state, 'stopping');
  });
});
