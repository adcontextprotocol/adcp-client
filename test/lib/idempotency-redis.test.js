/**
 * Redis idempotency backend integration tests.
 *
 * Requires a running Redis instance. Set REDIS_URL to run:
 *   REDIS_URL=redis://localhost:6379/15 node --test test/lib/idempotency-redis.test.js
 *
 * Use a dedicated db index (e.g., /15) — these tests FLUSHDB between runs.
 * Skipped entirely when REDIS_URL is not set.
 */

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const REDIS_URL = process.env.REDIS_URL;

// ────────── pure-function tests (no live Redis required) ──────────
//
// detectNodeRedisDbIndex + the default-prefix warning gate work off
// the client object's shape, not a live connection. Run them
// unconditionally so the warn behavior gets coverage in CI even when
// REDIS_URL isn't set.

describe('redisBackend — default-prefix-on-db-0 warning', () => {
  let redisBackend, __resetDefaultPrefixWarningForTests;
  let originalWarn;
  let warnings;

  before(() => {
    const server = require('../../dist/lib/server/index.js');
    redisBackend = server.redisBackend;
    // Reset hook is exported from the backend module but not surfaced
    // through the public server index — reach into the inner module.
    __resetDefaultPrefixWarningForTests =
      require('../../dist/lib/server/idempotency/backends/redis.js').__resetDefaultPrefixWarningForTests;
  });

  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    __resetDefaultPrefixWarningForTests();
  });

  after(() => {
    console.warn = originalWarn;
  });

  // Stub clients — never connected. The redisBackend constructor never
  // calls into them; only `detectNodeRedisDbIndex` reads `.options`.
  const stubClient = options => ({
    options,
    get: async () => null,
    set: async () => null,
    del: async () => 0,
    ping: async () => 'PONG',
  });

  test('warns once on default prefix + db 0 (options.database)', () => {
    redisBackend(stubClient({ database: 0 }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /default keyPrefix/);
    assert.match(warnings[0], /db 0/);
  });

  test('warns once on default prefix + db 0 (parsed from options.url)', () => {
    redisBackend(stubClient({ url: 'redis://localhost:6379' })); // implicit db 0
    assert.equal(warnings.length, 1);
  });

  test('warns once on default prefix + explicit /0 in url', () => {
    redisBackend(stubClient({ url: 'redis://localhost:6379/0' }));
    assert.equal(warnings.length, 1);
  });

  test('does NOT warn on db 15 (explicit dedicated db index)', () => {
    redisBackend(stubClient({ database: 15 }));
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn on db 7 parsed from url', () => {
    redisBackend(stubClient({ url: 'redis://localhost:6379/7' }));
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn when keyPrefix is set explicitly (even to the default value)', () => {
    redisBackend(stubClient({ database: 0 }), { keyPrefix: 'adcp:idem:' });
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn when suppressDefaultPrefixWarning is set', () => {
    redisBackend(stubClient({ database: 0 }), { suppressDefaultPrefixWarning: true });
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn for escape-hatch clients without an introspectable options.database / options.url', () => {
    // RedisLikeClient adapter path — no `options` object at all.
    redisBackend({ get: async () => null, set: async () => null, del: async () => 0, ping: async () => 'PONG' });
    assert.equal(warnings.length, 0);
  });

  test('warns at most once per process across multiple backend constructions', () => {
    redisBackend(stubClient({ database: 0 }));
    redisBackend(stubClient({ database: 0 }));
    redisBackend(stubClient({ database: 0 }));
    assert.equal(warnings.length, 1);
  });

  test('rediss:// (TLS) URL also triggers the warn on db 0', () => {
    redisBackend(stubClient({ url: 'rediss://prod.example.com:6380' }));
    assert.equal(warnings.length, 1);
  });

  test('does NOT warn when url has a non-numeric path component', () => {
    // Defensive — a malformed url path shouldn't be assumed to be db 0.
    redisBackend(stubClient({ url: 'redis://localhost:6379/notanumber' }));
    assert.equal(warnings.length, 0);
  });
});

