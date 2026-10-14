const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { comply } = require('../../dist/lib/testing/compliance');
const { ADCP_VERSION, toReleasePrecisionVersion } = require('../../dist/lib/version');
const {
  createTestClient,
  getOrCreateClientResolution,
  getOrDiscoverProfile,
  withTestClientScope,
} = require('../../dist/lib/testing/client');
const { withMCPConnectionScope } = require('../../dist/lib/protocols');

function writeCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-discovery-reuse-'));
  fs.mkdirSync(path.join(dir, 'universal'));
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      adcp_version: ADCP_VERSION,
      universal: ['first', 'second', 'third'],
      protocols: [],
      specialisms: [],
    })
  );
  for (const id of ['first', 'second', 'third']) {
    fs.writeFileSync(
      path.join(dir, 'universal', `${id}.yaml`),
      `id: ${id}
version: 1.0.0
title: ${id}
category: testing
track: core
summary: ''
narrative: ''
agent:
  interaction_model: '*'
  capabilities: []
caller:
  role: buyer_agent
invariants:
  disable: [status.monotonic, impairment.coherence]
phases:
  - id: flow
    title: Flow
    steps:
${['one', 'two', 'three']
  .map(
    step => `      - id: ${step}
        title: ${step}
        task: __test_probe
        sample_request: {}
        validations:
          - check: field_present
            path: probed
            description: probe answered
`
  )
  .join('')}`
    );
  }
  return dir;
}

async function startAgent(name) {
  const requests = [];
  const state = { rejected: false, failToolsOnce: false, idempotency: false, toolsGate: undefined, onTools: undefined };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const rpc = body ? JSON.parse(body) : {};
    requests.push({ method: rpc.method, tool: rpc.params?.name, authorization: req.headers.authorization });
    if (state.rejected || (rpc.method === 'tools/list' && state.failToolsOnce)) {
      const status = state.rejected ? 401 : 500;
      state.failToolsOnce = false;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'discovery refused' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name, version: '1.0.0' },
          },
        })
      );
      return;
    }
    if (rpc.method === 'tools/list') {
      state.onTools?.();
      await state.toolsGate;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: ['__test_probe', 'get_adcp_capabilities'].map(name => ({ name, inputSchema: { type: 'object' } })),
          },
        })
      );
      return;
    }
    const data =
      rpc.params?.name === 'get_adcp_capabilities'
        ? {
            adcp: {
              major_versions: [3],
              supported_versions: [toReleasePrecisionVersion(ADCP_VERSION)],
              build_version: ADCP_VERSION,
              idempotency: { supported: state.idempotency, ...(state.idempotency && { replay_ttl_seconds: 3600 }) },
            },
            supported_protocols: rpc.params.arguments?.protocols ?? ['media_buy'],
            specialisms: [],
          }
        : { probed: true };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          structuredContent: data,
          content: [{ type: 'text', text: JSON.stringify(data) }],
        },
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    requests,
    state,
    reset: () => {
      requests.splice(0);
      state.rejected = false;
      state.failToolsOnce = false;
      state.idempotency = false;
      state.toolsGate = undefined;
      state.onTools = undefined;
    },
    count: (method, token) =>
      requests.filter(
        r =>
          (r.method === method || r.tool === method) && (token === undefined || r.authorization === `Bearer ${token}`)
      ).length,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function assertDiscovery(agent, count, token) {
  assert.equal(agent.count('tools/list', token), count, 'tools/list count');
  assert.equal(agent.count('get_adcp_capabilities', token), count, 'capabilities count');
}

function assertPassed(result) {
  const scenarios = result.tracks.flatMap(track => track.scenarios);
  assert.equal(scenarios.length, 3);
  assert.ok(
    scenarios.every(s => s.overall_passed),
    JSON.stringify(scenarios)
  );
}

