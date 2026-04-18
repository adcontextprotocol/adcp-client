const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createIdempotencyStore, memoryBackend, hashPayload } = require('../../dist/lib/server/index.js');

function makeStore(opts = {}) {
  return createIdempotencyStore({
    backend: memoryBackend({ sweepIntervalMs: 0 }),
    ttlSeconds: opts.ttlSeconds ?? 86400,
    clockSkewSeconds: opts.clockSkewSeconds ?? 60,
  });
}

describe('createIdempotencyStore', () => {
  describe('ttl bounds validation', () => {
    it('throws below 1h', () => {
      assert.throws(() => makeStore({ ttlSeconds: 100 }), /ttlSeconds must be >= 3600/);
    });

    it('throws above 7d', () => {
      assert.throws(() => makeStore({ ttlSeconds: 9999999 }), /ttlSeconds must be <= 604800/);
    });

    it('throws on non-integer', () => {
      assert.throws(() => makeStore({ ttlSeconds: 3600.5 }), /must be a finite integer/);
    });

    it('accepts valid TTL within bounds', () => {
      const s = makeStore({ ttlSeconds: 86400 });
      assert.equal(s.ttlSeconds, 86400);
      assert.equal(s.capability().replay_ttl_seconds, 86400);
    });
  });

  describe('check + save lifecycle', () => {
    it('returns miss on first check', async () => {
      const store = makeStore();
      const result = await store.check({
        principal: 'p1',
        key: 'k1',
        payload: { budget: 5000 },
      });
      assert.equal(result.kind, 'miss');
      assert.ok(result.payloadHash);
    });

    it('returns replay on matching payload retry', async () => {
      const store = makeStore();
      const payload = { budget: 5000, start: '2026-01-01' };
      const { payloadHash } = await store.check({ principal: 'p1', key: 'k1', payload });
      await store.save({
        principal: 'p1',
        key: 'k1',
        payloadHash,
        response: { media_buy_id: 'mb_42' },
      });
      const result = await store.check({ principal: 'p1', key: 'k1', payload });
      assert.equal(result.kind, 'replay');
      assert.deepEqual(result.response, { media_buy_id: 'mb_42' });
    });

    it('returns conflict on same-key different-payload', async () => {
      const store = makeStore();
      const p1 = { budget: 5000 };
      const p2 = { budget: 9999 };
      const { payloadHash } = await store.check({ principal: 'p1', key: 'k1', payload: p1 });
      await store.save({
        principal: 'p1',
        key: 'k1',
        payloadHash,
        response: { media_buy_id: 'mb_42' },
      });
      const result = await store.check({ principal: 'p1', key: 'k1', payload: p2 });
      assert.equal(result.kind, 'conflict');
    });

    it('treats missing-vs-explicit-null as different payloads', async () => {
      const store = makeStore();
      const p1 = { budget: 5000, coupon: null };
      const p2 = { budget: 5000 };
      const { payloadHash } = await store.check({ principal: 'p1', key: 'k1', payload: p1 });
      await store.save({ principal: 'p1', key: 'k1', payloadHash, response: {} });
      const result = await store.check({ principal: 'p1', key: 'k1', payload: p2 });
      assert.equal(result.kind, 'conflict');
    });

    it('key-reordering does NOT cause conflict (canonical equivalence)', async () => {
      const store = makeStore();
      const p1 = { a: 1, b: 2, c: 3 };
      const p2 = { c: 3, a: 1, b: 2 };
      const { payloadHash } = await store.check({ principal: 'p1', key: 'k1', payload: p1 });
      await store.save({ principal: 'p1', key: 'k1', payloadHash, response: 'cached' });
      const result = await store.check({ principal: 'p1', key: 'k1', payload: p2 });
      assert.equal(result.kind, 'replay');
    });
  });

  describe('per-principal scoping', () => {
    it('same key under different principals are independent', async () => {
      const store = makeStore();
      const payload = { x: 1 };
      const { payloadHash } = await store.check({ principal: 'p1', key: 'k1', payload });
      await store.save({ principal: 'p1', key: 'k1', payloadHash, response: 'from-p1' });
      const otherResult = await store.check({ principal: 'p2', key: 'k1', payload });
      assert.equal(otherResult.kind, 'miss', 'principal p2 should not see p1 cache');
    });
  });

  describe('exclusion list (hash only)', () => {
    it('ignores idempotency_key in payload hash', () => {
      // Use hashPayload directly since check() now has a side effect (writes
      // an in-flight claim), so a second check on the same (principal, key)
      // returns 'in-flight' rather than 'miss' with a hash.
      const h1 = hashPayload({ idempotency_key: 'abc', budget: 5000 });
      const h2 = hashPayload({ idempotency_key: 'xyz', budget: 5000 });
      assert.equal(h1, h2);
    });

    it('ignores context (varies on retry by design)', async () => {
      const store = makeStore();
      const p1 = { context: { correlation_id: 'first' }, budget: 5000 };
      const p2 = { context: { correlation_id: 'retry' }, budget: 5000 };
      const { payloadHash } = await store.check({ principal: 'p', key: 'k', payload: p1 });
      await store.save({ principal: 'p', key: 'k', payloadHash, response: 'cached' });
      const result = await store.check({ principal: 'p', key: 'k', payload: p2 });
      assert.equal(result.kind, 'replay');
    });

    it('ignores governance_context (refreshed tokens allowed)', async () => {
      const store = makeStore();
      const p1 = { governance_context: 'token_v1', budget: 5000 };
      const p2 = { governance_context: 'token_v2', budget: 5000 };
      const { payloadHash } = await store.check({ principal: 'p', key: 'k', payload: p1 });
      await store.save({ principal: 'p', key: 'k', payloadHash, response: 'cached' });
      const result = await store.check({ principal: 'p', key: 'k', payload: p2 });
      assert.equal(result.kind, 'replay');
    });

    it('ignores push_notification_config.authentication.credentials but keeps url', async () => {
      const store = makeStore();
      const p1 = {
        budget: 5000,
        push_notification_config: {
          url: 'https://webhook.example/hook',
          authentication: { scheme: 'Bearer', credentials: 'token_v1' },
        },
      };
      const p2 = {
        budget: 5000,
        push_notification_config: {
          url: 'https://webhook.example/hook',
          authentication: { scheme: 'Bearer', credentials: 'token_v2' },
        },
      };
      const { payloadHash } = await store.check({ principal: 'p', key: 'k', payload: p1 });
      await store.save({ principal: 'p', key: 'k', payloadHash, response: 'cached' });
      assert.equal((await store.check({ principal: 'p', key: 'k', payload: p2 })).kind, 'replay');

      // URL change IS a conflict (not in exclusion list)
      const p3 = {
        budget: 5000,
        push_notification_config: {
          url: 'https://attacker.example/hook', // different URL
          authentication: { scheme: 'Bearer', credentials: 'token_v1' },
        },
      };
      assert.equal((await store.check({ principal: 'p', key: 'k', payload: p3 })).kind, 'conflict');
    });
  });

  describe('expired entries', () => {
    it('returns expired when past TTL + clock skew', async () => {
      const backend = memoryBackend({ sweepIntervalMs: 0 });
      const expiredStore = createIdempotencyStore({
        backend,
        ttlSeconds: 3600,
        clockSkewSeconds: 60,
      });
      const scopedKey = 'p\u001fk';
      await backend.put(scopedKey, {
        payloadHash: 'anyhash',
        response: {},
        expiresAt: Math.floor(Date.now() / 1000) - 120, // 120s ago, past 60s skew
      });
      const result = await expiredStore.check({ principal: 'p', key: 'k', payload: {} });
      assert.equal(result.kind, 'expired');
    });

    it('clock-skew tolerance allows just-expired entries', async () => {
      const backend = memoryBackend({ sweepIntervalMs: 0 });
      const store = createIdempotencyStore({
        backend,
        ttlSeconds: 3600,
        clockSkewSeconds: 60,
      });
      const scopedKey = 'p\u001fk';
      const payload = { x: 1 };
      const hash = hashPayload(payload);
      // Entry expired 30s ago — still within 60s skew window
      await backend.put(scopedKey, {
        payloadHash: hash,
        response: 'cached',
        expiresAt: Math.floor(Date.now() / 1000) - 30,
      });
      const result = await store.check({ principal: 'p', key: 'k', payload });
      assert.equal(result.kind, 'replay');
    });
  });

  describe('capability()', () => {
    it('returns the clamped TTL', () => {
      const store = makeStore({ ttlSeconds: 3600 });
      assert.deepEqual(store.capability(), { replay_ttl_seconds: 3600 });
    });
  });
});

