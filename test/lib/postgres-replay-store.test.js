/**
 * PostgresReplayStore integration tests.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_URL to run:
 *   DATABASE_URL=postgres://localhost/test node --test test/lib/postgres-replay-store.test.js
 *
 * Skipped entirely when DATABASE_URL is not set.
 */

const { test, describe, before, afterEach, after } = require('node:test');
const assert = require('node:assert');

const DATABASE_URL = process.env.DATABASE_URL;

const TABLE = 'adcp_replay_cache';

describe('PostgresReplayStore', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let Pool, pool;
  let PostgresReplayStore, getReplayStoreMigration, sweepExpiredReplays;

  before(async () => {
    Pool = require('pg').Pool;
    pool = new Pool({ connectionString: DATABASE_URL });

    const lib = require('../../dist/lib/signing/server.js');
    PostgresReplayStore = lib.PostgresReplayStore;
    getReplayStoreMigration = lib.getReplayStoreMigration;
    sweepExpiredReplays = lib.sweepExpiredReplays;

    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.query(getReplayStoreMigration());
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  // ====== Migration / configuration ======

  test('default migration creates the canonical schema', () => {
    const sql = getReplayStoreMigration();
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS adcp_replay_cache'));
    assert.ok(sql.includes('PRIMARY KEY (keyid, scope, nonce)'));
    assert.ok(sql.includes('idx_adcp_replay_cache_expires_at'));
    assert.ok(sql.includes('idx_adcp_replay_cache_keyid_scope_active'));
    assert.ok(sql.includes('adcp_replay_cache_insert_guarded'));
    assert.ok(sql.includes("ERRCODE = 'AD001'"));
    assert.ok(sql.includes('pg_try_advisory_xact_lock'));
  });

  test('custom table name flows through migration and queries', async () => {
    const customTable = 'custom_replay';
    await pool.query(`DROP TABLE IF EXISTS ${customTable} CASCADE`);
    await pool.query(getReplayStoreMigration(customTable));

    const customStore = new PostgresReplayStore(pool, { tableName: customTable });
    const now = 1_700_000_000;
    const result = await customStore.insert('kid-A', 'https://x/op', 'n1', 60, now);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(await customStore.has('kid-A', 'https://x/op', 'n1', now), true);

    await pool.query(`DROP TABLE ${customTable}`);
  });

  test('rejects SQL-injection-shaped table names', () => {
    assert.throws(() => getReplayStoreMigration('DROP TABLE; --'), /Invalid table name/);
    assert.throws(() => new PostgresReplayStore(pool, { tableName: 'Mixed' }), /Invalid table name/);
    assert.throws(() => new PostgresReplayStore(pool, { tableName: '1bad' }), /Invalid table name/);
    assert.doesNotThrow(() => getReplayStoreMigration(`t${'x'.repeat(39)}`));
    assert.throws(() => getReplayStoreMigration(`t${'x'.repeat(40)}`), /at most 40 characters/);
  });

  test('rejects invalid caps', () => {
    for (const cap of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new PostgresReplayStore(pool, { cap }), /cap must be a positive safe integer/);
    }
    assert.doesNotThrow(() => new PostgresReplayStore(pool, { cap: Number.MAX_SAFE_INTEGER }));
  });

  // ====== Core insert / has / replay-vs-rate_abuse ======

  test('insert returns ok the first time and replayed the second time for the same nonce', async () => {
    const store = new PostgresReplayStore(pool);
    const now = 1_700_000_100;

    const first = await store.insert('kid-A', 'https://seller/op1', 'nonce-1', 60, now);
    assert.strictEqual(first, 'ok');

    const second = await store.insert('kid-A', 'https://seller/op1', 'nonce-1', 60, now);
    assert.strictEqual(second, 'replayed');

    assert.strictEqual(await store.has('kid-A', 'https://seller/op1', 'nonce-1', now), true);
  });

  test('partitions storage by (keyid, scope) — same nonce on different scope is not a replay', async () => {
    const store = new PostgresReplayStore(pool);
    const now = 1_700_000_200;

    assert.strictEqual(await store.insert('kid-A', 'https://seller/op1', 'shared', 60, now), 'ok');
    assert.strictEqual(await store.insert('kid-A', 'https://seller/op2', 'shared', 60, now), 'ok');
    assert.strictEqual(await store.insert('kid-B', 'https://seller/op1', 'shared', 60, now), 'ok');
  });

  test('expired entries are not seen by has() — TTL boundary respected', async () => {
    const store = new PostgresReplayStore(pool);
    const now = 1_700_000_300;

    await store.insert('kid-A', 'https://seller/op', 'n1', 30, now);
    assert.strictEqual(await store.has('kid-A', 'https://seller/op', 'n1', now + 10), true);
    assert.strictEqual(await store.has('kid-A', 'https://seller/op', 'n1', now + 60), false);
  });

  test('insert returns ok for a previously-expired same-nonce — TTL bounds replay protection', async () => {
    const store = new PostgresReplayStore(pool);
    const now = 1_700_000_400;

    await store.insert('kid-A', 'https://seller/op', 'recycled', 30, now);
    // After expiry the same nonce can be inserted again — replay protection
    // is bounded by the signature's expiry, matching InMemoryReplayStore.
    const second = await store.insert('kid-A', 'https://seller/op', 'recycled', 30, now + 60);
    assert.strictEqual(second, 'ok');
  });

  test('rate_abuse fires once cap is hit; existing nonces still report replayed (precedence)', async () => {
    const store = new PostgresReplayStore(pool, { cap: 3 });
    const now = 1_700_000_500;

    assert.strictEqual(await store.insert('kid-A', 'https://seller/op', 'n1', 60, now), 'ok');
    assert.strictEqual(await store.insert('kid-A', 'https://seller/op', 'n2', 60, now), 'ok');
    assert.strictEqual(await store.insert('kid-A', 'https://seller/op', 'n3', 60, now), 'ok');

    // At cap. New nonce → rate_abuse.
    assert.strictEqual(await store.insert('kid-A', 'https://seller/op', 'n4', 60, now), 'rate_abuse');

    // Replay of an existing nonce — replay wins over rate_abuse.
    assert.strictEqual(await store.insert('kid-A', 'https://seller/op', 'n2', 60, now), 'replayed');
  });

  test('cap clears once entries pass expiry — no sweeper required', async () => {
    // The invariant: every store query filters `expires_at > now`, so an
    // expired-but-not-yet-swept entry doesn't count toward the cap. This
    // matches InMemoryReplayStore's prune-then-check semantics. Locking
    // this in a test so a future schema change can't quietly regress it.
    const store = new PostgresReplayStore(pool, { cap: 2 });
    const now = 1_700_000_550;

    await store.insert('kid-A', 'https://seller/op', 'a', 30, now);
    await store.insert('kid-A', 'https://seller/op', 'b', 30, now);
    assert.strictEqual(await store.isCapHit('kid-A', 'https://seller/op', now), true);

    // Advance past expiry — without running the sweeper.
    assert.strictEqual(await store.isCapHit('kid-A', 'https://seller/op', now + 60), false);

    // A fresh insert should now succeed (cap is no longer hit).
    const after = await store.insert('kid-A', 'https://seller/op', 'c', 30, now + 60);
    assert.strictEqual(after, 'ok');
  });

  test('concurrent recycle of an expired same-nonce — exactly one ok, others replayed', async () => {
    // Variant of the same-nonce concurrency test, but this time the row
    // already exists and is expired. Both the InMemory and Postgres stores
    // must serialize the recycle so only one caller observes the fresh
    // registration.
    const store = new PostgresReplayStore(pool);
    const now = 1_700_000_650;

    await store.insert('kid-A', 'https://seller/op', 'recycle-race', 30, now);

    // 10 concurrent attempts to register the same nonce, all at a time
    // past the original entry's expiry.
    const recycleAt = now + 60;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.insert('kid-A', 'https://seller/op', 'recycle-race', 30, recycleAt))
    );

    const okCount = results.filter(r => r === 'ok').length;
    const replayedCount = results.filter(r => r === 'replayed').length;
    assert.strictEqual(okCount, 1, 'exactly one concurrent recycle wins');
    assert.strictEqual(replayedCount, 9, 'losers report replayed');
  });

  test('isCapHit reflects active count vs configured cap', async () => {
    const store = new PostgresReplayStore(pool, { cap: 2 });
    const now = 1_700_000_600;

    assert.strictEqual(await store.isCapHit('kid-A', 'https://seller/op', now), false);
    await store.insert('kid-A', 'https://seller/op', 'n1', 60, now);
    assert.strictEqual(await store.isCapHit('kid-A', 'https://seller/op', now), false);
    await store.insert('kid-A', 'https://seller/op', 'n2', 60, now);
    assert.strictEqual(await store.isCapHit('kid-A', 'https://seller/op', now), true);

    // Once entries expire, cap is no longer hit.
    assert.strictEqual(await store.isCapHit('kid-A', 'https://seller/op', now + 120), false);
  });

  // ====== Sweeper ======

  test('sweepExpiredReplays deletes only expired rows', async () => {
    const store = new PostgresReplayStore(pool);
    const now = 1_700_000_700;

    await store.insert('kid-A', 'https://seller/op', 'short-lived', 30, now);
    await store.insert('kid-A', 'https://seller/op', 'long-lived', 600, now);

    const before = await pool.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
    assert.strictEqual(before.rows[0].n, 2);

    const { deleted } = await sweepExpiredReplays(pool, { now: now + 60 });
    assert.strictEqual(deleted, 1);

    const after = await pool.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
    assert.strictEqual(after.rows[0].n, 1);

    // Long-lived survives.
    assert.strictEqual(await store.has('kid-A', 'https://seller/op', 'long-lived', now + 60), true);
  });

  test('sweepExpiredReplays with batchSize larger than expired count returns actual count', async () => {
    const store = new PostgresReplayStore(pool);
    const now = 1_700_000_750;

    await store.insert('kid-A', 'https://seller/op', 'short-1', 30, now);
    await store.insert('kid-A', 'https://seller/op', 'short-2', 30, now);
    await store.insert('kid-A', 'https://seller/op', 'long', 600, now);

    // batchSize 100, but only 2 are expired at the sweep time.
    const { deleted } = await sweepExpiredReplays(pool, { now: now + 60, batchSize: 100 });
    assert.strictEqual(deleted, 2);

    const remaining = await pool.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
    assert.strictEqual(remaining.rows[0].n, 1);
  });

  test('sweepExpiredReplays with batchSize bounds work per call', async () => {
    const store = new PostgresReplayStore(pool);
    const now = 1_700_000_800;

    for (let i = 0; i < 5; i++) {
      await store.insert('kid-A', 'https://seller/op', `n${i}`, 30, now);
    }

    const first = await sweepExpiredReplays(pool, { now: now + 60, batchSize: 3 });
    assert.strictEqual(first.deleted, 3);

    const second = await sweepExpiredReplays(pool, { now: now + 60, batchSize: 10 });
    assert.strictEqual(second.deleted, 2);
  });

  test('bounded sweep preserves a nonce refreshed while its delete waits', async () => {
    const refreshClient = await pool.connect();
    const sweepClient = await pool.connect();
    const store = new PostgresReplayStore(pool);
    const refreshStore = new PostgresReplayStore(refreshClient);
    const now = 1_700_000_850;

    try {
      await store.insert('kid-A', 'https://seller/op', 'refresh-race', 30, now);

      await refreshClient.query('BEGIN');
      assert.strictEqual(await refreshStore.insert('kid-A', 'https://seller/op', 'refresh-race', 600, now + 60), 'ok');

      const sweep = sweepExpiredReplays(sweepClient, { now: now + 60, batchSize: 10 });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [
          sweepClient.processID,
        ]);
        if (activity.rows[0]?.wait_event_type === 'Lock') {
          waiting = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.strictEqual(waiting, true, 'the sweep must reach the row lock before refresh commits');

      await refreshClient.query('COMMIT');
      assert.deepStrictEqual(await sweep, { deleted: 0 });
      assert.strictEqual(await store.has('kid-A', 'https://seller/op', 'refresh-race', now + 60), true);
    } finally {
      await refreshClient.query('ROLLBACK').catch(() => {});
      refreshClient.release();
      sweepClient.release();
    }
  });

  // ====== Concurrency ======

  test('concurrent inserts of the same nonce — exactly one returns ok, others return replayed', async () => {
    const store = new PostgresReplayStore(pool);
    const now = 1_700_000_900;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.insert('kid-A', 'https://seller/op', 'race-nonce', 60, now))
    );

    const okCount = results.filter(r => r === 'ok').length;
    const replayedCount = results.filter(r => r === 'replayed').length;
    assert.strictEqual(okCount, 1, 'exactly one concurrent insert succeeds');
    assert.strictEqual(replayedCount, 9, 'the rest report replayed');
  });

  test('concurrent distinct nonces cannot overshoot the per-scope cap', async () => {
    const cap = 5;
    // Deliberately expose only query(): atomicity must not depend on a
    // Pool.connect() escape hatch or client-side connection affinity.
    const queryOnlyPool = { query: (...args) => pool.query(...args) };
    const store = new PostgresReplayStore(queryOnlyPool, { cap });
    const now = 1_700_000_950;

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.insert('kid-cap-race', 'https://seller/capped-op', `nonce-${index}`, 60, now)
      )
    );

    assert.strictEqual(results.filter(result => result === 'ok').length, cap, 'exactly cap inserts may succeed');
    assert.strictEqual(
      results.filter(result => result === 'rate_abuse').length,
      results.length - cap,
      'every insert beyond the cap must be rejected'
    );
    const persisted = await pool.query(
      `SELECT count(*)::int AS count FROM ${TABLE}
       WHERE keyid = $1 AND scope = $2 AND expires_at > to_timestamp($3)`,
      ['kid-cap-race', 'https://seller/capped-op', now]
    );
    assert.strictEqual(persisted.rows[0].count, cap, 'the substrate must never retain more than cap active rows');
  });

  test('transaction-scoped replay lock remains held until an outer transaction commits', async () => {
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const now = 1_700_000_975;
    const storeA = new PostgresReplayStore(clientA, { cap: 1 });
    const storeB = new PostgresReplayStore(clientB, { cap: 1 });

    try {
      await clientA.query('BEGIN');
      assert.strictEqual(await storeA.insert('kid-outer-tx', 'https://seller/tx', 'nonce-a', 60, now), 'ok');

      let secondSettled = false;
      const second = storeB.insert('kid-outer-tx', 'https://seller/tx', 'nonce-b', 60, now).finally(() => {
        secondSettled = true;
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.strictEqual(secondSettled, false, 'the next insert waits for the first transaction to commit');

      await clientA.query('COMMIT');
      assert.strictEqual(await second, 'rate_abuse');
    } finally {
      await clientA.query('ROLLBACK').catch(() => {});
      clientA.release();
      clientB.release();
    }
  });

  test('same-scope lock contention does not starve unrelated scopes in the shared pool', async () => {
    const lockHolder = await pool.connect();
    const now = 1_700_000_977;
    const heldStore = new PostgresReplayStore(lockHolder, { cap: 1 });
    const pooledStore = new PostgresReplayStore(pool, { cap: 1 });

    try {
      await lockHolder.query('BEGIN');
      assert.strictEqual(await heldStore.insert('kid-hot', 'https://seller/hot', 'held', 60, now), 'ok');

      const hotWaiters = Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          pooledStore.insert('kid-hot', 'https://seller/hot', `waiting-${index}`, 60, now)
        )
      );
      const unrelated = await Promise.race([
        pooledStore.insert('kid-cold', 'https://seller/cold', 'unrelated', 60, now),
        new Promise((_, reject) => setTimeout(() => reject(new Error('unrelated scope was starved')), 250)),
      ]);
      assert.strictEqual(unrelated, 'ok');

      await lockHolder.query('COMMIT');
      assert.ok((await hotWaiters).every(result => result === 'rate_abuse'));
    } finally {
      await lockHolder.query('ROLLBACK').catch(() => {});
      lockHolder.release();
    }
  });

  test('exhausted lock retries fail as backend contention, not signer rate abuse', async () => {
    const lockHolder = await pool.connect();
    const now = 1_700_000_978;
    const heldStore = new PostgresReplayStore(lockHolder, { cap: 10 });
    const contender = new PostgresReplayStore(pool, { cap: 10 });

    try {
      await lockHolder.query('BEGIN');
      assert.strictEqual(await heldStore.insert('kid-busy', 'https://seller/busy', 'held', 60, now), 'ok');
      await assert.rejects(
        () => contender.insert('kid-busy', 'https://seller/busy', 'contender', 60, now),
        /remained busy after bounded lock retries/
      );
    } finally {
      await lockHolder.query('ROLLBACK').catch(() => {});
      lockHolder.release();
    }
  });

  test('fails closed when an outer transaction uses a stale-snapshot isolation level', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const store = new PostgresReplayStore(client);
      await assert.rejects(
        () => store.insert('kid-repeatable-read', 'https://seller/tx', 'nonce-a', 60, 1_700_000_980),
        /requires READ COMMITTED/
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ====== Wiring with the verifier ======

  test('rejects non-finite or negative `now` / `ttlSeconds` — defense vs PG to_timestamp DoS', async () => {
    const store = new PostgresReplayStore(pool);
    await assert.rejects(() => store.insert('kid-A', 'scope', 'n1', 30, Number.NaN), /finite non-negative/);
    await assert.rejects(
      () => store.insert('kid-A', 'scope', 'n1', 30, Number.POSITIVE_INFINITY),
      /finite non-negative/
    );
    await assert.rejects(() => store.insert('kid-A', 'scope', 'n1', 30, -1), /finite non-negative/);
    await assert.rejects(() => store.insert('kid-A', 'scope', 'n1', Number.NaN, 1_700_000_000), /finite non-negative/);
    await assert.rejects(() => store.has('kid-A', 'scope', 'n1', Number.NaN), /finite non-negative/);
    await assert.rejects(() => store.isCapHit('kid-A', 'scope', Number.POSITIVE_INFINITY), /finite non-negative/);
  });

  test('end-to-end rate-abuse: cap hit at the verifier boundary surfaces request_signature_rate_abuse', async () => {
    const {
      signRequest,
      verifyRequestSignature,
      InMemoryRevocationStore,
      StaticJwksResolver,
      RequestSignatureError,
    } = require('../../dist/lib/signing/index.js');
    const { readFileSync } = require('node:fs');
    const path = require('node:path');

    const KEYS_PATH = path.join(
      __dirname,
      '..',
      '..',
      'compliance',
      'cache',
      'latest',
      'test-vectors',
      'request-signing',
      'keys.json'
    );
    const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys;
    const ed = keys.find(k => k.kid === 'test-ed25519-2026');
    const privateJwk = { ...ed, d: ed._private_d_for_test_only };
    delete privateJwk._private_d_for_test_only;
    const publicJwk = { ...ed };
    delete publicJwk._private_d_for_test_only;

    // Cap of 2 — third unique signed request should be rejected as rate_abuse,
    // exercising the same rejection path the conformance vector
    // `negative/020-rate-abuse.json` covers.
    const replayStore = new PostgresReplayStore(pool, { cap: 2 });
    const revocationStore = new InMemoryRevocationStore();
    const jwks = new StaticJwksResolver([publicJwk]);
    const capability = {
      supported: true,
      covers_content_digest: 'either',
      required_for: ['create_media_buy'],
    };
    const now = 1_700_001_500;
    const baseRequest = {
      method: 'POST',
      url: 'https://seller.example.com/adcp/create_media_buy',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: 'p1' }),
    };

    const signWithNonce = nonce =>
      signRequest(
        baseRequest,
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
        { now: () => now, nonce }
      );

    for (const nonce of ['rate-test-1', 'rate-test-2']) {
      const signed = signWithNonce(nonce);
      const result = await verifyRequestSignature(
        { ...baseRequest, headers: signed.headers },
        { capability, jwks, replayStore, revocationStore, operation: 'create_media_buy', now: () => now }
      );
      assert.strictEqual(result.status, 'verified');
    }

    const signed = signWithNonce('rate-test-3');
    await assert.rejects(
      () =>
        verifyRequestSignature(
          { ...baseRequest, headers: signed.headers },
          { capability, jwks, replayStore, revocationStore, operation: 'create_media_buy', now: () => now }
        ),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_rate_abuse'
    );
  });

  test('end-to-end: signed request → verifier with PostgresReplayStore → second attempt rejected as replay', async () => {
    const {
      signRequest,
      verifyRequestSignature,
      InMemoryRevocationStore,
      StaticJwksResolver,
    } = require('../../dist/lib/signing/index.js');
    const { readFileSync } = require('node:fs');
    const path = require('node:path');

    const KEYS_PATH = path.join(
      __dirname,
      '..',
      '..',
      'compliance',
      'cache',
      'latest',
      'test-vectors',
      'request-signing',
      'keys.json'
    );
    const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys;
    const ed = keys.find(k => k.kid === 'test-ed25519-2026');
    const privateJwk = { ...ed, d: ed._private_d_for_test_only };
    delete privateJwk._private_d_for_test_only;
    const publicJwk = { ...ed };
    delete publicJwk._private_d_for_test_only;

    const replayStore = new PostgresReplayStore(pool);
    const revocationStore = new InMemoryRevocationStore();
    const jwks = new StaticJwksResolver([publicJwk]);

    const now = 1_700_001_000;
    const request = {
      method: 'POST',
      url: 'https://seller.example.com/adcp/create_media_buy',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: 'p1' }),
    };
    const signed = signRequest(
      request,
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
      {
        now: () => now,
        nonce: 'pg-replay-test-nonce',
      }
    );

    const verified = await verifyRequestSignature(
      { ...request, headers: signed.headers },
      {
        capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
        jwks,
        replayStore,
        revocationStore,
        operation: 'create_media_buy',
        now: () => now,
      }
    );
    assert.strictEqual(verified.status, 'verified');

    // Second attempt with the same signature must be rejected as a replay
    // — even though this is a "second instance" simulation, the shared
    // PostgresReplayStore caught it.
    const { RequestSignatureError } = require('../../dist/lib/signing/index.js');
    await assert.rejects(
      () =>
        verifyRequestSignature(
          { ...request, headers: signed.headers },
          {
            capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
            jwks,
            replayStore,
            revocationStore,
            operation: 'create_media_buy',
            now: () => now,
          }
        ),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_replayed'
    );
  });
});

