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

test('pgBackend keeps an entry live through its exact expiry second', async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const { pgBackend } = require('../../dist/lib/server/index.js');
  const claimed = await pgBackend(pool).putIfAbsent('boundary-key', {
    payloadHash: 'new-owner',
    response: null,
    expiresAt: Math.floor(Date.now() / 1000) + 120,
  });
  assert.equal(claimed, false);
  assert.match(queries[0].sql, /expires_at < DATE_TRUNC\('second', NOW\(\)\)/);
});

test('cleanupExpiredIdempotency prunes by the physical retention horizon', async () => {
  const queries = [];
  const pool = {
    query: async sql => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };
  const { cleanupExpiredIdempotency } = require('../../dist/lib/server/index.js');
  await cleanupExpiredIdempotency(pool);
  assert.match(queries[0], /retain_until IS NULL/);
  assert.match(queries[0], /retain_until IS NOT NULL/);
  assert.match(queries[0], /expires_at < DATE_TRUNC\('second', NOW\(\)\) - INTERVAL '120 seconds'/);
});

test('pgBackend couples legacy physical retention to the configured store skew', () => {
  const { createIdempotencyStore, pgBackend } = require('../../dist/lib/server/index.js');
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.throws(
    () => createIdempotencyStore({ backend: pgBackend(pool), clockSkewSeconds: 121 }),
    /legacy retention grace \(120s\) must be at least clockSkewSeconds \(121s\)/
  );
  assert.doesNotThrow(() =>
    createIdempotencyStore({
      backend: pgBackend(pool, { legacyRetentionGraceSeconds: 600 }),
      clockSkewSeconds: 600,
    })
  );
});

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
    assert.ok(IDEMPOTENCY_MIGRATION.includes('idx_adcp_idempotency_retain_until'));
    assert.ok(IDEMPOTENCY_MIGRATION.includes('ON "adcp_idempotency"(retain_until, expires_at)'));
    assert.ok(!IDEMPOTENCY_MIGRATION.includes('UPDATE'));
    assert.ok(!IDEMPOTENCY_MIGRATION.includes('retain_until SET NOT NULL'));
  });

  test('getIdempotencyMigration generates custom table names', () => {
    const sql = getIdempotencyMigration({ tableName: 'my_idem' });
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS "my_idem"'));
    assert.ok(sql.includes('idx_my_idem_retain_until'));
  });

  test('getIdempotencyMigration rejects invalid identifiers', () => {
    assert.throws(() => getIdempotencyMigration({ tableName: 'DROP TABLE; --' }), /Invalid SQL identifier/);
    assert.throws(() => getIdempotencyMigration({ tableName: '123bad' }), /Invalid SQL identifier/);
    assert.throws(() => getIdempotencyMigration({ tableName: 'MixedCase' }), /Invalid SQL identifier/);
    assert.doesNotThrow(() => getIdempotencyMigration({ tableName: `t${'x'.repeat(45)}` }));
    assert.throws(() => getIdempotencyMigration({ tableName: `t${'x'.repeat(46)}` }), /at most 46 characters/);
    const longestValid = `t${'x'.repeat(45)}`;
    assert.match(getIdempotencyMigration({ tableName: longestValid }), new RegExp(`idx_${longestValid}_retain_until`));
  });

  test('pgBackend constructor rejects invalid table names', () => {
    assert.throws(() => pgBackend(pool, { tableName: 'Robert; DROP TABLE--' }), /Invalid SQL identifier/);
  });

  test('distinct per-agent tables isolate identical scoped keys', async () => {
    const agentATable = 'agent_a_idempotency';
    const agentBTable = 'agent_b_idempotency';
    await pool.query(`DROP TABLE IF EXISTS ${agentATable}, ${agentBTable} CASCADE`);
    await pool.query(getIdempotencyMigration({ tableName: agentATable }));
    await pool.query(getIdempotencyMigration({ tableName: agentBTable }));

    try {
      const agentA = pgBackend(pool, { tableName: agentATable });
      const agentB = pgBackend(pool, { tableName: agentBTable });
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await agentA.put('same-principal-and-key', {
        payloadHash: 'agent-a',
        response: { agent: 'a' },
        expiresAt,
      });
      await agentB.put('same-principal-and-key', {
        payloadHash: 'agent-b',
        response: { agent: 'b' },
        expiresAt,
      });

      assert.deepEqual((await agentA.get('same-principal-and-key')).response, { agent: 'a' });
      assert.deepEqual((await agentB.get('same-principal-and-key')).response, { agent: 'b' });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${agentATable}, ${agentBTable} CASCADE`);
    }
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
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at, retain_until)
       VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4), TO_TIMESTAMP($4))`,
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
      claimToken: miss.claimToken,
      response: { media_buy_id: 'mb_77' },
    });

    const replay = await store.check({ principal: 'p', key: 'e2e_key_abcdefghij', payload });
    assert.equal(replay.kind, 'replay');
    assert.deepEqual(replay.response, { media_buy_id: 'mb_77' });
  });

  test('store returns conflict on same-key different-payload', async () => {
    const store = createIdempotencyStore({ backend: pgBackend(pool), ttlSeconds: 3600 });
    const { payloadHash, claimToken } = await store.check({
      principal: 'p',
      key: 'conflict_key_abcdefg',
      payload: { a: 1 },
    });
    await store.save({
      principal: 'p',
      key: 'conflict_key_abcdefg',
      payloadHash,
      claimToken,
      response: { ok: true },
    });

    const conflict = await store.check({
      principal: 'p',
      key: 'conflict_key_abcdefg',
      payload: { a: 2 },
    });
    assert.equal(conflict.kind, 'conflict');
  });

  test('store refuses stale-owner save and release after a pg claim is reclaimed', async () => {
    const backend = pgBackend(pool);
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600 });
    const key = 'stale_pg_owner_abcdef';
    const payload = { a: 1 };
    const stale = await store.check({ principal: 'p', key, payload });
    assert.equal(stale.kind, 'miss');
    await backend.delete(`p\u001f${key}`);
    const current = await store.check({ principal: 'p', key, payload });
    assert.equal(current.kind, 'miss');

    await assert.rejects(
      store.save({
        principal: 'p',
        key,
        payloadHash: stale.payloadHash,
        claimToken: stale.claimToken,
        response: 'stale',
      }),
      /claim is no longer owned/
    );
    await assert.rejects(
      store.release({ principal: 'p', key, claimToken: stale.claimToken }),
      /claim is no longer owned/
    );
    await store.save({
      principal: 'p',
      key,
      payloadHash: current.payloadHash,
      claimToken: current.claimToken,
      response: 'current',
    });
    assert.equal((await store.check({ principal: 'p', key, payload })).response, 'current');
  });

  test('store returns expired when expires_at is past TTL + skew', async () => {
    const backend = pgBackend(pool);
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 60 });

    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at, retain_until)
       VALUES ($1, $2, $3::jsonb, TO_TIMESTAMP($4), TO_TIMESTAMP($5))`,
      ['p\u001fexp', 'h', JSON.stringify({}), Math.floor(Date.now() / 1000) - 120, Math.floor(Date.now() / 1000) + 60]
    );

    const result = await store.check({ principal: 'p', key: 'exp', payload: {} });
    assert.equal(result.kind, 'expired');
  });

  // ────────── cleanup helper ──────────

  test('cleanupExpiredIdempotency removes expired rows', async () => {
    const now = Math.floor(Date.now() / 1000);

    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at, retain_until)
       VALUES
         ('e1', 'h', '{}'::jsonb, TO_TIMESTAMP($1), TO_TIMESTAMP($1)),
         ('e2', 'h', '{}'::jsonb, TO_TIMESTAMP($1), TO_TIMESTAMP($1)),
         ('within-skew', 'h', '{}'::jsonb, TO_TIMESTAMP($1), TO_TIMESTAMP($2)),
         ('live', 'h', '{}'::jsonb, TO_TIMESTAMP($2), TO_TIMESTAMP($2))`,
      [now - 3600, now + 3600]
    );
    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at)
       VALUES ('legacy-within-skew', 'h', '{}'::jsonb, TO_TIMESTAMP($1))`,
      [now - 60]
    );

    const deleted = await cleanupExpiredIdempotency(pool);
    assert.equal(deleted, 2);

    const remaining = await pool.query(`SELECT scoped_key FROM ${TABLE} ORDER BY scoped_key`);
    assert.deepEqual(
      remaining.rows.map(r => r.scoped_key),
      ['legacy-within-skew', 'live', 'within-skew']
    );
  });

  test('cleanupExpiredIdempotency respects custom table names', async () => {
    const customTable = 'custom_idem';
    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
    await pool.query(getIdempotencyMigration({ tableName: customTable }));

    await pool.query(
      `INSERT INTO ${customTable} (scoped_key, payload_hash, response, expires_at, retain_until)
       VALUES ('stale', 'h', '{}'::jsonb, TO_TIMESTAMP($1), TO_TIMESTAMP($1))`,
      [Math.floor(Date.now() / 1000) - 3600]
    );

    const deleted = await cleanupExpiredIdempotency(pool, { tableName: customTable });
    assert.equal(deleted, 1);

    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
  });

  test('cleanup preserves a row whose expiry was advanced by an old writer', async () => {
    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at, retain_until)
       VALUES ('rolling-old-writer', 'old', '{}'::jsonb, TO_TIMESTAMP($1), TO_TIMESTAMP($1))`,
      [now - 3600]
    );
    // Pre-retainUntil binaries update the original columns only. The stale,
    // non-null retain_until must not override the newly live expires_at.
    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at)
       VALUES ('rolling-old-writer', 'new', '{}'::jsonb, TO_TIMESTAMP($1))
       ON CONFLICT (scoped_key) DO UPDATE SET
         payload_hash = EXCLUDED.payload_hash,
         response = EXCLUDED.response,
         expires_at = EXCLUDED.expires_at`,
      [now + 3600]
    );

    await cleanupExpiredIdempotency(pool);
    const remaining = await pool.query(`SELECT payload_hash FROM ${TABLE} WHERE scoped_key = 'rolling-old-writer'`);
    assert.equal(remaining.rowCount, 1);
    assert.equal(remaining.rows[0].payload_hash, 'new');
  });

  test('custom legacy grace preserves null rows through a skew above 120 seconds', async () => {
    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      `INSERT INTO ${TABLE} (scoped_key, payload_hash, response, expires_at)
       VALUES ('legacy-large-skew', 'h', '{}'::jsonb, TO_TIMESTAMP($1))`,
      [now - 300]
    );

    const deleted = await cleanupExpiredIdempotency(pool, { legacyRetentionGraceSeconds: 600 });
    assert.equal(deleted, 0);
    const entry = await pgBackend(pool, { legacyRetentionGraceSeconds: 600 }).get('legacy-large-skew');
    assert.equal(entry.retainUntil, now + 300);
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

test('pgBackend probe sanitizes database errors and preserves the original cause', async () => {
  const { pgBackend } = require('../../dist/lib/server/index.js');
  const databaseError = new Error('connect ECONNREFUSED 10.0.0.7 password=hunter2');
  const backend = pgBackend({
    query: async () => {
      throw databaseError;
    },
  });

  await assert.rejects(backend.probe(), error => {
    assert.match(error.message, /idempotency backend probe failed/);
    assert.doesNotMatch(error.message, /ECONNREFUSED|10\.0\.0\.7|hunter2/);
    assert.strictEqual(error.cause, databaseError);
    return true;
  });
});

test('pgBackend probe verifies the retain_until migration is installed', async () => {
  const { pgBackend } = require('../../dist/lib/server/index.js');
  let observedSql;
  const backend = pgBackend({
    query: async sql => {
      observedSql = sql;
      return { rows: [], rowCount: 0 };
    },
  });
  await backend.probe();
  assert.match(observedSql, /retain_until/);
  assert.match(observedSql, /expires_at/);
});

test('pgBackend redacts driver errors from every runtime operation', async () => {
  const { pgBackend, cleanupExpiredIdempotency } = require('../../dist/lib/server/index.js');
  const driverError = new Error('postgres://secret-host/internal_idempotency_table');
  const db = {
    query: async () => {
      throw driverError;
    },
  };
  const backend = pgBackend(db);
  const entry = { payloadHash: 'hash', response: {}, expiresAt: 1_700_000_000 };
  const operations = [
    () => backend.get('scoped-key'),
    () => backend.put('scoped-key', entry),
    () => backend.putIfAbsent('scoped-key', entry),
    () => backend.delete('scoped-key'),
    () => cleanupExpiredIdempotency(db),
  ];

  for (const operation of operations) {
    await assert.rejects(operation, error => {
      assert.match(error.message, /^pgBackend\.[A-Za-z]+: database operation failed$/);
      assert.doesNotMatch(error.message, /secret-host|internal_idempotency_table/);
      assert.strictEqual(error.cause, driverError);
      return true;
    });
  }
});
