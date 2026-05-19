/**
 * Redis ReplayStore integration tests.
 *
 * Requires a running Redis instance. Set REDIS_URL to run:
 *   REDIS_URL=redis://localhost:6379/15 node --test test/lib/redis-replay-store.test.js
 *
 * Use a dedicated db index (e.g., /15) — these tests FLUSHDB between runs.
 * Skipped entirely when REDIS_URL is not set.
 */

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const REDIS_URL = process.env.REDIS_URL;

// ────────── pure-function tests (no live Redis required) ──────────

describe('RedisReplayStore — default-prefix-on-db-0 warning', () => {
  let RedisReplayStore, __resetDefaultPrefixWarningForTests;
  let originalWarn;
  let warnings;

  before(() => {
    const signingServer = require('../../dist/lib/signing/server.js');
    RedisReplayStore = signingServer.RedisReplayStore;
    __resetDefaultPrefixWarningForTests =
      require('../../dist/lib/utils/redis-default-prefix-warn.js').__resetDefaultPrefixWarningForTests;
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

  const stubClient = options => ({
    options,
    eval: async () => 'ok',
    zScore: async () => null,
    zCount: async () => 0,
    ping: async () => 'PONG',
  });

  test('warns on default prefix + db 0', () => {
    new RedisReplayStore(stubClient({ database: 0 }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /RedisReplayStore/);
  });

  test('does NOT warn on db 15', () => {
    new RedisReplayStore(stubClient({ database: 15 }));
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn when keyPrefix is explicit', () => {
    new RedisReplayStore(stubClient({ database: 0 }), { keyPrefix: 'adcp:replay:' });
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn when suppressDefaultPrefixWarning is set', () => {
    new RedisReplayStore(stubClient({ database: 0 }), { suppressDefaultPrefixWarning: true });
    assert.equal(warnings.length, 0);
  });

  test('rejects non-positive cap', () => {
    assert.throws(() => new RedisReplayStore(stubClient({ database: 15 }), { cap: 0 }), /cap must be a positive/);
    assert.throws(() => new RedisReplayStore(stubClient({ database: 15 }), { cap: -1 }), /cap must be a positive/);
  });

  test('rejects negative setTtlGraceSeconds', () => {
    assert.throws(
      () => new RedisReplayStore(stubClient({ database: 15 }), { setTtlGraceSeconds: -1 }),
      /setTtlGraceSeconds must be a non-negative/
    );
  });
});

describe('RedisReplayStore', { skip: !REDIS_URL && 'REDIS_URL not set' }, () => {
  let client;
  let RedisReplayStore;

  before(async () => {
    const { createClient } = require('redis');
    client = createClient({ url: REDIS_URL });
    client.on('error', err => console.error('redis test client error', err));
    await client.connect();

    const signingServer = require('../../dist/lib/signing/server.js');
    RedisReplayStore = signingServer.RedisReplayStore;

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

  // ────────── primitives ──────────

  test('probe resolves against a live client', async () => {
    const store = new RedisReplayStore(client);
    await store.probe();
  });

  test('has returns false for unknown nonce', async () => {
    const store = new RedisReplayStore(client);
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await store.has('kid', '/op', 'nonce1', now), false);
  });

  test('insert + has round-trip', async () => {
    const store = new RedisReplayStore(client);
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await store.insert('kid', '/op', 'nonce1', 300, now), 'ok');
    assert.equal(await store.has('kid', '/op', 'nonce1', now), true);
  });

  test('insert returns replayed on duplicate nonce within TTL', async () => {
    const store = new RedisReplayStore(client);
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await store.insert('kid', '/op', 'dup', 300, now), 'ok');
    assert.equal(await store.insert('kid', '/op', 'dup', 300, now), 'replayed');
  });

  test('different scopes do not collide on the same nonce', async () => {
    const store = new RedisReplayStore(client);
    const now = Math.floor(Date.now() / 1000);
    // Same nonce on different (keyid, scope) tuples should both succeed.
    assert.equal(await store.insert('kid', '/create_media_buy', 'n1', 300, now), 'ok');
    assert.equal(await store.insert('kid', '/update_media_buy', 'n1', 300, now), 'ok');
    assert.equal(await store.insert('kid2', '/create_media_buy', 'n1', 300, now), 'ok');
  });

  test('expired nonce is reclaimable (Redis evicts; ZREMRANGEBYSCORE prunes)', async () => {
    const store = new RedisReplayStore(client);
    const now = Math.floor(Date.now() / 1000);
    // Insert with 1-second TTL; advance the "now" used in subsequent calls past expiry.
    assert.equal(await store.insert('kid', '/op', 'recycled', 1, now), 'ok');
    const future = now + 60;
    assert.equal(await store.has('kid', '/op', 'recycled', future), false);
    // Re-insert with the same nonce after expiry — should succeed (not 'replayed').
    assert.equal(await store.insert('kid', '/op', 'recycled', 300, future), 'ok');
  });

  test('cap enforcement: insert returns rate_abuse when cap reached', async () => {
    const store = new RedisReplayStore(client, { cap: 3 });
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await store.insert('kid', '/op', 'n1', 300, now), 'ok');
    assert.equal(await store.insert('kid', '/op', 'n2', 300, now), 'ok');
    assert.equal(await store.insert('kid', '/op', 'n3', 300, now), 'ok');
    assert.equal(await store.insert('kid', '/op', 'n4', 300, now), 'rate_abuse');
  });

  test('cap enforcement: replay wins over cap (precedence)', async () => {
    const store = new RedisReplayStore(client, { cap: 2 });
    const now = Math.floor(Date.now() / 1000);
    await store.insert('kid', '/op', 'n1', 300, now);
    await store.insert('kid', '/op', 'n2', 300, now);
    // n1 is already present AND cap is hit — the replay branch must win.
    assert.equal(await store.insert('kid', '/op', 'n1', 300, now), 'replayed');
  });

  test('isCapHit reflects unexpired-only count', async () => {
    const store = new RedisReplayStore(client, { cap: 2 });
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await store.isCapHit('kid', '/op', now), false);
    await store.insert('kid', '/op', 'n1', 300, now);
    await store.insert('kid', '/op', 'n2', 300, now);
    assert.equal(await store.isCapHit('kid', '/op', now), true);
    // 5 minutes in the future — both n1/n2 are still valid (300s TTL).
    assert.equal(await store.isCapHit('kid', '/op', now + 600), false);
  });

  test('concurrent insert with same nonce — exactly one wins, others see replayed', async () => {
    const store = new RedisReplayStore(client);
    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.all(Array.from({ length: 10 }, () => store.insert('kid', '/op', 'race', 300, now)));
    const oks = results.filter(r => r === 'ok');
    const replays = results.filter(r => r === 'replayed');
    assert.equal(oks.length, 1, 'exactly one concurrent insert must win');
    assert.equal(replays.length, 9);
  });

  test('concurrent insert at cap boundary — at most cap inserts succeed', async () => {
    const store = new RedisReplayStore(client, { cap: 5 });
    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.insert('kid', '/op', `n${i}`, 300, now))
    );
    const oks = results.filter(r => r === 'ok').length;
    const rateAbuses = results.filter(r => r === 'rate_abuse').length;
    assert.equal(oks, 5, 'exactly cap inserts must succeed under contention');
    assert.equal(rateAbuses, 15);
  });

  // ────────── input validation ──────────

  test('rejects non-finite now', async () => {
    const store = new RedisReplayStore(client);
    await assert.rejects(() => store.insert('kid', '/op', 'n', 300, NaN), /must be a finite/);
    await assert.rejects(() => store.has('kid', '/op', 'n', Infinity), /must be a finite/);
  });

  // ────────── keyPrefix isolation ──────────

  test('keyPrefix isolates writes from sibling deployments', async () => {
    const eu = new RedisReplayStore(client, { keyPrefix: 'adcp:replay:eu:' });
    const us = new RedisReplayStore(client, { keyPrefix: 'adcp:replay:us:' });
    const now = Math.floor(Date.now() / 1000);
    // Same (keyid, scope, nonce) in two prefixes should not collide.
    assert.equal(await eu.insert('kid', '/op', 'n1', 300, now), 'ok');
    assert.equal(await us.insert('kid', '/op', 'n1', 300, now), 'ok');
    assert.equal(await eu.has('kid', '/op', 'n1', now), true);
    assert.equal(await us.has('kid', '/op', 'n1', now), true);
  });

  // ────────── sorted-set TTL ──────────

  test('sorted set carries a PEXPIREAT past the latest insert (auto-eviction)', async () => {
    const store = new RedisReplayStore(client);
    const now = Math.floor(Date.now() / 1000);
    await store.insert('kid', '/op', 'n1', 300, now);
    // Compute the exact Redis key the store uses.
    const redisKey = `adcp:replay:kid\x1f/op`;
    const ttl = await client.ttl(redisKey);
    // Expected: 300 (TTL) + 3600 (default setTtlGraceSeconds) = ~3900s.
    assert.ok(ttl > 3800 && ttl <= 3905, `expected sorted-set TTL ~3900s, got ${ttl}`);
  });

  test('short-lived insert after long-lived MUST NOT shrink the set TTL (replay-bypass regression)', async () => {
    // Codex code review caught a real replay-bypass bug here: the
    // original Lua unconditionally PEXPIREAT'd the set to
    // `(latestInsert + grace) * 1000`, so a 60s nonce inserted after
    // a 3600s nonce would shrink the set's eviction time to ~1m + grace
    // and evict the still-valid 3600s nonce. A subsequent replay of
    // the long-lived nonce would then succeed because has() saw an
    // empty key. The fix: extend the set TTL forward-only via PTTL +
    // explicit max comparison against the SDK-supplied `now * 1000`.
    const store = new RedisReplayStore(client);
    const now = Math.floor(Date.now() / 1000);
    const redisKey = `adcp:replay:kid\x1f/op`;

    // Long-lived insert first: set TTL → ~3600 + 3600 = ~7200s.
    await store.insert('kid', '/op', 'n_long', 3600, now);
    const ttlBefore = await client.ttl(redisKey);
    assert.ok(ttlBefore > 7100 && ttlBefore <= 7205, `long-lived TTL: expected ~7200s, got ${ttlBefore}`);

    // Short-lived insert second. Buggy implementation would shrink TTL
    // to ~60 + 3600 = ~3660s. Fixed implementation preserves ~7200s.
    await store.insert('kid', '/op', 'n_short', 60, now);
    const ttlAfter = await client.ttl(redisKey);
    assert.ok(
      ttlAfter > 7100,
      `set TTL must not shrink after a shorter-lived insert (replay-bypass regression). Before: ${ttlBefore}, after: ${ttlAfter}`
    );

    // Both nonces still visible (proves the set wasn't prematurely evicted).
    assert.equal(await store.has('kid', '/op', 'n_long', now), true);
    assert.equal(await store.has('kid', '/op', 'n_short', now), true);
  });

  test('long-lived insert after short-lived DOES extend the set TTL (forward-only)', async () => {
    // Mirror of the regression test: forward extension still works.
    const store = new RedisReplayStore(client);
    const now = Math.floor(Date.now() / 1000);
    const redisKey = `adcp:replay:kid\x1f/op`;

    await store.insert('kid', '/op', 'n_short', 60, now);
    const ttlBefore = await client.ttl(redisKey);
    assert.ok(ttlBefore > 0 && ttlBefore <= 3665, `short-lived TTL: expected <=3660s, got ${ttlBefore}`);

    await store.insert('kid', '/op', 'n_long', 3600, now);
    const ttlAfter = await client.ttl(redisKey);
    assert.ok(ttlAfter > 7100 && ttlAfter <= 7205, `set TTL must extend to ~7200s. After: ${ttlAfter}`);
  });
});