describe('comply() discovery reuse', () => {
  let agent, peer, complianceDir;
  before(async () => {
    complianceDir = writeCache();
    agent = await startAgent('seller');
    peer = await startAgent('peer');
  });
  after(async () => {
    await Promise.all([agent.close(), peer.close()]);
    fs.rmSync(complianceDir, { recursive: true, force: true });
  });
  function run(extra = {}) {
    agent.reset();
    peer.reset();
    return comply(agent.url, { allow_http: true, complianceDir, auth: { type: 'bearer', token: 'owner' }, ...extra });
  }

  test('discovers once for three storyboards and nine steps', async () => {
    assertPassed(await run());
    assert.equal(agent.count('__test_probe'), 9);
    assertDiscovery(agent, 1);
  });

  test('reuses discovery with a stable hosted fetch transport', async () => {
    let fetchCalls = 0;
    const trustedFetchFn = (...args) => {
      fetchCalls++;
      return fetch(...args);
    };
    assertPassed(await run({ transport: { trustedFetchFn, allowPrivateIp: true } }));
    assert.ok(fetchCalls > 9);
    assert.equal(agent.count('__test_probe'), 9);
    assertDiscovery(agent, 1);
  });

  test('release-precision versions reuse discovery across storyboards', async () => {
    assertPassed(await run({ adcpVersion: toReleasePrecisionVersion(ADCP_VERSION) }));
    assertDiscovery(agent, 1);
  });

  test('routed storyboards reuse each agent and credential context', async () => {
    assertPassed(
      await run({
        routeStoryboard: sb => ({
          agents: {
            seller: { url: agent.url, auth: { type: 'bearer', token: 'owner' } },
            peer: { url: peer.url, auth: { type: 'bearer', token: 'peer' } },
          },
          default_agent: 'seller',
        }),
      })
    );
    assertDiscovery(agent, 1, 'owner');
    assertDiscovery(peer, 1, 'peer');
    assert.equal(agent.count('__test_probe'), 9);
  });

  test('changed credentials get separate discovery, returning credentials reuse it', async () => {
    assertPassed(
      await run({
        routeStoryboard: sb => ({
          agents: {
            seller: { url: agent.url, auth: { type: 'bearer', token: sb.id === 'second' ? 'other' : 'owner' } },
          },
          default_agent: 'seller',
        }),
      })
    );
    assertDiscovery(agent, 1, 'owner');
    assertDiscovery(agent, 1, 'other');
    assert.equal(agent.count('__test_probe', 'other'), 3);
  });

  test('explicit invalidation refreshes discovery once', async () => {
    assertPassed(
      await run({
        routeStoryboard: async sb => {
          if (sb.id === 'second') {
            const { client, reusedShared } = getOrCreateClientResolution(agent.url, {
              protocol: 'mcp',
              adcpVersion: ADCP_VERSION,
              versionEnvelope: 'auto',
              auth: { type: 'bearer', token: 'owner' },
              test_session_id: 'invalidation-run',
            });
            assert.equal(reusedShared, true);
            await client.invalidateDiscoveryCache();
          }
        },
        test_session_id: 'invalidation-run',
      })
    );
    assertDiscovery(agent, 2);
  });

  test('separate comply invocations perform their own discovery', async () => {
    assertPassed(await run());
    assertDiscovery(agent, 1);
    assertPassed(await run());
    assertDiscovery(agent, 1);
  });

  test('version and header changes each discover their own client context', async () => {
    const options = {
      protocol: 'mcp',
      adcpVersion: ADCP_VERSION,
      versionEnvelope: 'auto',
      auth: { type: 'bearer', token: 'owner' },
      test_session_id: 'scope-boundaries',
    };
    const seen = new Map();
    assertPassed(
      await run({
        test_session_id: options.test_session_id,
        routeStoryboard: async () => {
          for (const extra of [{ adcpVersion: '3.1.24' }, { headers: { 'x-tenant': 'other' } }]) {
            const contextualOptions = { ...options, ...extra };
            const { client } = getOrCreateClientResolution(agent.url, contextualOptions);
            const key = Object.keys(extra)[0];
            if (seen.has(key)) assert.equal(client, seen.get(key));
            seen.set(key, client);
            await getOrDiscoverProfile(client, contextualOptions);
          }
        },
      })
    );
    assertDiscovery(agent, 3);
  });

  test('a failed routed discovery is retried by the next storyboard', async () => {
    let routed = false;
    assertPassed(
      await run({
        routeStoryboard: () => {
          if (!routed) peer.state.failToolsOnce = true;
          routed = true;
          return {
            agents: {
              seller: { url: agent.url, auth: { type: 'bearer', token: 'owner' } },
              peer: { url: peer.url, auth: { type: 'bearer', token: 'peer' } },
            },
            default_agent: 'seller',
          };
        },
      })
    );
    assert.equal(peer.count('tools/list'), 2);
    assert.equal(peer.count('get_adcp_capabilities'), 1);
  });

  test('auth-rejected discovery still executes the degraded-profile storyboards', async () => {
    agent.reset();
    agent.state.rejected = true;
    const result = await comply(agent.url, { allow_http: true, complianceDir });
    assert.equal(result.storyboards_executed.length, 3);
    assert.ok(
      result.tracks
        .flatMap(t => t.scenarios)
        .every(s => s.steps.every(step => step.step !== 'Discover agent capabilities'))
    );
    agent.state.rejected = false;
  });

  test('concurrent invocations keep separate discovery lifetimes', async () => {
    agent.reset();
    const options = { allow_http: true, complianceDir, auth: { type: 'bearer', token: 'owner' } };
    const results = await Promise.all([comply(agent.url, options), comply(agent.url, options)]);
    results.forEach(assertPassed);
    assertDiscovery(agent, 2);
    assert.equal(agent.count('__test_probe'), 18);
  });

  test('later storyboards keep the refreshed profile after invalidation', async () => {
    const dir = writeCache();
    try {
      for (const id of ['second', 'third']) {
        const file = path.join(dir, 'universal', `${id}.yaml`);
        fs.writeFileSync(
          file,
          fs
            .readFileSync(file, 'utf8')
            .replaceAll(
              '        sample_request:',
              '        requires_capability:\n          path: adcp.idempotency.supported\n          equals: true\n        sample_request:'
            )
        );
      }
      assertPassed(
        await run({
          complianceDir: dir,
          test_session_id: 'refresh-profile',
          routeStoryboard: async sb => {
            if (sb.id !== 'second') return;
            agent.state.idempotency = true;
            const { client } = getOrCreateClientResolution(agent.url, {
              protocol: 'mcp',
              adcpVersion: ADCP_VERSION,
              versionEnvelope: 'auto',
              auth: { type: 'bearer', token: 'owner' },
              test_session_id: 'refresh-profile',
            });
            await client.invalidateDiscoveryCache();
          },
        })
      );
      assertDiscovery(agent, 2);
      assert.equal(agent.count('__test_probe'), 9, 'second and third use the new capability advertisement');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('in-flight endpoint discovery cannot undo explicit invalidation', async () => {
    agent.reset();
    await withTestClientScope(() =>
      withMCPConnectionScope(async () => {
        const client = createTestClient(agent.url);
        const single = client.client;
        const original = single.discoverMCPEndpoint.bind(single);
        let release, started;
        const gate = new Promise(resolve => {
          release = resolve;
        });
        const received = new Promise(resolve => {
          started = resolve;
        });
        let probes = 0;
        single.discoverMCPEndpoint = async (...args) => {
          probes++;
          const endpoint = await original(...args);
          if (probes === 1) {
            started();
            await gate;
          }
          return endpoint;
        };
        const pending = client.getAgentInfo();
        await received;
        await client.invalidateDiscoveryCache();
        release();
        await pending;
        await client.getAgentInfo();
        assert.equal(probes, 2, 'invalidated endpoint must be rediscovered');
      })
    );
  });

  test('storyboard applicability uses the refreshed profile after invalidation', async () => {
    const dir = writeCache();
    try {
      for (const id of ['second', 'third']) {
        const file = path.join(dir, 'universal', `${id}.yaml`);
        fs.writeFileSync(
          file,
          fs
            .readFileSync(file, 'utf8')
            .replace(
              'invariants:',
              'requires_capability:\n  path: adcp.idempotency.supported\n  equals: true\ninvariants:'
            )
        );
      }
      assertPassed(
        await run({
          complianceDir: dir,
          test_session_id: 'root-refresh',
          routeStoryboard: async sb => {
            if (sb.id !== 'first') return;
            agent.state.idempotency = true;
            const { client } = getOrCreateClientResolution(agent.url, {
              protocol: 'mcp',
              adcpVersion: ADCP_VERSION,
              versionEnvelope: 'auto',
              auth: { type: 'bearer', token: 'owner' },
              test_session_id: 'root-refresh',
            });
            await client.invalidateDiscoveryCache();
          },
        })
      );
      assertDiscovery(agent, 2);
      assert.equal(agent.count('__test_probe'), 9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a surviving discovery waiter retries when the first caller cancels', async () => {
    agent.reset();
    await withTestClientScope(() =>
      withMCPConnectionScope(async () => {
        const client = createTestClient(agent.url);
        let release, started;
        agent.state.toolsGate = new Promise(resolve => {
          release = resolve;
        });
        const received = new Promise(resolve => {
          started = resolve;
        });
        agent.state.onTools = started;
        const controller = new AbortController();
        const creator = getOrDiscoverProfile(client, { signal: controller.signal });
        const cancelled = assert.rejects(creator, /cancelled/);
        await received;
        const survivor = getOrDiscoverProfile(client, {});
        controller.abort(new Error('cancelled'));
        release();
        await cancelled;
        const result = await survivor;
        assert.equal(result.step.passed, true);
        assert.ok(result.profile.raw_capabilities);
        assert.equal(agent.count('tools/list'), 2);
      })
    );
  });

  test('filtered capability requests cannot replace the complete discovery observation', async () => {
    agent.reset();
    await withTestClientScope(() =>
      withMCPConnectionScope(async () => {
        const client = createTestClient(agent.url);
        await getOrDiscoverProfile(client, {});
        const filtered = await client.getAdcpCapabilities({ protocols: ['creative'] });
        assert.deepEqual(filtered.data.supported_protocols, ['creative']);
        assert.deepEqual((await client.getCapabilities()).protocols, ['media_buy']);
        assert.equal(agent.count('tools/list'), 1);
        assert.equal(agent.count('get_adcp_capabilities'), 2);
      })
    );
  });

  test('a capability call without a tool list leaves tool discovery cold', async () => {
    agent.reset();
    await withTestClientScope(() =>
      withMCPConnectionScope(async () => {
        const client = createTestClient(agent.url);
        await client.getAdcpCapabilities({});
        const capabilities = await client.getCapabilities();
        assert.ok(capabilities.discoveredTools.includes('__test_probe'));
        assert.equal(agent.count('tools/list'), 1);
        assert.equal(agent.count('get_adcp_capabilities'), 2);
      })
    );
  });
});
