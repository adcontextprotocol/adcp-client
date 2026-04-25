/**
 * PostgresTaskStore integration tests.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_URL to run:
 *   DATABASE_URL=postgres://localhost/test node --test test/lib/postgres-task-store.test.js
 *
 * Skipped entirely when DATABASE_URL is not set.
 */

const { test, describe, before, afterEach, after } = require('node:test');
const assert = require('node:assert');

const DATABASE_URL = process.env.DATABASE_URL;

const TABLE = 'adcp_mcp_tasks';

describe('PostgresTaskStore', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let Pool, pool;
  let PostgresTaskStore, MCP_TASKS_MIGRATION, getMcpTasksMigration, cleanupExpiredTasks;
  let store;

  before(async () => {
    Pool = require('pg').Pool;
    pool = new Pool({ connectionString: DATABASE_URL });

    const lib = require('../../dist/lib/index.js');
    PostgresTaskStore = lib.PostgresTaskStore;
    MCP_TASKS_MIGRATION = lib.MCP_TASKS_MIGRATION;
    getMcpTasksMigration = lib.getMcpTasksMigration;
    cleanupExpiredTasks = lib.cleanupExpiredTasks;

    // Fresh table each run for schema safety
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(MCP_TASKS_MIGRATION);
    store = new PostgresTaskStore(pool);
  });

  afterEach(async () => {
    // Clean slate between tests
    await pool.query(`DELETE FROM ${TABLE}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  const fakeRequest = { jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name: 'test' } };

  // ====== TABLE NAMING & CONFIGURATION ======

  test('default table name is adcp_mcp_tasks', () => {
    assert.ok(MCP_TASKS_MIGRATION.includes('adcp_mcp_tasks'), 'Migration should use adcp_mcp_tasks');
    assert.ok(MCP_TASKS_MIGRATION.includes('adcp_mcp_tasks_valid_status'), 'Constraint should be namespaced to table');
    assert.ok(MCP_TASKS_MIGRATION.includes('idx_adcp_mcp_tasks_expires_at'), 'Index should be namespaced to table');
  });

  test('getMcpTasksMigration generates custom table names', () => {
    const sql = getMcpTasksMigration({ tableName: 'my_tasks' });
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS my_tasks'));
    assert.ok(sql.includes('my_tasks_valid_status'));
    assert.ok(sql.includes('idx_my_tasks_expires_at'));
    assert.ok(sql.includes('idx_my_tasks_created_at'));
  });

  test('getMcpTasksMigration rejects invalid table names', () => {
    assert.throws(() => getMcpTasksMigration({ tableName: 'DROP TABLE; --' }), /Invalid table name/);
    assert.throws(() => getMcpTasksMigration({ tableName: '123bad' }), /Invalid table name/);
    assert.throws(() => getMcpTasksMigration({ tableName: 'MixedCase' }), /Invalid table name/);
  });

  test('constructor rejects invalid table names', () => {
    assert.throws(() => new PostgresTaskStore(pool, { tableName: 'Robert; DROP TABLE--' }), /Invalid table name/);
  });

  test('custom tableName works end-to-end', async () => {
    const customTable = 'custom_tasks';
    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
    await pool.query(getMcpTasksMigration({ tableName: customTable }));

    const customStore = new PostgresTaskStore(pool, { tableName: customTable });
    const task = await customStore.createTask({ ttl: 60000 }, '1', fakeRequest);
    assert.ok(task.taskId);

    const fetched = await customStore.getTask(task.taskId);
    assert.strictEqual(fetched.taskId, task.taskId);

    // Default store should NOT see this task
    const fromDefault = await store.getTask(task.taskId);
    assert.strictEqual(fromDefault, null, 'Custom table tasks should not be visible from default store');

    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
  });

  // ====== CORE CRUD ======

  test('createTask returns a valid task with working status', async () => {
    const task = await store.createTask({ ttl: 60000, pollInterval: 2000 }, '1', fakeRequest);

    assert.ok(task.taskId, 'taskId should be set');
    assert.strictEqual(task.status, 'working');
    assert.strictEqual(task.ttl, 60000);
    assert.strictEqual(task.pollInterval, 2000);
    assert.ok(task.createdAt, 'createdAt should be set');
    assert.ok(task.lastUpdatedAt, 'lastUpdatedAt should be set');
  });

  test('createTask with null TTL has no expiry', async () => {
    const task = await store.createTask({ ttl: null }, '1', fakeRequest);

    assert.strictEqual(task.ttl, null);

    // Verify no expires_at in DB
    const { rows } = await pool.query(`SELECT expires_at FROM ${TABLE} WHERE task_id = $1`, [task.taskId]);
    assert.strictEqual(rows[0].expires_at, null);
  });

  test('createTask defaults pollInterval to 1000', async () => {
    const task = await store.createTask({}, '1', fakeRequest);
    assert.strictEqual(task.pollInterval, 1000);
  });

  test('createTask accepts caller-supplied taskId', async () => {
    const suppliedId = 'storyboard-deterministic-id-001';
    const task = await store.createTask({ taskId: suppliedId, ttl: 60000 }, '1', fakeRequest);

    assert.strictEqual(task.taskId, suppliedId);
    assert.strictEqual(task.status, 'working');

    const fetched = await store.getTask(suppliedId);
    assert.strictEqual(fetched.taskId, suppliedId);
  });

  test('createTask throws on duplicate caller-supplied taskId', async () => {
    const suppliedId = 'duplicate-id-test';
    await store.createTask({ taskId: suppliedId }, '1', fakeRequest);

    await assert.rejects(() => store.createTask({ taskId: suppliedId }, '2', fakeRequest), /already exists/);
  });

  test('createTask with no taskId generates a random id each call', async () => {
    const t1 = await store.createTask({}, '1', fakeRequest);
    const t2 = await store.createTask({}, '2', fakeRequest);
    assert.notStrictEqual(t1.taskId, t2.taskId);
  });

  test('createTask rejects empty-string taskId', async () => {
    await assert.rejects(() => store.createTask({ taskId: '' }, '1', fakeRequest), /non-empty string/);
  });

  test('createTask rejects taskId longer than 128 characters', async () => {
    const tooLong = 'x'.repeat(129);
    await assert.rejects(() => store.createTask({ taskId: tooLong }, '1', fakeRequest), /128 characters or fewer/);
  });

  test('createTask accepts taskId at the 128-character boundary', async () => {
    const boundary = 'x'.repeat(128);
    const task = await store.createTask({ taskId: boundary }, '1', fakeRequest);
    assert.strictEqual(task.taskId, boundary);
  });

  test('getTask returns created task', async () => {
    const created = await store.createTask({ ttl: 60000 }, '1', fakeRequest);
    const fetched = await store.getTask(created.taskId);

    assert.strictEqual(fetched.taskId, created.taskId);
    assert.strictEqual(fetched.status, 'working');
  });

  test('getTask returns null for nonexistent task', async () => {
    const result = await store.getTask('nonexistent-id');
    assert.strictEqual(result, null);
  });

  test('storeTaskResult sets status and result', async () => {
    const task = await store.createTask({ ttl: 60000 }, '1', fakeRequest);

    const result = {
      content: [{ type: 'text', text: 'Done' }],
      structuredContent: { id: 'mb-1' },
    };
    await store.storeTaskResult(task.taskId, 'completed', result);

    const fetched = await store.getTask(task.taskId);
    assert.strictEqual(fetched.status, 'completed');

    const fetchedResult = await store.getTaskResult(task.taskId);
    assert.deepStrictEqual(fetchedResult.structuredContent, { id: 'mb-1' });
  });

  test('storeTaskResult throws for nonexistent task', async () => {
    await assert.rejects(() => store.storeTaskResult('no-such-task', 'completed', { content: [] }), /not found/);
  });

  test('storeTaskResult throws for already-terminal task', async () => {
    const task = await store.createTask({ ttl: 60000 }, '1', fakeRequest);
    await store.storeTaskResult(task.taskId, 'completed', { content: [] });

    await assert.rejects(() => store.storeTaskResult(task.taskId, 'failed', { content: [] }), /terminal status/);
  });

  test('getTaskResult throws when no result stored', async () => {
    const task = await store.createTask({ ttl: 60000 }, '1', fakeRequest);

    await assert.rejects(() => store.getTaskResult(task.taskId), /no result stored/);
  });

  test('getTaskResult throws for nonexistent task', async () => {
    await assert.rejects(() => store.getTaskResult('no-such-task'), /not found/);
  });

  test('updateTaskStatus transitions from working to input_required', async () => {
    const task = await store.createTask({}, '1', fakeRequest);
    await store.updateTaskStatus(task.taskId, 'input_required', 'Need more info');

    const fetched = await store.getTask(task.taskId);
    assert.strictEqual(fetched.status, 'input_required');
    assert.strictEqual(fetched.statusMessage, 'Need more info');
  });

  test('updateTaskStatus throws for nonexistent task', async () => {
    await assert.rejects(() => store.updateTaskStatus('no-such-task', 'cancelled'), /not found/);
  });

  test('updateTaskStatus throws when transitioning from terminal state', async () => {
    const task = await store.createTask({}, '1', fakeRequest);
    await store.storeTaskResult(task.taskId, 'completed', { content: [] });

    await assert.rejects(() => store.updateTaskStatus(task.taskId, 'working'), /terminal status/);
  });

  // ====== PAGINATION ======

  test('listTasks returns tasks ordered by creation time', async () => {
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      tasks.push(await store.createTask({}, String(i), fakeRequest));
    }

    const { tasks: listed } = await store.listTasks();
    assert.strictEqual(listed.length, 3);
    assert.strictEqual(listed[0].taskId, tasks[0].taskId);
    assert.strictEqual(listed[2].taskId, tasks[2].taskId);
  });

  test('listTasks paginates with cursor', async () => {
    // Create 15 tasks (more than PAGE_SIZE=10)
    const created = [];
    for (let i = 0; i < 15; i++) {
      created.push(await store.createTask({}, String(i), fakeRequest));
    }

    const page1 = await store.listTasks();
    assert.strictEqual(page1.tasks.length, 10);
    assert.ok(page1.nextCursor, 'Should have nextCursor');

    const page2 = await store.listTasks(page1.nextCursor);
    assert.strictEqual(page2.tasks.length, 5);
    assert.strictEqual(page2.nextCursor, undefined);

    // All 15 unique task IDs across both pages
    const allIds = new Set([...page1.tasks, ...page2.tasks].map(t => t.taskId));
    assert.strictEqual(allIds.size, 15);
  });

  test('listTasks with invalid cursor throws', async () => {
    await assert.rejects(() => store.listTasks('bad-cursor'), /Invalid cursor/);
  });

  // ====== EXPIRATION ======

  test('expired tasks are invisible to getTask', async () => {
    // Insert a task with expires_at in the past
    const taskId = 'expired-task-1';
    await pool.query(
      `INSERT INTO ${TABLE} (task_id, status, ttl, poll_interval, request_id, request, expires_at)
       VALUES ($1, 'working', 1, 1000, '1', $2, NOW() - interval '1 second')`,
      [taskId, JSON.stringify(fakeRequest)]
    );

    const result = await store.getTask(taskId);
    assert.strictEqual(result, null, 'Expired task should be invisible');
  });

  test('expired tasks are invisible to listTasks', async () => {
    // Insert expired task
    await pool.query(
      `INSERT INTO ${TABLE} (task_id, status, ttl, poll_interval, request_id, request, expires_at)
       VALUES ('expired-list-1', 'working', 1, 1000, '1', $1, NOW() - interval '1 second')`,
      [JSON.stringify(fakeRequest)]
    );
    // Insert live task
    await store.createTask({ ttl: null }, '2', fakeRequest);

    const { tasks } = await store.listTasks();
    assert.strictEqual(tasks.length, 1, 'Only live task should be listed');
  });

  test('cleanupExpiredTasks deletes expired rows', async () => {
    // Insert expired task
    await pool.query(
      `INSERT INTO ${TABLE} (task_id, status, ttl, poll_interval, request_id, request, expires_at)
       VALUES ('cleanup-1', 'completed', 1, 1000, '1', $1, NOW() - interval '1 second')`,
      [JSON.stringify(fakeRequest)]
    );
    // Insert live task
    await store.createTask({ ttl: null }, '2', fakeRequest);

    const deleted = await cleanupExpiredTasks(pool);
    assert.strictEqual(deleted, 1);

    // Verify only live task remains
    const { rows } = await pool.query(`SELECT count(*)::int as cnt FROM ${TABLE}`);
    assert.strictEqual(rows[0].cnt, 1);
  });

  test('cleanupExpired instance method works', async () => {
    // Insert expired task
    await pool.query(
      `INSERT INTO ${TABLE} (task_id, status, ttl, poll_interval, request_id, request, expires_at)
       VALUES ('cleanup-inst-1', 'completed', 1, 1000, '1', $1, NOW() - interval '1 second')`,
      [JSON.stringify(fakeRequest)]
    );

    const deleted = await store.cleanupExpired();
    assert.strictEqual(deleted, 1);
  });

  test('storeTaskResult resets expires_at from NOW()', async () => {
    const task = await store.createTask({ ttl: 60000 }, '1', fakeRequest);

    // Get original expires_at
    const { rows: before } = await pool.query(`SELECT expires_at FROM ${TABLE} WHERE task_id = $1`, [task.taskId]);

    // Small delay to ensure time advances
    await new Promise(r => setTimeout(r, 50));

    await store.storeTaskResult(task.taskId, 'completed', { content: [] });

    const { rows: after } = await pool.query(`SELECT expires_at FROM ${TABLE} WHERE task_id = $1`, [task.taskId]);

    assert.ok(
      new Date(after[0].expires_at) > new Date(before[0].expires_at),
      'expires_at should be reset to a later time after storeTaskResult'
    );
  });

  test('cleanup() is a no-op and does not throw', () => {
    store.cleanup();
  });

  test('updateTaskStatus to cancelled resets expires_at', async () => {
    const task = await store.createTask({ ttl: 60000 }, '1', fakeRequest);

    const { rows: before } = await pool.query(`SELECT expires_at FROM ${TABLE} WHERE task_id = $1`, [task.taskId]);

    await new Promise(r => setTimeout(r, 50));
    await store.updateTaskStatus(task.taskId, 'cancelled');

    const fetched = await store.getTask(task.taskId);
    assert.strictEqual(fetched.status, 'cancelled');

    const { rows: after } = await pool.query(`SELECT expires_at FROM ${TABLE} WHERE task_id = $1`, [task.taskId]);
    assert.ok(
      new Date(after[0].expires_at) > new Date(before[0].expires_at),
      'expires_at should be reset after cancellation'
    );
  });

  test('getTaskResult throws for expired task', async () => {
    // Insert expired task with a result
    await pool.query(
      `INSERT INTO ${TABLE} (task_id, status, ttl, poll_interval, request_id, request, result, expires_at)
       VALUES ('expired-result-1', 'completed', 1, 1000, '1', $1, $2, NOW() - interval '1 second')`,
      [JSON.stringify(fakeRequest), JSON.stringify({ content: [{ type: 'text', text: 'Done' }] })]
    );

    await assert.rejects(() => store.getTaskResult('expired-result-1'), /not found/);
  });

  test('storeTaskResult throws for expired task', async () => {
    // Insert expired working task
    await pool.query(
      `INSERT INTO ${TABLE} (task_id, status, ttl, poll_interval, request_id, request, expires_at)
       VALUES ('expired-store-1', 'working', 1, 1000, '1', $1, NOW() - interval '1 second')`,
      [JSON.stringify(fakeRequest)]
    );

    await assert.rejects(() => store.storeTaskResult('expired-store-1', 'completed', { content: [] }), /not found/);
  });
});
