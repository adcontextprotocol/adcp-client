/**
 * Regression coverage for adcp-client#3171 (shared discovery).
 *
 * A server-side caller that builds one `SingleAgentClient` per request used to
 * repeat endpoint discovery, `tools/list` and `get_adcp_capabilities` on every
 * call. With an explicit shared `discoveryCache` and a caller-owned
 * `authIdentity`, instances for the same agent, identity, version, headers,
 * signing identity and transport policy reuse one observation for the TTL.
 */

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const {
  createInMemoryAgentDiscoveryCache,
  agentDiscoveryCacheKey,
} = require('../../dist/lib/core/agent-discovery-cache.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const publicEntry = require('../../dist/lib/index.js');

let server;
let origin;
/** Per-path request tally for the legacy-era fixture. */
const tallies = new Map();

function tally(path) {
  let value = tallies.get(path);
  if (!value) {
    value = { initialize: 0, lists: 0, capabilityCalls: 0, requests: 0 };
    tallies.set(path, value);
  }
  return value;
}

const CAPABILITIES_PAYLOAD = {
  adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
  supported_protocols: ['media_buy'],
  media_buy: { features: { audience_targeting: true } },
};

before(async () => {
  server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const state = tally(path);
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = raw ? JSON.parse(raw) : {};
    state.requests++;
    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (message.method === 'initialize') state.initialize++;
    if (message.method === 'tools/list') {
      state.lists++;
      if (path.startsWith('/slow')) await new Promise(resolve => setTimeout(resolve, 200));
    }
    const noCapabilitiesTool = path.startsWith('/v2-only');
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'discovery-fixture', version: '1.0.0' },
        capabilities: { tools: {} },
      };
    } else if (message.method === 'tools/list') {
      result = {
        tools: [
          ...(noCapabilitiesTool
            ? []
            : [{ name: 'get_adcp_capabilities', inputSchema: { type: 'object', properties: {} } }]),
          { name: 'get_products', inputSchema: { type: 'object', properties: { brief: { type: 'string' } } } },
        ],
      };
    } else if (
      message.method === 'tools/call' &&
      message.params?.name === 'get_products' &&
      path.startsWith('/seller-error')
    ) {
      const envelope = { adcp_error: { code: 'TOOL_NOT_FOUND', message: 'get_products is gone' } };
      result = {
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        structuredContent: envelope,
        isError: true,
      };
    } else if (message.method === 'tools/call' && message.params?.name === 'get_adcp_capabilities') {
      state.capabilityCalls++;
      result = {
        content: [{ type: 'text', text: JSON.stringify(CAPABILITIES_PAYLOAD) }],
        structuredContent: CAPABILITIES_PAYLOAD,
        isError: false,
      };
    } else {
      result = { content: [{ type: 'text', text: '{}' }], isError: false };
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `session-${path.slice(1)}` });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeMCPConnections();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

let nextPath = 0;
function freshAgentUri(prefix = '') {
  return `${origin}${prefix}/t${++nextPath}/mcp`;
}

function pathOf(agentUri) {
  return new URL(agentUri).pathname;
}

function makeClient(agentUri, discoveryCache, agentOverrides = {}, configOverrides = {}) {
  return new SingleAgentClient(
    { id: `agent-${nextPath}`, name: 'fixture', agent_uri: agentUri, protocol: 'mcp', ...agentOverrides },
    {
      allowPrivateIp: true,
      transport: { allowPrivateIp: true },
      ...(discoveryCache && { discoveryCache }),
      ...configOverrides,
    }
  );
}

function sharing(cache, authIdentity = 'tenant-a', extra = {}) {
  return { cache, authIdentity, ...extra };
}

