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

describe('getDecisioningTaskRegistryMigration', () => {
  test('Postgres registry requires an explicit trusted namespace', () => {
    const { createPostgresTaskRegistry } = require('../dist/lib/server/decisioning');
    const pool = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
    };
    assert.throws(() => createPostgresTaskRegistry({ pool }), /Invalid registry namespace/);
  });

  test('backfills owner_scope and migrates to a composite task identity', () => {
    const { getDecisioningTaskRegistryMigration } = require('../dist/lib/server/decisioning');
    const sql = getDecisioningTaskRegistryMigration({ namespace: NAMESPACE });
    const addColumn = sql.indexOf('ADD COLUMN IF NOT EXISTS owner_scope TEXT');
    const ownerIndex = sql.indexOf('idx_adcp_decisioning_tasks_owner_account');
    assert.ok(addColumn >= 0, 'migration should add owner_scope for existing tables');
    assert.ok(ownerIndex > addColumn, 'owner_scope index must be created after the column exists');
    assert.ok(sql.includes("SET owner_scope = 'account:' || account_id"), 'legacy rows get account fallback scope');
    assert.ok(sql.includes("SET registry_namespace = 'test'"), 'legacy rows get the configured registry namespace');
    assert.ok(sql.includes('ALTER COLUMN owner_scope SET NOT NULL'));
    assert.ok(sql.includes('PRIMARY KEY (registry_namespace, account_id, owner_scope, task_id)'));
    assert.ok(sql.includes("pg_advisory_xact_lock(hashtext('adcp-task-registry:"));
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
    const registry = createPostgresTaskRegistry({ pool, namespace: NAMESPACE });

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
    }
  });
});

describe('createPostgresTaskRegistry', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let Pool, pool;
  let createPostgresTaskRegistry, getDecisioningTaskRegistryMigration;

  before(async () => {
    Pool = require('pg').Pool;
    pool = new Pool({ connectionString: DATABASE_URL });

    const lib = require('../dist/lib/server/decisioning');
    createPostgresTaskRegistry = lib.createPostgresTaskRegistry;
    getDecisioningTaskRegistryMigration = lib.getDecisioningTaskRegistryMigration;

    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(getDecisioningTaskRegistryMigration({ namespace: NAMESPACE }));
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  test('migration generates the expected table + indexes', () => {
    const sql = getDecisioningTaskRegistryMigration({ namespace: NAMESPACE });
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS adcp_decisioning_tasks'));
    assert.ok(sql.includes('adcp_decisioning_tasks_valid_status'));
    assert.ok(sql.includes('idx_adcp_decisioning_tasks_account_id'));
    assert.ok(sql.includes('idx_adcp_decisioning_tasks_status_created'));
  });

  test('migration rejects invalid table names', () => {
    assert.throws(
      () => getDecisioningTaskRegistryMigration({ tableName: 'DROP TABLE; --', namespace: NAMESPACE }),
      /Invalid table name/
    );
    assert.throws(
      () => getDecisioningTaskRegistryMigration({ tableName: '1bad', namespace: NAMESPACE }),
      /Invalid table name/
    );
    assert.throws(
      () => getDecisioningTaskRegistryMigration({ tableName: 'MixedCase', namespace: NAMESPACE }),
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

    await registry.complete(taskId, ACC_1_SCOPE, { media_buy_id: 'mb_42', status: 'active' });

    let record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.strictEqual(record.status, 'completed');
    assert.deepStrictEqual(record.result, { media_buy_id: 'mb_42', status: 'active' });

    // Subsequent complete() is a no-op (terminal-state guard via SQL WHERE)
    await registry.complete(taskId, ACC_1_SCOPE, { media_buy_id: 'mb_99', status: 'paused' });

    record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.deepStrictEqual(
      record.result,
      { media_buy_id: 'mb_42', status: 'active' },
      'second complete must be a no-op'
    );
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
    await pool.query(getDecisioningTaskRegistryMigration({ tableName: customTable, namespace: NAMESPACE }));

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

      await pool.query(getDecisioningTaskRegistryMigration({ tableName: legacyTable, namespace: 'tenant:migrated' }));

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
    await assert.rejects(registry.complete(taskId, ACC_1_SCOPE, circular), /not JSON-serializable/);

    const record = await registry.getTask(taskId, ACC_1_SCOPE);
    assert.strictEqual(record.status, 'submitted');
  });
});
