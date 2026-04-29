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