test('missing guarded-insert migration produces an actionable error', async () => {
  const { PostgresReplayStore } = require('../../dist/lib/signing/server.js');
  const missingFunction = Object.assign(new Error('internal database details'), { code: '42883' });
  const store = new PostgresReplayStore({
    query: async () => {
      throw missingFunction;
    },
  });

  await assert.rejects(store.insert('kid', 'scope', 'nonce', 60, 1_700_000_000), error => {
    assert.match(error.message, /rerun getReplayStoreMigration/);
    assert.strictEqual(error.cause, missingFunction);
    return true;
  });
});

test('non-READ-COMMITTED transactions produce a sanitized actionable error', async () => {
  const { PostgresReplayStore } = require('../../dist/lib/signing/server.js');
  const isolationError = Object.assign(new Error('postgres://secret-host/internal_replay_table'), {
    code: 'AD001',
  });
  const store = new PostgresReplayStore({
    query: async () => {
      throw isolationError;
    },
  });

  await assert.rejects(
    () => store.insert('kid', 'scope', 'nonce', 60, 1_700_000_000),
    error => {
      assert.strictEqual(error.message, 'PostgresReplayStore.insert requires READ COMMITTED transaction isolation.');
      assert.doesNotMatch(error.message, /secret-host|internal_replay_table/);
      assert.strictEqual(error.cause, isolationError);
      return true;
    }
  );
});

