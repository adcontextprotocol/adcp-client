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

  it('skips caching when credential is undefined (pass-through)', async () => {
    let upstreamCalls = 0;
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        upstreamCalls++;
        return sampleAgent();
      },
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    await registry.resolve({}); // no credential
    await registry.resolve({}); // no credential
    // Inner returns null for undefined credential without invoking the resolver
    // (signingOnly's first guard); the cache skips both. The point: every call
    // hits the inner registry rather than caching a null result.
    assert.equal(upstreamCalls, 0); // inner's signingOnly short-circuits before resolver
    // But the cache MUST NOT have stored a null here either; verify by
    // returning a real agent next and checking it's invoked.
    const inner2 = BuyerAgentRegistry.bearerOnly({
      resolveByCredential: async () => {
        upstreamCalls++;
        return sampleAgent();
      },
    });
    const registry2 = BuyerAgentRegistry.cached(inner2, { ttlSeconds: 60 });
    await registry2.resolve({}); // no credential → bearerOnly returns null without resolver
    await registry2.resolve({ credential: apiKeyCredential() }); // now real call
    assert.equal(upstreamCalls, 1, "pass-through path doesn't poison the cache");
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

  it('inFlight entry is released after the resolve completes (no leak)', async () => {
    const inner = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => sampleAgent(),
    });
    const registry = BuyerAgentRegistry.cached(inner, { ttlSeconds: 60 });

    await registry.resolve({ credential: sigCredential() });
    // Force TTL expiration via a fresh registry to test re-resolve path.
    let nowMs = 1_000_000;
    const registry2 = BuyerAgentRegistry.cached(inner, { ttlSeconds: 1, now: () => nowMs });
    await registry2.resolve({ credential: sigCredential() });
    nowMs += 2_000;
    await registry2.resolve({ credential: sigCredential() }); // must succeed, not deadlock
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