describe('redisBackend', { skip: !REDIS_URL && 'REDIS_URL not set' }, () => {
  let client;
  let redisBackend, createIdempotencyStore;

  before(async () => {
    const { createClient } = require('redis');
    client = createClient({ url: REDIS_URL });
    client.on('error', err => console.error('redis test client error', err));
    await client.connect();

    const server = require('../../dist/lib/server/index.js');
    redisBackend = server.redisBackend;
    createIdempotencyStore = server.createIdempotencyStore;

    await client.flushDb();
  });

  beforeEach(async () => {
    await client.flushDb();
  });

  after(async () => {
    if (client) {
      await client.flushDb();
      await client.quit();
    }
  });

  // ────────── options validation ──────────

  test('rejects negative expiredGraceSeconds', () => {
    assert.throws(() => redisBackend(client, { expiredGraceSeconds: -1 }), /must be a non-negative/);
  });

  // ────────── backend primitives ──────────

  test('probe resolves against a live client', async () => {
    const backend = redisBackend(client);
    await backend.probe();
  });

  test('get returns null for missing key', async () => {
    const backend = redisBackend(client);
    const result = await backend.get('missing-key');
    assert.equal(result, null);
  });

  test('put + get round-trip', async () => {
    const backend = redisBackend(client);
    const entry = {
      payloadHash: 'deadbeef',
      response: { media_buy_id: 'mb_42', packages: [{ id: 'p1' }] },
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    await backend.put('pk', entry);
    const got = await backend.get('pk');
    assert.deepEqual(got.response, entry.response);
    assert.equal(got.payloadHash, entry.payloadHash);
    assert.equal(got.expiresAt, entry.expiresAt);
  });

  test('put overwrites existing entry', async () => {
    const backend = redisBackend(client);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    await backend.put('pk', { payloadHash: 'h1', response: { v: 1 }, expiresAt });
    await backend.put('pk', { payloadHash: 'h2', response: { v: 2 }, expiresAt });

    const got = await backend.get('pk');
    assert.equal(got.payloadHash, 'h2');
    assert.deepEqual(got.response, { v: 2 });
  });

  test('putIfAbsent returns true on fresh key', async () => {
    const backend = redisBackend(client);
    const claimed = await backend.putIfAbsent('pk', {
      payloadHash: 'h1',
      response: null,
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    assert.equal(claimed, true);
  });

  test('putIfAbsent returns false when an unexpired entry exists', async () => {
    const backend = redisBackend(client);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('pk', { payloadHash: 'h1', response: { v: 1 }, expiresAt });

    const claimed = await backend.putIfAbsent('pk', {
      payloadHash: 'h2',
      response: { v: 2 },
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    assert.equal(claimed, false);

    // Original entry untouched
    const got = await backend.get('pk');
    assert.equal(got.payloadHash, 'h1');
    assert.deepEqual(got.response, { v: 1 });
  });

  test('putIfAbsent reclaims an expired entry (Redis auto-evicts; SET NX naturally succeeds)', async () => {
    const backend = redisBackend(client);
    // Write a value with a 100ms PX (millisecond TTL) so Redis auto-evicts it
    // shortly. After eviction, putIfAbsent must succeed — proving the
    // "Redis auto-deletes expired keys, reclaim is automatic" claim in
    // the backend JSDoc.
    await client.set('adcp:idem:preclaim', JSON.stringify({ payloadHash: 'stale', response: null, expiresAt: 0 }), {
      PX: 100,
    });
    // Wait past the PX TTL with a generous margin.
    await new Promise(resolve => setTimeout(resolve, 250));

    const claimed = await backend.putIfAbsent('preclaim', {
      payloadHash: 'fresh',
      response: { fresh: true },
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    assert.equal(claimed, true);

    const got = await backend.get('preclaim');
    assert.equal(got.payloadHash, 'fresh');
    assert.deepEqual(got.response, { fresh: true });
  });

  test('ttlFor refuses to write an entry whose expiresAt is already past', async () => {
    const backend = redisBackend(client);
    // expiresAt 3600s in the past — even with the 120s grace window,
    // the resulting Redis TTL would be deeply negative. Must throw
    // rather than silently clamp to EX 1 (which would let the entry
    // vanish in 1s and let the next caller re-execute the side effect).
    await assert.rejects(
      () =>
        backend.put('pstale', {
          payloadHash: 'h',
          response: {},
          expiresAt: Math.floor(Date.now() / 1000) - 3600,
        }),
      /expiresAt .* is already past/
    );
  });

  test('concurrent putIfAbsent — only one caller wins the claim', async () => {
    const backend = redisBackend(client);
    const entry = {
      payloadHash: 'claim',
      response: null,
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => backend.putIfAbsent('prace', entry)));
    const winners = results.filter(x => x === true);
    assert.equal(winners.length, 1, 'exactly one concurrent putIfAbsent must win');
  });

  test('delete removes the entry', async () => {
    const backend = redisBackend(client);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('pk', { payloadHash: 'h', response: {}, expiresAt });
    await backend.delete('pk');
    assert.equal(await backend.get('pk'), null);
  });

  test('keyPrefix isolates writes from other apps on the same db', async () => {
    const a = redisBackend(client, { keyPrefix: 'appA:' });
    const b = redisBackend(client, { keyPrefix: 'appB:' });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    await a.put('shared', { payloadHash: 'A', response: { from: 'a' }, expiresAt });
    await b.put('shared', { payloadHash: 'B', response: { from: 'b' }, expiresAt });

    assert.equal((await a.get('shared')).payloadHash, 'A');
    assert.equal((await b.get('shared')).payloadHash, 'B');
  });

  test('corrupt cached value surfaces an error rather than silently missing', async () => {
    const backend = redisBackend(client);
    await client.set('adcp:idem:pcorrupt', 'not json', { EX: 60 });
    await assert.rejects(
      () => backend.get('pcorrupt'),
      err => {
        // Generic public message — no scoped key, no parse-error detail.
        assert.match(err.message, /corrupt cache entry/);
        assert.doesNotMatch(err.message, /p\x1fcorrupt/, 'public error must not leak the scoped key');
        // Underlying parse error attached as Error.cause for server-side logs.
        assert.ok(err.cause instanceof Error, 'parse error must ride on Error.cause');
        return true;
      }
    );
  });

  // ────────── store + backend end-to-end ──────────

  test('store check/save round-trip works against real redis', async () => {
    const store = createIdempotencyStore({ backend: redisBackend(client), ttlSeconds: 3600 });
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
    const store = createIdempotencyStore({ backend: redisBackend(client), ttlSeconds: 3600 });
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

  test('store returns expired when expires_at is past TTL + skew (grace window keeps key visible)', async () => {
    // Backend default grace (120s) keeps the value present after expiresAt,
    // so the store layer can detect `expired` rather than collapsing to `miss`.
    const backend = redisBackend(client);
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 60 });

    // Write directly with a past expiresAt but a future Redis TTL so the
    // store sees the value and applies its own skew check.
    await client.set(
      'adcp:idem:pexp',
      JSON.stringify({ payloadHash: 'h', response: {}, expiresAt: Math.floor(Date.now() / 1000) - 120 }),
      { EX: 60 }
    );

    const result = await store.check({ principal: 'p', key: 'exp', payload: {} });
    assert.equal(result.kind, 'expired');
  });

  // ────────── unicode / nested edge cases ──────────

  test('round-trips nested structures and unicode', async () => {
    const backend = redisBackend(client);
    const response = {
      media_buy_id: 'mb_日本',
      packages: [
        { name: 'café', price: 5000.5 },
        { name: 'tag\\with\\slashes', nested: { deep: ['a', 'b', null] } },
      ],
    };
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('pjson', { payloadHash: 'h', response, expiresAt });
    const got = await backend.get('pjson');
    assert.deepEqual(got.response, response);
  });
});
