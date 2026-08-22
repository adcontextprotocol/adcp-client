const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdempotencyStore,
  memoryBackend,
  createLazyBackend,
  hashPayload,
} = require('../../dist/lib/server/index.js');

function makeStore(opts = {}) {
  return createIdempotencyStore({
    backend: memoryBackend({ sweepIntervalMs: 0 }),
    ttlSeconds: opts.ttlSeconds ?? 86400,
    clockSkewSeconds: opts.clockSkewSeconds ?? 60,
  });
}

describe('createIdempotencyStore', () => {
  describe('config validation', () => {
    it('throws helpful error when called with no config', () => {
      assert.throws(() => createIdempotencyStore(), /config\.backend is required|requires an IdempotencyStoreConfig/);
    });

    it('throws helpful error when backend is missing', () => {
      assert.throws(() => createIdempotencyStore({}), /config\.backend is required/);
    });

    it('error message names memoryBackend and pgBackend as the two options', () => {
      try {
        createIdempotencyStore({});
        assert.fail('should have thrown');
      } catch (err) {
        assert.match(err.message, /memoryBackend/);
        assert.match(err.message, /pgBackend/);
      }
    });

    it('rejects a custom backend without atomic owner fencing', () => {
      const backend = {
        get: async () => null,
        putIfAbsent: async () => true,
        replaceIfPayloadHash: true,
        replaceIfPayloadHashAndExpired: true,
        deleteIfPayloadHash: true,
        put: async () => {},
        delete: async () => {},
      };
      assert.throws(
        () => createIdempotencyStore({ backend }),
        /atomic putIfAbsent, replaceIfPayloadHash, replaceIfPayloadHashAndExpired, and deleteIfPayloadHash fencing/
      );
    });

    it('rejects a custom backend without atomic first-owner claiming', () => {
      const backend = {
        get: async () => null,
        replaceIfPayloadHash: async () => true,
        replaceIfPayloadHashAndExpired: async () => true,
        deleteIfPayloadHash: async () => true,
        put: async () => {},
        delete: async () => {},
      };
      assert.throws(() => createIdempotencyStore({ backend }), /requires atomic putIfAbsent/);
    });

    it('rejects a custom backend without atomic expired-owner replacement', () => {
      const backend = {
        get: async () => null,
        putIfAbsent: async () => true,
        replaceIfPayloadHash: async () => true,
        deleteIfPayloadHash: async () => true,
        put: async () => {},
        delete: async () => {},
      };
      assert.throws(
        () => createIdempotencyStore({ backend }),
        /requires atomic putIfAbsent, replaceIfPayloadHash, replaceIfPayloadHashAndExpired, and deleteIfPayloadHash/
      );
    });
  });

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

    it('rejects invalid clock skew values', () => {
      for (const clockSkewSeconds of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => makeStore({ clockSkewSeconds }), /clockSkewSeconds must be a non-negative safe integer/);
      }
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
      const { payloadHash, claimToken } = await store.check({ principal: 'p1', key: 'k1', payload });
      await store.save({
        principal: 'p1',
        key: 'k1',
        payloadHash,
        claimToken,
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
      const { payloadHash, claimToken } = await store.check({ principal: 'p1', key: 'k1', payload: p1 });
      await store.save({
        principal: 'p1',
        key: 'k1',
        payloadHash,
        claimToken,
        response: { media_buy_id: 'mb_42' },
      });
      const result = await store.check({ principal: 'p1', key: 'k1', payload: p2 });
      assert.equal(result.kind, 'conflict');
    });

    it('returns conflict immediately when an active claim has a different payload', async () => {
      const store = makeStore();
      const first = await store.check({ principal: 'p1', key: 'active-key', payload: { budget: 5000 } });
      assert.equal(first.kind, 'miss');

      const exactRetry = await store.check({ principal: 'p1', key: 'active-key', payload: { budget: 5000 } });
      const changedRetry = await store.check({ principal: 'p1', key: 'active-key', payload: { budget: 9999 } });

      assert.equal(exactRetry.kind, 'in-flight');
      assert.equal(changedRetry.kind, 'conflict');
    });

    it('treats missing-vs-explicit-null as different payloads', async () => {
      const store = makeStore();
      const p1 = { budget: 5000, coupon: null };
      const p2 = { budget: 5000 };
      const { payloadHash, claimToken } = await store.check({ principal: 'p1', key: 'k1', payload: p1 });
      await store.save({ principal: 'p1', key: 'k1', payloadHash, claimToken, response: {} });
      const result = await store.check({ principal: 'p1', key: 'k1', payload: p2 });
      assert.equal(result.kind, 'conflict');
    });

    it('key-reordering does NOT cause conflict (canonical equivalence)', async () => {
      const store = makeStore();
      const p1 = { a: 1, b: 2, c: 3 };
      const p2 = { c: 3, a: 1, b: 2 };
      const { payloadHash, claimToken } = await store.check({ principal: 'p1', key: 'k1', payload: p1 });
      await store.save({ principal: 'p1', key: 'k1', payloadHash, claimToken, response: 'cached' });
      const result = await store.check({ principal: 'p1', key: 'k1', payload: p2 });
      assert.equal(result.kind, 'replay');
    });
  });

  describe('per-principal scoping', () => {
    it('same key under different principals are independent', async () => {
      const store = makeStore();
      const payload = { x: 1 };
      const { payloadHash, claimToken } = await store.check({ principal: 'p1', key: 'k1', payload });
      await store.save({ principal: 'p1', key: 'k1', payloadHash, claimToken, response: 'from-p1' });
      const otherResult = await store.check({ principal: 'p2', key: 'k1', payload });
      assert.equal(otherResult.kind, 'miss', 'principal p2 should not see p1 cache');
    });
  });

  it('rejects ambiguous or unbounded scope segments before backend access', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    let backendReads = 0;
    const get = backend.get.bind(backend);
    backend.get = async key => {
      backendReads += 1;
      return get(key);
    };
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600 });

    for (const principal of ['', `tenant\u001fother`, 'x'.repeat(4097)]) {
      await assert.rejects(store.check({ principal, key: 'scope_key_abcdefgh', payload: {} }), /Invalid idempotency/);
    }
    for (const extraScope of ['', `session\u001fother`, 'x'.repeat(4097)]) {
      await assert.rejects(
        store.check({ principal: 'tenant', key: 'scope_key_abcdefgh', payload: {}, extraScope }),
        /Invalid idempotency/
      );
    }
    for (const key of ['', `scope\u001fkey`, 'x'.repeat(4097)]) {
      await assert.rejects(store.check({ principal: 'tenant', key, payload: {} }), /Invalid idempotency/);
    }
    assert.equal(backendReads, 0);
  });

  it('rejects a crafted key that aliases an extra-scope entry across every public lifecycle method', async () => {
    const store = makeStore();
    const principal = 'tenant';
    const extraScope = 'session';
    const key = 'legitimate-key';
    const craftedKey = `${extraScope}\u001f${key}`;
    const payload = { budget: 100 };
    const claim = await store.check({ principal, key, payload, extraScope });
    assert.equal(claim.kind, 'miss');

    await assert.rejects(store.check({ principal, key: craftedKey, payload }), /Invalid idempotency key/);
    await assert.rejects(
      store.renew({ principal, key: craftedKey, claimToken: claim.claimToken }),
      /Invalid idempotency key/
    );
    await assert.rejects(
      store.save({
        principal,
        key: craftedKey,
        payloadHash: claim.payloadHash,
        claimToken: claim.claimToken,
        response: 'poisoned',
      }),
      /Invalid idempotency key/
    );
    await assert.rejects(
      store.release({ principal, key: craftedKey, claimToken: claim.claimToken }),
      /Invalid idempotency key/
    );
    await assert.rejects(
      store.saveTransientError({
        principal,
        key: craftedKey,
        payloadHash: claim.payloadHash,
        claimToken: claim.claimToken,
        response: 'poisoned',
      }),
      /Invalid idempotency key/
    );

    await store.save({
      principal,
      key,
      payloadHash: claim.payloadHash,
      claimToken: claim.claimToken,
      response: 'scoped-result',
      extraScope,
    });
    assert.deepEqual(await store.check({ principal, key, payload, extraScope }), {
      kind: 'replay',
      response: 'scoped-result',
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
      const { payloadHash, claimToken } = await store.check({ principal: 'p', key: 'k', payload: p1 });
      await store.save({ principal: 'p', key: 'k', payloadHash, claimToken, response: 'cached' });
      const result = await store.check({ principal: 'p', key: 'k', payload: p2 });
      assert.equal(result.kind, 'replay');
    });

    it('ignores governance_context (refreshed tokens allowed)', async () => {
      const store = makeStore();
      const p1 = { governance_context: 'token_v1', budget: 5000 };
      const p2 = { governance_context: 'token_v2', budget: 5000 };
      const { payloadHash, claimToken } = await store.check({ principal: 'p', key: 'k', payload: p1 });
      await store.save({ principal: 'p', key: 'k', payloadHash, claimToken, response: 'cached' });
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
      const { payloadHash, claimToken } = await store.check({ principal: 'p', key: 'k', payload: p1 });
      await store.save({ principal: 'p', key: 'k', payloadHash, claimToken, response: 'cached' });
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

    it('ignores reporting_webhook.authentication.credentials but keeps routing fields', async () => {
      const store = makeStore();
      const p1 = {
        budget: 5000,
        reporting_webhook: {
          url: 'https://reports.example/hook',
          reporting_frequency: 'daily',
          authentication: { scheme: 'HMAC-SHA256', credentials: 'secret_v1' },
        },
      };
      const p2 = {
        ...p1,
        reporting_webhook: {
          ...p1.reporting_webhook,
          authentication: { scheme: 'HMAC-SHA256', credentials: 'secret_v2' },
        },
      };
      const { payloadHash, claimToken } = await store.check({ principal: 'p', key: 'k', payload: p1 });
      await store.save({ principal: 'p', key: 'k', payloadHash, claimToken, response: 'cached' });
      assert.equal((await store.check({ principal: 'p', key: 'k', payload: p2 })).kind, 'replay');

      const differentFrequency = {
        ...p2,
        reporting_webhook: { ...p2.reporting_webhook, reporting_frequency: 'hourly' },
      };
      assert.equal((await store.check({ principal: 'p', key: 'k', payload: differentFrequency })).kind, 'conflict');
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

    it('keeps just-expired in-flight claims fenced through clock skew', async () => {
      const backend = memoryBackend({ sweepIntervalMs: 0 });
      const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 60 });
      const payload = { budget: 42 };
      const hash = hashPayload(payload);
      const expiresAt = Math.floor(Date.now() / 1000) - 30;
      await backend.put('p\u001fclaim-skew', {
        payloadHash: `__adcp_in_flight__:${hash}:owner`,
        response: null,
        expiresAt,
        retainUntil: expiresAt + 60,
      });

      const result = await store.check({ principal: 'p', key: 'claim-skew', payload });
      assert.equal(result.kind, 'in-flight');
      assert.equal((await backend.get('p\u001fclaim-skew')).expiresAt, expiresAt);
    });

    it('persists a physical retention horizon through the configured clock-skew window', async () => {
      const backend = memoryBackend({ sweepIntervalMs: 0 });
      const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 90 });
      const payload = { budget: 42 };
      const claim = await store.check({ principal: 'p', key: 'retention-key', payload });
      await store.save({
        principal: 'p',
        key: 'retention-key',
        payloadHash: claim.payloadHash,
        claimToken: claim.claimToken,
        response: { media_buy_id: 'retained-buy' },
      });

      const persisted = await backend.get('p\u001fretention-key');
      assert.equal(persisted.retainUntil - persisted.expiresAt, 90);
    });

    it('retains transient failures through the configured clock-skew horizon', async () => {
      const backend = memoryBackend({ sweepIntervalMs: 0 });
      const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 90 });
      const claim = await store.check({ principal: 'p', key: 'transient-retention-key', payload: { budget: 42 } });
      await store.saveTransientError({
        principal: 'p',
        key: 'transient-retention-key',
        payloadHash: claim.payloadHash,
        claimToken: claim.claimToken,
        response: { error: 'temporary' },
      });

      const persisted = await backend.get('p\u001ftransient-retention-key');
      assert.equal(persisted.retainUntil - persisted.expiresAt, 90);
    });

    it('memory sweeping preserves entries until the physical retention horizon', async () => {
      const originalNow = Date.now;
      let nowMs = originalNow();
      Date.now = () => nowMs;
      const backend = memoryBackend({ sweepIntervalMs: 5 });
      try {
        const nowSeconds = Math.floor(nowMs / 1000);
        await backend.put('retained-through-skew', {
          payloadHash: 'hash',
          response: { media_buy_id: 'retained-buy' },
          expiresAt: nowSeconds - 1,
          retainUntil: nowSeconds + 60,
        });

        await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(await backend.get('retained-through-skew'));

        nowMs += 61_000;
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(await backend.get('retained-through-skew'), null);
      } finally {
        Date.now = originalNow;
        await backend.close();
      }
    });
  });

  describe('capability()', () => {
    it('returns the clamped TTL', () => {
      const store = makeStore({ ttlSeconds: 3600 });
      assert.deepEqual(store.capability(), { replay_ttl_seconds: 3600 });
    });
  });
});