describe('hashPayload', () => {
  it('strips exclusion fields before hashing', () => {
    const h1 = hashPayload({ idempotency_key: 'a', x: 1 });
    const h2 = hashPayload({ x: 1 });
    assert.equal(h1, h2);
  });

  it('produces stable hashes regardless of key order', () => {
    assert.equal(hashPayload({ a: 1, b: 2 }), hashPayload({ b: 2, a: 1 }));
  });

  it('excludes context only when it is an object (echo-back shape)', () => {
    // Object context (echo-back) is excluded from the hash
    assert.equal(
      hashPayload({ x: 1, context: { correlation_id: 'a' } }),
      hashPayload({ x: 1, context: { correlation_id: 'b' } })
    );

    // String context (SI handoff description) is load-bearing and NOT excluded
    assert.notEqual(
      hashPayload({ x: 1, context: 'handoff description A' }),
      hashPayload({ x: 1, context: 'handoff description B' })
    );
  });
});

describe('concurrent same-key claim race', () => {
  it('only one of N parallel checks wins the claim', async () => {
    const store = makeStore();
    const payload = { budget: 5000 };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.check({ principal: 'p1', key: 'shared_key_abcdefghij', payload }))
    );

    const misses = results.filter(r => r.kind === 'miss');
    const inFlights = results.filter(r => r.kind === 'in-flight');

    assert.equal(misses.length, 1, 'exactly one caller should see miss');
    assert.equal(misses.length + inFlights.length, 10, 'all others see in-flight');
  });
});

