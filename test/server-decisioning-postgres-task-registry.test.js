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
    await pool.query(getDecisioningTaskRegistryMigration());
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  test('migration generates the expected table + indexes', () => {
    const sql = getDecisioningTaskRegistryMigration();
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS adcp_decisioning_tasks'));
    assert.ok(sql.includes('adcp_decisioning_tasks_valid_status'));
    assert.ok(sql.includes('idx_adcp_decisioning_tasks_account_id'));
    assert.ok(sql.includes('idx_adcp_decisioning_tasks_status_created'));
  });

  test('migration rejects invalid table names', () => {
    assert.throws(() => getDecisioningTaskRegistryMigration({ tableName: 'DROP TABLE; --' }), /Invalid table name/);
    assert.throws(() => getDecisioningTaskRegistryMigration({ tableName: '1bad' }), /Invalid table name/);
    assert.throws(() => getDecisioningTaskRegistryMigration({ tableName: 'MixedCase' }), /Invalid table name/);
  });

  test('factory rejects invalid table names', () => {
    assert.throws(() => createPostgresTaskRegistry({ pool, tableName: 'Robert; DROP TABLE--' }), /Invalid table name/);
  });

  test('create + getTask roundtrips a submitted task', async () => {
    const registry = createPostgresTaskRegistry({ pool });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });
    assert.ok(taskId.startsWith('task_'));


    const record = await registry.getTask(taskId);
    assert.ok(record);
    assert.strictEqual(record.taskId, taskId);
    assert.strictEqual(record.tool, 'create_media_buy');
    assert.strictEqual(record.accountId, 'acc_1');
    assert.strictEqual(record.status, 'submitted');
    assert.ok(typeof record.createdAt === 'string');
    assert.ok(typeof record.updatedAt === 'string');
  });

  test('getTask returns null for unknown task_id', async () => {
    const registry = createPostgresTaskRegistry({ pool });
    const record = await registry.getTask('task_unknown');
    assert.strictEqual(record, null);
  });

  test('complete updates status + result, then is idempotent', async () => {
    const registry = createPostgresTaskRegistry({ pool });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    await registry.complete(taskId, { media_buy_id: 'mb_42', status: 'active' });

    let record = await registry.getTask(taskId);
    assert.strictEqual(record.status, 'completed');
    assert.deepStrictEqual(record.result, { media_buy_id: 'mb_42', status: 'active' });

    // Subsequent complete() is a no-op (terminal-state guard via SQL WHERE)
    await registry.complete(taskId, { media_buy_id: 'mb_99', status: 'paused' });

    record = await registry.getTask(taskId);
    assert.deepStrictEqual(record.result, { media_buy_id: 'mb_42', status: 'active' }, 'second complete must be a no-op');
  });

  test('fail updates status + error + status_message, then is idempotent', async () => {
    const registry = createPostgresTaskRegistry({ pool });
    const { taskId } = await registry.create({ tool: 'sync_creatives', accountId: 'acc_1' });

    await registry.fail(taskId, {
      code: 'GOVERNANCE_DENIED',
      recovery: 'terminal',
      message: 'operator declined the buy',
    });

    let record = await registry.getTask(taskId);
    assert.strictEqual(record.status, 'failed');
    assert.strictEqual(record.error.code, 'GOVERNANCE_DENIED');
    assert.strictEqual(record.error.recovery, 'terminal');
    assert.strictEqual(record.statusMessage, 'operator declined the buy');

    // Second fail is a no-op
    await registry.fail(taskId, { code: 'INVALID_STATE', recovery: 'correctable', message: 'should not overwrite' });

    record = await registry.getTask(taskId);
    assert.strictEqual(record.error.code, 'GOVERNANCE_DENIED', 'second fail must be a no-op');
  });

  test('complete after fail is a no-op (terminal-state guard)', async () => {
    const registry = createPostgresTaskRegistry({ pool });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    await registry.fail(taskId, { code: 'POLICY_VIOLATION', recovery: 'terminal', message: 'denied' });
    await registry.complete(taskId, { media_buy_id: 'mb_should_not_set' });

    const record = await registry.getTask(taskId);
    assert.strictEqual(record.status, 'failed', 'complete() after fail() must not change terminal state');
    assert.strictEqual(record.result, undefined);
  });

  test('cross-instance read: registry A creates, registry B reads', async () => {
    // Models the load-balanced deployment scenario: process A allocates the
    // task, process B reads the lifecycle for `tasks/get`.
    const registryA = createPostgresTaskRegistry({ pool });
    const registryB = createPostgresTaskRegistry({ pool });

    const { taskId } = await registryA.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    const recordViaB = await registryB.getTask(taskId);
    assert.ok(recordViaB, 'registry B sees a task created by registry A');
    assert.strictEqual(recordViaB.status, 'submitted');

    await registryA.complete(taskId, { media_buy_id: 'mb_77' });

    const finalViaB = await registryB.getTask(taskId);
    assert.strictEqual(finalViaB.status, 'completed');
    assert.deepStrictEqual(finalViaB.result, { media_buy_id: 'mb_77' });
  });

  test('custom tableName works end-to-end', async () => {
    const customTable = 'custom_decisioning_tasks';
    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
    await pool.query(getDecisioningTaskRegistryMigration({ tableName: customTable }));

    const registry = createPostgresTaskRegistry({ pool, tableName: customTable });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    const record = await registry.getTask(taskId);
    assert.ok(record);
    assert.strictEqual(record.taskId, taskId);

    await pool.query(`DROP TABLE ${customTable} CASCADE`);
  });

  test('hasWebhook round-trips through create + getTask', async () => {
    // hasWebhook is set when buyer wires push_notification_config.url at
    // dispatch time; surfaced via tasks_get's spec-defined `has_webhook`
    // field. Two records: one with, one without.
    const registry = createPostgresTaskRegistry({ pool });
    const { taskId: tWithHook } = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
      hasWebhook: true,
    });
    const { taskId: tNoHook } = await registry.create({
      tool: 'create_media_buy',
      accountId: 'acc_1',
    });

    const r1 = await registry.getTask(tWithHook);
    const r2 = await registry.getTask(tNoHook);
    assert.strictEqual(r1.hasWebhook, true);
    assert.strictEqual(r2.hasWebhook, undefined, 'hasWebhook omitted on read when stored false');
  });

  test('complete() rejects oversized result with descriptive error', async () => {
    // 4MB cap on JSONB column. 5MB string trips assertResultSize before
    // the DB write — protects the Node process from OOM on a malicious
    // adopter return.
    const registry = createPostgresTaskRegistry({ pool });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    const oversized = { huge: 'x'.repeat(5 * 1024 * 1024) };
    await assert.rejects(
      registry.complete(taskId, oversized),
      /exceeds.*bytes/
    );

    // Task stays submitted — failed write didn't transition.
    const record = await registry.getTask(taskId);
    assert.strictEqual(record.status, 'submitted');
  });

  test('complete() rejects circular-reference result with clear error', async () => {
    // safeStringify wraps JSON.stringify so adopter circular-ref returns
    // surface as a clear "not JSON-serializable" error pointing at the
    // task id, instead of bubbling as a generic registry-write fail.
    const registry = createPostgresTaskRegistry({ pool });
    const { taskId } = await registry.create({ tool: 'create_media_buy', accountId: 'acc_1' });

    const circular = { name: 'mb_42' };
    circular.self = circular;
    await assert.rejects(
      registry.complete(taskId, circular),
      /not JSON-serializable/
    );

    const record = await registry.getTask(taskId);
    assert.strictEqual(record.status, 'submitted');
  });
});
