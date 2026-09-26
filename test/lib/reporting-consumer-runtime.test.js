const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const ACCOUNT_ID = 'buyer-account-1';
const AUTHENTICATION = { consumerScope: 'seller.example|buyer-principal-1' };

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

  test('enforces the change-walk deadline when a client ignores cancellation', async () => {
    const { drainReportingChangesV1 } = require('../../dist/lib/reporting/index.js');
    await assert.rejects(
      () =>
        drainReportingChangesV1({
          client: {
            async getReportingStatus() {
              await new Promise(resolve => setTimeout(resolve, 50));
              return page({ checkpoint: 'checkpoint-too-late' });
            },
          },
          request: { account: { account_id: ACCOUNT_ID } },
          changesAfter: 'checkpoint-before-timeout',
          limits: { maxLoadMs: 5 },
        }),
      error => error?.code === 'CHANGE_LIMIT_EXCEEDED'
    );
  });

  test('drains conformant change pages that omit optional total_count', async () => {
    const { drainReportingChangesV1 } = require('../../dist/lib/reporting/index.js');
    const response = page({ checkpoint: 'checkpoint-without-total' });
    delete response.pagination.total_count;
    response.periods = [{ reporting_obligation_id: 'changed-obligation' }];
    const result = await drainReportingChangesV1({
      client: {
        async getReportingStatus() {
          return response;
        },
      },
      request: { account: { account_id: ACCOUNT_ID } },
      changesAfter: 'checkpoint-before-change',
    });
    assert.equal(result.changed, true);
    assert.equal(result.recordCount, 1);
    assert.equal(result.changesCheckpoint, 'checkpoint-without-total');
  });

  test('does not skip adjustment-receipt-only changes when total_count is absent or stale', async () => {
    const { drainReportingChangesV1 } = require('../../dist/lib/reporting/index.js');
    for (const declaredTotal of [undefined, 0]) {
      const response = page({ checkpoint: `checkpoint-adjustment-${declaredTotal ?? 'absent'}` });
      if (declaredTotal === undefined) delete response.pagination.total_count;
      else response.pagination.total_count = declaredTotal;
      response.adjustment_receipts = [{ reporting_adjustment_receipt_id: 'adjustment-receipt-1' }];
      const result = await drainReportingChangesV1({
        client: {
          async getReportingStatus() {
            return response;
          },
        },
        request: { account: { account_id: ACCOUNT_ID } },
        changesAfter: 'checkpoint-before-adjustment',
      });
      assert.equal(result.changed, true);
      assert.equal(result.recordCount, 1);
    }
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
    const repaired = await consumer.handleAuthenticatedNotification(
      {
        notification_type: 'reporting.ledger_changed',
        account_id: ACCOUNT_ID,
        idempotency_key: 'ledger-notification-0001',
      },
      AUTHENTICATION
    );
    assert.equal(repaired.state, 'reconciled');
    assert.equal(repaired.changesCheckpoint, 'checkpoint-2');
    assert.equal(calls.at(-2).changes_after, 'checkpoint-1', 'the doorbell is repaired from durable state');
    assert.equal(calls.at(-1).changes_after, undefined, 'changed data triggers an authoritative full reconcile');

    deltaCount = 0;
    const beforeDuplicate = calls.length;
    const duplicate = await consumer.handleAuthenticatedNotification(
      {
        notification_type: 'reporting.delivery_ready',
        account_id: ACCOUNT_ID,
        idempotency_key: 'delivery-notification-0001',
      },
      AUTHENTICATION
    );
    assert.equal(duplicate.state, 'unchanged');
    assert.equal(calls.length, beforeDuplicate + 1, 'an empty delta avoids redundant destination work');

    const beforeStatus = calls.length;
    const status = await consumer.handleAuthenticatedNotification(
      {
        notification_type: 'reporting.status_changed',
        account_id: ACCOUNT_ID,
        idempotency_key: 'status-notification-0001',
      },
      AUTHENTICATION
    );
    assert.equal(status.state, 'reconciled');
    assert.equal(calls.length, beforeStatus + 1, 'clock-driven health always performs a non-incremental read');
    const repeated = await consumer.handleAuthenticatedNotification(
      {
        notification_type: 'reporting.status_changed',
        account_id: ACCOUNT_ID,
        idempotency_key: 'status-notification-0001',
      },
      AUTHENTICATION
    );
    assert.equal(repeated.state, 'duplicate');
    assert.equal(calls.length, beforeStatus + 1, 'a processed transport retry performs no ledger read');
    assert.equal(await consumer.handleAuthenticatedNotification({ notification_type: 'unrelated' }), null);
    await consumer.stop();
  });

  test('shares the account concurrency limit across manual runs and authenticated notifications', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    let inFlight = 0;
    let peak = 0;
    const accounts = Array.from({ length: 8 }, (_, index) => {
      const accountId = `buyer-account-concurrency-${index}`;
      return {
        consumerScope: AUTHENTICATION.consumerScope,
        accountId,
        reconciliation: {
          request: { account: { account_id: accountId } },
          expectedPeriods: [],
          inspect: async () => ({ rowCount: 0, controlTotals: [] }),
          client: {
            async getReportingStatus() {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              await new Promise(resolve => setTimeout(resolve, 10));
              inFlight -= 1;
              return { ...page({ checkpoint: `cursor-${index}` }), account_id: accountId };
            },
            async syncReportingReceipts() {
              return { status: 'completed', results: [] };
            },
          },
        },
      };
    });
    const consumer = createReliableReportingConsumerV1({
      accounts,
      persistence: memoryPersistence(),
      ownerToken: 'buyer-concurrency-worker',
      maxConcurrentAccounts: 1,
      runOnStart: false,
    });
    const results = await Promise.all(
      accounts.map((account, index) =>
        index % 2 === 0
          ? consumer.runAccount(account.accountId)
          : consumer.handleAuthenticatedNotification(
              {
                notification_type: 'reporting.status_changed',
                account_id: account.accountId,
                idempotency_key: `notification-concurrency-${index}`,
              },
              AUTHENTICATION
            )
      )
    );
    assert.equal(peak, 1);
    assert.ok(results.every(result => result.state === 'reconciled'));
    await consumer.stop();
  });

  test('classifies malformed reporting notifications as non-retryable input errors', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const consumer = createReliableReportingConsumerV1({
      accounts: [],
      persistence: memoryPersistence(),
      ownerToken: 'buyer-malformed-notification-worker',
      runOnStart: false,
    });
    await assert.rejects(
      () =>
        consumer.handleAuthenticatedNotification(
          { notification_type: 'reporting.status_changed', account_id: ACCOUNT_ID, idempotency_key: 'bad' },
          AUTHENTICATION
        ),
      error => error?.code === 'INVALID_NOTIFICATION'
    );
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

  test('requires authenticated scope even when an account ID is globally unique', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const consumer = createReliableReportingConsumerV1({
      accounts: [
        account({
          async getReportingStatus() {
            return page({ checkpoint: 'checkpoint-auth-required' });
          },
          async syncReportingReceipts() {
            return { status: 'completed', results: [] };
          },
        }),
      ],
      persistence: memoryPersistence(),
      ownerToken: 'buyer-worker-auth',
      runOnStart: false,
    });
    await assert.rejects(
      () =>
        consumer.handleAuthenticatedNotification({
          notification_type: 'reporting.ledger_changed',
          account_id: ACCOUNT_ID,
          idempotency_key: 'auth-required-notification-0001',
        }),
      /consumerScope is required/
    );
    await consumer.stop();
  });

  test('returns a completed reconciliation when the seller omits optional change checkpoints', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const persistence = memoryPersistence();
    const consumer = createReliableReportingConsumerV1({
      accounts: [
        account({
          async getReportingStatus() {
            const response = page({ checkpoint: 'unused' });
            delete response.changes_checkpoint;
            delete response.pagination.total_count;
            return response;
          },
          async syncReportingReceipts() {
            return { status: 'completed', results: [] };
          },
        }),
      ],
      persistence,
      ownerToken: 'buyer-worker-without-changes',
      runOnStart: false,
    });
    const result = await consumer.runAccount(ACCOUNT_ID);
    assert.equal(result.state, 'reconciled');
    assert.equal('changesCheckpoint' in result, false);
    assert.equal(persistence.cursors.size, 0);
    await consumer.stop();
  });

  test('rejects a natural-key response outside the leased account before reconciliation side effects', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const persistence = memoryPersistence();
    let receiptSubmissions = 0;
    const consumer = createReliableReportingConsumerV1({
      accounts: [
        {
          consumerScope: AUTHENTICATION.consumerScope,
          accountId: ACCOUNT_ID,
          reconciliation: {
            client: {
              async getReportingStatus() {
                return { ...page({ checkpoint: 'wrong-account-checkpoint' }), account_id: 'other-account' };
              },
              async syncReportingReceipts() {
                receiptSubmissions += 1;
                return { status: 'completed', results: [] };
              },
            },
            request: { account: { property_id: 'publisher.example' } },
            expectedPeriods: [],
            inspect: async () => ({ rowCount: 0, controlTotals: [] }),
          },
        },
      ],
      persistence,
      ownerToken: 'buyer-worker-natural-key',
      runOnStart: false,
    });
    await assert.rejects(
      () => consumer.runAccount(ACCOUNT_ID),
      error => error?.code === 'ACCOUNT_SCOPE_MISMATCH'
    );
    assert.equal(receiptSubmissions, 0);
    assert.equal(persistence.cursors.size, 0);
    await consumer.stop();
  });

  test('atomically refreshes the buyer account roster without restarting', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const consumer = createReliableReportingConsumerV1({
      accounts: [],
      persistence: memoryPersistence(),
      ownerToken: 'buyer-worker-dynamic-roster',
      runOnStart: false,
    });
    await assert.rejects(() => consumer.runAccount(ACCOUNT_ID), /unknown reporting consumer account/);
    consumer.replaceAccounts([
      account({
        async getReportingStatus() {
          return page({ checkpoint: 'checkpoint-dynamic' });
        },
        async syncReportingReceipts() {
          return { status: 'completed', results: [] };
        },
      }),
    ]);
    assert.equal((await consumer.runAccount(ACCOUNT_ID)).state, 'reconciled');
    consumer.replaceAccounts([]);
    await assert.rejects(() => consumer.runAccount(ACCOUNT_ID), /unknown reporting consumer account/);
    await consumer.stop();
  });

  test('runs a follow-up reconciliation for a notification received during older work', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const persistence = memoryPersistence();
    let releaseFirst;
    const firstBlocked = new Promise(resolve => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const consumer = createReliableReportingConsumerV1({
      accounts: [
        account({
          async getReportingStatus() {
            calls += 1;
            if (calls === 1) await firstBlocked;
            return page({
              checkpoint: calls === 1 ? 'checkpoint-before-notification' : 'checkpoint-after-notification',
            });
          },
          async syncReportingReceipts() {
            return { status: 'completed', results: [] };
          },
        }),
      ],
      persistence,
      ownerToken: 'buyer-worker-followup',
      runOnStart: false,
    });
    const older = consumer.runAccount(ACCOUNT_ID);
    await new Promise(resolve => setImmediate(resolve));
    const notified = consumer.handleAuthenticatedNotification(
      {
        notification_type: 'reporting.status_changed',
        account_id: ACCOUNT_ID,
        idempotency_key: 'overlap-notification-0001',
      },
      AUTHENTICATION
    );
    releaseFirst();
    assert.equal((await older).changesCheckpoint, 'checkpoint-before-notification');
    const result = await notified;
    assert.equal(result.state, 'reconciled');
    assert.equal(result.changesCheckpoint, 'checkpoint-after-notification');
    assert.equal(calls, 2);
    assert.equal(
      (
        await consumer.handleAuthenticatedNotification(
          {
            notification_type: 'reporting.status_changed',
            account_id: ACCOUNT_ID,
            idempotency_key: 'overlap-notification-0001',
          },
          AUTHENTICATION
        )
      ).state,
      'duplicate'
    );
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

  test('aborts an in-flight seller read during graceful shutdown', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    let readStarted;
    const started = new Promise(resolve => {
      readStarted = resolve;
    });
    const consumer = createReliableReportingConsumerV1({
      accounts: [
        account({
          async getReportingStatus(_request, { signal }) {
            readStarted();
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
        }),
      ],
      persistence: memoryPersistence(),
      ownerToken: 'buyer-worker-stop-abort',
      runOnStart: false,
    });
    const running = consumer.runAccount(ACCOUNT_ID);
    await started;
    await consumer.stop();
    assert.equal((await running).state, 'stopping');
  });

  test('fences checkpoint writes when lease renewal stalls past expiry', async () => {
    const { createReliableReportingConsumerV1 } = require('../../dist/lib/reporting/index.js');
    const persistence = memoryPersistence();
    persistence.workLeases.claim = async ({ key, ownerToken }) => ({
      scopeKey: `${key.consumerScope}|${key.accountId}`,
      ownerToken,
      generation: 1,
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    persistence.workLeases.renew = async () => new Promise(() => {});
    persistence.workLeases.release = async () => false;
    const consumer = createReliableReportingConsumerV1({
      accounts: [
        account({
          async getReportingStatus() {
            await new Promise(resolve => setTimeout(resolve, 1_100));
            return page({ checkpoint: 'checkpoint-after-expired-lease' });
          },
          async syncReportingReceipts() {
            return { status: 'completed', results: [] };
          },
        }),
      ],
      persistence,
      ownerToken: 'buyer-worker-stalled-renewal',
      leaseMilliseconds: 1_000,
      runOnStart: false,
    });
    const result = await consumer.runAccount(ACCOUNT_ID);
    assert.equal(result.state, 'lease_lost');
    assert.equal(persistence.cursors.size, 0, 'expired ownership cannot advance the durable cursor');
    await consumer.stop();
  });
});