describe('shared discovery cache', () => {
  test('two clients for the same agent URL and auth identity make one capabilities round trip within the TTL', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const first = await makeClient(uri, sharing(cache), { auth_token: 'token-1' }).getCapabilities();
    const state = tally(pathOf(uri));
    assert.equal(first.version, 'v3');
    assert.equal(state.lists, 1);
    assert.equal(state.capabilityCalls, 1);
    const requestsAfterFirst = state.requests;

    // A different token for the same principal reuses the evidence; no request reaches the seller.
    const second = await makeClient(uri, sharing(cache), { auth_token: 'token-2-rotated' }).getCapabilities();
    assert.equal(second.version, 'v3');
    assert.equal(state.lists, 1, 'no second tools/list');
    assert.equal(state.capabilityCalls, 1, 'no second get_adcp_capabilities');
    assert.equal(state.requests, requestsAfterFirst, 'the second client sent nothing at all');
    assert.deepEqual(second, first);
  });

  test('concurrent cold clients share a single discovery', async () => {
    const uri = freshAgentUri('/slow');
    const cache = createInMemoryAgentDiscoveryCache();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => makeClient(uri, sharing(cache), { auth_token: 'token' }).getCapabilities())
    );
    const state = tally(pathOf(uri));
    assert.equal(
      results.every(capabilities => capabilities.version === 'v3'),
      true
    );
    assert.equal(state.capabilityCalls, 1);
    assert.equal(state.lists, 1);
  });

  test('a cancelled leader does not fail followers, and a follower honors its own abort', async () => {
    const uri = freshAgentUri('/slow');
    const cache = createInMemoryAgentDiscoveryCache();
    const leaderAbort = new AbortController();
    const leader = makeClient(uri, sharing(cache), { auth_token: 'token' }).getCapabilities({
      signal: leaderAbort.signal,
    });
    leader.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 40));

    const followerAbort = new AbortController();
    const impatient = makeClient(uri, sharing(cache), { auth_token: 'token' }).getCapabilities({
      signal: followerAbort.signal,
    });
    impatient.catch(() => {});
    const patient = makeClient(uri, sharing(cache), { auth_token: 'token' }).getCapabilities();
    await new Promise(resolve => setTimeout(resolve, 20));
    leaderAbort.abort(new Error('leader cancelled'));
    followerAbort.abort(new Error('follower cancelled'));

    await assert.rejects(leader);
    await assert.rejects(impatient);
    assert.equal((await patient).version, 'v3', 'the follower discovers for itself');
  });

  test('entries are isolated by identity, version, tenant headers and transport policy but not by correlation headers or token', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const state = () => tally(pathOf(uri)).capabilityCalls;
    const caps = (agent, discovery, config) => makeClient(uri, discovery, agent, config).getCapabilities();

    await caps({ auth_token: 'a' }, sharing(cache, 'tenant-a'));
    assert.equal(state(), 1);
    await caps({ auth_token: 'a' }, sharing(cache, 'tenant-a'), { adcpVersion: '3.0.1' }).catch(() => {});
    const afterVersion = state();
    await caps({ auth_token: 'b' }, sharing(cache, 'tenant-b'));
    assert.equal(state(), afterVersion + 1, 'another identity must not share evidence');

    const beforeTenant = state();
    await caps({ auth_token: 'a', headers: { 'x-tenant': 'one' } }, sharing(cache, 'tenant-a'));
    assert.equal(state(), beforeTenant + 1, 'an unknown tenant header is part of the key');
    await caps({ auth_token: 'a', headers: { 'x-tenant': 'one', 'x-request-id': 'r-1' } }, sharing(cache, 'tenant-a'));
    await caps(
      {
        auth_token: 'a',
        headers: { 'x-tenant': 'one', traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
      },
      sharing(cache, 'tenant-a')
    );
    assert.equal(state(), beforeTenant + 1, 'correlation headers must not fragment the key');

    await caps(
      { auth_token: 'a', headers: { Authorization: 'Bearer ignored-by-auth-token' } },
      sharing(cache, 'tenant-a')
    );
    await caps(
      { auth_token: 'a', headers: { Authorization: 'Bearer another-ignored-value' } },
      sharing(cache, 'tenant-a')
    );
    // Both calls above carry a non-credential-keyed header set equal to the first: credential headers never fragment.
    assert.equal(state(), beforeTenant + 1);

    const beforePolicy = state();
    await caps({ auth_token: 'a' }, sharing(cache, 'tenant-a'), {
      transport: { allowPrivateIp: true, maxResponseBytes: 1_000_000 },
    });
    assert.equal(state(), beforePolicy + 1, 'transport policy is part of the key');
  });

  test('keys never contain the identity, token or header values', () => {
    const key = agentDiscoveryCacheKey({
      protocol: 'mcp',
      agentUri: 'https://seller.example/mcp',
      adcpVersion: '3.0.0',
      authIdentity: 'tenant-secret-identity',
      headers: { 'x-tenant': 'secret-tenant', Authorization: 'Bearer secret-token' },
    });
    assert.match(key, /^adcp:agent-discovery:v1:[0-9a-f]{64}$/);
    for (const secret of ['tenant-secret-identity', 'secret-tenant', 'secret-token']) assert.ok(!key.includes(secret));
    const withToken = agentDiscoveryCacheKey({
      protocol: 'mcp',
      agentUri: 'https://seller.example/mcp',
      adcpVersion: '3.0.0',
      authIdentity: 'tenant-secret-identity',
      headers: { 'x-tenant': 'secret-tenant', Authorization: 'Bearer rotated' },
    });
    assert.equal(withToken, key);
  });

  test('entries expire after the TTL', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const config = sharing(cache, 'tenant-a', { ttlMs: 60 });
    await makeClient(uri, config).getCapabilities();
    await makeClient(uri, config).getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 1);
    await new Promise(resolve => setTimeout(resolve, 90));
    await makeClient(uri, config).getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 2, 'expired evidence is rediscovered');
  });

  test('a short-TTL caller never inherits evidence older than its own TTL from a long-TTL client', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    await makeClient(uri, sharing(cache, 'tenant-a', { ttlMs: 24 * 60 * 60 * 1000 })).getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 1);

    const strict = makeClient(uri, sharing(cache, 'tenant-a', { ttlMs: 60 }));
    await strict.getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 1, 'fresh enough for the short-TTL caller too');
    await new Promise(resolve => setTimeout(resolve, 90));

    // The same long-lived instance and a brand-new short-TTL client both refuse the 90 ms old evidence.
    await strict.getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 2, 'the adopted copy expires at observedAt + this caller TTL');
    await makeClient(uri, sharing(cache, 'tenant-a', { ttlMs: 60 })).getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 2, 'the strict caller refreshed the shared entry for itself');

    // A long-TTL caller is still served by an entry younger than its own window.
    const lenient = createInMemoryAgentDiscoveryCache();
    await makeClient(uri, sharing(lenient, 'tenant-b')).getCapabilities();
    await new Promise(resolve => setTimeout(resolve, 90));
    await makeClient(uri, sharing(lenient, 'tenant-b')).getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 3);
  });

  test('array tool schemas are refused on seed and on install', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const capabilities = await makeClient(
      freshAgentUri(),
      sharing(createInMemoryAgentDiscoveryCache())
    ).getCapabilities();
    const client = makeClient(uri, sharing(cache));
    assert.equal(await client.primeDiscoveryCache({ capabilities, toolSchemas: [{ get_products: {} }] }), false);
    assert.equal(cache.size, 0);

    const now = Date.now();
    const poisoned = {
      get: () => ({ capabilities, toolSchemas: [{ brief: {} }], observedAt: now - 1, expiresAt: now + 60_000 }),
      set: () => {},
      delete: () => {},
    };
    assert.equal((await makeClient(uri, sharing(poisoned)).getCapabilities()).version, 'v3');
    assert.equal(tally(pathOf(uri)).capabilityCalls, 1, 'the poisoned entry was a miss, so discovery ran live');
  });

  test('an adopted or discovered endpoint is re-probed after its freshness bound or a policy change', async () => {
    const uri = `${origin}/t-endpoint-${++nextPath}`;
    const cache = createInMemoryAgentDiscoveryCache();
    const client = makeClient(uri, sharing(cache, 'tenant-a', { ttlMs: 60 }));
    const state = tally(pathOf(uri));
    await client.ensureEndpointDiscovered();
    const afterFirst = state.initialize;
    assert.ok(afterFirst >= 1);
    await client.ensureEndpointDiscovered();
    assert.equal(state.initialize, afterFirst, 'cached within the bound');

    await client.ensureEndpointDiscovered({ transport: { allowPrivateIp: true, maxResponseBytes: 4_000_000 } });
    assert.ok(state.initialize > afterFirst, 'a different transport policy is a different endpoint key');

    const afterPolicy = state.initialize;
    await new Promise(resolve => setTimeout(resolve, 90));
    await client.ensureEndpointDiscovered({ transport: { allowPrivateIp: true, maxResponseBytes: 4_000_000 } });
    assert.ok(state.initialize > afterPolicy, 'the endpoint expires with its TTL');

    // A peer adopts the shared endpoint, then must not hold it past its own bound.
    const peerCache = createInMemoryAgentDiscoveryCache();
    await makeClient(uri, sharing(peerCache, 'tenant-a', { ttlMs: 60 })).ensureEndpointDiscovered();
    const peer = makeClient(uri, sharing(peerCache, 'tenant-a', { ttlMs: 60 }));
    const beforePeer = state.initialize;
    await peer.ensureEndpointDiscovered();
    assert.equal(state.initialize, beforePeer, 'adopted without probing');
    await new Promise(resolve => setTimeout(resolve, 90));
    await peer.ensureEndpointDiscovered();
    assert.ok(state.initialize > beforePeer, 'the adopted endpoint expires too');
  });

  test('an invalidation that lands during an in-flight discovery is not undone by it', async () => {
    const uri = freshAgentUri('/slow');
    const inner = createInMemoryAgentDiscoveryCache();
    const writes = [];
    const cache = {
      get: key => inner.get(key),
      set: (key, entry) => {
        writes.push(entry);
        inner.set(key, entry);
      },
      delete: key => inner.delete(key),
    };
    const client = makeClient(uri, sharing(cache));
    const inFlight = client.getCapabilities();
    await new Promise(resolve => setTimeout(resolve, 60));
    await client.invalidateDiscoveryCache();
    assert.equal((await inFlight).version, 'v3', 'the call itself still completes');
    assert.ok(
      writes.every(entry => entry.capabilities === undefined),
      'the pre-invalidation result was not written back'
    );
    const before = tally(pathOf(uri)).capabilityCalls;
    await client.getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, before + 1, 'and it was not kept locally either');
  });

  test('an invalidation during a slow backend merge-read or set still wins over the writer', async () => {
    const uri = freshAgentUri();
    const inner = createInMemoryAgentDiscoveryCache();
    const keys = [];
    let holdSet;
    const setReached = new Promise(resolve => {
      holdSet = resolve;
    });
    let releaseSet;
    const setGate = new Promise(resolve => {
      releaseSet = resolve;
    });
    const cache = {
      get: key => inner.get(key),
      set: async (key, entry) => {
        keys.push(key);
        holdSet();
        await setGate;
        inner.set(key, entry);
      },
      delete: key => inner.delete(key),
    };
    const client = makeClient(uri, sharing(cache));
    const pending = client.getCapabilities();
    await setReached;
    await client.invalidateDiscoveryCache();
    releaseSet();
    assert.equal((await pending).version, 'v3');
    const stored = keys.map(key => inner.get(key)).filter(Boolean);
    assert.ok(
      stored.every(entry => entry.capabilities === undefined),
      'the pre-invalidation capabilities were taken back out (only post-invalidation endpoint evidence may remain)'
    );
    const before = tally(pathOf(uri)).capabilityCalls;
    await client.getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, before + 1, 'and the local copy was dropped as well');
  });

  test('a stale writer finishing after invalidation and a fresh seed cannot erase the seed', async () => {
    const uri = freshAgentUri();
    const inner = createInMemoryAgentDiscoveryCache();
    const order = [];
    let holdFirstSet;
    const firstSetReached = new Promise(resolve => {
      holdFirstSet = resolve;
    });
    let releaseFirstSet;
    const firstSetGate = new Promise(resolve => {
      releaseFirstSet = resolve;
    });
    let sets = 0;
    const cache = {
      get: key => inner.get(key),
      set: async (key, entry) => {
        const mine = ++sets;
        order.push(`set${mine}`);
        if (mine === 1) {
          holdFirstSet();
          await firstSetGate; // the stale writer's backend call is slow to settle
        }
        inner.set(key, entry);
      },
      delete: key => {
        order.push('delete');
        inner.delete(key);
      },
    };
    const capabilities = await makeClient(
      freshAgentUri(),
      sharing(createInMemoryAgentDiscoveryCache())
    ).getCapabilities();
    const client = makeClient(uri, sharing(cache));
    const stale = client.getCapabilities();
    await firstSetReached;
    await Promise.race([client.invalidateDiscoveryCache(), new Promise(resolve => setTimeout(resolve, 20))]);
    const seeding = client.primeDiscoveryCache({ capabilities, endpoint: { agentUri: uri, mcpEra: 'legacy' } });
    releaseFirstSet();
    await stale;
    assert.equal(await seeding, true, 'the fresh seed was accepted');

    const requestsBefore = tally(pathOf(uri)).requests;
    const consumer = makeClient(uri, sharing(cache));
    assert.equal((await consumer.getCapabilities()).version, 'v3');
    assert.equal(tally(pathOf(uri)).requests, requestsBefore, 'the seed survived: no seller request was needed');
    assert.ok(order.indexOf('delete') > order.indexOf('set1'), 'invalidation ran after the stale set settled');
  });

  test('a long-lived instance honors the TTL on its own live result', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const client = makeClient(uri, sharing(cache, 'tenant-a', { ttlMs: 60 }));
    await client.getCapabilities();
    await client.getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 1);
    await new Promise(resolve => setTimeout(resolve, 90));
    await client.getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 2);
  });

  test('a per-call transport override cannot reuse evidence gathered under another policy', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const client = makeClient(uri, sharing(cache));
    await client.getCapabilities();
    await client.getCapabilities({ transport: { allowPrivateIp: true, maxResponseBytes: 2_000_000 } });
    assert.equal(tally(pathOf(uri)).capabilityCalls, 2);
  });

  test('synthetic capabilities are never shared', async () => {
    const uri = freshAgentUri('/v2-only');
    const inner = createInMemoryAgentDiscoveryCache();
    const written = [];
    const cache = {
      get: key => inner.get(key),
      set: (key, entry) => {
        written.push(entry);
        inner.set(key, entry);
      },
      delete: key => inner.delete(key),
    };
    const first = await makeClient(uri, sharing(cache)).getCapabilities();
    assert.equal(first._synthetic, true);
    assert.ok(
      written.every(entry => entry.capabilities === undefined && entry.toolSchemas === undefined),
      'no capability evidence is written for synthetic results'
    );
    await makeClient(uri, sharing(cache)).getCapabilities();
    assert.equal(tally(pathOf(uri)).lists, 2);
  });

  test('scoped trustedFetchFn calls bypass the shared cache in both directions', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    await makeClient(uri, sharing(cache)).getCapabilities();
    assert.equal(cache.size, 1);
    const scoped = makeClient(
      uri,
      sharing(cache),
      {},
      { transport: { allowPrivateIp: true, trustedFetchFn: (input, init) => fetch(input, init) } }
    );
    await scoped.getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 2, 'the scoped call discovered for itself');
    assert.equal(await scoped.primeDiscoveryCache({ capabilities: { ...(await scoped.getCapabilities()) } }), false);
  });

  test('stored entries are copies in both directions', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const first = await makeClient(uri, sharing(cache)).getCapabilities();
    first.protocols.push('tampered');
    first.features.tampered = true;
    const second = await makeClient(uri, sharing(cache)).getCapabilities();
    assert.ok(!second.protocols.includes('tampered'));
    assert.equal(second.features.tampered, undefined);
    second.protocols.push('tampered-again');
    const third = await makeClient(uri, sharing(cache)).getCapabilities();
    assert.ok(!third.protocols.includes('tampered-again'));
  });
});

