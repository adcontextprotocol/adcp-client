/**
 * Redis ctx-metadata backend integration tests.
 *
 * Requires a running Redis instance. Set REDIS_URL to run:
 *   REDIS_URL=redis://localhost:6379/15 node --test test/lib/ctx-metadata-redis.test.js
 *
 * Use a dedicated db index (e.g., /15) — these tests FLUSHDB between runs.
 * Skipped entirely when REDIS_URL is not set.
 */

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const REDIS_URL = process.env.REDIS_URL;

// ────────── pure-function tests (no live Redis required) ──────────

describe('redisCtxMetadataStore — default-prefix-on-db-0 warning', () => {
  let redisCtxMetadataStore, __resetDefaultPrefixWarningForTests;
  let originalWarn;
  let warnings;

  before(() => {
    const server = require('../../dist/lib/server/index.js');
    redisCtxMetadataStore = server.redisCtxMetadataStore;
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
    get: async () => null,
    mGet: async () => [],
    set: async () => null,
    del: async () => 0,
    ping: async () => 'PONG',
  });

  test('warns on default prefix + db 0', () => {
    redisCtxMetadataStore(stubClient({ database: 0 }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /redisCtxMetadataStore/);
    assert.match(warnings[0], /default keyPrefix/);
  });

  test('does NOT warn on db 15', () => {
    redisCtxMetadataStore(stubClient({ database: 15 }));
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn when keyPrefix is explicit', () => {
    redisCtxMetadataStore(stubClient({ database: 0 }), { keyPrefix: 'adcp:ctx_meta:' });
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn when suppressDefaultPrefixWarning is set', () => {
    redisCtxMetadataStore(stubClient({ database: 0 }), { suppressDefaultPrefixWarning: true });
    assert.equal(warnings.length, 0);
  });

  test('does NOT warn for escape-hatch clients without introspectable options', () => {
    redisCtxMetadataStore({
      get: async () => null,
      mGet: async () => [],
      set: async () => null,
      del: async () => 0,
      ping: async () => 'PONG',
    });
    assert.equal(warnings.length, 0);
  });
});

describe('redisCtxMetadataStore', { skip: !REDIS_URL && 'REDIS_URL not set' }, () => {
  let client;
  let redisCtxMetadataStore, createCtxMetadataStore;

  before(async () => {
    const { createClient } = require('redis');
    client = createClient({ url: REDIS_URL });
    client.on('error', err => console.error('redis test client error', err));
    await client.connect();

    const server = require('../../dist/lib/server/index.js');
    redisCtxMetadataStore = server.redisCtxMetadataStore;
    createCtxMetadataStore = server.createCtxMetadataStore;

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
    assert.throws(() => redisCtxMetadataStore(client, { expiredGraceSeconds: -1 }), /must be a non-negative/);
  });

  // ────────── backend primitives ──────────

  test('probe resolves against a live client', async () => {
    const backend = redisCtxMetadataStore(client);
    await backend.probe();
  });

  test('get returns null for missing key', async () => {
    const backend = redisCtxMetadataStore(client);
    assert.equal(await backend.get('missing'), null);
  });

  test('put + get round-trip without TTL (durable entry)', async () => {
    const backend = redisCtxMetadataStore(client);
    await backend.put('a:product:p1', { value: { ad_unit_id: 'au_42' } });
    const got = await backend.get('a:product:p1');
    assert.deepEqual(got.value, { ad_unit_id: 'au_42' });
    assert.equal(got.expiresAt, undefined);
    // No TTL was set — Redis reports -1 (key exists, no expiry).
    const ttl = await client.ttl('adcp:ctx_meta:a:product:p1');
    assert.equal(ttl, -1, 'durable entries must have no Redis TTL');
  });

  test('put + get round-trip with expiresAt (uses TTL + grace)', async () => {
    const backend = redisCtxMetadataStore(client);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await backend.put('a:media_buy:mb1', { value: { order_id: 'o_77' }, expiresAt });
    const got = await backend.get('a:media_buy:mb1');
    assert.equal(got.expiresAt, expiresAt);
    // Redis TTL should be expiresAt - now + grace (60s default).
    const ttl = await client.ttl('adcp:ctx_meta:a:media_buy:mb1');
    assert.ok(ttl > 3600 && ttl <= 3661, `expected TTL ~3660s, got ${ttl}`);
  });

  test('put round-trips resource field alongside value', async () => {
    const backend = redisCtxMetadataStore(client);
    await backend.put('a:product:p1', {
      value: { ad_unit_id: 'au_42' },
      resource: { product_id: 'p1', name: 'Premium Sports' },
    });
    const got = await backend.get('a:product:p1');
    assert.deepEqual(got.resource, { product_id: 'p1', name: 'Premium Sports' });
  });

  test('put overwrites existing entry', async () => {
    const backend = redisCtxMetadataStore(client);
    await backend.put('a:product:p1', { value: { v: 1 } });
    await backend.put('a:product:p1', { value: { v: 2 } });
    const got = await backend.get('a:product:p1');
    assert.deepEqual(got.value, { v: 2 });
  });

  test('delete removes the entry', async () => {
    const backend = redisCtxMetadataStore(client);
    await backend.put('a:product:p1', { value: { v: 1 } });
    await backend.delete('a:product:p1');
    assert.equal(await backend.get('a:product:p1'), null);
  });

  test('refuses to write an entry whose expiresAt is already past', async () => {
    const backend = redisCtxMetadataStore(client);
    await assert.rejects(
      () => backend.put('a:product:p1', { value: {}, expiresAt: Math.floor(Date.now() / 1000) - 3600 }),
      /expiresAt .* is already past/
    );
  });

  // ────────── bulkGet ──────────

  test('bulkGet returns empty Map on empty input', async () => {
    const backend = redisCtxMetadataStore(client);
    const got = await backend.bulkGet([]);
    assert.equal(got.size, 0);
  });

  test('bulkGet returns entries for all hits, omits misses', async () => {
    const backend = redisCtxMetadataStore(client);
    await backend.put('a:product:p1', { value: { id: 1 } });
    await backend.put('a:product:p2', { value: { id: 2 } });
    const got = await backend.bulkGet(['a:product:p1', 'a:product:missing', 'a:product:p2']);
    assert.equal(got.size, 2);
    assert.deepEqual(got.get('a:product:p1').value, { id: 1 });
    assert.deepEqual(got.get('a:product:p2').value, { id: 2 });
    assert.equal(got.has('a:product:missing'), false);
  });

  test('bulkGet uses a single MGET round trip (witnessed via batch parity)', async () => {
    // Indirect witness: a 100-key batch completes in < 50ms locally, far
    // faster than 100 sequential GETs would on a real network. We don't
    // have a clean way to assert "exactly one round trip" without a
    // protocol-level wireshark — this is the next-best signal.
    const backend = redisCtxMetadataStore(client);
    for (let i = 0; i < 100; i++) {
      await backend.put(`a:product:p${i}`, { value: { i } });
    }
    const keys = Array.from({ length: 100 }, (_, i) => `a:product:p${i}`);
    const t0 = Date.now();
    const got = await backend.bulkGet(keys);
    const elapsed = Date.now() - t0;
    assert.equal(got.size, 100);
    assert.ok(elapsed < 200, `bulkGet of 100 keys took ${elapsed}ms — expected MGET-style single trip`);
  });

  // ────────── keyPrefix isolation ──────────

  test('keyPrefix isolates writes from other apps on the same db', async () => {
    const a = redisCtxMetadataStore(client, { keyPrefix: 'app_a:' });
    const b = redisCtxMetadataStore(client, { keyPrefix: 'app_b:' });
    await a.put('shared', { value: { from: 'a' } });
    await b.put('shared', { value: { from: 'b' } });
    assert.deepEqual((await a.get('shared')).value, { from: 'a' });
    assert.deepEqual((await b.get('shared')).value, { from: 'b' });
  });

  // ────────── corrupt-value handling ──────────

  test('corrupt cached value surfaces an error with Error.cause, no key leak', async () => {
    const backend = redisCtxMetadataStore(client);
    await client.set('adcp:ctx_meta:a:product:corrupt', 'not json');
    await assert.rejects(
      () => backend.get('a:product:corrupt'),
      err => {
        assert.match(err.message, /corrupt cache entry/);
        assert.doesNotMatch(err.message, /a:product:corrupt/, 'public error must not leak the scoped key');
        assert.ok(err.cause instanceof Error, 'parse error must ride on Error.cause');
        return true;
      }
    );
  });

  // ────────── store + backend end-to-end ──────────

  test('store get/set round-trip works against real Redis', async () => {
    const store = createCtxMetadataStore({ backend: redisCtxMetadataStore(client) });
    await store.set('acct1', 'product', 'p1', { ad_unit_id: 'au_42' });
    const got = await store.get('acct1', 'product', 'p1');
    assert.deepEqual({ ...got }, { ad_unit_id: 'au_42' });
  });

  test('store TTL: set with ttlSeconds expires after grace window', async () => {
    const store = createCtxMetadataStore({ backend: redisCtxMetadataStore(client) });
    await store.set('acct1', 'product', 'p1', { ad_unit_id: 'au_42' }, 3600);
    // scopeCtxMetadataKey joins segments with U+001F.
    const ttl = await client.ttl('adcp:ctx_meta:acct1\x1fproduct\x1fp1');
    assert.ok(ttl > 3600 && ttl <= 3661, `expected Redis TTL ~3660s, got ${ttl}`);
  });

  // ────────── unicode / nested edge cases ──────────

  test('round-trips nested structures and unicode', async () => {
    const backend = redisCtxMetadataStore(client);
    const value = {
      ad_unit_id: 'au_日本',
      targeting: [
        { key: 'café', value: 5000.5 },
        { key: 'tag\\with\\slashes', nested: { deep: ['a', 'b', null] } },
      ],
    };
    await backend.put('a:product:json', { value });
    const got = await backend.get('a:product:json');
    assert.deepEqual(got.value, value);
  });
});
