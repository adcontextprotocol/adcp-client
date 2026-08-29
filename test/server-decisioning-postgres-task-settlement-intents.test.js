/**
 * PostgreSQL task-settlement intent queue integration tests.
 *
 * Requires a running PostgreSQL. Database-independent contract tests always
 * run; integration tests skip when DATABASE_URL is unset.
 */

process.env.NODE_ENV = 'test';

const { test, describe, before, afterEach, after } = require('node:test');
const assert = require('node:assert');

const DATABASE_URL = process.env.DATABASE_URL;
const TABLE = 'adcp_task_settlement_intents_test';
const TASK_TABLE = 'adcp_decisioning_tasks_intent_test';
const DOMAIN_TABLE = 'adcp_task_settlement_domain_test';
const NAMESPACE = 'intent-test';

function ref(taskId = 'task_1', overrides = {}) {
  return {
    taskId,
    accountId: 'account-1',
    ownerScope: 'api_key:buyer-1',
    registryId: 'registry-1',
    ...overrides,
  };
}

describe('task settlement intent queue contract', () => {
  test('migration creates a namespaced, scoped, leased queue', () => {
    const { getTaskSettlementIntentMigration } = require('../dist/lib/server/decisioning');
    const sql = getTaskSettlementIntentMigration({ tableName: TABLE });
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${TABLE}`));
    assert.match(sql, /PRIMARY KEY \(queue_namespace, registry_id, account_id, owner_scope, task_id\)/);
    assert.match(sql, /state IN \('pending', 'dead_letter'\)/);
    assert.match(sql, /WHERE state = 'pending'/);
    assert.throws(() => getTaskSettlementIntentMigration({ tableName: 'bad;drop' }), /tableName/);
  });

  test('enqueue can participate in the caller transaction and strips server-only result fields', async () => {
    const { createPostgresTaskSettlementIntentQueue } = require('../dist/lib/server/decisioning');
    let values;
    const transaction = {
      async query(_sql, params) {
        values = params;
        return { rows: [{ task_id: 'task_tx' }], rowCount: 1 };
      },
    };
    const queue = createPostgresTaskSettlementIntentQueue({
      db: {
        async query() {
          throw new Error('base pool must not be used');
        },
      },
      namespace: NAMESPACE,
      tableName: TABLE,
    });

    const checkpoint = await queue.enqueue(
      {
        taskRef: ref('task_tx'),
        action: 'complete',
        result: {
          media_buy_id: 'mb-1',
          ctx_metadata: { token: 'secret' },
          products: [
            {
              product_id: 'product-1',
              implementation_config: { upstream: 'private' },
            },
          ],
        },
      },
      { db: transaction }
    );

    assert.strictEqual(checkpoint.taskId, 'task_tx');
    assert.match(checkpoint.intentFingerprint, /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(JSON.parse(values[6]), {
      result: { media_buy_id: 'mb-1', products: [{ product_id: 'product-1' }] },
    });
  });

  test('configuration rejects unsafe namespaces, incomplete refs, and invalid recovery limits', async () => {
    const { createPostgresTaskSettlementIntentQueue } = require('../dist/lib/server/decisioning');
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    assert.throws(() => createPostgresTaskSettlementIntentQueue({ db, namespace: 'unsafe namespace' }), /namespace/);
    const queue = createPostgresTaskSettlementIntentQueue({ db, namespace: NAMESPACE, tableName: TABLE });
    await assert.rejects(
      queue.enqueue({ taskRef: { ...ref(), registryId: undefined }, action: 'complete', result: {} }),
      /registryId/
    );
    await assert.rejects(queue.enqueue({ taskRef: ref(), action: 'complete', result: undefined }), /requires a result/);
    await assert.rejects(queue.recover({ settle: async () => 'settled', leaseMs: 0 }), /leaseMs/);
    await assert.rejects(queue.recover({ settle: async () => 'settled', batchSize: 1001 }), /batchSize/);
    await assert.rejects(queue.recover({ settle: async () => 'settled', workerId: 7 }), /workerId/);
  });

  test('probe verifies every column required by runtime writes and recovery', async () => {
    let sql;
    const queue = require('../dist/lib/server/decisioning').createPostgresTaskSettlementIntentQueue({
      db: {
        async query(statement) {
          sql = statement;
          return { rows: [], rowCount: 0 };
        },
      },
      namespace: NAMESPACE,
      tableName: TABLE,
    });
    await queue.probe();
    assert.match(sql, /created_at/);
    assert.match(sql, /updated_at/);
  });
});

describe('Postgres task settlement intent queue', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let pool;
  let createPostgresTaskRegistry;
  let createPostgresTaskSettlementIntentQueue;
  let queue;

  before(async () => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL });
    const lib = require('../dist/lib/server/decisioning');
    createPostgresTaskRegistry = lib.createPostgresTaskRegistry;
    createPostgresTaskSettlementIntentQueue = lib.createPostgresTaskSettlementIntentQueue;
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.query(`DROP TABLE IF EXISTS ${TASK_TABLE} CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${DOMAIN_TABLE}`);
    await pool.query(lib.getTaskSettlementIntentMigration({ tableName: TABLE }));
    await pool.query(lib.getDecisioningTaskRegistryBootstrap({ namespace: NAMESPACE, tableName: TASK_TABLE }));
    await pool.query(`CREATE TABLE ${DOMAIN_TABLE} (id TEXT PRIMARY KEY)`);
    queue = createPostgresTaskSettlementIntentQueue({ db: pool, namespace: NAMESPACE, tableName: TABLE });
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
    await pool.query(`DELETE FROM ${TASK_TABLE}`);
    await pool.query(`DELETE FROM ${DOMAIN_TABLE}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  test('domain state and intent can commit or roll back in one caller-owned transaction', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${DOMAIN_TABLE} (id) VALUES ($1)`, ['rolled-back']);
      await queue.enqueue({ taskRef: ref('task_rollback'), action: 'complete', result: { ok: true } }, { db: client });
      await client.query('ROLLBACK');

      assert.strictEqual((await pool.query(`SELECT 1 FROM ${TABLE}`)).rowCount, 0);
      assert.strictEqual((await pool.query(`SELECT 1 FROM ${DOMAIN_TABLE}`)).rowCount, 0);

      await client.query('BEGIN');
      await client.query(`INSERT INTO ${DOMAIN_TABLE} (id) VALUES ($1)`, ['committed']);
      await queue.enqueue({ taskRef: ref('task_commit'), action: 'complete', result: { ok: true } }, { db: client });
      await client.query('COMMIT');

      assert.strictEqual((await pool.query(`SELECT 1 FROM ${TABLE}`)).rowCount, 1);
      assert.strictEqual((await pool.query(`SELECT 1 FROM ${DOMAIN_TABLE}`)).rowCount, 1);
    } finally {
      client.release();
    }
  });

  test('exact retries reuse a checkpoint and changed terminal artifacts conflict', async () => {
    const intent = { taskRef: ref('task_exact'), action: 'complete', result: { revision: 1 } };
    const first = await queue.enqueue(intent);
    const second = await queue.enqueue(intent);
    assert.deepStrictEqual(second, first);
    await assert.rejects(
      queue.enqueue({ ...intent, result: { revision: 2 } }),
      error => error.name === 'TaskSettlementIntentConflictError'
    );
    assert.strictEqual((await pool.query(`SELECT 1 FROM ${TABLE}`)).rowCount, 1);
  });

  test('failed settlements retry exactly and persist only the error class', async () => {
    await queue.enqueue({
      taskRef: ref('task_retry'),
      action: 'fail',
      error: { code: 'INVALID_STATE', message: 'safe buyer message', recovery: 'correctable' },
      result: { media_buy_id: 'mb-retry' },
    });
    const observed = [];
    assert.deepStrictEqual(
      await queue.recover({
        retryAfterMs: 0,
        settle: async (intent, claim) => {
          observed.push(intent);
          assert.strictEqual(await claim.extendLease(), true);
          const unsafeError = new TypeError('postgres://user:password@private.internal must not persist');
          unsafeError.name = 'TypeError\ninjected';
          throw unsafeError;
        },
      }),
      { claimed: 1, settled: 0, retried: 1, deadLettered: 0, leaseLost: 0 }
    );
    assert.strictEqual(observed[0].action, 'fail');
    assert.deepStrictEqual(observed[0].result, { media_buy_id: 'mb-retry' });
    const stored = await pool.query(`SELECT last_error, attempt_count FROM ${TABLE}`);
    assert.deepStrictEqual(stored.rows, [{ last_error: 'TypeError_injected', attempt_count: 1 }]);

    assert.deepStrictEqual(await queue.recover({ retryAfterMs: 0, settle: async () => 'settled' }), {
      claimed: 1,
      settled: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
    assert.strictEqual((await pool.query(`SELECT 1 FROM ${TABLE}`)).rowCount, 0);
  });

  test('a crash after registry settlement heals through an idempotent retry', async () => {
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'intent-registry',
      tableName: TASK_TABLE,
    });
    const taskRef = await registry.create({
      tool: 'update_media_buy',
      accountId: 'account-1',
      ownerScope: 'api_key:buyer-1',
      overrideTaskId: 'task_crash',
    });
    await queue.enqueue({ taskRef, action: 'complete', result: { media_buy_id: 'mb-crash' } });
    let simulateCrash = true;
    const settle = async intent => {
      const outcome = await registry.complete(intent.taskRef.taskId, intent.taskRef, intent.result);
      if (outcome.outcome === 'already_terminal') {
        const stored = await registry.getTask(intent.taskRef.taskId, intent.taskRef);
        assert.strictEqual(stored.status, 'completed');
        assert.deepStrictEqual(stored.result, intent.result);
      } else {
        assert.strictEqual(outcome.outcome, 'applied');
      }
      if (simulateCrash) {
        simulateCrash = false;
        throw new Error('simulated death after registry commit');
      }
      return 'settled';
    };

    assert.deepStrictEqual(await queue.recover({ retryAfterMs: 0, settle }), {
      claimed: 1,
      settled: 0,
      retried: 1,
      deadLettered: 0,
      leaseLost: 0,
    });
    assert.strictEqual((await registry.getTask(taskRef.taskId, taskRef)).status, 'completed');
    assert.deepStrictEqual(await queue.recover({ retryAfterMs: 0, settle }), {
      claimed: 1,
      settled: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
  });

  test('failed intents preserve an explicit null result through fingerprint verification', async () => {
    await queue.enqueue({
      taskRef: ref('task_null_result'),
      action: 'fail',
      error: { code: 'INVALID_STATE', message: 'safe message', recovery: 'correctable' },
      result: null,
    });
    let observed;
    assert.deepStrictEqual(
      await queue.recover({
        settle: async intent => {
          observed = intent;
          return 'settled';
        },
      }),
      { claimed: 1, settled: 1, retried: 0, deadLettered: 0, leaseLost: 0 }
    );
    assert.strictEqual(Object.hasOwn(observed, 'result'), true);
    assert.strictEqual(observed.result, null);
  });

  test('task refs are normalized before fingerprinting and persistence', async () => {
    await queue.enqueue({
      taskRef: { ...ref('task_extra_ref'), untrusted_extra: 'must-not-affect-fingerprint' },
      action: 'complete',
      result: { ok: true },
    });
    let observed;
    assert.deepStrictEqual(
      await queue.recover({
        settle: async intent => {
          observed = intent;
          return 'settled';
        },
      }),
      { claimed: 1, settled: 1, retried: 0, deadLettered: 0, leaseLost: 0 }
    );
    assert.deepStrictEqual(observed.taskRef, ref('task_extra_ref'));
  });

  test('concurrent workers claim a due intent once', async () => {
    await queue.enqueue({ taskRef: ref('task_concurrent'), action: 'complete', result: { ok: true } });
    let calls = 0;
    const settle = async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return 'settled';
    };
    const [first, second] = await Promise.all([
      queue.recover({ workerId: 'worker-a', settle }),
      queue.recover({ workerId: 'worker-b', settle }),
    ]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(first.settled + second.settled, 1);
    assert.strictEqual(first.claimed + second.claimed, 1);
  });

  test('a worker that loses its lease cannot report another worker acknowledgement as its own', async () => {
    await queue.enqueue({ taskRef: ref('task_lease_lost'), action: 'complete', result: { ok: true } });
    let releaseFirst;
    let firstStarted;
    const started = new Promise(resolve => {
      firstStarted = resolve;
    });
    const firstErrors = [];
    const firstRecovery = queue.recover({
      workerId: 'worker-with-short-lease',
      leaseMs: 5,
      settle: async () => {
        firstStarted();
        await new Promise(resolve => {
          releaseFirst = resolve;
        });
        return 'settled';
      },
      onError: (_error, context) => firstErrors.push(context),
    });

    await started;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepStrictEqual(await queue.recover({ workerId: 'replacement-worker', settle: async () => 'settled' }), {
      claimed: 1,
      settled: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
    releaseFirst();
    assert.deepStrictEqual(await firstRecovery, {
      claimed: 1,
      settled: 0,
      retried: 0,
      deadLettered: 0,
      leaseLost: 1,
    });
    assert.strictEqual(firstErrors[0].disposition, 'lease_lost');
  });

  test('an expired worker cannot reschedule an intent after its lease boundary', async () => {
    await queue.enqueue({ taskRef: ref('task_expired_retry'), action: 'complete', result: { ok: true } });
    assert.deepStrictEqual(
      await queue.recover({
        leaseMs: 5,
        retryAfterMs: 0,
        settle: async () => {
          await new Promise(resolve => setTimeout(resolve, 20));
          throw new Error('late failure');
        },
      }),
      { claimed: 1, settled: 0, retried: 0, deadLettered: 0, leaseLost: 1 }
    );
    assert.deepStrictEqual(await queue.recover({ settle: async () => 'settled' }), {
      claimed: 1,
      settled: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
  });

  test('poison intents dead-letter at the configured attempt limit', async () => {
    await queue.enqueue({ taskRef: ref('task_poison'), action: 'complete', result: { ok: false } });
    const errors = [];
    assert.deepStrictEqual(
      await queue.recover({
        maxAttempts: 1,
        settle: async () => {
          throw new RangeError('poison');
        },
        onError: (_error, context) => errors.push(context),
      }),
      { claimed: 1, settled: 0, retried: 0, deadLettered: 1, leaseLost: 0 }
    );
    assert.strictEqual(errors[0].disposition, 'dead_letter');
    assert.deepStrictEqual((await pool.query(`SELECT state, last_error FROM ${TABLE}`)).rows, [
      { state: 'dead_letter', last_error: 'RangeError' },
    ]);
  });

  test('fingerprint verification prevents a modified stored payload from reaching settlement', async () => {
    await queue.enqueue({ taskRef: ref('task_tampered'), action: 'complete', result: { revision: 1 } });
    await pool.query(
      `UPDATE ${TABLE}
          SET payload = '{"result":{"revision":2}}'::jsonb
        WHERE task_id = 'task_tampered'`
    );
    let called = false;
    assert.deepStrictEqual(
      await queue.recover({
        maxAttempts: 1,
        settle: async () => {
          called = true;
          return 'settled';
        },
      }),
      { claimed: 1, settled: 0, retried: 0, deadLettered: 1, leaseLost: 0 }
    );
    assert.strictEqual(called, false);
    assert.deepStrictEqual((await pool.query(`SELECT state, last_error FROM ${TABLE}`)).rows, [
      { state: 'dead_letter', last_error: 'TypeError' },
    ]);
  });

  test('manual acknowledgement is exact and idempotent', async () => {
    const checkpoint = await queue.enqueue({
      taskRef: ref('task_ack'),
      action: 'complete',
      result: { ok: true },
    });
    assert.strictEqual(await queue.acknowledge(checkpoint), true);
    assert.strictEqual(await queue.acknowledge(checkpoint), false);
  });
});