describe('invalidation and seeding', () => {
  test('invalidateDiscoveryCache drops local and shared evidence', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const client = makeClient(uri, sharing(cache));
    await client.getCapabilities();
    assert.equal(cache.size, 1);
    await client.invalidateDiscoveryCache();
    assert.equal(cache.size, 0);
    await client.getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 2);
    await makeClient(uri, sharing(cache)).refreshCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 3, 'refreshCapabilities bypasses shared evidence too');
  });

  test('stale shared evidence missing a required feature is refreshed before the call is refused', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const seeder = makeClient(uri, sharing(cache));
    const live = await seeder.getCapabilities();
    const stale = structuredClone(live);
    stale.protocols = ['signals'];
    assert.equal(await seeder.primeDiscoveryCache({ capabilities: stale }), true);

    const client = makeClient(uri, sharing(cache));
    const before = tally(pathOf(uri)).capabilityCalls;
    await client.validateTaskFeatures('get_products');
    assert.equal(tally(pathOf(uri)).capabilityCalls, before + 1, 'validation went to the live seller');
    assert.ok((await client.getCapabilities()).protocols.includes('media_buy'));
  });

  test('a seller version or capability error invalidates shared evidence', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const client = makeClient(uri, sharing(cache));
    await client.getCapabilities();
    await client.invalidateDiscoveryOnCapabilityError('RATE_LIMITED');
    assert.equal(cache.size, 1, 'unrelated errors keep the evidence');
    await client.invalidateDiscoveryOnCapabilityError('VERSION_UNSUPPORTED');
    assert.equal(cache.size, 0);
  });

  test("a seller capability error invalidates the entry for the call's effective per-call transport policy", async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const client = makeClient(uri, sharing(cache));
    const override = { transport: { allowPrivateIp: true, maxResponseBytes: 3_000_000 } };
    await client.getCapabilities();
    await client.getCapabilities(override);
    assert.equal(cache.size, 2, 'default and overridden policies are separate entries');
    await client.invalidateDiscoveryOnCapabilityError('VERSION_UNSUPPORTED', override);
    assert.equal(cache.size, 1, 'only the entry the failing call used is dropped');
    const before = tally(pathOf(uri)).capabilityCalls;
    await makeClient(uri, sharing(cache)).getCapabilities(override);
    assert.equal(tally(pathOf(uri)).capabilityCalls, before + 1, 'the stale overridden entry is gone');
  });

  test('shared endpoint evidence never persists URL queries or fragments', async () => {
    const uri = `${origin}/query-endpoint-${++nextPath}?token=endpoint-secret`;
    const cache = createInMemoryAgentDiscoveryCache();
    const client = makeClient(uri, sharing(cache));
    assert.equal((await client.ensureEndpointDiscovered()).agent_uri, uri, 'operational endpoint stays intact');
    assert.equal(cache.size, 0, 'query-bearing endpoint was not written');
    const capabilities = await client.getCapabilities();
    const entry = cache.get(client.sharedDiscoveryKey());
    assert.ok(entry.capabilities, 'capabilities can still be shared');
    assert.equal(entry.endpoint, undefined);
    for (const suffix of ['?token=endpoint-secret', '#endpoint-secret']) {
      assert.equal(
        await client.primeDiscoveryCache({
          capabilities,
          endpoint: { agentUri: `${origin}/mcp${suffix}` },
        }),
        false
      );
    }
  });

  test('primeDiscoveryCache seeds evidence that outlives the instance, endpoint included', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const donor = makeClient(freshAgentUri(), sharing(createInMemoryAgentDiscoveryCache()));
    const capabilities = await donor.getCapabilities();

    const seeder = makeClient(uri, sharing(cache));
    assert.equal(
      await seeder.primeDiscoveryCache({ capabilities, endpoint: { agentUri: uri, mcpEra: 'legacy' } }),
      true
    );

    const state = tally(pathOf(uri));
    const consumer = makeClient(uri, sharing(cache));
    assert.equal((await consumer.getCapabilities()).version, 'v3');
    assert.equal(state.requests, 0, 'a seeded client reaches the seller zero times for discovery');
  });

  test('primeDiscoveryCache refuses synthetic, malformed, uncloneable, foreign-origin and unaccepted evidence', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const client = makeClient(uri, sharing(cache));
    const capabilities = await makeClient(
      freshAgentUri(),
      sharing(createInMemoryAgentDiscoveryCache())
    ).getCapabilities();

    assert.equal(await client.primeDiscoveryCache({ capabilities: { ...capabilities, _synthetic: true } }), false);
    assert.equal(await client.primeDiscoveryCache({ capabilities: { version: 'v9' } }), false);
    assert.equal(
      await client.primeDiscoveryCache({ capabilities: { ...capabilities, extensions: [() => {}] } }),
      false
    );
    assert.equal(
      await client.primeDiscoveryCache({ capabilities, endpoint: { agentUri: 'https://evil.example/mcp' } }),
      false
    );
    assert.equal(
      await client.primeDiscoveryCache({
        capabilities,
        endpoint: { agentUri: uri.replace('http://', 'http://user:pw@') },
      }),
      false
    );
    assert.equal(cache.size, 0);

    const rejecting = {
      get: () => undefined,
      set: () => {
        throw new Error('backend down');
      },
      delete: () => {},
    };
    assert.equal(await makeClient(uri, sharing(rejecting)).primeDiscoveryCache({ capabilities }), false);
    assert.equal(await makeClient(uri).primeDiscoveryCache({ capabilities }), false, 'no discoveryCache configured');
  });
});

