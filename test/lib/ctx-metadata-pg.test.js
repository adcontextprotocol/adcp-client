/**
 * Postgres ctx-metadata backend integration tests.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_URL to run:
 *   DATABASE_URL=postgres://localhost/test node --test test/lib/ctx-metadata-pg.test.js
 *
 * Skipped entirely when DATABASE_URL is not set.
 *
 * The headline coverage here is the `resource`-field round-trip,
 * which was missing from the pre-7.9 pg backend (it dropped the field
 * on read AND on write, while the Redis sibling preserved it — a real
 * cross-backend parity bug surfaced by DX review on PR #1858).
 */

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const DATABASE_URL = process.env.DATABASE_URL;
const TABLE = 'adcp_ctx_metadata';

describe('pgCtxMetadataStore', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let Pool, pool;
  let pgCtxMetadataStore, getCtxMetadataMigration, CTX_METADATA_MIGRATION, cleanupExpiredCtxMetadata;

  before(async () => {
    Pool = require('pg').Pool;
    pool = new Pool({ connectionString: DATABASE_URL });

    const server = require('../../dist/lib/server/index.js');
    pgCtxMetadataStore = server.pgCtxMetadataStore;
    getCtxMetadataMigration = server.getCtxMetadataMigration;
    CTX_METADATA_MIGRATION = server.CTX_METADATA_MIGRATION;
    cleanupExpiredCtxMetadata = server.cleanupExpiredCtxMetadata;

    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(CTX_METADATA_MIGRATION);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  // ────────── migration ──────────

  test('default migration creates the resource column', async () => {
    const result = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'resource'`,
      [TABLE]
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].data_type, 'jsonb');
  });

  test('migration is idempotent (ALTER TABLE ADD COLUMN IF NOT EXISTS)', async () => {
    // Re-running on an existing table must not throw.
    await pool.query(CTX_METADATA_MIGRATION);
    await pool.query(CTX_METADATA_MIGRATION);
  });

  test('migration upgrades an older table that pre-dated the resource column', async () => {
    const upgradeTable = 'ctx_metadata_upgrade_test';
    await pool.query(`DROP TABLE IF EXISTS ${upgradeTable} CASCADE`);
    // Simulate a deployment running the pre-7.9 migration.
    await pool.query(
      `CREATE TABLE ${upgradeTable} (
         scoped_key  TEXT PRIMARY KEY,
         value       JSONB NOT NULL,
         expires_at  TIMESTAMPTZ,
         created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    // Run the current migration — should add the resource column.
    await pool.query(getCtxMetadataMigration({ tableName: upgradeTable }));
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'resource'`,
      [upgradeTable]
    );
    assert.equal(result.rows.length, 1, 'resource column must be added on upgrade');
    await pool.query(`DROP TABLE IF EXISTS ${upgradeTable} CASCADE`);
  });

  // ────────── startup probe ──────────

  test('probe succeeds when required columns exist', async () => {
    const backend = pgCtxMetadataStore(pool);
    await backend.probe();
  });

  test('probe fails closed when an older table is missing the resource column', async () => {
    const oldTable = 'ctx_metadata_probe_old';
    await pool.query(`DROP TABLE IF EXISTS ${oldTable} CASCADE`);
    await pool.query(
      `CREATE TABLE ${oldTable} (
         scoped_key  TEXT PRIMARY KEY,
         value       JSONB NOT NULL,
         expires_at  TIMESTAMPTZ,
         created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    const backend = pgCtxMetadataStore(pool, { tableName: oldTable });
    await assert.rejects(
      () => backend.probe(),
      err => {
        assert.match(err.message, /ctx_metadata backend probe failed/);
        assert.match(err.message, /create or upgrade/);
        assert.ok(err.cause, 'raw pg error should be attached as Error.cause');
        assert.ok(!err.message.includes('column "resource"'), 'raw pg error must not be in public message');
        return true;
      }
    );
    await pool.query(`DROP TABLE IF EXISTS ${oldTable} CASCADE`);
  });

  // ────────── resource round-trip (the headline coverage) ──────────

  test('put + get round-trips the resource field', async () => {
    const backend = pgCtxMetadataStore(pool);
    const entry = {
      value: { upstream_id: 'gam_42' },
      resource: { product_id: 'p1', name: 'Display 300x250', price_cpm: 5.5 },
    };
    await backend.put('aproductp1', entry);
    const got = await backend.get('aproductp1');
    assert.deepEqual(got.value, entry.value);
    assert.deepEqual(got.resource, entry.resource, 'resource MUST survive the pg round-trip');
  });

  test('bulkGet round-trips the resource field', async () => {
    const backend = pgCtxMetadataStore(pool);
    await backend.put('aproductp1', {
      value: { upstream: 'gam_1' },
      resource: { product_id: 'p1' },
    });
    await backend.put('aproductp2', {
      value: { upstream: 'gam_2' },
      resource: { product_id: 'p2', name: 'Premium' },
    });
    const got = await backend.bulkGet(['aproductp1', 'aproductp2']);
    assert.equal(got.size, 2);
    assert.deepEqual(got.get('aproductp1').resource, { product_id: 'p1' });
    assert.deepEqual(got.get('aproductp2').resource, { product_id: 'p2', name: 'Premium' });
  });

  test('entry without resource omits the field on read (matches memory + Redis backends)', async () => {
    const backend = pgCtxMetadataStore(pool);
    await backend.put('aproductno_res', { value: { only: 'value' } });
    const got = await backend.get('aproductno_res');
    assert.deepEqual(got, { value: { only: 'value' } }, 'no resource → field absent, not undefined');
    assert.ok(!('resource' in got), 'resource key must not appear in the returned entry');
  });

  test('put overwrites resource on conflict', async () => {
    const backend = pgCtxMetadataStore(pool);
    await backend.put('aproductp1', {
      value: { v: 1 },
      resource: { product_id: 'p1', version: 'first' },
    });
    await backend.put('aproductp1', {
      value: { v: 2 },
      resource: { product_id: 'p1', version: 'second' },
    });
    const got = await backend.get('aproductp1');
    assert.equal(got.value.v, 2);
    assert.equal(got.resource.version, 'second');
  });

  test('put can clear a previously-set resource by writing without it', async () => {
    const backend = pgCtxMetadataStore(pool);
    await backend.put('aproductp1', {
      value: { v: 1 },
      resource: { product_id: 'p1' },
    });
    // Second write omits resource entirely.
    await backend.put('aproductp1', { value: { v: 2 } });
    const got = await backend.get('aproductp1');
    assert.equal(got.value.v, 2);
    assert.ok(!('resource' in got), 'resource must be cleared, not retained from prior write');
  });

  // ────────── value + expiry primitives ──────────

  test('get returns null for missing key', async () => {
    const backend = pgCtxMetadataStore(pool);
    assert.equal(await backend.get('missing'), null);
  });

  test('expires_at round-trips as unix epoch seconds', async () => {
    const backend = pgCtxMetadataStore(pool);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('aproductexp', {
      value: { v: 1 },
      resource: { product_id: 'exp' },
      expiresAt,
    });
    const got = await backend.get('aproductexp');
    assert.equal(got.expiresAt, expiresAt);
  });

  test('delete removes the entry', async () => {
    const backend = pgCtxMetadataStore(pool);
    await backend.put('aproductdel', { value: {}, resource: {} });
    await backend.delete('aproductdel');
    assert.equal(await backend.get('aproductdel'), null);
  });

  test('round-trips nested structures and unicode in resource', async () => {
    const backend = pgCtxMetadataStore(pool);
    const resource = {
      product_id: 'mb_日本',
      name: 'café',
      tags: ['a', 'b', null],
      nested: { deep: { value: 5000.5 } },
    };
    await backend.put('aproductunicode', { value: {}, resource });
    const got = await backend.get('aproductunicode');
    assert.deepEqual(got.resource, resource);
  });

  // ────────── cleanup helper ──────────

  test('cleanupExpiredCtxMetadata removes expired rows', async () => {
    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, value, resource, expires_at) VALUES
         ('e1', '{}'::jsonb, NULL, TO_TIMESTAMP($1)),
         ('e2', '{}'::jsonb, '{"r": 2}'::jsonb, TO_TIMESTAMP($1)),
         ('live', '{}'::jsonb, NULL, TO_TIMESTAMP($2))`,
      [now - 3600, now + 3600]
    );
    const deleted = await cleanupExpiredCtxMetadata(pool);
    assert.equal(deleted, 2);
    const remaining = await pool.query(`SELECT scoped_key FROM ${TABLE} ORDER BY scoped_key`);
    assert.deepEqual(
      remaining.rows.map(r => r.scoped_key),
      ['live']
    );
  });
});