test('unexpected guarded-insert results fail closed', async () => {
  const { PostgresReplayStore } = require('../../dist/lib/signing/server.js');
  const store = new PostgresReplayStore({
    query: async () => ({ rows: [{ result: null }], rowCount: 1 }),
  });

  await assert.rejects(
    store.insert('kid', 'scope', 'nonce', 60, 1_700_000_000),
    /guarded database function returned an unexpected value/
  );
});

test('PostgresReplayStore rejects expiry overflow before querying PostgreSQL', async () => {
  const { PostgresReplayStore } = require('../../dist/lib/signing/server.js');
  let queryCalls = 0;
  const store = new PostgresReplayStore({
    query: async () => {
      queryCalls++;
      throw new Error('query should not run');
    },
  });

  await assert.rejects(store.insert('kid', 'scope', 'nonce', 0, Number.MAX_SAFE_INTEGER), /now must be/);
  await assert.rejects(store.insert('kid', 'scope', 'nonce', Number.MAX_SAFE_INTEGER, 0), /ttlSeconds must be/);
  await assert.rejects(store.insert('kid', 'scope', 'nonce', 1, 253_402_300_799), /expiresAt must be/);
  assert.strictEqual(queryCalls, 0);
});

test('sweepExpiredReplays rejects invalid time and batch size before querying PostgreSQL', async () => {
  const { sweepExpiredReplays } = require('../../dist/lib/signing/server.js');
  let queryCalls = 0;
  const db = {
    query: async () => {
      queryCalls++;
      throw new Error('query should not run');
    },
  };

  for (const now of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(sweepExpiredReplays(db, { now }), /sweep now must be a finite non-negative number/);
  }
  for (const batchSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(sweepExpiredReplays(db, { now: 1_700_000_000, batchSize }), /positive safe integer/);
  }
  assert.strictEqual(queryCalls, 0);
});

test('PostgresReplayStore redacts driver errors from every database operation', async () => {
  const { PostgresReplayStore, sweepExpiredReplays } = require('../../dist/lib/signing/server.js');
  const driverError = Object.assign(new Error('postgres://secret-host/internal_replay_table'), { code: 'XX000' });
  const db = {
    query: async () => {
      throw driverError;
    },
  };
  const store = new PostgresReplayStore(db);
  const operations = [
    () => store.has('kid', 'scope', 'nonce', 1_700_000_000),
    () => store.isCapHit('kid', 'scope', 1_700_000_000),
    () => store.insert('kid', 'scope', 'nonce', 60, 1_700_000_000),
    () => sweepExpiredReplays(db, { now: 1_700_000_000 }),
    () => sweepExpiredReplays(db, { now: 1_700_000_000, batchSize: 10 }),
  ];

  for (const operation of operations) {
    await assert.rejects(operation, error => {
      assert.match(error.message, /^PostgresReplayStore\.[A-Za-z]+: database operation failed$/);
      assert.doesNotMatch(error.message, /secret-host|internal_replay_table/);
      assert.strictEqual(error.cause, driverError);
      return true;
    });
  }
});
