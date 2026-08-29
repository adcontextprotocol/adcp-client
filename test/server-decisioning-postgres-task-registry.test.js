/**
 * Postgres-backed TaskRegistry integration tests.
 *
 * Requires a running PostgreSQL. Skipped when DATABASE_URL is unset:
 *   DATABASE_URL=postgres://localhost/test node --test test/server-decisioning-postgres-task-registry.test.js
 */

process.env.NODE_ENV = 'test';

const { test, describe, before, afterEach, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const DATABASE_URL = process.env.DATABASE_URL;
const TABLE = 'adcp_decisioning_tasks';
const SETTLEMENT_OUTBOX = 'adcp_task_webhook_outbox_test';
const SETTLEMENT_DELIVERIES = 'adcp_task_webhook_deliveries_test';
const NAMESPACE = 'test';
const ACC_1_SCOPE = { accountId: 'acc_1', ownerScope: 'account:acc_1' };
const ACCT_1_SCOPE = { accountId: 'acct_1', ownerScope: 'account:acct_1' };

describe('decisioning task registry schema management', () => {
  test('Postgres registry requires an explicit trusted namespace', () => {
    const { createPostgresTaskRegistry } = require('../dist/lib/server/decisioning');
    const pool = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
    };
    assert.throws(() => createPostgresTaskRegistry({ pool }), /Invalid registry namespace/);
  });

  test('registry identity uses an unambiguous storage/table/namespace tuple', () => {
    const { createPostgresTaskRegistry } = require('../dist/lib/server/decisioning');
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const first = createPostgresTaskRegistry({
      pool,
      tableName: 'tasks',
      namespace: 'x:tasks:y',
      storageId: 'prod',
    });
    const second = createPostgresTaskRegistry({
      pool,
      tableName: 'tasks',
      namespace: 'y',
      storageId: 'prod:tasks:x',
    });
    assert.notStrictEqual(first.registryId, second.registryId);
  });

  test('Postgres awaitTask ignores a scoped ref issued by another registry', async () => {
    const { createPostgresTaskRegistry } = require('../dist/lib/server/decisioning');
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const first = createPostgresTaskRegistry({ pool, namespace: 'first', storageId: 'shared-store' });
    const second = createPostgresTaskRegistry({ pool, namespace: 'second', storageId: 'shared-store' });
    const taskId = 'task_same_tuple';
    const scope = { accountId: 'acct-shared', ownerScope: 'api_key:shared' };
    const firstRef = { taskId, ...scope, registryId: first.registryId };
    let release;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    second._registerBackground(taskId, scope, pending);

    try {
      const outcome = await Promise.race([
        second.awaitTask(taskId, firstRef).then(() => 'resolved'),
        new Promise(resolve => setImmediate(() => resolve('blocked'))),
      ]);
      assert.strictEqual(outcome, 'resolved');
    } finally {
      release();
    }
  });

  test('runtime registry operations wrap database errors without exposing infrastructure details', async () => {
    const { createPostgresTaskRegistry } = require('../dist/lib/server/decisioning');
    const databaseError = new Error('password authentication failed for private-db.internal');
    const registry = createPostgresTaskRegistry({
      namespace: NAMESPACE,
      pool: {
        async query() {
          throw databaseError;
        },
      },
    });

    await assert.rejects(
      registry.create({ tool: 'create_media_buy', accountId: 'acct-1' }),
      error =>
        error.message === 'PostgresTaskRegistry.create: database operation failed' && error.cause === databaseError
    );
  });

  test('push settlement wraps pool acquisition errors without exposing infrastructure details', async () => {
    const {
      createPostgresTaskRegistry,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const databaseError = new Error('private database host unavailable');
    const pool = {
      async query(sql) {
        if (sql.includes('SELECT tool, status, result, error, has_webhook')) {
          return {
            rows: [{ tool: 'create_media_buy', status: 'submitted', result: null, error: null, has_webhook: true }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        throw databaseError;
      },
    };
    const registry = createPostgresTaskRegistry({ namespace: NAMESPACE, storageId: 'pool-error', pool });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
    });
    await assert.rejects(
      coordinator.settle(
        {
          taskId: 'task_pool_error',
          accountId: 'acc_1',
          ownerScope: 'account:acc_1',
          registryId: registry.registryId,
        },
        { status: 'completed', result: { ok: true } },
        { url: 'https://buyer.example/webhooks/task', operationId: 'pool-error-operation' }
      ),
      error =>
        error.message === 'PostgresTaskSettlementCoordinator.settle: transaction failed' &&
        error.cause === databaseError
    );
  });

  test('push settlement finishes secret protection before acquiring a transaction client', async () => {
    const {
      createPostgresTaskRegistry,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const databaseError = new Error('stop after the protection-order assertion');
    let connectCalls = 0;
    let releaseProtection;
    const protectionReleased = new Promise(resolve => {
      releaseProtection = resolve;
    });
    let markProtectionStarted;
    const protectionStarted = new Promise(resolve => {
      markProtectionStarted = resolve;
    });
    const pool = {
      async query(sql) {
        if (sql.includes('SELECT tool, status, result, error, has_webhook')) {
          return {
            rows: [{ tool: 'create_media_buy', status: 'submitted', result: null, error: null, has_webhook: true }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        connectCalls++;
        throw databaseError;
      },
    };
    const registry = createPostgresTaskRegistry({ namespace: NAMESPACE, storageId: 'protect-before-connect', pool });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: {
        async protect(authentication) {
          markProtectionStarted();
          await protectionReleased;
          return {
            protectedValue: { ciphertext: 'opaque-test-value' },
            fingerprint: require('node:crypto').createHash('sha256').update(authentication.token).digest('hex'),
          };
        },
        resolve() {
          return { type: 'bearer', token: 'buyer-validation-secret' };
        },
      },
    });
    const settlement = coordinator.settle(
      {
        taskId: 'task_protection_order',
        accountId: 'acc_1',
        ownerScope: 'account:acc_1',
        registryId: registry.registryId,
      },
      { status: 'completed', result: { ok: true } },
      {
        url: 'https://buyer.example/webhooks/task',
        operationId: 'protection-order-operation',
        token: 'buyer-validation-secret',
      }
    );

    await protectionStarted;
    assert.strictEqual(connectCalls, 0, 'KMS work must finish before the transaction client is acquired');
    releaseProtection();
    await assert.rejects(
      settlement,
      error =>
        error.message === 'PostgresTaskSettlementCoordinator.settle: transaction failed' &&
        error.cause === databaseError
    );
    assert.strictEqual(connectCalls, 1);
  });

  test('out-of-scope settlement refs return not_found before validation or secret protection', async () => {
    const {
      createPostgresTaskRegistry,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    let protectionCalls = 0;
    let connectCalls = 0;
    const pool = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        connectCalls++;
        throw new Error('must not acquire a transaction for a scoped miss');
      },
    };
    const registry = createPostgresTaskRegistry({ namespace: NAMESPACE, storageId: 'scoped-miss', pool });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: {
        protect() {
          protectionCalls++;
          throw new Error('must not protect a scoped miss');
        },
        resolve() {
          return { type: 'bearer', token: 'unused-validation-secret' };
        },
      },
    });

    assert.deepStrictEqual(
      await coordinator.settle(
        {
          taskId: 'missing_task',
          accountId: 'wrong_account',
          ownerScope: 'account:wrong_account',
          registryId: registry.registryId,
        },
        { status: 'completed', result: { not_json: Number.POSITIVE_INFINITY } },
        { url: 'not-a-url', token: 'short' }
      ),
      { outcome: 'not_found_in_scope', delivery: 'not_applicable' }
    );
    assert.strictEqual(protectionCalls, 0);
    assert.strictEqual(connectCalls, 0);
  });

  test('an observed conflicting terminal task returns before secret protection', async () => {
    const {
      createPostgresTaskRegistry,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    let protectionCalls = 0;
    let connectCalls = 0;
    const pool = {
      async query(sql) {
        if (sql.includes('SELECT tool, status, result, error, has_webhook')) {
          return {
            rows: [
              {
                tool: 'create_media_buy',
                status: 'completed',
                result: { media_buy_id: 'winner' },
                error: null,
                has_webhook: true,
              },
            ],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      async connect() {
        connectCalls++;
        throw new Error('must not acquire a transaction for a known conflict');
      },
    };
    const registry = createPostgresTaskRegistry({ namespace: NAMESPACE, storageId: 'known-terminal-conflict', pool });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: {
        protect() {
          protectionCalls++;
          throw new Error('must not protect a known conflict');
        },
        resolve() {
          return { type: 'bearer', token: 'buyer-validation-secret' };
        },
      },
    });

    assert.deepStrictEqual(
      await coordinator.settle(
        {
          taskId: 'terminal_task',
          accountId: 'acc_1',
          ownerScope: 'account:acc_1',
          registryId: registry.registryId,
        },
        { status: 'completed', result: { media_buy_id: 'loser' } },
        {
          url: 'https://buyer.example/webhooks/task',
          operationId: 'known-terminal-conflict',
          token: 'buyer-validation-secret',
        }
      ),
      {
        outcome: 'already_terminal',
        status: 'completed',
        compatibility: 'conflicting',
        delivery: 'not_applicable',
      }
    );
    assert.strictEqual(protectionCalls, 0);
    assert.strictEqual(connectCalls, 0);
  });

  test('bootstrap DDL creates the scoped schema without legacy upgrade writes', () => {
    const {
      getDecisioningTaskRegistryBootstrap,
      getDecisioningTaskRegistryMigration,
    } = require('../dist/lib/server/decisioning');
    const sql = getDecisioningTaskRegistryBootstrap({ namespace: NAMESPACE });
    assert.ok(sql.includes('PRIMARY KEY (registry_namespace, account_id, owner_scope, task_id)'));
    assert.ok(sql.includes('idx_adcp_decisioning_tasks_owner_account'));
    assert.doesNotMatch(sql, /UPDATE adcp_decisioning_tasks/);
    assert.doesNotMatch(sql, /DROP CONSTRAINT/);
    assert.throws(
      () => getDecisioningTaskRegistryMigration({ namespace: NAMESPACE }),
      /unsafe and no longer returns SQL/
    );
  });

  test('scope-v1 upgrade is phased, bounded, and keeps concurrent index creation out of transactions', () => {
    const { getDecisioningTaskRegistryScopeV1Upgrade } = require('../dist/lib/server/decisioning');
    const upgrade = getDecisioningTaskRegistryScopeV1Upgrade({
      namespace: NAMESPACE,
      lockTimeoutMs: 2500,
      statementTimeoutMs: 60000,
    });

    assert.strictEqual(upgrade.version, 1);
    assert.match(upgrade.preflightSql, /estimated_rows/);
    assert.match(upgrade.preflightSql, /primary_key_definition/);
    assert.match(upgrade.preflightSql, /null_owner_scopes/);
    assert.match(upgrade.preflightSql, /duplicate target keys/);
    assert.match(upgrade.prepareSql, /SET LOCAL lock_timeout = '2500ms'/);
    assert.match(upgrade.prepareSql, /SET owner_scope = 'account:' \|\| account_id/);
    assert.match(upgrade.prepareSql, /do not reassign tenant ownership/);
    assert.ok(upgrade.concurrentIndexSql.every(sql => sql.includes('CONCURRENTLY')));
    assert.ok(upgrade.concurrentIndexSql.every(sql => !sql.includes('BEGIN')));
    assert.match(upgrade.cutoverSql, /PRIMARY KEY USING INDEX/);
    assert.match(upgrade.verifySql, /null_scope_rows/);
  });

  test('registry persists owner_scope and lists with account + owner predicates', async () => {
    const { createPostgresTaskRegistry } = require('../dist/lib/server/decisioning');
    const queries = [];
    const now = new Date('2026-01-01T00:00:00.000Z');
    const pool = {
      async query(text, params) {
        queries.push({ text, params });
        if (text.includes('INSERT INTO')) return { rowCount: 1, rows: [] };
        if (text.includes('SELECT task_id')) {
          return {
            rows: [
              {
                task_id: 'task_1',
                tool: 'create_media_buy',
                account_id: 'acct_1',
                owner_scope: 'api_key:buyer-1',
                status: 'submitted',
                status_message: null,
                result: null,
                error: null,
                progress: null,
                has_webhook: false,
                created_at: now,
                updated_at: now,
              },
            ],
          };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE, storageId: 'store:test-primary' });

    await registry.create({
      tool: 'create_media_buy',
      accountId: 'acct_1',
      ownerScope: 'api_key:buyer-1',
      overrideTaskId: 'task_1',
    });

    assert.deepStrictEqual(queries[0].params, [
      'task_1',
      'create_media_buy',
      'acct_1',
      'api_key:buyer-1',
      false,
      'test',
    ]);

    const listed = await registry.list({ accountId: 'acct_1', ownerScope: 'api_key:buyer-1' });
    assert.strictEqual(listed.tasks.length, 1);
    assert.strictEqual(listed.tasks[0].ownerScope, 'api_key:buyer-1');
    assert.match(queries[1].text, /WHERE registry_namespace = \$1 AND account_id = \$2 AND owner_scope = \$3/);
    assert.deepStrictEqual(queries[1].params, ['test', 'acct_1', 'api_key:buyer-1']);

    await registry.list({ accountId: 'acct_1', ownerScope: 'account:acct_1' });
    assert.deepStrictEqual(queries[2].params, ['test', 'acct_1', 'account:acct_1']);

    await registry.getTask('task_1', { accountId: 'acct_1', ownerScope: 'api_key:buyer-1' });
    assert.match(queries[3].text, /task_id = \$1 AND registry_namespace = \$2 AND account_id = \$3/);
    assert.match(queries[3].text, /owner_scope = \$4/);
    assert.deepStrictEqual(queries[3].params, ['task_1', 'test', 'acct_1', 'api_key:buyer-1']);
  });

  test('in-memory registry preserves rejected and canceled terminal records', async () => {
    const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry');
    const registry = createInMemoryTaskRegistry();

    for (const status of ['rejected', 'canceled']) {
      const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acct_1' });
      const seeded = await registry.getTask(taskId, ACCT_1_SCOPE);
      seeded.status = status;
      seeded.result = { terminal: status };

      await registry.updateProgress(taskId, ACCT_1_SCOPE, { percent: 50, message: 'must not overwrite' });
      await registry.complete(taskId, ACCT_1_SCOPE, { terminal: 'completed' });
      await registry.fail(taskId, ACCT_1_SCOPE, { code: 'INVALID_STATE', message: 'must not overwrite' });

      const record = await registry.getTask(taskId, ACCT_1_SCOPE);
      assert.strictEqual(record.status, status);
      assert.deepStrictEqual(record.result, { terminal: status });
      assert.strictEqual(record.progress, undefined);
      assert.strictEqual(record.error, undefined);
    }
  });

  test('Postgres registry fences every terminal status in all update queries', async () => {
    const { createPostgresTaskRegistry } = require('../dist/lib/server/decisioning');
    const queries = [];
    const pool = {
      async query(text) {
        queries.push(text);
        return { rowCount: 0, rows: [] };
      },
    };
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });

    await registry.updateProgress('task_terminal', ACC_1_SCOPE, { percent: 50 });
    await registry.complete('task_terminal', ACC_1_SCOPE, { terminal: 'completed' });
    await registry.fail('task_terminal', ACC_1_SCOPE, { code: 'INVALID_STATE', message: 'must not overwrite' });

    assert.strictEqual(queries.length, 3);
    for (const query of queries) {
      assert.match(query, /status NOT IN \('completed', 'failed', 'rejected', 'canceled'\)/);
      assert.match(query, /WITH candidate AS MATERIALIZED/);
      assert.match(query, /FOR UPDATE/);
    }
  });

  test('Postgres maps atomic statement rows to the same mutation outcomes as memory', async () => {
    const { createPostgresTaskRegistry } = require('../dist/lib/server/decisioning');
    const returnedRows = [
      [{ outcome: 'applied', status: 'submitted' }],
      [{ outcome: 'already_terminal', status: 'failed' }],
      [],
    ];
    const pool = {
      async query() {
        return { rowCount: returnedRows[0]?.length ?? 0, rows: returnedRows.shift() };
      },
    };
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });

    assert.deepStrictEqual(await registry.complete('task_1', ACC_1_SCOPE, { ok: true }), { outcome: 'applied' });
    assert.deepStrictEqual(
      await registry.fail('task_1', ACC_1_SCOPE, {
        code: 'INVALID_STATE',
        recovery: 'correctable',
        message: 'already done',
      }),
      { outcome: 'already_terminal', status: 'failed' }
    );
    assert.deepStrictEqual(await registry.updateProgress('task_1', ACC_1_SCOPE, { percentage: 50 }), {
      outcome: 'not_found_in_scope',
    });
  });
});