describe('release (in-flight claim rollback)', () => {
  it('release lets a retry re-claim and re-execute', async () => {
    const store = makeStore();
    const payload = { x: 1 };

    const first = await store.check({ principal: 'p', key: 'release_test_abcdefg', payload });
    assert.equal(first.kind, 'miss');

    // Without release, a retry would see 'in-flight'
    await store.release({ principal: 'p', key: 'release_test_abcdefg' });

    const second = await store.check({ principal: 'p', key: 'release_test_abcdefg', payload });
    assert.equal(second.kind, 'miss', 'after release, key should be reclaimable');
  });
});

describe('memory backend clone-on-read', () => {
  it('mutations to returned response do not leak into cache', async () => {
    const store = makeStore();
    const response = { media_buy_id: 'mb_42', packages: [] };
    const { payloadHash } = await store.check({ principal: 'p', key: 'clone_test_abcdefg', payload: { x: 1 } });
    await store.save({ principal: 'p', key: 'clone_test_abcdefg', payloadHash, response });

    const r1 = await store.check({ principal: 'p', key: 'clone_test_abcdefg', payload: { x: 1 } });
    assert.equal(r1.kind, 'replay');
    // Mutate the returned response
    r1.response.media_buy_id = 'MUTATED';
    r1.response.packages.push({ package_id: 'injected' });

    const r2 = await store.check({ principal: 'p', key: 'clone_test_abcdefg', payload: { x: 1 } });
    assert.equal(r2.kind, 'replay');
    assert.equal(r2.response.media_buy_id, 'mb_42', 'cache should not be affected by caller mutation');
    assert.equal(r2.response.packages.length, 0);
  });
});

describe('extra scope (si_send_message)', () => {
  it('same key under different sessions does not cross-replay', async () => {
    const store = makeStore();
    const payload = { message: 'hello' };

    const miss1 = await store.check({
      principal: 'p1',
      key: 'si_key_abcdefghij1234',
      payload,
      extraScope: 'session_A',
    });
    assert.equal(miss1.kind, 'miss');
    await store.save({
      principal: 'p1',
      key: 'si_key_abcdefghij1234',
      payloadHash: miss1.payloadHash,
      response: { reply: 'from session A' },
      extraScope: 'session_A',
    });

    // Same principal, same key, DIFFERENT session — must miss, not replay
    const miss2 = await store.check({
      principal: 'p1',
      key: 'si_key_abcdefghij1234',
      payload,
      extraScope: 'session_B',
    });
    assert.equal(miss2.kind, 'miss', 'different session must not replay');
  });
});
