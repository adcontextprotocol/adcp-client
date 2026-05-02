'use strict';

// Stage 5 of #1269 — `BuyerAgentRegistry.cached` decorator.
//
// Tests the caching decorator's contracts:
//   - TTL-bounded
//   - LRU-evicted on max-size overflow
//   - Concurrent-resolve coalesced (one upstream call per N parallel resolves)
//   - Per-kind cache keys (no cross-kind collisions)
//   - Skips uncacheable inputs (credential === undefined → pass-through)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { BuyerAgentRegistry, markVerifiedHttpSig } = require('../../dist/lib/server/decisioning/buyer-agent');

const sampleAgent = (overrides = {}) => ({
  agent_url: 'https://agent.scope3.com',
  display_name: 'Scope3',
  status: 'active',
  billing_capabilities: new Set(['operator']),
  ...overrides,
});

const sigCredential = (overrides = {}) =>
  markVerifiedHttpSig({
    kind: 'http_sig',
    keyid: 'kid',
    agent_url: 'https://agent.scope3.com',
    verified_at: 1714660000,
    ...overrides,
  });

const apiKeyCredential = (overrides = {}) => ({
  kind: 'api_key',
  key_id: 'hashed_key_id',
  ...overrides,
});

const oauthCredential = (overrides = {}) => ({
  kind: 'oauth',
  client_id: 'oauth_client_xyz',
  scopes: [],
  ...overrides,
});

describe('BuyerAgentRegistry.cached — basic semantics', () => {
  it('serves a cache hit on a second call with the same credential within TTL', async () => {
    let upstreamCalls = 0;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async url => {
        upstreamCalls++;
        return sampleAgent({ agent_url: url });
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    const first = await registry.resolve({ credential: sigCredential() });
    const second = await registry.resolve({ credential: sigCredential() });

    assert.equal(upstreamCalls, 1, 'second call MUST hit cache, not upstream');
    assert.equal(first.agent_url, 'https://agent.scope3.com');
    assert.equal(second.agent_url, 'https://agent.scope3.com');
  });

  it('expires entries after TTL and re-resolves upstream', async () => {
    let nowMs = 1_000_000;
    let upstreamCalls = 0;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        upstreamCalls++;
        return sampleAgent();
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, {
      ttlSeconds: 30,
      now: () => nowMs,
    });

    await registry.resolve({ credential: sigCredential() });
    nowMs += 29_000; // 29s later — within TTL
    await registry.resolve({ credential: sigCredential() });
    assert.equal(upstreamCalls, 1, 'within TTL → still cached');

    nowMs += 2_000; // 31s total — TTL expired
    await registry.resolve({ credential: sigCredential() });
    assert.equal(upstreamCalls, 2, 'past TTL → upstream re-resolves');
  });

  it('does NOT cache nulls by default (cacheNullsTtlSeconds defaults to 0)', async () => {
    let upstreamCalls = 0;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        upstreamCalls++;
        return null;
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    await registry.resolve({ credential: sigCredential() });
    await registry.resolve({ credential: sigCredential() });
    assert.equal(
      upstreamCalls,
      2,
      'nulls must NOT be cached by default — freshly onboarded agents are recognized within one request'
    );
  });

  it('caches nulls when cacheNullsTtlSeconds > 0', async () => {
    let upstreamCalls = 0;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        upstreamCalls++;
        return null;
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, {
      ttlSeconds: 60,
      cacheNullsTtlSeconds: 10,
    });

    await registry.resolve({ credential: sigCredential() });
    await registry.resolve({ credential: sigCredential() });
    assert.equal(upstreamCalls, 1, 'nulls cached for cacheNullsTtlSeconds');
  });

  it('skips caching when credential is undefined (pass-through to inner)', async () => {
    // signingOnly's guard returns null before invoking the resolver,
    // so we count cache-side calls via inner.resolve invocations.
    let innerResolveCalls = 0;
    const inner = {
      async resolve() {
        innerResolveCalls++;
        return null;
      },
    };
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    await registry.resolve({}); // no credential
    await registry.resolve({}); // no credential
    // Pass-through: every call hits inner.resolve directly; the cache
    // is never consulted because the credential is uncacheable.
    assert.equal(innerResolveCalls, 2, 'undefined credential MUST pass through to inner on every call');
  });
});

