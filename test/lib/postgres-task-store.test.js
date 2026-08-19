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
    // Most legacy CRUD tests exercise the explicit trusted-worker/single-tenant
    // compatibility mode. Session-isolation tests construct the secure default.
    store = new PostgresTaskStore(pool, { allowUnscopedAccess: true });
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
    assert.ok(MCP_TASKS_MIGRATION.includes('session_id'), 'Migration should scope tasks by MCP session');
    assert.ok(
      MCP_TASKS_MIGRATION.includes('task_id         TEXT PRIMARY KEY'),
      'Task IDs should remain globally unique'
    );
    assert.ok(MCP_TASKS_MIGRATION.includes('adcp_mcp_tasks_valid_status'), 'Constraint should be namespaced to table');
    assert.ok(MCP_TASKS_MIGRATION.includes('idx_adcp_mcp_tasks_expires_at'), 'Index should be namespaced to table');
  });

  test('getMcpTasksMigration generates custom table names', () => {
    const sql = getMcpTasksMigration({ tableName: 'my_tasks' });
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS my_tasks'));
    assert.ok(sql.includes('my_tasks_valid_status'));
    assert.ok(sql.includes('idx_my_tasks_expires_at'));
    assert.ok(sql.includes('idx_my_tasks_session_created_at'));
  });

  test('getMcpTasksMigration upgrades globally-keyed tables without losing legacy tasks', async () => {
    const legacyTable = 'legacy_tasks';
    await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
    await pool.query(`
      CREATE TABLE ${legacyTable} (
        task_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'working',
        ttl INTEGER,
        poll_interval INTEGER NOT NULL DEFAULT 1000,
        status_message TEXT,
        request_id TEXT NOT NULL,
        request JSONB NOT NULL,
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `);
    await pool.query(`INSERT INTO ${legacyTable} (task_id, request_id, request) VALUES ('shared-id', '1', $1::jsonb)`, [
      JSON.stringify(fakeRequest),
    ]);

    try {
      await pool.query(getMcpTasksMigration({ tableName: legacyTable }));
      // The generated migration must also be safe to run repeatedly.
      await pool.query(getMcpTasksMigration({ tableName: legacyTable }));

      const pk = await pool.query(`
        SELECT a.attname
        FROM pg_index i
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON TRUE
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key_column.attnum
        WHERE i.indrelid = '${legacyTable}'::regclass AND i.indisprimary
        ORDER BY key_column.ordinality
      `);
      assert.deepStrictEqual(
        pk.rows.map(row => row.attname),
        ['task_id']
      );

      const legacyStore = new PostgresTaskStore(pool, { tableName: legacyTable, allowUnscopedAccess: true });
      assert.ok(await legacyStore.getTask('shared-id'), 'legacy row should remain addressable by its task ID');
      assert.strictEqual(await legacyStore.getTask('shared-id', 'session-a'), null);
      await assert.rejects(
        () => legacyStore.createTask({ taskId: 'shared-id' }, '2', fakeRequest, 'session-a'),
        /already exists/,
        'MCP task IDs remain globally unique after migration'
      );
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
    }
  });

  test('getMcpTasksMigration rejects invalid table names', () => {
    assert.throws(() => getMcpTasksMigration({ tableName: 'DROP TABLE; --' }), /Invalid table name/);
    assert.throws(() => getMcpTasksMigration({ tableName: '123bad' }), /Invalid table name/);
    assert.throws(() => getMcpTasksMigration({ tableName: 'MixedCase' }), /Invalid table name/);
    assert.doesNotThrow(() => getMcpTasksMigration({ tableName: `t${'x'.repeat(39)}` }));
    assert.throws(() => getMcpTasksMigration({ tableName: `t${'x'.repeat(40)}` }), /at most 40 characters/);
  });

  test('constructor rejects invalid table names', () => {
    assert.throws(() => new PostgresTaskStore(pool, { tableName: 'Robert; DROP TABLE--' }), /Invalid table name/);
  });

  test('custom tableName works end-to-end', async () => {
    const customTable = 'custom_tasks';
    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
    await pool.query(getMcpTasksMigration({ tableName: customTable }));

    const customStore = new PostgresTaskStore(pool, { tableName: customTable, allowUnscopedAccess: true });
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

  test('task CRUD and listing are isolated by MCP session', async () => {
    const secureStore = new PostgresTaskStore(pool);
    await assert.rejects(() => secureStore.createTask({}, '0', fakeRequest), /requires a non-empty MCP session ID/);
    const taskA = await secureStore.createTask({ taskId: 'session-a-task' }, '1', fakeRequest, 'session-a');
    const taskB = await secureStore.createTask({ taskId: 'session-b-task' }, '2', fakeRequest, 'session-b');

    assert.strictEqual(await secureStore.getTask(taskA.taskId, 'session-c'), null);
    assert.strictEqual(await secureStore.getTask(taskB.taskId, 'session-a'), null);
    await secureStore.updateTaskStatus(taskA.taskId, 'input_required', 'session A only', 'session-a');

    assert.strictEqual((await secureStore.getTask(taskA.taskId, 'session-a')).status, 'input_required');
    assert.strictEqual((await secureStore.getTask(taskB.taskId, 'session-b')).status, 'working');
    assert.deepStrictEqual(
      (await secureStore.listTasks(undefined, 'session-a')).tasks.map(task => task.taskId),
      [taskA.taskId]
    );
    assert.deepStrictEqual(
      (await secureStore.listTasks(undefined, 'session-b')).tasks.map(task => task.taskId),
      [taskB.taskId]
    );
    assert.deepStrictEqual((await secureStore.listTasks(undefined, 'session-c')).tasks, []);

    await assert.rejects(
      () => secureStore.storeTaskResult(taskA.taskId, 'completed', { content: [] }, 'session-c'),
      /not found/
    );

    await assert.rejects(() => secureStore.getTask(taskA.taskId), /requires a non-empty MCP session ID/);
    await assert.rejects(
      () => secureStore.storeTaskResult(taskA.taskId, 'completed', { content: [] }),
      /requires a non-empty MCP session ID/
    );

    // A separate trusted worker store can explicitly use task IDs as capabilities.
    const workerStore = new PostgresTaskStore(pool, { allowUnscopedAccess: true });
    await workerStore.storeTaskResult(taskA.taskId, 'completed', { content: [] });
    assert.strictEqual((await workerStore.getTask(taskA.taskId)).status, 'completed');
  });

  test('unscoped access is an explicit single-tenant opt-in and listing excludes owned tasks', async () => {
    const singleTenantStore = new PostgresTaskStore(pool, { allowUnscopedAccess: true });
    const unowned = await singleTenantStore.createTask({}, '1', fakeRequest);
    await singleTenantStore.createTask({}, '2', fakeRequest, 'owned-session');

    assert.deepStrictEqual(
      (await singleTenantStore.listTasks()).tasks.map(task => task.taskId),
      [unowned.taskId]
    );
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
    const sessionId = 'pagination-session';
    const tasks = [];
    for (let i = 0; i < 3; i++) {
      tasks.push(await store.createTask({}, String(i), fakeRequest, sessionId));
    }

    const { tasks: listed } = await store.listTasks(undefined, sessionId);
    assert.strictEqual(listed.length, 3);
    assert.strictEqual(listed[0].taskId, tasks[0].taskId);
    assert.strictEqual(listed[2].taskId, tasks[2].taskId);
  });

  test('listTasks paginates with cursor', async () => {
    const sessionId = 'pagination-session';
    // Create 15 tasks (more than PAGE_SIZE=10)
    const created = [];
    for (let i = 0; i < 15; i++) {
      created.push(await store.createTask({}, String(i), fakeRequest, sessionId));
    }

    const page1 = await store.listTasks(undefined, sessionId);
    assert.strictEqual(page1.tasks.length, 10);
    assert.ok(page1.nextCursor, 'Should have nextCursor');

    const page2 = await store.listTasks(page1.nextCursor, sessionId);
    assert.strictEqual(page2.tasks.length, 5);
    assert.strictEqual(page2.nextCursor, undefined);

    // All 15 unique task IDs across both pages
    const allIds = new Set([...page1.tasks, ...page2.tasks].map(t => t.taskId));
    assert.strictEqual(allIds.size, 15);
  });

  test('listTasks with invalid cursor throws', async () => {
    await assert.rejects(() => store.listTasks('bad-cursor', 'pagination-session'), /Invalid cursor/);
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
    const sessionId = 'expiry-session';
    // Insert expired task
    await pool.query(
      `INSERT INTO ${TABLE} (task_id, session_id, status, ttl, poll_interval, request_id, request, expires_at)
       VALUES ('expired-list-1', $1, 'working', 1, 1000, '1', $2, NOW() - interval '1 second')`,
      [sessionId, JSON.stringify(fakeRequest)]
    );
    // Insert live task
    await store.createTask({ ttl: null }, '2', fakeRequest, sessionId);

    const { tasks } = await store.listTasks(undefined, sessionId);
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

test('PostgresTaskStore rejects invalid timing fields before querying PostgreSQL', async () => {
  const { PostgresTaskStore } = require('../../dist/lib/index.js');
  let queryCalls = 0;
  const store = new PostgresTaskStore(
    {
      query: async () => {
        queryCalls++;
        throw new Error('query should not run');
      },
    },
    { allowUnscopedAccess: true }
  );
  const request = { jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name: 'test' } };

  for (const ttl of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(
      () => store.createTask({ ttl }, '1', request),
      /ttl must be a non-negative PostgreSQL integer/
    );
  }
  for (const pollInterval of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(
      () => store.createTask({ pollInterval }, '1', request),
      /pollInterval must be a non-negative PostgreSQL integer/
    );
  }
  assert.strictEqual(queryCalls, 0);
});

test('PostgresTaskStore redacts database driver errors from every public operation', async () => {
  const { PostgresTaskStore, cleanupExpiredTasks } = require('../../dist/lib/index.js');
  const driverError = Object.assign(new Error('postgres://secret-host/internal_table'), { code: 'XX000' });
  const db = {
    query: async () => {
      throw driverError;
    },
  };
  const store = new PostgresTaskStore(db, { allowUnscopedAccess: true });
  const request = { jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name: 'test' } };
  const operations = [
    () => store.createTask({}, '1', request),
    () => store.getTask('task-1'),
    () => store.storeTaskResult('task-1', 'completed', { content: [] }),
    () => store.getTaskResult('task-1'),
    () => store.updateTaskStatus('task-1', 'cancelled'),
    () => store.listTasks(),
    () => store.cleanupExpired(),
    () => cleanupExpiredTasks(db),
  ];

  for (const operation of operations) {
    await assert.rejects(operation, error => {
      assert.match(error.message, /^PostgresTaskStore\.[A-Za-z]+: database operation failed$/);
      assert.doesNotMatch(error.message, /secret-host|internal_table/);
      assert.strictEqual(error.cause, driverError);
      return true;
    });
  }
});
