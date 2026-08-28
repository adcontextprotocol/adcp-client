/**
 * Postgres-backed TaskRegistry integration tests.
 *
 * Requires a running PostgreSQL. Skipped when DATABASE_URL is unset:
 *   DATABASE_URL=postgres://localhost/test node --test test/server-decisioning-postgres-task-registry.test.js
 */

process.env.NODE_ENV = 'test';

const { test, describe, before, afterEach, after } = require('node:test');
const assert = require('node:assert');

const DATABASE_URL = process.env.DATABASE_URL;
const TABLE = 'adcp_decisioning_tasks';
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

    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(getDecisioningTaskRegistryBootstrap({ namespace: NAMESPACE }));
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
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