describe('BuyerAgentRegistry.cached — per-kind cache keys', () => {
  it('different credential kinds are cached independently (no cross-kind collision)', async () => {
    const calls = [];
    const inner = BuyerAgentRegistry.mixed({
      resolveByAgentUrl: async url => {
        calls.push({ kind: 'signed', url });
        return sampleAgent({ agent_url: url, display_name: 'signed-resolved' });
      },
      resolveByCredential: async cred => {
        calls.push({ kind: cred.kind, value: cred.kind === 'api_key' ? cred.key_id : cred.client_id });
        return sampleAgent({ display_name: `${cred.kind}-resolved` });
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    // Same string value across kinds — must NOT collide.
    const collisionValue = 'collision';
    await registry.resolve({
      credential: markVerifiedHttpSig({
        kind: 'http_sig',
        keyid: 'k',
        agent_url: collisionValue,
        verified_at: 0,
      }),
    });
    await registry.resolve({ credential: { kind: 'api_key', key_id: collisionValue } });
    await registry.resolve({ credential: { kind: 'oauth', client_id: collisionValue, scopes: [] } });

    assert.equal(calls.length, 3, 'one upstream call per kind despite identical value strings');
    assert.deepEqual(calls.map(c => c.kind).sort(), ['api_key', 'oauth', 'signed']);
  });

  it('different agent_url values within the same kind are cached separately', async () => {
    const urls = [];
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async url => {
        urls.push(url);
        return sampleAgent({ agent_url: url });
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    await registry.resolve({ credential: sigCredential({ agent_url: 'https://agent-a.com' }) });
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://agent-b.com' }) });
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://agent-a.com' }) });

    assert.deepEqual(urls, ['https://agent-a.com', 'https://agent-b.com']);
  });
});

describe('BuyerAgentRegistry.cached — concurrent resolve coalescing', () => {
  it('N parallel resolves on the same key produce ONE upstream call', async () => {
    let upstreamCalls = 0;
    let release;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        upstreamCalls++;
        // Block until the test releases — simulates a slow upstream.
        await new Promise(resolve => {
          release = resolve;
        });
        return sampleAgent();
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    // Fire 10 parallel resolves on the same key.
    const promises = Array.from({ length: 10 }, () => registry.resolve({ credential: sigCredential() }));

    // Wait one microtask so all 10 enter the inFlight check.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(upstreamCalls, 1, 'parallel resolves MUST coalesce to one upstream call');

    release();
    const results = await Promise.all(promises);
    assert.equal(results.length, 10);
    assert.equal(
      results.every(r => r?.agent_url === 'https://agent.scope3.com'),
      true
    );
  });

  it('coalesced resolves all see the same result reference (no duplication)', async () => {
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => sampleAgent(),
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    const [a, b, c] = await Promise.all([
      registry.resolve({ credential: sigCredential() }),
      registry.resolve({ credential: sigCredential() }),
      registry.resolve({ credential: sigCredential() }),
    ]);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
  });

  it('expired entry triggers re-resolve without deadlock (inFlight released after settle)', async () => {
    let nowMs = 1_000_000;
    let upstreamCalls = 0;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        upstreamCalls++;
        return sampleAgent();
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 1, now: () => nowMs });

    await registry.resolve({ credential: sigCredential() });
    nowMs += 2_000; // expire
    await registry.resolve({ credential: sigCredential() }); // must succeed, not deadlock
    assert.equal(upstreamCalls, 2, 'expired entry → re-resolve');
  });

  it('rejected upstream propagates to all coalesced callers AND does not poison the cache', async () => {
    let upstreamCalls = 0;
    let mode = 'reject';
    const inner = {
      async resolve() {
        upstreamCalls++;
        // Yield once so concurrent callers can land in the inFlight map
        // before this one settles, then dispatch on the current mode.
        await new Promise(resolve => setImmediate(resolve));
        if (mode === 'reject') throw new Error('upstream DB outage');
        return sampleAgent();
      },
    };
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    // Phase 1: fire 5 parallel resolves; all should coalesce and reject.
    const promises = Array.from({ length: 5 }, () => registry.resolve({ credential: sigCredential() }));
    const settled = await Promise.allSettled(promises);
    assert.equal(upstreamCalls, 1, 'coalesced to one upstream call');
    assert.equal(
      settled.every(r => r.status === 'rejected' && r.reason.message === 'upstream DB outage'),
      true,
      'all coalesced callers see the same rejection'
    );

    // Phase 2: cache MUST NOT carry a poisoned entry; next call retries.
    mode = 'resolve';
    const result = await registry.resolve({ credential: sigCredential() });
    assert.equal(upstreamCalls, 2, 'rejected upstream did not cache; next call hits upstream again');
    assert.ok(result);
  });

  it('returned BuyerAgent is the same reference for coalesced callers AND for cache hits', async () => {
    const agent = sampleAgent();
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => agent,
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    const first = await registry.resolve({ credential: sigCredential() });
    const second = await registry.resolve({ credential: sigCredential() });
    assert.strictEqual(first, second, 'cache hit must return the same reference');
    // The cache freezes the value before sharing — defense-in-depth
    // against future mutation across coalesced callers.
    assert.equal(Object.isFrozen(first), true);
  });
});

describe('BuyerAgentRegistry.cached — invalidate / clear API', () => {
  it('invalidate(credential) drops the matching cache entry; next resolve hits upstream', async () => {
    let upstreamCalls = 0;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async url => {
        upstreamCalls++;
        return sampleAgent({ agent_url: url });
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    const cred = sigCredential();
    await registry.resolve({ credential: cred });
    await registry.resolve({ credential: cred });
    assert.equal(upstreamCalls, 1, 'second call cached');

    registry.invalidate(cred);
    await registry.resolve({ credential: cred });
    assert.equal(upstreamCalls, 2, 'invalidated key MUST re-resolve upstream');
  });

  it('invalidate(other) does NOT drop unrelated entries', async () => {
    let upstreamCalls = 0;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async url => {
        upstreamCalls++;
        return sampleAgent({ agent_url: url });
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    await registry.resolve({ credential: sigCredential({ agent_url: 'https://a.com' }) });
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://b.com' }) });
    assert.equal(upstreamCalls, 2);

    registry.invalidate(sigCredential({ agent_url: 'https://a.com' }));
    // b is still cached.
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://b.com' }) });
    assert.equal(upstreamCalls, 2, 'invalidate(a) MUST NOT drop b');
    // a re-resolves.
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://a.com' }) });
    assert.equal(upstreamCalls, 3);
  });

  it('clear() drops every entry', async () => {
    let upstreamCalls = 0;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async url => {
        upstreamCalls++;
        return sampleAgent({ agent_url: url });
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    await registry.resolve({ credential: sigCredential({ agent_url: 'https://a.com' }) });
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://b.com' }) });
    assert.equal(upstreamCalls, 2);

    registry.clear();

    await registry.resolve({ credential: sigCredential({ agent_url: 'https://a.com' }) });
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://b.com' }) });
    assert.equal(upstreamCalls, 4, 'clear() MUST evict all cached entries');
  });

  it('invalidate() on a never-cached credential is a no-op', async () => {
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => sampleAgent(),
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });
    // No resolves have happened — invalidate must not throw.
    registry.invalidate(sigCredential());
    registry.clear();
  });
});

describe('BuyerAgentRegistry.cached — LRU eviction', () => {
  it('evicts oldest entry when maxSize is reached', async () => {
    const lookups = [];
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async url => {
        lookups.push(url);
        return sampleAgent({ agent_url: url });
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60, maxSize: 2 });

    await registry.resolve({ credential: sigCredential({ agent_url: 'https://a.com' }) });
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://b.com' }) });
    // Cache holds [a, b]. Adding c evicts a (oldest).
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://c.com' }) });
    // Re-resolving a should hit upstream again (was evicted).
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://a.com' }) });

    assert.deepEqual(lookups, ['https://a.com', 'https://b.com', 'https://c.com', 'https://a.com']);
  });

  it('LRU touch on cache hit moves entry to most-recent (delays eviction)', async () => {
    const lookups = [];
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async url => {
        lookups.push(url);
        return sampleAgent({ agent_url: url });
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60, maxSize: 2 });

    await registry.resolve({ credential: sigCredential({ agent_url: 'https://a.com' }) });
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://b.com' }) });
    // Touch `a` — now b is oldest.
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://a.com' }) });
    // Add c — should evict b (oldest) not a.
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://c.com' }) });
    // a should still be cached, b should be re-resolved.
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://a.com' }) });
    await registry.resolve({ credential: sigCredential({ agent_url: 'https://b.com' }) });

    assert.deepEqual(lookups, [
      'https://a.com', // initial
      'https://b.com', // initial
      'https://c.com', // initial
      'https://b.com', // re-resolved (was evicted by LRU)
    ]);
  });
});

describe('BuyerAgentRegistry.cached — option validation', () => {
  it('throws on invalid inner', () => {
    assert.throws(() => BuyerAgentRegistry.cached(null), /must be a BuyerAgentRegistry/);
    assert.throws(() => BuyerAgentRegistry.cached({}), /must be a BuyerAgentRegistry/);
    assert.throws(() => BuyerAgentRegistry.cached('not-a-registry'), /must be a BuyerAgentRegistry/);
  });

  it('throws on non-positive ttlSeconds', () => {
    const inner = BuyerAgentRegistry.signingOnly({ resolveByAgentUrl: async () => sampleAgent() });
    assert.throws(() => BuyerAgentRegistry.cached(inner, { ttlSeconds: 0 }), /ttlSeconds/);
    assert.throws(() => BuyerAgentRegistry.cached(inner, { ttlSeconds: -1 }), /ttlSeconds/);
  });

  it('throws on negative cacheNullsTtlSeconds', () => {
    const inner = BuyerAgentRegistry.signingOnly({ resolveByAgentUrl: async () => sampleAgent() });
    assert.throws(() => BuyerAgentRegistry.cached(inner, { cacheNullsTtlSeconds: -1 }), /cacheNullsTtlSeconds/);
  });

  it('throws on maxSize < 1', () => {
    const inner = BuyerAgentRegistry.signingOnly({ resolveByAgentUrl: async () => sampleAgent() });
    assert.throws(() => BuyerAgentRegistry.cached(inner, { maxSize: 0 }), /maxSize/);
  });
});
