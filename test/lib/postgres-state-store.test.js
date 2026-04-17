/**
 * PostgresStateStore integration tests — focused on CAS semantics that
 * InMemoryStateStore can't cover (real concurrent clients, affected-row counts
 * on UPDATE, ADD COLUMN IF NOT EXISTS upgrade path).
 *
 * Requires a running PostgreSQL instance. Set DATABASE_URL to run:
 *   DATABASE_URL=postgres://localhost/test node --test test/lib/postgres-state-store.test.js
 *
 * Skipped entirely when DATABASE_URL is not set.
 */

const { test, describe, before, afterEach, after } = require('node:test');
const assert = require('node:assert');

const DATABASE_URL = process.env.DATABASE_URL;
const TABLE = 'adcp_state';

describe('PostgresStateStore', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let Pool, pool;
  let PostgresStateStore, ADCP_STATE_MIGRATION, getAdcpStateMigration;
  let patchWithRetry, PatchConflictError;
  let store;

  before(async () => {
    Pool = require('pg').Pool;
    pool = new Pool({ connectionString: DATABASE_URL });

    const lib = require('../../dist/lib/index.js');
    const server = require('../../dist/lib/server/index.js');
    PostgresStateStore = lib.PostgresStateStore;
    ADCP_STATE_MIGRATION = lib.ADCP_STATE_MIGRATION;
    getAdcpStateMigration = lib.getAdcpStateMigration;
    patchWithRetry = server.patchWithRetry;
    PatchConflictError = server.PatchConflictError;

    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(ADCP_STATE_MIGRATION);
    store = new PostgresStateStore(pool);
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  // ====== VERSION COLUMN ======

  test('first put lands at version=1', async () => {
    await store.put('col', 'x', { v: 1 });
    const { rows } = await pool.query(`SELECT version FROM ${TABLE} WHERE collection = 'col' AND id = 'x'`);
    assert.strictEqual(rows[0].version, 1);
  });

  test('put bumps version on conflict', async () => {
    await store.put('col', 'x', { v: 1 });
    await store.put('col', 'x', { v: 2 });
    await store.put('col', 'x', { v: 3 });
    const result = await store.getWithVersion('col', 'x');
    assert.strictEqual(result.version, 3);
    assert.deepStrictEqual(result.data, { v: 3 });
  });

  test('patch bumps version same as put', async () => {
    await store.put('col', 'x', { v: 1 });
    await store.patch('col', 'x', { extra: true });
    const result = await store.getWithVersion('col', 'x');
    assert.strictEqual(result.version, 2);
    assert.deepStrictEqual(result.data, { v: 1, extra: true });
  });

  // ====== putIfMatch CAS ======

  test('putIfMatch(null) inserts when row is missing', async () => {
    const result = await store.putIfMatch('col', 'x', { v: 1 }, null);
    assert.deepStrictEqual(result, { ok: true, version: 1 });
  });

  test('putIfMatch(null) conflicts when row exists; reports currentVersion', async () => {
    await store.put('col', 'x', { v: 1 });
    await store.put('col', 'x', { v: 2 });
    const result = await store.putIfMatch('col', 'x', { v: 99 }, null);
    assert.deepStrictEqual(result, { ok: false, currentVersion: 2 });
  });

  test('putIfMatch(version) succeeds when version matches, bumps and returns new version', async () => {
    await store.put('col', 'x', { v: 1 });
    const result = await store.putIfMatch('col', 'x', { v: 2 }, 1);
    assert.deepStrictEqual(result, { ok: true, version: 2 });
    assert.deepStrictEqual(await store.get('col', 'x'), { v: 2 });
  });

  test('putIfMatch(stale) conflicts; row unchanged', async () => {
    await store.put('col', 'x', { v: 1 });
    await store.put('col', 'x', { v: 2 });
    const result = await store.putIfMatch('col', 'x', { v: 99 }, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.currentVersion, 2);
    assert.deepStrictEqual(await store.get('col', 'x'), { v: 2 });
  });

  test('putIfMatch(version) against missing row reports currentVersion=null', async () => {
    const result = await store.putIfMatch('col', 'x', { v: 1 }, 5);
    assert.deepStrictEqual(result, { ok: false, currentVersion: null });
  });

  // ====== REAL CONCURRENT CLIENTS ======

  test('two concurrent null-expected inserts: exactly one wins', async () => {
    // Use two separate clients so the inserts truly race at the DB.
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const s1 = new PostgresStateStore({ query: (sql, params) => c1.query(sql, params) });
      const s2 = new PostgresStateStore({ query: (sql, params) => c2.query(sql, params) });

      const [r1, r2] = await Promise.all([
        s1.putIfMatch('col', 'x', { winner: 'A' }, null),
        s2.putIfMatch('col', 'x', { winner: 'B' }, null),
      ]);

      const wins = [r1, r2].filter(r => r.ok);
      const losses = [r1, r2].filter(r => !r.ok);
      assert.strictEqual(wins.length, 1, 'exactly one inserter should win');
      assert.strictEqual(losses.length, 1);
      assert.strictEqual(losses[0].currentVersion, 1, 'loser should see version=1');
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('two concurrent version-matched updates: first wins, second sees bumped version', async () => {
    await store.put('col', 'x', { count: 0 });

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const s1 = new PostgresStateStore({ query: (sql, params) => c1.query(sql, params) });
      const s2 = new PostgresStateStore({ query: (sql, params) => c2.query(sql, params) });

      const [r1, r2] = await Promise.all([
        s1.putIfMatch('col', 'x', { count: 1 }, 1),
        s2.putIfMatch('col', 'x', { count: 2 }, 1),
      ]);

      const wins = [r1, r2].filter(r => r.ok);
      const losses = [r1, r2].filter(r => !r.ok);
      assert.strictEqual(wins.length, 1, 'exactly one CAS should win');
      assert.strictEqual(losses.length, 1);
      assert.strictEqual(wins[0].version, 2);
      assert.strictEqual(losses[0].currentVersion, 2);
    } finally {
      c1.release();
      c2.release();
    }
  });

  // ====== patchWithRetry over Postgres ======

  test('patchWithRetry: 50 concurrent increments all land', async () => {
    await store.put('counters', 'c', { value: 0 });

    // 50 concurrent patchWithRetry calls all incrementing the same counter.
    // If CAS is correct, final value is exactly 50. If it's racy, we lose writes.
    const concurrency = 50;
    await Promise.all(
      Array.from({ length: concurrency }, () =>
        patchWithRetry(
          store,
          'counters',
          'c',
          current => ({
            value: (current?.value ?? 0) + 1,
          }),
          { maxAttempts: 100, backoffMs: () => 0 }
        )
      )
    );

    const final = await store.get('counters', 'c');
    assert.strictEqual(final.value, concurrency, `expected ${concurrency} increments; got ${final.value}`);
  });

  test('patchWithRetry: deleted-during-retry throws by default', async () => {
    await store.put('col', 'x', { v: 1 });

    let callCount = 0;
    await assert.rejects(
      () =>
        patchWithRetry(
          store,
          'col',
          'x',
          async current => {
            callCount += 1;
            if (callCount === 1) {
              await store.delete('col', 'x');
            }
            return { v: (current?.v ?? 0) + 1 };
          },
          { backoffMs: () => 0 }
        ),
      err => err instanceof PatchConflictError && err.reason === 'deleted_during_retry'
    );
  });

  // ====== MIGRATION IDEMPOTENCY ======

  test('getAdcpStateMigration is idempotent (re-running is a no-op)', async () => {
    await pool.query(ADCP_STATE_MIGRATION);
    await pool.query(ADCP_STATE_MIGRATION);
    await pool.query(ADCP_STATE_MIGRATION);
    // If any run errored (e.g. CREATE TABLE without IF NOT EXISTS), we'd have thrown.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'version'`,
      [TABLE]
    );
    assert.strictEqual(rows.length, 1, 'version column present after repeated migration runs');
  });

  test('ADD COLUMN IF NOT EXISTS upgrades pre-version tables without rewriting data', async () => {
    // Simulate a legacy table created before the version column existed.
    const legacyTable = 'legacy_state';
    await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
    await pool.query(`
      CREATE TABLE ${legacyTable} (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (collection, id)
      )
    `);
    await pool.query(`INSERT INTO ${legacyTable} (collection, id, data) VALUES ('c', 'x', '{"legacy": true}')`);

    // Now run the current migration — should add `version` without touching the row.
    await pool.query(getAdcpStateMigration(legacyTable));

    const legacyStore = new PostgresStateStore(pool, { tableName: legacyTable });
    const result = await legacyStore.getWithVersion('c', 'x');
    assert.deepStrictEqual(result.data, { legacy: true });
    assert.strictEqual(result.version, 1, 'pre-existing rows default to version=1');

    await pool.query(`DROP TABLE IF EXISTS ${legacyTable} CASCADE`);
  });
});