describe('createLazyBackend', () => {
  it('exposes declared legacy retention grace for synchronous store validation', () => {
    const backend = createLazyBackend(async () => memoryBackend({ sweepIntervalMs: 0 }), {
      legacyRetentionGraceSeconds: 60,
    });
    assert.throws(
      () => createIdempotencyStore({ backend, clockSkewSeconds: 120 }),
      /legacy retention grace \(60s\) must be at least clockSkewSeconds \(120s\)/
    );
  });

  it('rejects an unsafe resolved backend even when its grace was not known at construction', async () => {
    const backend = createLazyBackend(async () => ({
      ...memoryBackend({ sweepIntervalMs: 0 }),
      legacyRetentionGraceSeconds: 60,
    }));
    createIdempotencyStore({ backend, clockSkewSeconds: 120 });
    await assert.rejects(
      () => backend.get('p\u001fk'),
      error =>
        error?.cause?.message ===
        'createLazyBackend: resolved backend legacy retention grace (60s) must be at least clockSkewSeconds (120s).'
    );
  });

  it('rejects a resolved backend without atomic first-owner claiming', async () => {
    const backend = createLazyBackend(async () => {
      const inner = memoryBackend({ sweepIntervalMs: 0 });
      return {
        get: inner.get,
        put: inner.put,
        replaceIfPayloadHash: inner.replaceIfPayloadHash,
        replaceIfPayloadHashAndExpired: inner.replaceIfPayloadHashAndExpired,
        deleteIfPayloadHash: inner.deleteIfPayloadHash,
        delete: inner.delete,
      };
    });

    await assert.rejects(
      () => backend.get('p\u001fk'),
      error =>
        error?.cause?.message ===
        'createLazyBackend: resolved backend must support atomic putIfAbsent, replaceIfPayloadHash, replaceIfPayloadHashAndExpired, and deleteIfPayloadHash fencing.'
    );
  });

  it('rejects a resolved backend without atomic expired-owner replacement', async () => {
    const backend = createLazyBackend(async () => {
      const { replaceIfPayloadHashAndExpired: _omitted, ...inner } = memoryBackend({ sweepIntervalMs: 0 });
      return inner;
    });

    await assert.rejects(
      () => backend.get('p\u001fk'),
      error =>
        error?.cause?.message ===
        'createLazyBackend: resolved backend must support atomic putIfAbsent, replaceIfPayloadHash, replaceIfPayloadHashAndExpired, and deleteIfPayloadHash fencing.'
    );
  });

  it('retains the largest skew required by stores sharing one unresolved backend', async () => {
    const backend = createLazyBackend(async () => ({
      ...memoryBackend({ sweepIntervalMs: 0 }),
      legacyRetentionGraceSeconds: 60,
    }));
    createIdempotencyStore({ backend, clockSkewSeconds: 120 });
    createIdempotencyStore({ backend, clockSkewSeconds: 0 });
    await assert.rejects(
      () => backend.get('p\u001fk'),
      error =>
        error?.cause?.message ===
        'createLazyBackend: resolved backend legacy retention grace (60s) must be at least clockSkewSeconds (120s).'
    );
  });

  it('resolves the backend on first operation', async () => {
    let calls = 0;
    const inner = memoryBackend({ sweepIntervalMs: 0 });
    const backend = createLazyBackend(async () => {
      calls += 1;
      return inner;
    });

    assert.equal(calls, 0);
    const expiresAt = futureSeconds();
    await backend.put('p\u001fk', { payloadHash: 'hash', response: { ok: true }, expiresAt });
    assert.equal(calls, 1);
    assert.deepEqual(await backend.get('p\u001fk'), {
      payloadHash: 'hash',
      response: { ok: true },
      expiresAt,
      retainUntil: expiresAt,
    });
  });

  it('shares one factory invocation across concurrent first operations', async () => {
    let calls = 0;
    let releaseFactory;
    const factoryReady = new Promise(resolve => {
      releaseFactory = resolve;
    });
    const inner = memoryBackend({ sweepIntervalMs: 0 });
    const backend = createLazyBackend(async () => {
      calls += 1;
      await factoryReady;
      return inner;
    });

    const expiresAt = futureSeconds();
    const entry = { payloadHash: 'hash', response: 'cached', expiresAt, retainUntil: expiresAt };
    const putA = backend.put('p\u001fk-a', entry);
    const putB = backend.put('p\u001fk-b', entry);
    await Promise.resolve();
    assert.equal(calls, 1);
    releaseFactory();
    await Promise.all([putA, putB]);
    assert.deepEqual(await backend.get('p\u001fk-a'), entry);
    assert.deepEqual(await backend.get('p\u001fk-b'), entry);
    assert.equal(calls, 1);
  });

  it('probe triggers resolution and delegates to the resolved backend', async () => {
    let calls = 0;
    let probes = 0;
    const backend = createLazyBackend(async () => {
      calls += 1;
      return {
        ...memoryBackend({ sweepIntervalMs: 0 }),
        async probe() {
          probes += 1;
        },
      };
    });

    await backend.probe();
    assert.equal(calls, 1);
    assert.equal(probes, 1);
  });

  it('close is safe before the factory has resolved', async () => {
    let calls = 0;
    const backend = createLazyBackend(async () => {
      calls += 1;
      return memoryBackend({ sweepIntervalMs: 0 });
    });

    await backend.close();
    assert.equal(calls, 0);
  });

  it('does not expose clearAll by default at the store boundary', () => {
    const backend = createLazyBackend(async () => memoryBackend({ sweepIntervalMs: 0 }));
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600 });

    assert.equal(typeof backend.clearAll, 'undefined');
    assert.equal(typeof store.clearAll, 'undefined');
  });

  it('delegates clearAll only when explicitly enabled', async () => {
    const backend = createLazyBackend(async () => memoryBackend({ sweepIntervalMs: 0 }), { clearAll: true });
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600 });
    const expiresAt = futureSeconds();

    assert.equal(typeof backend.clearAll, 'function');
    assert.equal(typeof store.clearAll, 'function');
    await backend.put('p\u001fk', { payloadHash: 'hash', response: 'cached', expiresAt });
    assert.deepEqual(await backend.get('p\u001fk'), {
      payloadHash: 'hash',
      response: 'cached',
      expiresAt,
      retainUntil: expiresAt,
    });
    await store.clearAll();
    assert.equal(await backend.get('p\u001fk'), null);
  });

  it('retries factory resolution after a failed attempt', async () => {
    let calls = 0;
    const inner = memoryBackend({ sweepIntervalMs: 0 });
    const backend = createLazyBackend(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary redis bootstrap failure');
      return inner;
    });

    await assert.rejects(() => backend.get('p\u001fk'), /failed to resolve idempotency backend/);
    const expiresAt = futureSeconds();
    await backend.put('p\u001fk', { payloadHash: 'hash', response: 'cached', expiresAt });
    assert.equal(calls, 2);
    assert.deepEqual(await backend.get('p\u001fk'), {
      payloadHash: 'hash',
      response: 'cached',
      expiresAt,
      retainUntil: expiresAt,
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

function futureSeconds() {
  return Math.floor(Date.now() / 1000) + 3600;
}

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
    await store.release({ principal: 'p', key: 'release_test_abcdefg', claimToken: first.claimToken });

    const second = await store.check({ principal: 'p', key: 'release_test_abcdefg', payload });
    assert.equal(second.kind, 'miss', 'after release, key should be reclaimable');
  });

  it('release preserves the original payload binding', async () => {
    const store = makeStore();
    const first = await store.check({ principal: 'p', key: 'released_binding_abcdef', payload: { budget: 10 } });
    await store.release({ principal: 'p', key: 'released_binding_abcdef', claimToken: first.claimToken });

    const changed = await store.check({ principal: 'p', key: 'released_binding_abcdef', payload: { budget: 20 } });
    assert.equal(changed.kind, 'conflict');
  });

  for (const [label, delayedPayload, expectedKind] of [
    ['exact payload', { budget: 10 }, 'in-flight'],
    ['changed payload', { budget: 20 }, 'conflict'],
  ]) {
    it(`classifies ${label} correctly when release wins a pending claim race`, async () => {
      const delegate = memoryBackend({ sweepIntervalMs: 0 });
      let putCount = 0;
      let releaseFirstPut;
      let markFirstPut;
      const firstPutStarted = new Promise(resolve => {
        markFirstPut = resolve;
      });
      const firstPutGate = new Promise(resolve => {
        releaseFirstPut = resolve;
      });
      const backend = {
        ...delegate,
        putIfAbsent: async (...args) => {
          putCount += 1;
          if (putCount === 1) {
            markFirstPut();
            await firstPutGate;
          }
          return delegate.putIfAbsent(...args);
        },
      };
      const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 60 });
      const key = `release-race-${expectedKind}`;
      const delayed = store.check({ principal: 'p', key, payload: delayedPayload });
      await firstPutStarted;

      const owner = await store.check({ principal: 'p', key, payload: { budget: 10 } });
      assert.equal(owner.kind, 'miss');
      await store.release({ principal: 'p', key, claimToken: owner.claimToken });
      releaseFirstPut();

      assert.equal((await delayed).kind, expectedKind);
    });
  }
});