describe('createPostgresTaskRegistry', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let Pool, pool;
  let createPostgresTaskRegistry, getDecisioningTaskRegistryBootstrap, getDecisioningTaskRegistryScopeV1Upgrade;

  before(async () => {
    Pool = require('pg').Pool;
    pool = new Pool({ connectionString: DATABASE_URL });

    const lib = require('../dist/lib/server/decisioning');
    createPostgresTaskRegistry = lib.createPostgresTaskRegistry;
    getDecisioningTaskRegistryBootstrap = lib.getDecisioningTaskRegistryBootstrap;
    getDecisioningTaskRegistryScopeV1Upgrade = lib.getDecisioningTaskRegistryScopeV1Upgrade;
    const { getWebhookDeliveryMigration, getWebhookDeliveryRecoveryMigration } = require('../dist/lib/server');

    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${SETTLEMENT_OUTBOX} CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${SETTLEMENT_DELIVERIES} CASCADE`);
    await pool.query(getDecisioningTaskRegistryBootstrap({ namespace: NAMESPACE }));
    await pool.query(getWebhookDeliveryRecoveryMigration({ tableName: SETTLEMENT_OUTBOX }));
    await pool.query(getWebhookDeliveryMigration({ tableName: SETTLEMENT_DELIVERIES }));
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
    await pool.query(`DELETE FROM ${SETTLEMENT_OUTBOX}`);
    await pool.query(`DELETE FROM ${SETTLEMENT_DELIVERIES}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  test('migration generates the expected table + indexes', () => {
    const sql = getDecisioningTaskRegistryBootstrap({ namespace: NAMESPACE });
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS adcp_decisioning_tasks'));
    assert.ok(sql.includes('adcp_decisioning_tasks_valid_status'));
    assert.ok(sql.includes('idx_adcp_decisioning_tasks_account_id'));
    assert.ok(sql.includes('idx_adcp_decisioning_tasks_status_created'));
  });

  test('migration rejects invalid table names', () => {
    assert.throws(
      () => getDecisioningTaskRegistryBootstrap({ tableName: 'DROP TABLE; --', namespace: NAMESPACE }),
      /Invalid table name/
    );
    assert.throws(
      () => getDecisioningTaskRegistryBootstrap({ tableName: '1bad', namespace: NAMESPACE }),
      /Invalid table name/
    );
    assert.throws(
      () => getDecisioningTaskRegistryBootstrap({ tableName: 'MixedCase', namespace: NAMESPACE }),
      /Invalid table name/
    );
  });

  test('factory rejects invalid table names', () => {
    assert.throws(
      () => createPostgresTaskRegistry({ pool, namespace: NAMESPACE, tableName: 'Robert; DROP TABLE--' }),
      /Invalid table name/
    );
  });

  test('push settlement coordinator rejects invalid retry policies instead of silently changing them', () => {
    const { createPostgresTaskSettlementCoordinator } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:invalid-settlement-retries',
    });
    for (const retries of [
      { maxAttempts: 0 },
      { maxAttempts: 1.5 },
      { initialDelayMs: -1 },
      { maxDelayMs: Infinity },
      { jitter: 1.1 },
    ]) {
      assert.throws(
        () =>
          createPostgresTaskSettlementCoordinator({
            registry,
            publisherScope: 'test-seller',
            outbox: { tableName: SETTLEMENT_OUTBOX },
            retries,
          }),
        TypeError
      );
    }
  });

  test('create + getTask roundtrips a submitted task', async () => {
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });
    assert.ok(taskId.startsWith('task_'));

    const record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.ok(record);
    assert.strictEqual(record.taskId, taskId);
    assert.strictEqual(record.tool, 'create_media_buy');
    assert.strictEqual(record.accountId, 'acc_1');
    assert.strictEqual(record.status, 'submitted');
    assert.ok(typeof record.createdAt === 'string');
    assert.ok(typeof record.updatedAt === 'string');
  });

  test('getTask returns null for unknown task_id', async () => {
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const record = await registry.getTask('task_unknown', ACC_1_SCOPE);
    assert.strictEqual(record, null);
  });

  test('complete updates status + result, then is idempotent', async () => {
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    assert.deepStrictEqual(await registry.complete(taskId, ACC_1_SCOPE, { media_buy_id: 'mb_42', status: 'active' }), {
      outcome: 'applied',
    });

    let record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.strictEqual(record.status, 'completed');
    assert.deepStrictEqual(record.result, { media_buy_id: 'mb_42', status: 'active' });

    // Subsequent complete() is a no-op (terminal-state guard via SQL WHERE)
    assert.deepStrictEqual(await registry.complete(taskId, ACC_1_SCOPE, { media_buy_id: 'mb_99', status: 'paused' }), {
      outcome: 'already_terminal',
      status: 'completed',
    });

    record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.deepStrictEqual(
      record.result,
      { media_buy_id: 'mb_42', status: 'active' },
      'second complete must be a no-op'
    );
  });

  test('scoped mutation outcomes conflate every no-match and isolate duplicate public ids', async () => {
    const { completeScopedTask } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE, storageId: 'store:test-primary' });
    const first = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      ownerScope: 'api_key:first',
      overrideTaskId: 'task_pg_shared',
    });
    const second = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_2',
      ownerScope: 'api_key:second',
      overrideTaskId: 'task_pg_shared',
    });
    const circular = {};
    circular.self = circular;

    assert.deepStrictEqual(await registry.complete(first.taskId, { ...first, accountId: 'wrong' }, { leaked: true }), {
      outcome: 'not_found_in_scope',
    });
    assert.deepStrictEqual(await registry.complete(first.taskId, { ...first, accountId: 'wrong' }, circular), {
      outcome: 'not_found_in_scope',
    });
    assert.deepStrictEqual(
      await registry.updateProgress(first.taskId, { ...first, ownerScope: 'api_key:wrong' }, { percentage: 101 }),
      { outcome: 'not_found_in_scope' }
    );
    assert.deepStrictEqual(await completeScopedTask(registry, JSON.parse(JSON.stringify(first)), { owner: 'first' }), {
      outcome: 'applied',
    });
    assert.deepStrictEqual(await registry.complete(first.taskId, first, circular), {
      outcome: 'already_terminal',
      status: 'completed',
    });
    assert.strictEqual((await registry.getTask(second.taskId, second)).status, 'submitted');

    const otherNamespace = createPostgresTaskRegistry({
      pool,
      namespace: 'test-other',
      storageId: 'store:test-other',
    });
    const otherRef = await otherNamespace.create({
      tool: 'create_media_buy',
      accountId: first.accountId,
      ownerScope: first.ownerScope,
      overrideTaskId: first.taskId,
    });
    assert.deepStrictEqual(await completeScopedTask(otherNamespace, first, { leaked: true }), {
      outcome: 'not_found_in_scope',
    });
    assert.strictEqual((await otherNamespace.getTask(otherRef.taskId, otherRef)).status, 'submitted');
  });

  test('worker settlement strips server-only fields and rejects webhook-backed tasks', async () => {
    const { completeScopedTask } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE, storageId: 'store:test-worker' });
    const cleanRef = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });
    assert.deepStrictEqual(
      await registry.updateProgress(cleanRef.taskId, cleanRef, {
        ...cleanRef,
        message: 'queued',
        creatives_processed: 3,
        clientSecret: 'top-level-secret',
        details: { bearer: 'must-not-persist', refreshToken: 'nested-secret', safe: 'kept' },
      }),
      { outcome: 'applied' }
    );
    assert.deepStrictEqual((await registry.getTask(cleanRef.taskId, cleanRef)).progress, {
      message: 'queued',
      creatives_processed: 3,
      details: { safe: 'kept' },
    });
    await assert.rejects(
      registry.updateProgress(cleanRef.taskId, cleanRef, { message: 'x'.repeat(65 * 1024) }),
      /Task progress JSON exceeds/
    );
    const result = {
      taskRef: { taskId: cleanRef.taskId, accountId: cleanRef.accountId, ownerScope: cleanRef.ownerScope },
      products: [
        {
          product_id: 'product-1',
          ctx_metadata: { bearer: 'secret' },
          implementation_config: { upstream_id: 'secret' },
        },
      ],
    };
    assert.deepStrictEqual(await completeScopedTask(registry, cleanRef, result), { outcome: 'applied' });
    assert.deepStrictEqual((await registry.getTask(cleanRef.taskId, cleanRef)).result, {
      products: [{ product_id: 'product-1' }],
    });

    const webhookRef = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      hasWebhook: true,
    });
    await assert.rejects(
      completeScopedTask(registry, webhookRef, { ok: true }),
      /unavailable for tasks with push notifications/
    );
    assert.strictEqual((await registry.getTask(webhookRef.taskId, webhookRef)).status, 'submitted');
  });

  test('push worker settlement atomically binds recovery, protects tokens, and classifies retries', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:push-settlement',
    });
    const adapter = {
      protect(authentication, context) {
        const token = authentication.token ?? authentication.secret;
        return {
          protectedValue: {
            ciphertext: Buffer.from(`${context.purpose}:${token}`, 'utf8').toString('base64'),
          },
          fingerprint: require('node:crypto').createHash('sha256').update(`${context.purpose}:${token}`).digest('hex'),
        };
      },
      resolve(protectedValue, context) {
        const cleartext = Buffer.from(protectedValue.ciphertext, 'base64').toString('utf8');
        const prefix = `${context.purpose}:`;
        assert.ok(cleartext.startsWith(prefix));
        return { type: 'bearer', token: cleartext.slice(prefix.length) };
      },
    };
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: adapter,
      recovery: { defaultLeaseMs: 1000 },
    });
    const ref = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      ownerScope: 'api_key:buyer-a',
      hasWebhook: true,
    });
    const push = {
      url: 'https://buyer.example/webhooks/task',
      operationId: 'approval-op-1',
      token: 'buyer-validation-secret',
    };
    const result = { media_buy_id: 'mb_crash_safe', ctx_metadata: { bearer: 'must-strip' } };

    assert.deepStrictEqual(await completeScopedPushTask(coordinator, ref, push, result), {
      outcome: 'applied',
      delivery: 'durably_bound',
    });
    assert.deepStrictEqual((await registry.getTask(ref.taskId, ref)).result, {
      media_buy_id: 'mb_crash_safe',
    });

    const raw = await pool.query(`SELECT snapshot::text AS snapshot FROM ${SETTLEMENT_OUTBOX}`);
    assert.strictEqual(raw.rowCount, 1);
    assert.doesNotMatch(raw.rows[0].snapshot, /buyer-validation-secret|must-strip/);

    assert.deepStrictEqual(await completeScopedPushTask(coordinator, ref, push, result), {
      outcome: 'already_terminal',
      status: 'completed',
      compatibility: 'compatible',
      delivery: 'recoverable',
    });
    await assert.rejects(
      completeScopedPushTask(coordinator, ref, { ...push, url: 'https://other.example/webhook' }, result),
      /already bound to a conflicting route or payload/
    );
    assert.deepStrictEqual(await completeScopedPushTask(coordinator, ref, push, { media_buy_id: 'wrong' }), {
      outcome: 'already_terminal',
      status: 'completed',
      compatibility: 'conflicting',
      delivery: 'not_applicable',
    });
    assert.strictEqual((await pool.query(`SELECT count(*)::int AS count FROM ${SETTLEMENT_OUTBOX}`)).rows[0].count, 1);

    const restartedRegistry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:push-settlement',
    });
    assert.notStrictEqual(restartedRegistry, registry, 'restart reconstructs the registry from stable configuration');
    const restarted = createPostgresTaskSettlementCoordinator({
      registry: restartedRegistry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: adapter,
      recovery: { defaultLeaseMs: 1000 },
    });
    const [beforePublish] = await restarted.recovery.claimPending({ ownerToken: 'recovery-worker-a', limit: 1 });
    assert.ok(beforePublish);
    assert.strictEqual(await restarted.recovery.release(beforePublish, 0), true, 'crash-before-publish is retryable');
    const [publishedNotAcked] = await restarted.recovery.claimPending({ ownerToken: 'recovery-worker-b', limit: 1 });
    assert.ok(publishedNotAcked);
    assert.strictEqual(publishedNotAcked.snapshot.payload.token, 'buyer-validation-secret');
    assert.deepStrictEqual(publishedNotAcked.snapshot.payload.result, { media_buy_id: 'mb_crash_safe' });
    const { createWebhookEmitter, pgWebhookDeliveryStore } = require('../dist/lib/server');
    const { privateKey } = require('node:crypto').generateKeyPairSync('ed25519');
    const privateJwk = privateKey.export({ format: 'jwk' });
    let publishes = 0;
    const emitter = createWebhookEmitter({
      signerKey: {
        keyid: 'settlement-recovery-key',
        alg: 'ed25519',
        privateKey: {
          ...privateJwk,
          kid: 'settlement-recovery-key',
          alg: 'EdDSA',
          key_ops: ['sign'],
          adcp_use: 'request-signing',
        },
      },
      publisherScope: publishedNotAcked.key.publisherScope,
      tenantScope: publishedNotAcked.key.tenantScope,
      deliveryStore: pgWebhookDeliveryStore(pool, { tableName: SETTLEMENT_DELIVERIES }),
      deliveryRecovery: restarted.recovery,
      fetch: async () => {
        publishes++;
        return { status: 204, headers: { get: () => undefined } };
      },
    });
    const publishResult = await emitter.emitRecovered(publishedNotAcked);
    assert.strictEqual(publishResult.delivered, true);
    assert.strictEqual(publishes, 1);
    // Simulate process death after POST success but before lease settlement.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const afterPublishCrash = createPostgresTaskSettlementCoordinator({
      registry: restartedRegistry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: adapter,
      recovery: { defaultLeaseMs: 1000 },
    });
    const [reclaimed] = await afterPublishCrash.recovery.claimPending({ ownerToken: 'recovery-worker-c', limit: 1 });
    assert.ok(reclaimed, 'an unacknowledged publish is recoverable after lease expiry');
    assert.strictEqual(reclaimed.key.deliveryId, publishedNotAcked.key.deliveryId);
    assert.deepStrictEqual(reclaimed.snapshot.payload, publishedNotAcked.snapshot.payload);
    const replayResult = await emitter.emitRecovered(reclaimed);
    assert.strictEqual(replayResult.delivered, true);
    assert.strictEqual(replayResult.idempotency_key, publishResult.idempotency_key);
    assert.strictEqual(publishes, 2, 'restart retries the same at-least-once delivery before acknowledging');
    assert.strictEqual(await afterPublishCrash.recovery.settleLease(reclaimed, 'delivered'), true);
    assert.deepStrictEqual(await completeScopedPushTask(coordinator, ref, push, result), {
      outcome: 'already_terminal',
      status: 'completed',
      compatibility: 'compatible',
      delivery: 'delivered',
    });
    await assert.rejects(
      completeScopedPushTask(coordinator, ref, { ...push, operationId: 'changed-after-delivery' }, result),
      /already bound to a conflicting route or payload/
    );
  });

  test('push settlement preserves legacy operation identity and rejects deterministic poison results', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
      TaskPushSettlementConfigurationError,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:legacy-operation',
    });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller-legacy',
      outbox: { tableName: SETTLEMENT_OUTBOX },
    });

    const legacyRef = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      hasWebhook: true,
    });
    assert.deepStrictEqual(
      await completeScopedPushTask(
        coordinator,
        legacyRef,
        { url: 'https://buyer.example/legacy', servedAdcpVersion: '3.0.1' },
        { media_buy_id: 'mb_legacy' }
      ),
      { outcome: 'applied', delivery: 'durably_bound' }
    );
    const legacyOutbox = await pool.query(
      `SELECT snapshot->'payload'->>'operation_id' AS operation_id FROM ${SETTLEMENT_OUTBOX}
        WHERE publisher_scope = $1`,
      ['test-seller-legacy']
    );
    assert.strictEqual(legacyOutbox.rows[0].operation_id, `create_media_buy.${legacyRef.taskId}`);

    const currentRef = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      hasWebhook: true,
    });
    await assert.rejects(
      completeScopedPushTask(
        coordinator,
        currentRef,
        { url: 'https://buyer.example/current', servedAdcpVersion: '3.2.0-beta.5' },
        { media_buy_id: 'mb_current' }
      ),
      error => error instanceof TaskPushSettlementConfigurationError && /operationId is required/.test(error.message)
    );
    for (const servedAdcpVersion of [undefined, 'not-a-version']) {
      await assert.rejects(
        completeScopedPushTask(
          coordinator,
          currentRef,
          { url: 'https://buyer.example/current', servedAdcpVersion },
          { media_buy_id: 'mb_current' }
        ),
        error => error instanceof TaskPushSettlementConfigurationError && /operationId is required/.test(error.message)
      );
    }
    await assert.rejects(
      completeScopedPushTask(
        coordinator,
        currentRef,
        {
          url: 'https://buyer.example/current',
          operationId: 'current-operation',
          servedAdcpVersion: '3.2.0-beta.5',
        },
        { media_buy_id: 1n }
      ),
      error => error instanceof TaskPushSettlementConfigurationError && /serializable JSON/.test(error.message)
    );
    for (const poison of [NaN, Infinity, new Map([['media_buy_id', 'mb_current']]), new Date()]) {
      await assert.rejects(
        completeScopedPushTask(
          coordinator,
          currentRef,
          {
            url: 'https://buyer.example/current',
            operationId: 'current-operation',
            servedAdcpVersion: '3.2.0-beta.5',
          },
          { value: poison }
        ),
        error => error instanceof TaskPushSettlementConfigurationError && /serializable JSON/.test(error.message)
      );
    }
    await assert.rejects(
      completeScopedPushTask(
        coordinator,
        currentRef,
        {
          url: 'https://',
          operationId: 'current-operation',
          servedAdcpVersion: '3.2.0-beta.5',
        },
        { media_buy_id: 'mb_current' }
      ),
      error => error instanceof TaskPushSettlementConfigurationError && /url must be/.test(error.message)
    );
    assert.strictEqual((await registry.getTask(currentRef.taskId, currentRef)).status, 'submitted');
  });

  test('push settlement refuses to create a delivery for a task terminalized outside its atomic transaction', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
      TaskPushSettlementConfigurationError,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:preterminal-no-outbox',
    });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller-preterminal',
      outbox: { tableName: SETTLEMENT_OUTBOX },
    });
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    const result = { media_buy_id: 'mb_preterminal' };
    assert.deepStrictEqual(await registry.complete(ref.taskId, ref, result), { outcome: 'applied' });

    await assert.rejects(
      completeScopedPushTask(
        coordinator,
        ref,
        { url: 'https://buyer.example/preterminal', operationId: 'preterminal-operation' },
        result
      ),
      error =>
        error instanceof TaskPushSettlementConfigurationError &&
        /no atomic webhook delivery checkpoint/.test(error.message)
    );
    assert.strictEqual((await pool.query(`SELECT count(*)::int AS count FROM ${SETTLEMENT_OUTBOX}`)).rows[0].count, 0);
  });

  test('a separate Node process reconstructs the registry and atomically settles a push task', async () => {
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:child-process-settlement',
    });
    const ref = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      ownerScope: 'api_key:child-process',
      hasWebhook: true,
    });
    const script = `
      const { Pool } = require('pg');
      const {
        completeScopedPushTask,
        createPostgresTaskRegistry,
        createPostgresTaskSettlementCoordinator,
      } = require('./dist/lib/server/decisioning');
      (async () => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const registry = createPostgresTaskRegistry({
          pool,
          namespace: process.env.TASK_NAMESPACE,
          storageId: process.env.TASK_STORAGE_ID,
        });
        const coordinator = createPostgresTaskSettlementCoordinator({
          registry,
          publisherScope: process.env.TASK_PUBLISHER,
          outbox: { tableName: process.env.TASK_OUTBOX },
        });
        const outcome = await completeScopedPushTask(
          coordinator,
          JSON.parse(process.env.TASK_REF),
          {
            url: 'https://buyer.example/child-process',
            operationId: 'child-process-operation',
            servedAdcpVersion: '3.2.0-beta.5',
          },
          { media_buy_id: 'mb_child_process' },
        );
        process.stdout.write(JSON.stringify(outcome));
        await pool.end();
      })().catch(error => {
        process.stderr.write(error.stack || String(error));
        process.exitCode = 1;
      });
    `;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TASK_NAMESPACE: NAMESPACE,
        TASK_STORAGE_ID: 'store:child-process-settlement',
        TASK_PUBLISHER: 'test-seller-child-process',
        TASK_OUTBOX: SETTLEMENT_OUTBOX,
        TASK_REF: JSON.stringify(ref),
      },
    });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.deepStrictEqual(JSON.parse(child.stdout), { outcome: 'applied', delivery: 'durably_bound' });
    const state = await registry.getTask(ref.taskId, ref);
    assert.strictEqual(state.status, 'completed');
    assert.deepStrictEqual(state.result, { media_buy_id: 'mb_child_process' });
    assert.strictEqual(
      (
        await pool.query(`SELECT count(*)::int AS count FROM ${SETTLEMENT_OUTBOX} WHERE publisher_scope = $1`, [
          'test-seller-child-process',
        ])
      ).rows[0].count,
      1
    );
  });

  test('shared outbox recovery claims are isolated by publisher and registry scope', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const firstRegistry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:isolated-first',
    });
    const secondRegistry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:isolated-second',
    });
    const first = createPostgresTaskSettlementCoordinator({
      registry: firstRegistry,
      publisherScope: 'shared-publisher',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      recovery: { defaultLeaseMs: 1000 },
    });
    const second = createPostgresTaskSettlementCoordinator({
      registry: secondRegistry,
      publisherScope: 'shared-publisher',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      recovery: { defaultLeaseMs: 1000 },
    });
    const firstRef = await firstRegistry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    const secondRef = await secondRegistry.create({ tool: 'create_media_buy', accountId: 'acc_2', hasWebhook: true });
    const push = { url: 'https://buyer.example/webhooks/task', operationId: 'shared-operation' };
    await completeScopedPushTask(first, firstRef, push, { media_buy_id: 'first-buy' });
    await completeScopedPushTask(second, secondRef, push, { media_buy_id: 'second-buy' });

    const [firstLease] = await first.recovery.claimPending({ ownerToken: 'first-scope-worker', limit: 10 });
    const [secondLease] = await second.recovery.claimPending({ ownerToken: 'second-scope-worker', limit: 10 });
    assert.strictEqual(firstLease.snapshot.payload.task_id, firstRef.taskId);
    assert.strictEqual(secondLease.snapshot.payload.task_id, secondRef.taskId);
    assert.notStrictEqual(firstLease.key.tenantScope, secondLease.key.tenantScope);
    assert.deepStrictEqual(await first.recovery.claimPending({ ownerToken: 'first-scope-worker-2', limit: 10 }), []);
    assert.strictEqual(await first.recovery.settleLease(firstLease, 'delivered'), true);
    assert.strictEqual(await second.recovery.settleLease(secondLease, 'delivered'), true);
  });

  test('concurrent conflicting settlements commit exactly one terminal result and webhook', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:concurrent-settlement',
    });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
    });
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    const push = { url: 'https://buyer.example/webhooks/task', operationId: 'concurrent-operation' };
    const outcomes = await Promise.all([
      completeScopedPushTask(coordinator, ref, push, { media_buy_id: 'candidate-a' }),
      completeScopedPushTask(coordinator, ref, push, { media_buy_id: 'candidate-b' }),
    ]);
    assert.strictEqual(outcomes.filter(outcome => outcome.outcome === 'applied').length, 1);
    assert.strictEqual(
      outcomes.filter(outcome => outcome.outcome === 'already_terminal' && outcome.compatibility === 'conflicting')
        .length,
      1
    );
    const task = await registry.getTask(ref.taskId, ref);
    const outbox = await pool.query(`SELECT snapshot FROM ${SETTLEMENT_OUTBOX}`);
    assert.strictEqual(outbox.rowCount, 1);
    assert.deepStrictEqual(outbox.rows[0].snapshot.payload.result, task.result);
  });

  test('paused authentication protection holds neither a transaction connection nor the task row lock', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    let connectCalls = 0;
    let activeConnections = 0;
    const trackingPool = {
      query: (sql, values) => pool.query(sql, values),
      async connect() {
        connectCalls++;
        activeConnections++;
        const client = await pool.connect();
        return {
          query: (sql, values) => client.query(sql, values),
          release() {
            activeConnections--;
            client.release();
          },
        };
      },
    };
    const registry = createPostgresTaskRegistry({
      pool: trackingPool,
      namespace: NAMESPACE,
      storageId: 'store:paused-protection',
    });
    let releaseProtection;
    const protectionReleased = new Promise(resolve => {
      releaseProtection = resolve;
    });
    let markProtectionStarted;
    const protectionStarted = new Promise(resolve => {
      markProtectionStarted = resolve;
    });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: {
        async protect(authentication) {
          markProtectionStarted();
          await protectionReleased;
          return {
            protectedValue: { ciphertext: 'opaque-paused-protection' },
            fingerprint: require('node:crypto').createHash('sha256').update(authentication.token).digest('hex'),
          };
        },
        resolve() {
          return { type: 'bearer', token: 'buyer-validation-secret' };
        },
      },
    });
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    const settlement = completeScopedPushTask(
      coordinator,
      ref,
      {
        url: 'https://buyer.example/webhooks/task',
        operationId: 'paused-protection-operation',
        token: 'buyer-validation-secret',
      },
      { media_buy_id: 'paused-protection-buy' }
    );

    await protectionStarted;
    assert.strictEqual(connectCalls, 0, 'settlement must not acquire a transaction client before protection finishes');
    assert.strictEqual(activeConnections, 0);

    const probe = await pool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query(
        `SELECT task_id FROM ${TABLE}
          WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4
          FOR UPDATE NOWAIT`,
        [ref.taskId, NAMESPACE, ref.accountId, ref.ownerScope]
      );
      await probe.query('ROLLBACK');
    } finally {
      probe.release();
    }

    releaseProtection();
    assert.deepStrictEqual(await settlement, { outcome: 'applied', delivery: 'durably_bound' });
    assert.strictEqual(connectCalls, 1);
    assert.strictEqual(activeConnections, 0);
  });

  test('task transitions that race paused protection are revalidated under the settlement lock', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:task-transition-during-protection',
    });
    let releaseProtection;
    const protectionReleased = new Promise(resolve => {
      releaseProtection = resolve;
    });
    let markProtectionStarted;
    const protectionStarted = new Promise(resolve => {
      markProtectionStarted = resolve;
    });
    const pausedCoordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: {
        async protect(authentication) {
          markProtectionStarted();
          await protectionReleased;
          return {
            protectedValue: { ciphertext: 'opaque-task-race-secret' },
            fingerprint: require('node:crypto').createHash('sha256').update(authentication.token).digest('hex'),
          };
        },
        resolve() {
          return { type: 'bearer', token: 'buyer-validation-secret' };
        },
      },
    });
    const winnerCoordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
    });
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    const paused = completeScopedPushTask(
      pausedCoordinator,
      ref,
      {
        url: 'https://buyer.example/webhooks/task',
        operationId: 'task-transition-race',
        token: 'buyer-validation-secret',
      },
      { media_buy_id: 'paused-candidate' }
    );

    await protectionStarted;
    assert.deepStrictEqual(
      await completeScopedPushTask(
        winnerCoordinator,
        ref,
        {
          url: 'https://buyer.example/webhooks/task',
          operationId: 'task-transition-race',
        },
        { media_buy_id: 'winning-candidate' }
      ),
      { outcome: 'applied', delivery: 'durably_bound' }
    );
    releaseProtection();

    assert.deepStrictEqual(await paused, {
      outcome: 'already_terminal',
      status: 'completed',
      compatibility: 'conflicting',
      delivery: 'not_applicable',
    });
    assert.deepStrictEqual((await registry.getTask(ref.taskId, ref)).result, {
      media_buy_id: 'winning-candidate',
    });
    assert.strictEqual((await pool.query(`SELECT count(*)::int AS count FROM ${SETTLEMENT_OUTBOX}`)).rows[0].count, 1);
  });

  test('an outbox race during protection accepts one intent and rejects the conflicting route', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
      TaskPushSettlementConfigurationError,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:protection-race',
    });
    let releaseProtection;
    const protectionReleased = new Promise(resolve => {
      releaseProtection = resolve;
    });
    let protectionCalls = 0;
    let markBothStarted;
    const bothStarted = new Promise(resolve => {
      markBothStarted = resolve;
    });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: {
        async protect(authentication) {
          protectionCalls++;
          if (protectionCalls === 2) markBothStarted();
          await protectionReleased;
          return {
            protectedValue: { ciphertext: `opaque-protection-race-${protectionCalls}` },
            fingerprint: require('node:crypto').createHash('sha256').update(authentication.token).digest('hex'),
          };
        },
        resolve() {
          return { type: 'bearer', token: 'buyer-validation-secret' };
        },
      },
    });
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    const basePush = {
      operationId: 'protection-race-operation',
      token: 'buyer-validation-secret',
    };
    const first = completeScopedPushTask(
      coordinator,
      ref,
      { ...basePush, url: 'https://buyer.example/webhooks/first' },
      { media_buy_id: 'protection-race-buy' }
    );
    const second = completeScopedPushTask(
      coordinator,
      ref,
      { ...basePush, url: 'https://buyer.example/webhooks/second' },
      { media_buy_id: 'protection-race-buy' }
    );

    await bothStarted;
    releaseProtection();
    const outcomes = await Promise.allSettled([first, second]);
    assert.strictEqual(
      outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value.outcome === 'applied').length,
      1
    );
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof TaskPushSettlementConfigurationError);
    assert.match(rejected.reason.message, /already bound to a conflicting route or payload/);
    assert.strictEqual((await pool.query(`SELECT count(*)::int AS count FROM ${SETTLEMENT_OUTBOX}`)).rows[0].count, 1);
  });

  test('a transient authentication-protection outage leaves settlement retryable', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:transient-protection',
    });
    let protectionAttempts = 0;
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
      authenticationAdapter: {
        protect(authentication) {
          protectionAttempts++;
          if (protectionAttempts === 1) throw new Error('temporary KMS outage');
          return {
            protectedValue: { ciphertext: 'opaque-ciphertext-reference' },
            fingerprint: require('node:crypto').createHash('sha256').update(authentication.token).digest('hex'),
          };
        },
        resolve() {
          return { type: 'bearer', token: 'buyer-validation-secret' };
        },
      },
    });
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    const push = {
      url: 'https://buyer.example/webhooks/task',
      operationId: 'approval-op-kms-retry',
      token: 'buyer-validation-secret',
    };
    await assert.rejects(
      completeScopedPushTask(coordinator, ref, push, { media_buy_id: 'kms-retry-buy' }),
      error =>
        error.message === 'PostgresTaskSettlementCoordinator.settle: transaction failed' &&
        error.cause?.name === 'WebhookAuthenticationProtectionError'
    );
    assert.strictEqual((await registry.getTask(ref.taskId, ref)).status, 'submitted');
    assert.strictEqual((await pool.query(`SELECT count(*)::int AS count FROM ${SETTLEMENT_OUTBOX}`)).rows[0].count, 0);
    assert.deepStrictEqual(await completeScopedPushTask(coordinator, ref, push, { media_buy_id: 'kms-retry-buy' }), {
      outcome: 'applied',
      delivery: 'durably_bound',
    });
  });

  test('a failure between outbox insert and task update rolls back both and retries cleanly', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:push-rollback',
    });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
    });
    const ref = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      hasWebhook: true,
    });
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_task_settlement_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.task_id = '${ref.taskId}' AND NEW.status = 'completed' THEN
          RAISE EXCEPTION 'injected crash boundary';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_task_settlement_update
      BEFORE UPDATE ON ${TABLE}
      FOR EACH ROW EXECUTE FUNCTION fail_task_settlement_update();
    `);
    const push = { url: 'https://buyer.example/webhooks/task', operationId: 'approval-op-rollback' };
    try {
      await assert.rejects(
        completeScopedPushTask(coordinator, ref, push, { media_buy_id: 'mb_after_retry' }),
        /transaction failed/
      );
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS fail_task_settlement_update ON ${TABLE}`);
      await pool.query(`DROP FUNCTION IF EXISTS fail_task_settlement_update()`);
    }
    assert.strictEqual((await registry.getTask(ref.taskId, ref)).status, 'submitted');
    assert.strictEqual((await pool.query(`SELECT count(*)::int AS count FROM ${SETTLEMENT_OUTBOX}`)).rows[0].count, 0);
    assert.deepStrictEqual(await completeScopedPushTask(coordinator, ref, push, { media_buy_id: 'mb_after_retry' }), {
      outcome: 'applied',
      delivery: 'durably_bound',
    });
  });

  test('a deferred commit failure rolls back the updated task and its outbox checkpoint', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:push-commit-rollback',
    });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
    });
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1', hasWebhook: true });
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_task_settlement_commit() RETURNS trigger AS $$
      BEGIN
        IF NEW.task_id = '${ref.taskId}' AND NEW.status = 'completed' THEN
          RAISE EXCEPTION 'injected deferred commit boundary';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER fail_task_settlement_commit
      AFTER UPDATE ON ${TABLE}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fail_task_settlement_commit();
    `);
    const push = { url: 'https://buyer.example/webhooks/task', operationId: 'approval-op-deferred-rollback' };
    try {
      await assert.rejects(
        completeScopedPushTask(coordinator, ref, push, { media_buy_id: 'mb_commit_retry' }),
        /transaction failed/
      );
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS fail_task_settlement_commit ON ${TABLE}`);
      await pool.query(`DROP FUNCTION IF EXISTS fail_task_settlement_commit()`);
    }
    assert.strictEqual((await registry.getTask(ref.taskId, ref)).status, 'submitted');
    assert.strictEqual((await pool.query(`SELECT count(*)::int AS count FROM ${SETTLEMENT_OUTBOX}`)).rows[0].count, 0);
    assert.deepStrictEqual(await completeScopedPushTask(coordinator, ref, push, { media_buy_id: 'mb_commit_retry' }), {
      outcome: 'applied',
      delivery: 'durably_bound',
    });
  });

  test('failed push settlement stores one canonical failure artifact and recoverable webhook', async () => {
    const { createPostgresTaskSettlementCoordinator, failScopedPushTask } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:push-failure',
    });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
    });
    const ref = await registry.create({ tool: 'sync_creatives', accountId: 'acc_1', hasWebhook: true });
    const error = { code: 'GOVERNANCE_DENIED', recovery: 'terminal', message: 'Approval declined' };
    assert.deepStrictEqual(
      await failScopedPushTask(
        coordinator,
        ref,
        { url: 'https://buyer.example/webhooks/task', operationId: 'approval-op-failed' },
        error
      ),
      { outcome: 'applied', delivery: 'durably_bound' }
    );
    const stored = await registry.getTask(ref.taskId, ref);
    assert.strictEqual(stored.status, 'failed');
    assert.deepStrictEqual(stored.error, error);
    assert.deepStrictEqual(stored.result, { errors: [error] });
    const [lease] = await coordinator.recovery.claimPending({ ownerToken: 'failed-task-worker', limit: 1 });
    assert.strictEqual(lease.snapshot.payload.status, 'failed');
    assert.strictEqual(lease.snapshot.payload.message, 'Approval declined');
    assert.deepStrictEqual(lease.snapshot.payload.result, { errors: [error] });
  });

  test('push settlement keeps wrong scoped refs non-enumerating and creates no outbox row', async () => {
    const {
      completeScopedPushTask,
      createPostgresTaskSettlementCoordinator,
    } = require('../dist/lib/server/decisioning');
    const registry = createPostgresTaskRegistry({
      pool,
      namespace: NAMESPACE,
      storageId: 'store:push-scope',
    });
    const coordinator = createPostgresTaskSettlementCoordinator({
      registry,
      publisherScope: 'test-seller',
      outbox: { tableName: SETTLEMENT_OUTBOX },
    });
    const ref = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      ownerScope: 'api_key:buyer-a',
      hasWebhook: true,
    });
    const outcome = await completeScopedPushTask(
      coordinator,
      { ...ref, ownerScope: 'api_key:buyer-b' },
      { url: 'https://buyer.example/webhooks/task', operationId: 'approval-op-scope' },
      { media_buy_id: 'must-not-apply' }
    );
    assert.deepStrictEqual(outcome, { outcome: 'not_found_in_scope', delivery: 'not_applicable' });
    assert.strictEqual((await registry.getTask(ref.taskId, ref)).status, 'submitted');
    assert.strictEqual((await pool.query(`SELECT count(*)::int AS count FROM ${SETTLEMENT_OUTBOX}`)).rows[0].count, 0);
  });

  test('explicit registry identity prevents cross-store settlement with an identical tuple', async () => {
    const { completeScopedTask } = require('../dist/lib/server/decisioning');
    const firstTable = 'task_registry_store_a';
    const secondTable = 'task_registry_store_b';
    await pool.query(`DROP TABLE IF EXISTS ${firstTable} CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${secondTable} CASCADE`);
    try {
      await pool.query(getDecisioningTaskRegistryBootstrap({ tableName: firstTable, namespace: 'shared-namespace' }));
      await pool.query(getDecisioningTaskRegistryBootstrap({ tableName: secondTable, namespace: 'shared-namespace' }));
      const firstRegistry = createPostgresTaskRegistry({
        pool,
        tableName: firstTable,
        namespace: 'shared-namespace',
        storageId: 'store:physical-a',
      });
      const secondRegistry = createPostgresTaskRegistry({
        pool,
        tableName: secondTable,
        namespace: 'shared-namespace',
        storageId: 'store:physical-b',
      });
      const createOpts = {
        tool: 'create_media_buy',
        accountId: 'same-account',
        ownerScope: 'api_key:same-owner',
        overrideTaskId: 'task_identical_across_stores',
      };
      const firstRef = await firstRegistry.create(createOpts);
      const secondRef = await secondRegistry.create(createOpts);

      assert.deepStrictEqual(await completeScopedTask(secondRegistry, firstRef, { leaked: true }), {
        outcome: 'not_found_in_scope',
      });
      assert.strictEqual((await secondRegistry.getTask(secondRef.taskId, secondRef)).status, 'submitted');
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${firstTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${secondTable} CASCADE`);
    }
  });

  test('concurrent terminal transitions have one applied winner and one terminal replay', async () => {
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const ref = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });
    const outcomes = await Promise.all([
      registry.complete(ref.taskId, ref, { winner: 'a' }),
      registry.fail(ref.taskId, ref, {
        code: 'INVALID_STATE',
        recovery: 'correctable',
        message: 'winner b',
      }),
    ]);
    assert.deepStrictEqual(outcomes.map(value => value.outcome).sort(), ['already_terminal', 'applied']);
  });

  test('fail updates status + error + status_message, then is idempotent', async () => {
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const { taskId } = await registry.create({ tool: 'sync_creatives', accountId: 'acc_1' });

    const error = {
      code: 'GOVERNANCE_DENIED',
      recovery: 'terminal',
      message: 'operator declined the buy',
    };
    const artifact = { errors: [error] };
    await registry.fail(taskId, ACC_1_SCOPE, error, artifact);

    let record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.strictEqual(record.status, 'failed');
    assert.strictEqual(record.error.code, 'GOVERNANCE_DENIED');
    assert.strictEqual(record.error.recovery, 'terminal');
    assert.strictEqual(record.statusMessage, 'operator declined the buy');
    assert.deepStrictEqual(record.result, artifact);

    // Second fail is a no-op
    await registry.fail(taskId, ACC_1_SCOPE, {
      code: 'INVALID_STATE',
      recovery: 'correctable',
      message: 'should not overwrite',
    });

    record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.strictEqual(record.error.code, 'GOVERNANCE_DENIED', 'second fail must be a no-op');
  });

  test('complete after fail is a no-op (terminal-state guard)', async () => {
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    await registry.fail(taskId, ACC_1_SCOPE, {
      code: 'POLICY_VIOLATION',
      recovery: 'terminal',
      message: 'denied',
    });
    await registry.complete(taskId, ACC_1_SCOPE, { media_buy_id: 'mb_should_not_set' });

    const record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.strictEqual(record.status, 'failed', 'complete() after fail() must not change terminal state');
    assert.strictEqual(record.result, undefined);
  });

  test('cross-instance read: registry A creates, registry B reads', async () => {
    // Models the load-balanced deployment scenario: process A allocates the
    // task, process B reads the lifecycle for `tasks/get`.
    const registryA = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const registryB = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });

    const { taskId } = await registryA.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    const recordViaB = await registryB.getTask(taskId, ACC_1_SCOPE);
    assert.ok(recordViaB, 'registry B sees a task created by registry A');
    assert.strictEqual(recordViaB.status, 'submitted');

    await registryA.complete(taskId, ACC_1_SCOPE, { media_buy_id: 'mb_77' });

    const finalViaB = await registryB.getTask(taskId, ACC_1_SCOPE);
    assert.strictEqual(finalViaB.status, 'completed');
    assert.deepStrictEqual(finalViaB.result, { media_buy_id: 'mb_77' });
  });

  test('custom tableName works end-to-end', async () => {
    const customTable = 'custom_decisioning_tasks';
    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
    await pool.query(getDecisioningTaskRegistryBootstrap({ tableName: customTable, namespace: NAMESPACE }));

    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE, tableName: customTable });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    const record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.ok(record);
    assert.strictEqual(record.taskId, taskId);

    await pool.query(`DROP TABLE ${customTable} CASCADE`);
  });

  test('hasWebhook round-trips through create + getTask', async () => {
    // hasWebhook is set when buyer wires push_notification_config.url at
    // dispatch time; surfaced via tasks_get's spec-defined `has_webhook`
    // field. Two records: one with, one without.
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const { taskId: tWithHook } = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      hasWebhook: true,
    });
    const { taskId: tNoHook } = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
    });

    const r1 = await registry.getTask(tWithHook, ACC_1_SCOPE);
    const r2 = await registry.getTask(tNoHook, ACC_1_SCOPE);
    assert.strictEqual(r1.hasWebhook, true);
    assert.strictEqual(r2.hasWebhook, undefined, 'hasWebhook omitted on read when stored false');
  });

  test('list enforces owner_scope and exposes account fallback tasks only to that scope', async () => {
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const { taskId: scoped } = await registry.create({
      tool: 'sync_creatives',
      accountId: 'acc_1',
      ownerScope: 'session:publisher-a',
    });
    const { taskId: otherScoped } = await registry.create({
      tool: 'sync_creatives',
      accountId: 'acc_1',
      ownerScope: 'session:publisher-b',
    });
    const { taskId: accountScoped } = await registry.create({
      tool: 'sync_creatives',
      accountId: 'acc_1',
      overrideTaskId: 'task_account_fallback',
    });

    const publisherA = await registry.list({ accountId: 'acc_1', ownerScope: 'session:publisher-a' });
    assert.deepStrictEqual(
      publisherA.tasks.map(task => task.taskId),
      [scoped]
    );

    const publisherB = await registry.list({ accountId: 'acc_1', ownerScope: 'session:publisher-b' });
    assert.deepStrictEqual(
      publisherB.tasks.map(task => task.taskId),
      [otherScoped]
    );

    const accountFallback = await registry.list({ accountId: 'acc_1', ownerScope: 'account:acc_1' });
    assert.deepStrictEqual(
      accountFallback.tasks.map(task => task.taskId),
      [accountScoped]
    );
  });

  test('migration backfills legacy tasks into the configured namespace', async () => {
    const legacyTable = 'legacy_decisioning_tasks';
    await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
    try {
      await pool.query(`
        CREATE TABLE ${legacyTable} (
          task_id TEXT PRIMARY KEY,
          tool TEXT NOT NULL,
          account_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'submitted',
          status_message TEXT,
          result JSONB,
          error JSONB,
          progress JSONB,
          has_webhook BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT ${legacyTable}_valid_status CHECK (
            status IN ('submitted', 'working', 'completed', 'failed')
          )
        )
      `);
      await pool.query(`INSERT INTO ${legacyTable} (task_id, tool, account_id) VALUES ($1, $2, $3)`, [
        'task_legacy',
        'sync_creatives',
        'acc_legacy',
      ]);

      const upgrade = getDecisioningTaskRegistryScopeV1Upgrade({
        tableName: legacyTable,
        namespace: 'tenant:migrated',
      });
      await pool.query(upgrade.preflightSql);
      await pool.query(upgrade.prepareSql);
      for (const sql of upgrade.concurrentIndexSql) await pool.query(sql);
      await pool.query(upgrade.cutoverSql);
      await pool.query(upgrade.verifySql);
      const { rows: nullScopeRows } = await pool.query(
        `SELECT count(*) AS count FROM ${legacyTable} WHERE registry_namespace IS NULL OR owner_scope IS NULL`
      );
      assert.strictEqual(nullScopeRows[0].count, '0');

      const migrated = createPostgresTaskRegistry({
        pool,
        tableName: legacyTable,
        namespace: 'tenant:migrated',
      });
      const record = await migrated.getTask('task_legacy', {
        accountId: 'acc_legacy',
        ownerScope: 'account:acc_legacy',
      });
      assert.ok(record);

      const first = await migrated.create({
        tool: 'sync_creatives',
        accountId: 'acc_legacy',
        ownerScope: 'api_key:first',
        overrideTaskId: 'task_duplicate_after_upgrade',
      });
      const second = await migrated.create({
        tool: 'sync_creatives',
        accountId: 'acc_legacy',
        ownerScope: 'api_key:second',
        overrideTaskId: 'task_duplicate_after_upgrade',
      });
      assert.deepStrictEqual(await migrated.complete(first.taskId, first, { owner: 'first' }), {
        outcome: 'applied',
      });
      assert.strictEqual((await migrated.getTask(second.taskId, second)).status, 'submitted');

      const otherNamespace = createPostgresTaskRegistry({
        pool,
        tableName: legacyTable,
        namespace: 'tenant:other',
      });
      assert.strictEqual(
        await otherNamespace.getTask('task_legacy', {
          accountId: 'acc_legacy',
          ownerScope: 'account:acc_legacy',
        }),
        null
      );

      await otherNamespace.create({
        tool: 'sync_creatives',
        accountId: first.accountId,
        ownerScope: first.ownerScope,
        overrideTaskId: first.taskId,
      });

      // Every phase converges after valid scoped duplicates and another
      // namespace have been written.
      await pool.query(upgrade.preflightSql);
      await pool.query(upgrade.prepareSql);
      for (const sql of upgrade.concurrentIndexSql) await pool.query(sql);
      await pool.query(upgrade.cutoverSql);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
    }
  });

  test('cutover refuses a valid same-name index with the wrong key definition', async () => {
    const legacyTable = 'legacy_decisioning_tasks_wrong_idx';
    await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
    try {
      await pool.query(`
        CREATE TABLE ${legacyTable} (
          task_id TEXT PRIMARY KEY,
          tool TEXT NOT NULL,
          account_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'submitted',
          status_message TEXT,
          result JSONB,
          error JSONB,
          progress JSONB,
          has_webhook BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`INSERT INTO ${legacyTable} (task_id, tool, account_id) VALUES ('task_wrong_idx', 't', 'acc')`);
      const upgrade = getDecisioningTaskRegistryScopeV1Upgrade({
        tableName: legacyTable,
        namespace: 'tenant:wrong-index-test',
      });
      await pool.query(upgrade.prepareSql);
      await pool.query(`CREATE UNIQUE INDEX ${legacyTable}_scope_pkey ON ${legacyTable}(task_id)`);

      await assert.rejects(pool.query(upgrade.cutoverSql), /wrong definition/);
      const { rows } = await pool.query(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = '${legacyTable}'::regclass AND contype = 'p'
      `);
      assert.match(rows[0].definition, /PRIMARY KEY \(task_id\)/);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
    }
  });

  test('cutover resolves the staged index in the target table schema', async () => {
    const shadowSchema = 'task_registry_shadow_idx';
    const targetSchema = 'task_registry_target_idx';
    const legacyTable = 'schema_scoped_tasks';
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS ${targetSchema} CASCADE`);
      await client.query(`CREATE SCHEMA ${shadowSchema}`);
      await client.query(`CREATE SCHEMA ${targetSchema}`);
      await client.query(`CREATE TABLE ${shadowSchema}.unrelated (id TEXT PRIMARY KEY)`);
      await client.query(`CREATE UNIQUE INDEX ${legacyTable}_scope_pkey ON ${shadowSchema}.unrelated(id)`);
      await client.query(`
        CREATE TABLE ${targetSchema}.${legacyTable} (
          task_id TEXT PRIMARY KEY,
          tool TEXT NOT NULL,
          account_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'submitted',
          status_message TEXT,
          result JSONB,
          error JSONB,
          progress JSONB,
          has_webhook BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`SET search_path = ${shadowSchema}, ${targetSchema}, public`);
      const upgrade = getDecisioningTaskRegistryScopeV1Upgrade({
        tableName: legacyTable,
        namespace: 'tenant:schema-index-test',
      });
      await client.query(upgrade.prepareSql);
      for (const sql of upgrade.concurrentIndexSql) await client.query(sql);
      await client.query(upgrade.cutoverSql);

      const { rows } = await client.query(`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = '${legacyTable}'::regclass AND contype = 'p'
      `);
      assert.match(rows[0].definition, /registry_namespace, account_id, owner_scope, task_id/);
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${shadowSchema} CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS ${targetSchema} CASCADE`);
      client.release();
    }
  });

  test('concurrent upgrade preparation cannot reassign legacy rows between namespaces', async () => {
    const legacyTable = 'legacy_decisioning_tasks_race';
    await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
    try {
      await pool.query(`
        CREATE TABLE ${legacyTable} (
          task_id TEXT PRIMARY KEY,
          tool TEXT NOT NULL,
          account_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'submitted',
          status_message TEXT,
          result JSONB,
          error JSONB,
          progress JSONB,
          has_webhook BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`INSERT INTO ${legacyTable} (task_id, tool, account_id) VALUES ('task_race', 't', 'acc')`);
      const first = getDecisioningTaskRegistryScopeV1Upgrade({
        tableName: legacyTable,
        namespace: 'tenant:first',
      });
      const second = getDecisioningTaskRegistryScopeV1Upgrade({
        tableName: legacyTable,
        namespace: 'tenant:second',
      });

      const attempts = await Promise.allSettled([pool.query(first.prepareSql), pool.query(second.prepareSql)]);
      assert.deepStrictEqual(attempts.map(attempt => attempt.status).sort(), ['fulfilled', 'rejected']);
      const { rows } = await pool.query(`SELECT DISTINCT registry_namespace FROM ${legacyTable}`);
      assert.strictEqual(rows.length, 1);
      assert.ok(['tenant:first', 'tenant:second'].includes(rows[0].registry_namespace));
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
    }
  });

  test('complete() rejects oversized result with descriptive error', async () => {
    // 4MB cap on JSONB column. 5MB string trips assertResultSize before
    // the DB write — protects the Node process from OOM on a malicious
    // adopter return.
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    const oversized = { huge: 'x'.repeat(5 * 1024 * 1024) };
    await assert.rejects(registry.complete(taskId, ACC_1_SCOPE, oversized), /exceeds.*bytes/);

    // Task stays submitted — failed write didn't transition.
    const record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.strictEqual(record.status, 'submitted');
  });

  test('complete() rejects circular-reference result with clear error', async () => {
    // safeStringify wraps JSON.stringify so adopter circular-ref returns
    // surface as a clear "not JSON-serializable" error pointing at the
    // task id, instead of bubbling as a generic registry-write fail.
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    const circular = { name: 'mb_42' };
    circular.self = circular;
    await assert.rejects(
      registry.complete(taskId, ACC_1_SCOPE, circular),
      error => /not JSON-serializable/.test(error.message) && error.cause instanceof Error
    );

    const record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.strictEqual(record.status, 'submitted');
  });
});