describe('configuration and backend failures', () => {
  test('authIdentity is required and the cache must implement get/set/delete', () => {
    const cache = createInMemoryAgentDiscoveryCache();
    const agent = { id: 'a', name: 'a', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' };
    assert.throws(() => new SingleAgentClient(agent, { discoveryCache: { cache } }), /authIdentity is required/);
    assert.throws(() => new SingleAgentClient(agent, { discoveryCache: { cache, authIdentity: '' } }), /authIdentity/);
    assert.throws(
      () => new SingleAgentClient(agent, { discoveryCache: { cache: {}, authIdentity: 'x' } }),
      /get, set and delete/
    );
    assert.throws(
      () => new SingleAgentClient(agent, { discoveryCache: { cache, authIdentity: 'x', ttlMs: -1 } }),
      /ttlMs/
    );
    assert.throws(() => createInMemoryAgentDiscoveryCache({ maxEntries: 0 }), /maxEntries/);
  });

  test('public entry exports the cache factory', () => {
    assert.equal(typeof publicEntry.createInMemoryAgentDiscoveryCache, 'function');
  });

  test('a failing or malformed backend costs a rediscovery, not a failed call', async () => {
    const uri = freshAgentUri();
    const throwing = {
      get: () => {
        throw new Error('backend down');
      },
      set: () => {
        throw new Error('backend down');
      },
      delete: () => {
        throw new Error('backend down');
      },
    };
    assert.equal((await makeClient(uri, sharing(throwing)).getCapabilities()).version, 'v3');

    const now = Date.now();
    const malformed = {
      get: () => ({
        capabilities: { version: 'v3', majorVersions: 'nope' },
        observedAt: now - 1,
        expiresAt: now + 60_000,
      }),
      set: () => {},
      delete: () => {},
    };
    assert.equal((await makeClient(uri, sharing(malformed)).getCapabilities()).version, 'v3');

    const uncloneable = {
      get: () => ({
        capabilities: {
          version: 'v3',
          majorVersions: [3],
          protocols: [],
          features: {},
          extensions: [],
          _synthetic: false,
          discoveredTools: [],
          boom: () => {},
        },
        observedAt: now - 1,
        expiresAt: now + 60_000,
      }),
      set: () => {},
      delete: () => {},
    };
    assert.equal((await makeClient(uri, sharing(uncloneable)).getCapabilities()).version, 'v3');
  });

  test('an unresponsive backend cannot make a call uncancellable', async () => {
    const hung = {
      get: () => new Promise(() => {}),
      set: () => new Promise(() => {}),
      delete: () => new Promise(() => {}),
    };
    const abort = new AbortController();
    const started = Date.now();
    const pending = makeClient(freshAgentUri(), sharing(hung)).getCapabilities({ signal: abort.signal });
    setTimeout(() => abort.abort(new Error('caller gave up')), 50);
    await assert.rejects(pending, error => /caller gave up|aborted/i.test(String(error.message)));
    assert.ok(Date.now() - started < 1_500, 'cancellation does not wait for the backend');
  });

  test('without a discoveryCache nothing is shared across instances', async () => {
    const uri = freshAgentUri();
    await makeClient(uri).getCapabilities();
    await makeClient(uri).getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, 2);
  });
});