describe('request claim ownership fencing', () => {
  it('renew extends the owner lease beyond its original expiry', async () => {
    const originalNow = Date.now;
    let now = 2_000_000_000_000;
    Date.now = () => now;
    try {
      const store = makeStore({ clockSkewSeconds: 0 });
      const key = 'renew_owner_abcdefghij';
      const payload = { x: 1 };
      const owner = await store.check({ principal: 'p', key, payload });
      assert.equal(owner.kind, 'miss');

      now += 100_000;
      await store.renew({ principal: 'p', key, claimToken: owner.claimToken });
      now += 30_000;

      const retry = await store.check({ principal: 'p', key, payload });
      assert.equal(retry.kind, 'in-flight', 'renewed owner must still fence retries after the original 120s lease');
    } finally {
      Date.now = originalNow;
    }
  });

  it('a stale expiry read cannot reclaim a claim renewed before atomic expired-owner replacement', async () => {
    const delegate = memoryBackend({ sweepIntervalMs: 0 });
    const key = 'renewal_aba_abcdefghij';
    const scopedKey = `p\u001f${key}`;
    const owner = '__adcp_in_flight__:owner';
    await delegate.put(scopedKey, {
      payloadHash: owner,
      response: null,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });

    let releaseReplacement;
    let markReplacementReached;
    const replacementReached = new Promise(resolve => {
      markReplacementReached = resolve;
    });
    const replacementGate = new Promise(resolve => {
      releaseReplacement = resolve;
    });
    const backend = {
      ...delegate,
      replaceIfPayloadHashAndExpired: async (...args) => {
        markReplacementReached();
        await replacementGate;
        return delegate.replaceIfPayloadHashAndExpired(...args);
      },
    };
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 0 });
    const attempt = store.check({ principal: 'p', key, payload: { x: 1 } });
    await replacementReached;
    await delegate.replaceIfPayloadHash(scopedKey, owner, {
      payloadHash: owner,
      response: null,
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    releaseReplacement();

    assert.equal((await attempt).kind, 'in-flight');
  });

  it('a stale absent read cannot replace a newly expired request generation', async () => {
    const delegate = memoryBackend({ sweepIntervalMs: 0 });
    const key = 'absent_aba_abcdefghij';
    const scopedKey = `p\u001f${key}`;
    let releaseInitialRead;
    let markInitialRead;
    const initialReadReached = new Promise(resolve => {
      markInitialRead = resolve;
    });
    const initialReadGate = new Promise(resolve => {
      releaseInitialRead = resolve;
    });
    let blockFirstRead = true;
    const backend = {
      ...delegate,
      get: async keyToRead => {
        const snapshot = await delegate.get(keyToRead);
        if (blockFirstRead) {
          blockFirstRead = false;
          markInitialRead();
          await initialReadGate;
        }
        return snapshot;
      },
    };
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 0 });
    const staleAttempt = store.check({ principal: 'p', key, payload: { x: 'stale' } });
    await initialReadReached;
    const newerClaim = `__adcp_in_flight__:${hashPayload({ x: 'newer' })}:newer-owner`;
    await delegate.put(scopedKey, {
      payloadHash: newerClaim,
      response: null,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      retainUntil: Math.floor(Date.now() / 1000) + 300,
    });
    releaseInitialRead();

    assert.equal((await staleAttempt).kind, 'conflict');
    assert.equal((await delegate.get(scopedKey)).payloadHash, newerClaim);
  });

  it('treats a claim expiring exactly now as live until the next second', async () => {
    const originalNow = Date.now;
    const fixedNow = 2_000_000_000_000;
    Date.now = () => fixedNow;
    try {
      const backend = memoryBackend({ sweepIntervalMs: 0 });
      const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 0 });
      await backend.put('p\u001fequality_edge_abcdef', {
        payloadHash: '__adcp_in_flight__:owner',
        response: null,
        expiresAt: Math.floor(fixedNow / 1000),
      });
      const result = await store.check({ principal: 'p', key: 'equality_edge_abcdef', payload: {} });
      assert.equal(result.kind, 'in-flight');
    } finally {
      Date.now = originalNow;
    }
  });

  it('a stale owner cannot save over or release a reclaimed request', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const store = createIdempotencyStore({ backend, ttlSeconds: 3600, clockSkewSeconds: 0 });
    const key = 'stale_owner_abcdefghij';
    const scopedKey = `p\u001f${key}`;
    const payload = { x: 1 };

    const stale = await store.check({ principal: 'p', key, payload });
    assert.equal(stale.kind, 'miss');
    // Model a crashed request whose short execution lease has expired.
    const staleEntry = await backend.get(scopedKey);
    await backend.put(scopedKey, { ...staleEntry, expiresAt: Math.floor(Date.now() / 1000) - 1 });

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
    await assert.rejects(
      store.renew({ principal: 'p', key, claimToken: stale.claimToken }),
      /claim is no longer owned/
    );

    await store.save({
      principal: 'p',
      key,
      payloadHash: current.payloadHash,
      claimToken: current.claimToken,
      response: 'current',
    });
    const replay = await store.check({ principal: 'p', key, payload });
    assert.equal(replay.kind, 'replay');
    assert.equal(replay.response, 'current');
  });
});

describe('memory backend clone-on-read', () => {
  it('mutations to returned response do not leak into cache', async () => {
    const store = makeStore();
    const response = { media_buy_id: 'mb_42', packages: [] };
    const { payloadHash, claimToken } = await store.check({
      principal: 'p',
      key: 'clone_test_abcdefg',
      payload: { x: 1 },
    });
    await store.save({ principal: 'p', key: 'clone_test_abcdefg', payloadHash, claimToken, response });

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
      claimToken: miss1.claimToken,
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
