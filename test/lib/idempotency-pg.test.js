/**
 * Postgres idempotency backend integration tests.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_URL to run:
 *   DATABASE_URL=postgres://localhost/test node --test test/lib/idempotency-pg.test.js
 *
 * Skipped entirely when DATABASE_URL is not set.
 */

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const DATABASE_URL = process.env.DATABASE_URL;

const TABLE = 'adcp_idempotency';

describe('pgBackend', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let Pool, pool;
  let pgBackend, getIdempotencyMigration, IDEMPOTENCY_MIGRATION, cleanupExpiredIdempotency;
  let createIdempotencyStore, hashPayload;

  before(async () => {
    Pool = require('pg').Pool;
    pool = new Pool({ connectionString: DATABASE_URL });

    const server = require('../../dist/lib/server/index.js');
    pgBackend = server.pgBackend;
    getIdempotencyMigration = server.getIdempotencyMigration;
    IDEMPOTENCY_MIGRATION = server.IDEMPOTENCY_MIGRATION;
    cleanupExpiredIdempotency = server.cleanupExpiredIdempotency;
    createIdempotencyStore = server.createIdempotencyStore;
    hashPayload = server.hashPayload;

    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(IDEMPOTENCY_MIGRATION);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  // ────────── migration helpers ──────────

  test('default table name is adcp_idempotency', () => {
    assert.ok(IDEMPOTENCY_MIGRATION.includes('adcp_idempotency'));
    assert.ok(IDEMPOTENCY_MIGRATION.includes('idx_adcp_idempotency_expires_at'));
  });

  test('getIdempotencyMigration generates custom table names', () => {
    const sql = getIdempotencyMigration({ tableName: 'my_idem' });
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS "my_idem"'));
    assert.ok(sql.includes('idx_my_idem_expires_at'));
  });

  test('getIdempotencyMigration rejects invalid identifiers', () => {
    assert.throws(() => getIdempotencyMigration({ tableName: 'DROP TABLE; --' }), /Invalid SQL identifier/);
    assert.throws(() => getIdempotencyMigration({ tableName: '123bad' }), /Invalid SQL identifier/);
    assert.throws(() => getIdempotencyMigration({ tableName: 'MixedCase' }), /Invalid SQL identifier/);
  });

  test('pgBackend constructor rejects invalid table names', () => {
    assert.throws(() => pgBackend(pool, { tableName: 'Robert; DROP TABLE--' }), /Invalid SQL identifier/);
  });

  // ────────── backend primitives ──────────

  test('get returns null for missing key', async () => {
    const backend = pgBackend(pool);
    const result = await backend.get('missing-key');
    assert.equal(result, null);
  });

  test('put + get round-trip with JSONB response', async () => {
    const backend = pgBackend(pool);
    const entry = {
      payloadHash: 'deadbeef',
      response: { media_buy_id: 'mb_42', packages: [{ id: 'p1' }] },
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    await backend.put('p\u001fk', entry);
    const got = await backend.get('p\u001fk');
    assert.deepEqual(got.response, entry.response);
    assert.equal(got.payloadHash, entry.payloadHash);
    assert.equal(got.expiresAt, entry.expiresAt);
  });

  test('put overwrites existing entry (ON CONFLICT DO UPDATE)', async () => {
    const backend = pgBackend(pool);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    await backend.put('p\u001fk', { payloadHash: 'h1', response: { v: 1 }, expiresAt });
    await backend.put('p\u001fk', { payloadHash: 'h2', response: { v: 2 }, expiresAt });

    const got = await backend.get('p\u001fk');
    assert.equal(got.payloadHash, 'h2');
    assert.deepEqual(got.response, { v: 2 });
  });

  test('putIfAbsent returns true on fresh key', async () => {
    const backend = pgBackend(pool);
    const claimed = await backend.putIfAbsent('p\u001fk', {
      payloadHash: 'h1',
      response: null,
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    assert.equal(claimed, true);
  });

  test('putIfAbsent returns false when an unexpired entry exists', async () => {
    const backend = pgBackend(pool);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('p\u001fk', { payloadHash: 'h1', response: { v: 1 }, expiresAt });

    const claimed = await backend.putIfAbsent('p\u001fk', {
      payloadHash: 'h2',
      response: { v: 2 },
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    assert.equal(claimed, false);

    // Original row is untouched
    const got = await backend.get('p\u001fk');
    assert.equal(got.payloadHash, 'h1');
    assert.deepEqual(got.response, { v: 1 });
  });

  test('putIfAbsent reclaims an expired entry', async () => {
    const backend = pgBackend(pool);
    // Manually insert an expired row
    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at) VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4))`,
      ['p\u001fk', 'stale', JSON.stringify({ stale: true }), Math.floor(Date.now() / 1000) - 120]
    );

    const claimed = await backend.putIfAbsent('p\u001fk', {
      payloadHash: 'fresh',
      response: { fresh: true },
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    assert.equal(claimed, true);

    const got = await backend.get('p\u001fk');
    assert.equal(got.payloadHash, 'fresh');
    assert.deepEqual(got.response, { fresh: true });
  });

  test('concurrent putIfAbsent — only one caller wins the claim', async () => {
    const backend = pgBackend(pool);
    const entry = {
      payloadHash: 'claim',
      response: null,
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => backend.putIfAbsent('p\u001frace', entry)));
    const winners = results.filter(x => x === true);
    assert.equal(winners.length, 1, 'exactly one concurrent putIfAbsent must win');
  });

  test('delete removes the entry', async () => {
    const backend = pgBackend(pool);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('p\u001fk', { payloadHash: 'h', response: {}, expiresAt });
    await backend.delete('p\u001fk');
    assert.equal(await backend.get('p\u001fk'), null);
  });

  // ────────── store + backend end-to-end ──────────

  test('store check/save round-trip works against real pg', async () => {
    const store = createIdempotencyStore({ backend: pgBackend(pool), ttlSeconds: 3600 });
    const payload = { budget: 5000, tags: ['a', 'b'] };

    const miss = await store.check({ principal: 'p', key: 'e2e_key_abcdefghij', payload });
    assert.equal(miss.kind, 'miss');

    await store.save({
      principal: 'p',
      key: 'e2e_key_abcdefghij',
      payloadHash: miss.payloadHash,
      response: { media_buy_id: 'mb_77' },
    });

    const replay = await store.check({ principal: 'p', key: 'e2e_key_abcdefghij', payload });
    assert.equal(replay.kind, 'replay');
    assert.deepEqual(replay.response, { media_buy_id: 'mb_77' });
  });

  test('store returns conflict on same-key different-payload', async () => {
    const store = createIdempotencyStore({ backend: pgBackend(pool), ttlSeconds: 3600 });
    const { payloadHash } = await store.check({
      principal: 'p',
      key: 'conflict_key_abcdefg',
      payload: { a: 1 },
    });
    await store.save({
      principal: 'p',
      key: 'conflict_key_abcdefg',
      payloadHash,
      response: { ok: true },
    });

    const conflict = await store.check({
      principal: 'p',
      key: 'conflict_key_abcdefg',
      payload: { a: 2 },
    });
    assert.equal(conflict.kind, 'conflict');
  });

  test('store returns expired when expires_at is past TTL + skew', async () => {
    const backend = pgBackend(pool);
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 60 });

    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at) VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4))`,
      ['p\u001fexp', 'h', JSON.stringify({}), Math.floor(Date.now() / 1000) - 120]
    );

    const result = await store.check({ principal: 'p', key: 'exp', payload: {} });
    assert.equal(result.kind, 'expired');
  });

  // ────────── cleanup helper ──────────

  test('cleanupExpiredIdempotency removes expired rows', async () => {
    const now = Math.floor(Date.now() / 1000);

    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at)
       VALUES
         ('e1', 'h', '{}'::jsonb, TO_TIMESTAMP($1)),
         ('e2', 'h', '{}'::jsonb, TO_TIMESTAMP($1)),
         ('live', 'h', '{}'::jsonb, TO_TIMESTAMP($2))`,
      [now - 3600, now + 3600]
    );

    const deleted = await cleanupExpiredIdempotency(pool);
    assert.equal(deleted, 2);

    const remaining = await pool.query(`SELECT scoped_key FROM ${TABLE} ORDER BY scoped_key`);
    assert.deepEqual(
      remaining.rows.map(r => r.scoped_key),
      ['live']
    );
  });

  test('cleanupExpiredIdempotency respects custom table names', async () => {
    const customTable = 'custom_idem';
    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
    await pool.query(getIdempotencyMigration({ tableName: customTable }));

    await pool.query(
      `INSERT INTO ${customTable} (scoped_key, payload_hash, response, expires_at)
       VALUES ('stale', 'h', '{}'::jsonb, TO_TIMESTAMP($1))`,
      [Math.floor(Date.now() / 1000) - 3600]
    );

    const deleted = await cleanupExpiredIdempotency(pool, { tableName: customTable });
    assert.equal(deleted, 1);

    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
  });

  // ────────── JSONB edge cases ──────────

  test('round-trips nested structures and unicode via JSONB', async () => {
    const backend = pgBackend(pool);
    const response = {
      media_buy_id: 'mb_日本',
      packages: [
        { name: 'café', price: 5000.5 },
        { name: 'tag\\with\\slashes', nested: { deep: ['a', 'b', null] } },
      ],
    };
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('p\u001fjson', { payloadHash: 'h', response, expiresAt });
    const got = await backend.get('p\u001fjson');
    assert.deepEqual(got.response, response);
  });
});
