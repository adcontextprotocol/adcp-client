/**
 * PostgreSQL task-settlement intent queue integration tests.
 *
 * Requires a running PostgreSQL. Database-independent contract tests always
 * run; integration tests skip when DATABASE_URL is unset.
 */

process.env.NODE_ENV = 'test';

const { test, describe, before, afterEach, after } = require('node:test');
const assert = require('node:assert');
const { randomBytes } = require('node:crypto');

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

function singleClaimDb(intent) {
  const { canonicalJsonSha256 } = require('../dist/lib/utils/jcs');
  const scopeFingerprint = canonicalJsonSha256({
    registryId: intent.taskRef.registryId,
    accountId: intent.taskRef.accountId,
    ownerScope: intent.taskRef.ownerScope,
    taskId: intent.taskRef.taskId,
  });
  let claimed = false;
  return {
    async query(sql) {
      if (sql.includes('WITH due AS')) {
        if (claimed) return { rows: [], rowCount: 0 };
        claimed = true;
        return {
          rows: [
            {
              registry_id: intent.taskRef.registryId,
              account_id: intent.taskRef.accountId,
              owner_scope: intent.taskRef.ownerScope,
              task_id: intent.taskRef.taskId,
              scope_fingerprint: scopeFingerprint,
              action: intent.action,
              intent_fingerprint: canonicalJsonSha256(intent),
              attempt_count: 1,
              lease_claim_id: 'claim-1',
              lease_version: '1',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT payload FROM')) {
        return {
          rows: [
            {
              payload:
                intent.action === 'complete'
                  ? { result: intent.result }
                  : {
                      error: intent.error,
                      ...(Object.hasOwn(intent, 'result') && { result: intent.result }),
                    },
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('DELETE FROM') || sql.includes('SET state =')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in singleClaimDb: ${sql}`);
    },
  };
}

describe('task settlement intent queue contract', () => {
  test('migration creates a namespaced, scoped, leased queue', () => {
    const { getTaskSettlementIntentMigration } = require('../dist/lib/server/decisioning');
    const sql = getTaskSettlementIntentMigration({ tableName: TABLE });
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${TABLE}`));
    assert.match(sql, /PRIMARY KEY \(queue_namespace, scope_fingerprint\)/);
    assert.match(sql, /scope_fingerprint ~ '\^\[a-f0-9\]\{64\}\$'/);
    assert.match(sql, /state IN \('pending', 'dead_letter', 'acknowledged'\)/);
    assert.match(sql, /retain_until/);
    assert.match(sql, /WHERE state = 'acknowledged'/);
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
    assert.throws(
      () => createPostgresTaskSettlementIntentQueue({ db, namespace: NAMESPACE, idempotencyHorizonMs: 0 }),
      /idempotencyHorizonMs/
    );
    const queue = createPostgresTaskSettlementIntentQueue({ db, namespace: NAMESPACE, tableName: TABLE });
    await assert.rejects(
      queue.enqueue({ taskRef: { ...ref(), registryId: undefined }, action: 'complete', result: {} }),
      /registryId/
    );
    await assert.rejects(
      queue.enqueue({ taskRef: ref(`task_${String.fromCharCode(0xd800)}`), action: 'complete', result: {} }),
      /well-formed Unicode/
    );
    await assert.rejects(queue.enqueue({ taskRef: ref(), action: 'complete', result: undefined }), /requires a result/);
    await assert.rejects(queue.recover({ settle: async () => 'settled', leaseMs: 0 }), /leaseMs/);
    await assert.rejects(queue.recover({ settle: async () => 'settled', batchSize: 1001 }), /batchSize/);
    await assert.rejects(queue.recover({ settle: async () => 'settled', workerId: 7 }), /workerId/);
    await assert.rejects(queue.pruneAcknowledged({ limit: 0 }), /pruneAcknowledged limit/);
  });

  test('configuration is snapshotted so caller mutation cannot redirect the queue', async () => {
    const { createPostgresTaskSettlementIntentQueue } = require('../dist/lib/server/decisioning');
    const calls = [];
    const originalDb = {
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.includes('INSERT INTO')) return { rows: [{ task_id: 'task_snapshot' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const options = { db: originalDb, namespace: NAMESPACE, tableName: TABLE, idempotencyHorizonMs: 12_345 };
    const queue = createPostgresTaskSettlementIntentQueue(options);
    options.db = { query: async () => assert.fail('mutated db must not be used') };
    options.namespace = 'redirected';
    options.tableName = 'redirected_table';
    options.idempotencyHorizonMs = 1;

    const checkpoint = await queue.enqueue({ taskRef: ref('task_snapshot'), action: 'complete', result: { ok: true } });
    await queue.acknowledge(checkpoint);
    await queue.probe();
    await queue.recover({ settle: async () => 'settled' });

    assert.strictEqual(calls.length, 5);
    for (const { sql, values } of calls) {
      assert.match(sql, new RegExp(TABLE));
      assert.doesNotMatch(sql, /redirected_table/);
      assert.strictEqual(values[0], NAMESPACE);
    }
    assert.strictEqual(calls.find(({ sql }) => sql.includes("SET state = 'acknowledged'")).values[7], 12_345);
  });

  test('fail intents validate their structured error before persistence', async () => {
    const {
      canonicalizeTaskSettlementIntent,
      createPostgresTaskSettlementIntentQueue,
    } = require('../dist/lib/server/decisioning');
    let values;
    let queryCount = 0;
    const queue = createPostgresTaskSettlementIntentQueue({
      db: {
        async query(_sql, params) {
          queryCount += 1;
          values = params;
          return { rows: [{ task_id: 'task_error' }], rowCount: 1 };
        },
      },
      namespace: NAMESPACE,
      tableName: TABLE,
    });
    for (const error of [
      { code: '', message: 'message', recovery: 'terminal' },
      { code: 'INVALID_STATE', message: '', recovery: 'terminal' },
      { code: 'INVALID_STATE', message: 'message', recovery: 'sometimes' },
    ]) {
      await assert.rejects(queue.enqueue({ taskRef: ref('task_error'), action: 'fail', error }), /error\./);
    }

    const inheritedError = Object.create({
      code: 'INVALID_STATE',
      message: 'inherited values must not persist',
      recovery: 'terminal',
    });
    await assert.rejects(
      queue.enqueue({ taskRef: ref('task_error'), action: 'fail', error: inheritedError }),
      /error\.code/
    );
    const loneSurrogate = String.fromCharCode(0xd800);
    await assert.rejects(
      queue.enqueue({ taskRef: ref('task_error'), action: 'complete', result: { value: loneSurrogate } }),
      /well-formed Unicode/
    );
    await assert.rejects(
      queue.enqueue({ taskRef: ref('task_error'), action: 'complete', result: { [loneSurrogate]: 'value' } }),
      /well-formed Unicode/
    );
    await assert.rejects(
      queue.enqueue({
        taskRef: ref('task_error'),
        action: 'fail',
        error: {
          code: 'INVALID_STATE',
          message: 'message',
          recovery: 'terminal',
          [loneSurrogate]: 'legacy extension',
        },
      }),
      /well-formed Unicode/
    );
    assert.strictEqual(queryCount, 0);

    const rawIntent = {
      taskRef: ref('task_error'),
      action: 'fail',
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'conflict',
        recovery: 'correctable',
        field: 'legacy-private-field',
      },
    };
    const canonicalIntent = canonicalizeTaskSettlementIntent(rawIntent);
    await queue.enqueue(rawIntent);
    const storedError = JSON.parse(values[6]).error;
    assert.strictEqual(storedError.code, 'IDEMPOTENCY_CONFLICT');
    assert.strictEqual(storedError.message, 'conflict');
    assert.strictEqual(Object.hasOwn(storedError, 'field'), false);
    assert.deepStrictEqual(canonicalIntent.error, storedError);
  });

  test('recovery fingerprints the exact stored error before normalizing it for current settlement', async () => {
    const { createPostgresTaskSettlementIntentQueue } = require('../dist/lib/server/decisioning');
    const intent = {
      taskRef: ref('task_pre_upgrade'),
      action: 'fail',
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'legacy conflict',
        recovery: 'terminal',
        field: 'field-allowed-by-an-older-sdk',
      },
    };
    const queue = createPostgresTaskSettlementIntentQueue({
      db: singleClaimDb(intent),
      namespace: NAMESPACE,
      tableName: TABLE,
    });
    let observed;
    assert.deepStrictEqual(
      await queue.recover({
        settle: async recovered => {
          observed = recovered;
          return 'settled';
        },
      }),
      { claimed: 1, settled: 1, retried: 0, deadLettered: 0, leaseLost: 0 }
    );
    assert.deepStrictEqual(observed.error, {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'legacy conflict',
      recovery: 'correctable',
    });
  });

  test('recovery rejects malformed stored structured errors after fingerprint verification', async () => {
    const { createPostgresTaskSettlementIntentQueue } = require('../dist/lib/server/decisioning');
    const intent = {
      taskRef: ref('task_bad_stored_error'),
      action: 'fail',
      error: { code: 'INVALID_STATE', message: '', recovery: 'correctable' },
    };
    const queue = createPostgresTaskSettlementIntentQueue({
      db: singleClaimDb(intent),
      namespace: NAMESPACE,
      tableName: TABLE,
    });
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
  });

  test('recovery rejects stored payloads whose Unicode would collide after UTF-8 encoding', async () => {
    const { createPostgresTaskSettlementIntentQueue } = require('../dist/lib/server/decisioning');
    const intent = {
      taskRef: ref('task_bad_stored_unicode'),
      action: 'complete',
      result: { value: String.fromCharCode(0xd800) },
    };
    const queue = createPostgresTaskSettlementIntentQueue({
      db: singleClaimDb(intent),
      namespace: NAMESPACE,
      tableName: TABLE,
    });
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
  });

  test('accepts long opaque task-reference components supported by durable registries', async () => {
    const { createPostgresTaskSettlementIntentQueue } = require('../dist/lib/server/decisioning');
    const longPart = 'x'.repeat(2048);
    const longRef = ref(longPart, {
      accountId: `account:${longPart}`,
      ownerScope: `owner:${longPart}`,
      registryId: `custom:${longPart}`,
    });
    let values;
    const queue = createPostgresTaskSettlementIntentQueue({
      db: {
        async query(_sql, params) {
          values = params;
          return { rows: [{ task_id: 'task_long_registry' }], rowCount: 1 };
        },
      },
      namespace: NAMESPACE,
      tableName: TABLE,
    });
    const checkpoint = await queue.enqueue({
      taskRef: longRef,
      action: 'complete',
      result: { ok: true },
    });
    assert.deepStrictEqual(values.slice(1, 5), [
      longRef.registryId,
      longRef.accountId,
      longRef.ownerScope,
      longRef.taskId,
    ]);
    assert.deepStrictEqual(
      {
        taskId: checkpoint.taskId,
        accountId: checkpoint.accountId,
        ownerScope: checkpoint.ownerScope,
        registryId: checkpoint.registryId,
      },
      longRef
    );
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
    assert.match(sql, /retain_until/);
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
    assert.deepStrictEqual(stored.rows, [{ last_error: 'TypeError', attempt_count: 1 }]);

    assert.deepStrictEqual(await queue.recover({ retryAfterMs: 0, settle: async () => 'settled' }), {
      claimed: 1,
      settled: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
    assert.deepStrictEqual((await pool.query(`SELECT state FROM ${TABLE}`)).rows, [{ state: 'acknowledged' }]);
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

  test('a legacy failed intent normalizes after fingerprint verification and heals after a crash', async () => {
    const { canonicalJsonSha256 } = require('../dist/lib/utils/jcs');
    const { canonicalizeTaskSettlementIntent } = require('../dist/lib/server/decisioning');
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
      overrideTaskId: 'task_legacy_fail_crash',
    });
    const legacyError = {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'legacy conflict',
      recovery: 'terminal',
      field: 'removed-by-current-sanitizer',
    };
    const storedIntent = { taskRef, action: 'fail', error: legacyError };
    const scopeFingerprint = canonicalJsonSha256({
      registryId: taskRef.registryId,
      accountId: taskRef.accountId,
      ownerScope: taskRef.ownerScope,
      taskId: taskRef.taskId,
    });
    await pool.query(
      `INSERT INTO ${TABLE} (
         queue_namespace, registry_id, account_id, owner_scope, task_id,
         action, payload, intent_fingerprint, scope_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, 'fail', $6::jsonb, $7, $8)`,
      [
        NAMESPACE,
        taskRef.registryId,
        taskRef.accountId,
        taskRef.ownerScope,
        taskRef.taskId,
        JSON.stringify({ error: legacyError }),
        canonicalJsonSha256(storedIntent),
        scopeFingerprint,
      ]
    );
    await pool.query(
      `UPDATE ${TASK_TABLE}
          SET status = 'failed', error = $1::jsonb, result = NULL, status_message = $2
        WHERE task_id = $3 AND registry_namespace = $4 AND account_id = $5 AND owner_scope = $6`,
      [
        JSON.stringify(legacyError),
        legacyError.message,
        taskRef.taskId,
        NAMESPACE,
        taskRef.accountId,
        taskRef.ownerScope,
      ]
    );

    let simulateCrash = true;
    const settle = async intent => {
      assert.deepStrictEqual(intent.error, {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'legacy conflict',
        recovery: 'correctable',
      });
      const outcome = await registry.fail(intent.taskRef.taskId, intent.taskRef, intent.error);
      assert.strictEqual(outcome.outcome, 'already_terminal');
      const stored = await registry.getTask(intent.taskRef.taskId, intent.taskRef);
      assert.strictEqual(stored.status, 'failed');
      const storedIntent = canonicalizeTaskSettlementIntent({
        taskRef: intent.taskRef,
        action: 'fail',
        error: stored.error,
        ...(Object.hasOwn(stored, 'result') && { result: stored.result }),
      });
      assert.deepStrictEqual(storedIntent, intent);
      if (simulateCrash) {
        simulateCrash = false;
        throw new Error('simulated death after legacy failure commit');
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
    assert.deepStrictEqual(await queue.recover({ retryAfterMs: 0, settle }), {
      claimed: 1,
      settled: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
  });

  test('failed intents preserve an explicit null result through crash recovery and registry readback', async () => {
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
      overrideTaskId: 'task_null_result',
    });
    await queue.enqueue({
      taskRef,
      action: 'fail',
      error: { code: 'INVALID_STATE', message: 'safe message', recovery: 'correctable' },
      result: null,
    });
    let simulateCrash = true;
    const settle = async intent => {
      assert.strictEqual(Object.hasOwn(intent, 'result'), true);
      assert.strictEqual(intent.result, null);
      const outcome = await registry.fail(intent.taskRef.taskId, intent.taskRef, intent.error, intent.result);
      if (outcome.outcome === 'already_terminal') {
        const stored = await registry.getTask(intent.taskRef.taskId, intent.taskRef);
        assert.strictEqual(stored.status, 'failed');
        assert.strictEqual(Object.hasOwn(stored, 'result'), true);
        assert.strictEqual(stored.result, null);
      } else {
        assert.strictEqual(outcome.outcome, 'applied');
      }
      if (simulateCrash) {
        simulateCrash = false;
        throw new Error('simulated death after explicit null failure commit');
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
    assert.deepStrictEqual(await queue.recover({ retryAfterMs: 0, settle }), {
      claimed: 1,
      settled: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
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

  test('long incompressible opaque refs fit because only the scope fingerprint is indexed', async () => {
    const opaque = prefix => `${prefix}:${randomBytes(1024).toString('hex')}`;
    const longRef = {
      taskId: opaque('task'),
      accountId: opaque('account'),
      ownerScope: opaque('owner'),
      registryId: opaque('registry'),
    };
    const checkpoint = await queue.enqueue({
      taskRef: longRef,
      action: 'complete',
      result: { ok: true },
    });
    const stored = await pool.query(
      `SELECT scope_fingerprint, registry_id, account_id, owner_scope, task_id FROM ${TABLE}`
    );
    assert.match(stored.rows[0].scope_fingerprint, /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(
      {
        registryId: stored.rows[0].registry_id,
        accountId: stored.rows[0].account_id,
        ownerScope: stored.rows[0].owner_scope,
        taskId: stored.rows[0].task_id,
      },
      longRef
    );
    assert.strictEqual(await queue.acknowledge(checkpoint), true);
  });

  test('settlement callback mutation cannot corrupt the internal fencing reference', async () => {
    await queue.enqueue({ taskRef: ref('task_mutated_callback'), action: 'complete', result: { ok: true } });
    assert.deepStrictEqual(
      await queue.recover({
        settle: async intent => {
          intent.taskRef.taskId = 'attacker-mutated-task-id';
          return 'settled';
        },
      }),
      { claimed: 1, settled: 1, retried: 0, deadLettered: 0, leaseLost: 0 }
    );
    assert.deepStrictEqual((await pool.query(`SELECT state FROM ${TABLE}`)).rows, [{ state: 'acknowledged' }]);
  });

  test('one recovery call cannot reclaim a zero-delay retry it already saw', async () => {
    await queue.enqueue({ taskRef: ref('task_zero_delay'), action: 'complete', result: { ok: true } });
    let calls = 0;
    assert.deepStrictEqual(
      await queue.recover({
        batchSize: 3,
        retryAfterMs: 0,
        settle: async () => {
          calls += 1;
          throw new Error('retry later');
        },
      }),
      { claimed: 1, settled: 0, retried: 1, deadLettered: 0, leaseLost: 0 }
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual((await pool.query(`SELECT attempt_count FROM ${TABLE}`)).rows[0].attempt_count, 1);
  });

  test('a slow first item does not consume the short lease of the next batch item', async () => {
    await queue.enqueue({ taskRef: ref('task_slow_first'), action: 'complete', result: { ok: true } });
    await new Promise(resolve => setTimeout(resolve, 5));
    await queue.enqueue({ taskRef: ref('task_fast_second'), action: 'complete', result: { ok: true } });
    const observed = [];
    assert.deepStrictEqual(
      await queue.recover({
        batchSize: 2,
        leaseMs: 250,
        settle: async intent => {
          observed.push(intent.taskRef.taskId);
          if (intent.taskRef.taskId === 'task_slow_first') {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          return 'settled';
        },
      }),
      { claimed: 2, settled: 1, retried: 0, deadLettered: 0, leaseLost: 1 }
    );
    assert.deepStrictEqual(observed, ['task_slow_first', 'task_fast_second']);
    assert.deepStrictEqual(await queue.recover({ settle: async () => 'settled' }), {
      claimed: 1,
      settled: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
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

  test('a concurrent worker can settle the second row while the first callback is blocked', async () => {
    await queue.enqueue({ taskRef: ref('task_blocked_first'), action: 'complete', result: { ok: true } });
    await new Promise(resolve => setTimeout(resolve, 5));
    await queue.enqueue({ taskRef: ref('task_healthy_second'), action: 'complete', result: { ok: true } });

    let signalFirstStarted;
    let releaseFirst;
    const firstStarted = new Promise(resolve => {
      signalFirstStarted = resolve;
    });
    const firstCanFinish = new Promise(resolve => {
      releaseFirst = resolve;
    });
    const firstRecovery = queue.recover({
      workerId: 'blocked-first-worker',
      batchSize: 2,
      settle: async intent => {
        assert.strictEqual(intent.taskRef.taskId, 'task_blocked_first');
        signalFirstStarted();
        await firstCanFinish;
        return 'settled';
      },
    });

    await firstStarted;
    const secondObserved = [];
    assert.deepStrictEqual(
      await queue.recover({
        workerId: 'healthy-second-worker',
        batchSize: 2,
        settle: async intent => {
          secondObserved.push(intent.taskRef.taskId);
          return 'settled';
        },
      }),
      { claimed: 1, settled: 1, retried: 0, deadLettered: 0, leaseLost: 0 }
    );
    assert.deepStrictEqual(secondObserved, ['task_healthy_second']);

    releaseFirst();
    assert.deepStrictEqual(await firstRecovery, {
      claimed: 1,
      settled: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
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

  test('an expired max-attempt worker is dead-lettered before settlement can run again', async () => {
    await queue.enqueue({ taskRef: ref('task_expired_retry'), action: 'complete', result: { ok: true } });
    assert.deepStrictEqual(
      await queue.recover({
        leaseMs: 5,
        retryAfterMs: 0,
        maxAttempts: 1,
        settle: async () => {
          await new Promise(resolve => setTimeout(resolve, 20));
          throw new Error('late failure');
        },
      }),
      { claimed: 1, settled: 0, retried: 0, deadLettered: 0, leaseLost: 1 }
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
      {
        claimed: 1,
        settled: 0,
        retried: 0,
        deadLettered: 1,
        leaseLost: 0,
      }
    );
    assert.strictEqual(called, false);
    assert.deepStrictEqual((await pool.query(`SELECT state, attempt_count, last_error FROM ${TABLE}`)).rows, [
      { state: 'dead_letter', attempt_count: 1, last_error: 'Error' },
    ]);
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

  test('acknowledgement retains the immutable fingerprint through the idempotency horizon', async () => {
    const taskRef = ref('task_ack_tombstone');
    const firstIntent = { taskRef, action: 'complete', result: { revision: 1 } };
    const checkpoint = await queue.enqueue(firstIntent);
    assert.strictEqual(await queue.acknowledge(checkpoint), true);

    assert.deepStrictEqual(await queue.enqueue(firstIntent), checkpoint);
    await assert.rejects(
      queue.enqueue({ ...firstIntent, result: { revision: 2 } }),
      error => error.name === 'TaskSettlementIntentConflictError'
    );
    const retained = await pool.query(
      `SELECT state, payload, retain_until > clock_timestamp() AS retained FROM ${TABLE}`
    );
    assert.deepStrictEqual(retained.rows, [{ state: 'acknowledged', payload: {}, retained: true }]);

    await pool.query(`UPDATE ${TABLE} SET retain_until = clock_timestamp() - INTERVAL '1 second'`);
    const replacement = await queue.enqueue({ ...firstIntent, result: { revision: 2 } });
    assert.notStrictEqual(replacement.intentFingerprint, checkpoint.intentFingerprint);
    assert.deepStrictEqual((await pool.query(`SELECT state, attempt_count FROM ${TABLE}`)).rows, [
      { state: 'pending', attempt_count: 0 },
    ]);
  });

  test('expired acknowledgement tombstones can be pruned in bounded batches', async () => {
    const checkpoint = await queue.enqueue({
      taskRef: ref('task_expired_tombstone'),
      action: 'complete',
      result: { ok: true },
    });
    assert.strictEqual(await queue.acknowledge(checkpoint), true);
    await pool.query(`UPDATE ${TABLE} SET retain_until = clock_timestamp() - INTERVAL '1 second'`);

    assert.strictEqual(await queue.pruneAcknowledged({ limit: 1 }), 1);
    assert.strictEqual(await queue.pruneAcknowledged({ limit: 1 }), 0);
    assert.strictEqual((await pool.query(`SELECT 1 FROM ${TABLE}`)).rowCount, 0);
  });
});