describe('final review regressions', () => {
  /** A backend wrapper whose operations can be made to fail, hang or be counted. */
  function controllableBackend() {
    const inner = createInMemoryAgentDiscoveryCache();
    const backend = {
      inner,
      calls: { set: 0, delete: 0 },
      failDelete: false,
      gate: undefined,
      get: key => inner.get(key),
      set: async (key, entry) => {
        backend.calls.set++;
        backend.lastSet = entry;
        if (backend.gate && backend.calls.set === 1) await backend.gate;
        return inner.set(key, entry);
      },
      delete: async key => {
        backend.calls.delete++;
        if (backend.failDelete) throw new Error('delete failed');
        if (backend.deleteGate && backend.calls.delete === 1) await backend.deleteGate;
        return inner.delete(key);
      },
    };
    return backend;
  }

  test('public require() refreshes stale shared evidence before refusing', async () => {
    const uri = freshAgentUri();
    const cache = createInMemoryAgentDiscoveryCache();
    const seeder = makeClient(uri, sharing(cache));
    const stale = structuredClone(await seeder.getCapabilities());
    stale.protocols = ['signals'];
    assert.equal(await seeder.primeDiscoveryCache({ capabilities: stale }), true);

    const client = makeClient(uri, sharing(cache));
    const before = tally(pathOf(uri)).capabilityCalls;
    await client.require('media_buy');
    assert.equal(tally(pathOf(uri)).capabilityCalls, before + 1, 'require() decided on live capabilities');
    await assert.rejects(client.require('governance'), /governance/, 'a genuinely missing feature is still refused');
  });

  test('a seller capability error on a standard method invalidates shared evidence', async () => {
    const uri = freshAgentUri('/seller-error');
    const cache = createInMemoryAgentDiscoveryCache();
    const client = makeClient(uri, sharing(cache));
    await client.getCapabilities();
    assert.equal(cache.size, 1);
    await client.getProducts({ buying_mode: 'brief', brief: 'anything' }).catch(() => {});
    assert.equal(cache.size, 0, 'the unprojected execution path invalidated the entry');
  });

  test('a read after a failed delete misses through the invalidation tombstone', async () => {
    const uri = freshAgentUri();
    const backend = controllableBackend();
    const first = makeClient(uri, sharing(backend));
    await first.getCapabilities();
    await new Promise(resolve => setTimeout(resolve, 10));
    backend.failDelete = true;
    await first.invalidateDiscoveryCache();
    assert.equal(backend.inner.size, 1, 'the backend still holds the stale entry');

    const before = tally(pathOf(uri)).capabilityCalls;
    await makeClient(uri, sharing(backend)).getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, before + 1, 'the stale entry was not trusted');
    backend.failDelete = false;
    const after = tally(pathOf(uri)).capabilityCalls;
    await makeClient(uri, sharing(backend)).getCapabilities();
    assert.equal(tally(pathOf(uri)).capabilityCalls, after, 'evidence written after the invalidation is shared');
  });

  test('after a failed delete a fresh write does not merge the old endpoint back in', async () => {
    const uri = `${origin}/t-endpoint-${++nextPath}`;
    const backend = controllableBackend();
    const first = makeClient(uri, sharing(backend));
    await first.getCapabilities();
    assert.ok(backend.lastSet?.endpoint, 'the first discovery stored its endpoint');
    await new Promise(resolve => setTimeout(resolve, 10));
    backend.failDelete = true;
    await first.invalidateDiscoveryCache();

    const second = makeClient(uri, sharing(backend));
    const initializes = tally(pathOf(uri)).initialize;
    await second.getCapabilities();
    assert.ok(tally(pathOf(uri)).initialize > initializes, 'the old endpoint was not adopted or merged back');
  });

  test("another instance's invalidation drops this instance's local evidence and endpoint", async () => {
    const uri = `${origin}/t-endpoint-${++nextPath}`;
    const cache = createInMemoryAgentDiscoveryCache();
    const a = makeClient(uri, sharing(cache));
    const b = makeClient(uri, sharing(cache));
    await a.getCapabilities();
    await b.getCapabilities();
    const state = tally(pathOf(uri));
    const calls = state.capabilityCalls;
    const initializes = state.initialize;
    await b.getCapabilities();
    assert.equal(state.capabilityCalls, calls, 'cached locally before the invalidation');

    await a.invalidateDiscoveryCache();
    await b.getCapabilities();
    assert.equal(state.capabilityCalls, calls + 1, 'the peer rediscovered instead of serving its local copy');
    assert.ok(state.initialize > initializes, 'the peer re-probed its endpoint');
  });

  test('a seed that did not confirm is dropped when still queued, and a hung delete queue stays bounded', async () => {
    const uri = freshAgentUri();
    const backend = controllableBackend();
    let release;
    backend.gate = new Promise(resolve => (release = resolve));
    const capabilities = await makeClient(
      freshAgentUri(),
      sharing(createInMemoryAgentDiscoveryCache())
    ).getCapabilities();
    const client = makeClient(uri, sharing(backend));

    const [first, second] = await Promise.all([
      client.primeDiscoveryCache({ capabilities }),
      client.primeDiscoveryCache({ capabilities }),
    ]);
    assert.deepEqual([first, second], [false, false], 'an unanswered backend is not a confirmed seed');
    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(backend.calls.set, 1, 'the write still queued behind the hung one was dropped');
  });

  test('invalidations queued behind a hung delete coalesce into one', async () => {
    const uri = freshAgentUri();
    const backend = controllableBackend();
    let release;
    backend.deleteGate = new Promise(resolve => (release = resolve));
    const client = makeClient(uri, sharing(backend));
    await client.getCapabilities();

    const hung = client.invalidateDiscoveryCache();
    await new Promise(resolve => setTimeout(resolve, 20));
    await Promise.all(Array.from({ length: 25 }, () => client.invalidateDiscoveryCache()));
    await hung;
    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(backend.calls.delete, 2, 'one in flight and one coalesced follow-up, in order');
  });

  test('concurrent calls on one instance tolerate a slow shared write while discovering the endpoint', async () => {
    const uri = `${origin}/t-endpoint-${++nextPath}`;
    const inner = createInMemoryAgentDiscoveryCache();
    const slow = {
      get: key => inner.get(key),
      set: async (key, entry) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return inner.set(key, entry);
      },
      delete: key => inner.delete(key),
    };
    const client = makeClient(uri, sharing(slow));
    const agents = await Promise.all([client.ensureEndpointDiscovered(), client.ensureEndpointDiscovered()]);
    for (const agent of agents) assert.equal(typeof agent.agent_uri, 'string');
  });
});
