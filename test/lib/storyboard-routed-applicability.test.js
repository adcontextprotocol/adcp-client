process.env.NODE_ENV = 'test';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { partitionStoryboardsByRequiredTools } = require('../../dist/lib/testing/compliance/comply.js');
const { closeConnections } = require('../../dist/lib/protocols/index.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');
const { routedAgentOptions } = require('../../dist/lib/testing/storyboard/agent-routing.js');

// Real routed discovery and MCP dispatch, with deterministic protocol fixtures.
// No union/profile injection stands in for options.agents.
async function startAgent(tools, capabilities = {}, rejectTools = false) {
  const calls = [];
  const authorization = [];
  const connections = [];
  const metadataRequests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.includes('/.well-known/')) {
      metadataRequests.push(req.url);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const mcp = new McpServer({ name: 'routing-contract-test', version: '1.0.0' });
    for (const name of new Set(['get_adcp_capabilities', ...tools])) {
      mcp.registerTool(name, {}, async () => {
        calls.push(name);
        authorization.push(req.headers.authorization);
        if (rejectTools && name !== 'get_adcp_capabilities') {
          return { isError: true, content: [{ type: 'text', text: 'Deterministic agent rejection' }] };
        }
        const data =
          name === 'get_adcp_capabilities'
            ? {
                adcp: { major_versions: [3], supported_versions: ['3.1', '3.2'] },
                supported_protocols: [],
                ...capabilities,
              }
            : name === 'get_signals'
              ? { signals: [] }
              : name === 'get_products'
                ? { products: [] }
                : {};
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    connections.push(mcp);
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    authorization,
    metadataRequests,
    close: async () => {
      await Promise.all(connections.map(s => s.close()));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function storyboard(steps, required_tools = ['get_adcp_capabilities', 'sync_governance']) {
  return {
    id: 'routed_boundary',
    title: 'Routed boundary',
    required_tools,
    phases: [{ id: 'p', title: 'p', steps: steps.map(s => ({ title: s.id, sample_request: {}, ...s })) }],
  };
}

function sets(result) {
  const steps = result.phases.flatMap(p => p.steps);
  return {
    selected: steps.filter(s => !s.skipped).map(s => s.step_id),
    skipped: steps.filter(s => s.skipped).map(s => [s.step_id, s.skip_reason]),
    failed: steps.filter(s => !s.passed).map(s => s.step_id),
  };
}

async function run(topology, sb, options = {}, entryOptions = {}) {
  const entries = await Promise.all(
    Object.entries(topology).map(async ([key, [tools, caps, reject]]) => [key, await startAgent(tools, caps, reject)])
  );
  const agents = Object.fromEntries(entries);
  try {
    const result = await runStoryboard('', sb, {
      strictResponseSchemaValidation: false,
      invariants: [],
      ...options,
      agents: Object.fromEntries(entries.map(([key, a]) => [key, { url: a.url, ...entryOptions[key] }])),
    });
    return {
      result,
      calls: Object.fromEntries(entries.map(([key, a]) => [key, a.calls])),
      authorization: Object.fromEntries(entries.map(([key, a]) => [key, a.authorization])),
    };
  } finally {
    await closeConnections();
    await Promise.all(Object.values(agents).map(a => a.close()));
  }
}

for (const adcpVersion of ['3.1.20', '3.1.23', ADCP_VERSION]) {
  describe(`routed applicability (${adcpVersion})`, () => {
    test('a prerequisite on another agent cannot authorize the selected agent', async () => {
      const { result, calls } = await run(
        { a: [[], {}], b: [['sync_governance'], {}] },
        storyboard([
          { id: 'split', task: 'get_adcp_capabilities', requires_tool: 'sync_governance', agent: 'a' },
          { id: 'complete', task: 'get_adcp_capabilities', requires_tool: 'sync_governance', agent: 'b' },
        ]),
        { adcpVersion }
      );
      assert.deepEqual(sets(result), { selected: ['complete'], skipped: [['split', 'missing_tool']], failed: [] });
      assert.deepEqual(calls, { a: ['get_adcp_capabilities'], b: ['get_adcp_capabilities', 'get_adcp_capabilities'] });
    });

    test('task availability and a separate prerequisite must coexist on the route', async () => {
      const { result, calls } = await run(
        { a: [['sync_governance'], {}], b: [['get_signals'], { supported_protocols: ['signals'] }] },
        storyboard([
          { id: 'missing_task', task: 'get_signals', requires_tool: 'sync_governance', agent: 'a' },
          { id: 'missing_prerequisite', task: 'get_signals', requires_tool: 'sync_governance', agent: 'b' },
          { id: 'legitimate_route', task: 'get_signals', sample_request: { signal_spec: 'test' } },
        ]),
        { adcpVersion }
      );
      assert.deepEqual(sets(result), {
        selected: ['legitimate_route'],
        skipped: [
          ['missing_task', 'missing_tool'],
          ['missing_prerequisite', 'missing_tool'],
        ],
        failed: [],
      });
      assert.deepEqual(calls.a, ['get_adcp_capabilities']);
      // The typed tool call also negotiates its client's capability cache.
      assert.deepEqual(calls.b, ['get_adcp_capabilities', 'get_adcp_capabilities', 'get_signals']);
    });

    test('any-of selection preserves first and secondary complete routes despite stale caller tools', async () => {
      for (const owner of ['a', 'b']) {
        const sb = storyboard(
          [{ id: 'owner', task: 'get_adcp_capabilities', requires_tool: 'sync_governance', agent: owner }],
          ['sync_governance', 'activate_signal']
        );
        const { result } = await run(
          { a: [owner === 'a' ? ['sync_governance'] : [], {}], b: [owner === 'b' ? ['sync_governance'] : [], {}] },
          sb,
          { adcpVersion, agentTools: [], profile: { name: 'stale', tools: [] } }
        );
        assert.deepEqual(sets(result), { selected: ['owner'], skipped: [], failed: [] });
        assert.deepEqual(
          partitionStoryboardsByRequiredTools([sb], ['sync_governance']).runnable.map(s => s.id),
          ['routed_boundary']
        );
      }
    });

    test('a caller cannot invent tools absent from routed discovery', async () => {
      const { result, calls } = await run(
        { a: [[], {}], b: [[], {}] },
        storyboard([{ id: 'absent', task: 'sync_governance', agent: 'a' }], ['sync_governance']),
        { adcpVersion, agentTools: ['sync_governance'] }
      );
      assert.equal(result.failed_count, 0);
      assert.equal(result.passed_count, 0);
      assert.deepEqual(sets(result), { selected: [], skipped: [['missing_tool', 'missing_tool']], failed: [] });
      assert.deepEqual(calls, { a: ['get_adcp_capabilities'], b: ['get_adcp_capabilities'] });
    });

    test('overlapping protocol claims remain failures and explicit routes remain authoritative', async () => {
      const topology = {
        a: [[], { supported_protocols: ['signals'] }],
        b: [['get_signals'], { supported_protocols: ['signals'] }],
      };
      const conflict = await run(topology, storyboard([{ id: 'ambiguous', task: 'get_signals' }]), { adcpVersion });
      assert.equal(conflict.result.failed_count, 1);
      assert.match(conflict.result.phases[0].steps[0].error, /Routing conflict/);
      assert.deepEqual(conflict.calls, { a: ['get_adcp_capabilities'], b: ['get_adcp_capabilities'] });
      const explicit = await run(
        topology,
        storyboard([
          { id: 'incomplete_override', task: 'get_signals', agent: 'a' },
          { id: 'complete_override', task: 'get_signals', agent: 'b', sample_request: { signal_spec: 'test' } },
        ]),
        { adcpVersion }
      );
      assert.deepEqual(sets(explicit.result), {
        selected: ['complete_override'],
        skipped: [['incomplete_override', 'missing_tool']],
        failed: [],
      });
    });

    test('an absent route stays a failure even if the union advertises the task', async () => {
      const { result } = await run(
        { a: [['get_signals'], {}], b: [[], {}] },
        storyboard([{ id: 'unrouted', task: 'get_signals' }]),
        { adcpVersion }
      );
      assert.deepEqual(sets(result), { selected: ['unrouted'], skipped: [], failed: ['unrouted'] });
      assert.match(result.phases[0].steps[0].error, /No agent.*signals/);
    });

    test('discovery failure stays a failure instead of becoming an empty-tool skip', async () => {
      const sb = storyboard([{ id: 'broken', task: 'get_signals', agent: 'broken' }], ['get_signals']);
      for (const discovery_resilient of [false, true]) {
        const result = await runStoryboard('', sb, {
          adcpVersion,
          discovery_resilient,
          agents: { broken: { url: 'http://127.0.0.1:1/mcp' } },
          agentTools: ['get_signals'],
        });
        assert.equal(result.failed_count, 1);
        assert.equal(result.skipped_count, 0);
        assert.equal(result.overall_passed, false);
      }
    });

    test('root and phase capabilities follow selected routes in either map order', async () => {
      for (const scope of ['root', 'phase', 'all']) {
        for (const order of [
          ['a', 'b'],
          ['b', 'a'],
        ]) {
          const sb = storyboard([
            { id: 'unsupported', task: 'get_adcp_capabilities', agent: 'a' },
            { id: 'supported', task: 'get_adcp_capabilities', agent: 'b' },
          ]);
          const predicate = { path: 'account.require_operator_auth', equals: true };
          if (scope === 'root') sb.requires_capability = predicate;
          if (scope === 'phase') sb.phases[0].requires_capability = predicate;
          if (scope === 'all')
            sb.requires_all_capabilities = [predicate, { path: 'request_signing.supported', equals: true }];
          const topology = Object.fromEntries(
            order.map(key => [
              key,
              [
                [],
                {
                  account: { require_operator_auth: key === 'b' },
                  request_signing: { supported: true },
                },
              ],
            ])
          );
          const { result, calls } = await run(topology, sb, {
            adcpVersion,
            _profile: { raw_capabilities: { account: { require_operator_auth: false } } },
          });
          assert.deepEqual(sets(result), {
            selected: ['supported'],
            skipped: [['unsupported', 'not_applicable']],
            failed: [],
          });
          assert.deepEqual(calls.a, ['get_adcp_capabilities']);
          assert.deepEqual(calls.b, ['get_adcp_capabilities', 'get_adcp_capabilities']);
        }
      }
    });

    test('conjunctive capabilities cannot be assembled across agents', async () => {
      const sb = storyboard([
        { id: 'a', task: 'get_adcp_capabilities', agent: 'a' },
        { id: 'b', task: 'get_adcp_capabilities', agent: 'b' },
      ]);
      sb.requires_all_capabilities = [
        { path: 'account.require_operator_auth', equals: true },
        { path: 'request_signing.supported', equals: true },
      ];
      const { result, calls } = await run(
        {
          a: [[], { account: { require_operator_auth: true }, request_signing: { supported: false } }],
          b: [[], { account: { require_operator_auth: false }, request_signing: { supported: true } }],
        },
        sb,
        { adcpVersion }
      );
      assert.deepEqual(sets(result), {
        selected: [],
        skipped: [['capability_unsupported', 'capability_unsupported']],
        failed: [],
      });
      assert.deepEqual(calls, { a: ['get_adcp_capabilities'], b: ['get_adcp_capabilities'] });
    });

    test('resilient broken routes remain failures through capability and tool-family gates', async () => {
      const healthy = await startAgent([], { account: { require_operator_auth: false } });
      try {
        for (const scope of ['root', 'phase', 'family']) {
          const sb = storyboard([{ id: 'broken', task: 'get_signals', agent: 'broken' }], ['get_signals']);
          const predicate = { path: 'account.require_operator_auth', equals: true };
          if (scope === 'root') sb.requires_capability = predicate;
          if (scope === 'phase') sb.phases[0].requires_capability = predicate;
          if (scope === 'family') sb.required_any_of_tools = [{ tools: ['get_signals', 'activate_signal'] }];
          const result = await runStoryboard('', sb, {
            adcpVersion,
            discovery_resilient: true,
            agents: { healthy: { url: healthy.url }, broken: { url: 'http://127.0.0.1:1/mcp' } },
          });
          assert.deepEqual(sets(result), { selected: ['broken'], skipped: [], failed: ['broken'] });
          assert.equal(result.failed_count, 1);
        }
      } finally {
        await closeConnections();
        await healthy.close();
      }
    });

    test('cascade classification checks the selected route before borrowing union tools', async () => {
      const sb = storyboard([
        {
          id: 'trigger',
          task: 'get_adcp_capabilities',
          agent: 'a',
          stateful: true,
          validations: [{ check: 'field_value', path: 'missing', value: 'required' }],
        },
        { id: 'missing_task', task: 'get_signals', agent: 'a', stateful: true },
        {
          id: 'missing_prerequisite',
          task: 'get_adcp_capabilities',
          requires_tool: 'get_signals',
          agent: 'a',
          stateful: true,
        },
        { id: 'unrouted', task: 'get_signals', stateful: true },
        { id: 'dependent', task: 'get_signals', agent: 'b', stateful: true },
      ]);
      const { result, calls } = await run({ a: [[], {}], b: [['get_signals'], {}] }, sb, { adcpVersion });
      assert.deepEqual(sets(result), {
        selected: ['trigger', 'unrouted'],
        skipped: [
          ['missing_task', 'missing_tool'],
          ['missing_prerequisite', 'missing_tool'],
          ['dependent', 'prerequisite_failed'],
        ],
        failed: ['trigger', 'unrouted', 'dependent'],
      });
      assert.deepEqual(calls, { a: ['get_adcp_capabilities', 'get_adcp_capabilities'], b: ['get_adcp_capabilities'] });
    });

    test("creative preflight cannot borrow another route's tool or suppress later coverage", async () => {
      const { BUILD_ASSETS_FROM_FORMAT_DIRECTIVE } = require('../../dist/lib/testing/storyboard/creative-assets.js');
      const sb = storyboard([
        {
          id: 'missing_creative',
          task: 'sync_creatives',
          agent: 'a',
          sample_request: {
            creatives: [
              {
                creative_id: 'one',
                assets: {
                  [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
                    slots: [{ asset_group_id: 'video_main', asset_type: 'video', required: true }],
                  },
                },
              },
            ],
          },
        },
        { id: 'still_runs', task: 'get_adcp_capabilities', agent: 'a' },
      ]);
      const { result, calls } = await run({ a: [[], {}], b: [['sync_creatives'], {}] }, sb, { adcpVersion });
      assert.deepEqual(sets(result), {
        selected: ['still_runs'],
        skipped: [['missing_creative', 'missing_tool']],
        failed: [],
      });
      assert.deepEqual(calls, { a: ['get_adcp_capabilities', 'get_adcp_capabilities'], b: ['get_adcp_capabilities'] });
    });

    test('actual wire credentials stay on their selected route including auth overrides', async () => {
      const { result, authorization } = await run(
        { a: [[], {}], b: [[], {}] },
        storyboard([
          { id: 'a', task: 'get_adcp_capabilities', agent: 'a' },
          { id: 'b', task: 'get_adcp_capabilities', agent: 'b' },
          { id: 'anonymous_a', task: 'get_adcp_capabilities', agent: 'a', auth: 'none' },
          { id: 'anonymous_b', task: 'get_adcp_capabilities', agent: 'b', auth: 'none' },
        ]),
        { adcpVersion, allow_http: true, auth: { type: 'bearer', token: 'test-run-default' } },
        {
          a: { auth: { type: 'bearer', token: 'test-route-a' } },
          b: { auth: { type: 'bearer', token: 'test-route-b' } },
        }
      );
      assert.deepEqual(sets(result), {
        selected: ['a', 'b', 'anonymous_a', 'anonymous_b'],
        skipped: [],
        failed: [],
      });
      assert.deepEqual(authorization, {
        a: ['Bearer test-route-a', 'Bearer test-route-a', undefined],
        b: ['Bearer test-route-b', 'Bearer test-route-b', undefined],
      });
    });

    test('dynamic ambiguity fails before any earlier non-discovery call', async () => {
      const { result, calls } = await run(
        {
          a: [['get_signals'], { supported_protocols: ['signals'] }],
          b: [['get_signals'], { supported_protocols: ['signals'] }],
        },
        storyboard([
          { id: 'earlier', task: 'get_adcp_capabilities', agent: 'a' },
          { id: 'ambiguous', task: '$test_kit.routing.task', task_default: 'get_signals' },
        ]),
        { adcpVersion }
      );
      assert.equal(result.failed_count, 1);
      assert.equal(result.skipped_count, 0);
      assert.match(result.phases[0].steps[0].error, /Routing conflict/);
      assert.deepEqual(calls, { a: ['get_adcp_capabilities'], b: ['get_adcp_capabilities'] });
    });

    test('dynamic task names route by their resolved canonical protocol', async () => {
      const { result, calls } = await run(
        {
          a: [[], {}],
          b: [['get_signals'], { supported_protocols: ['signals'] }],
        },
        storyboard([
          {
            id: 'dynamic',
            task: '$test_kit.routing.task',
            task_default: 'get_signals',
            sample_request: { signal_spec: 'test' },
          },
        ]),
        { adcpVersion }
      );
      assert.deepEqual(sets(result), { selected: ['dynamic'], skipped: [], failed: [] });
      assert.deepEqual(calls.b, ['get_adcp_capabilities', 'get_adcp_capabilities', 'get_signals']);
      assert.equal(result.phases[0].steps[0].agent_index, 2);
    });

    test('account capability and tool presence come from the same selected agent', async () => {
      const { result, calls } = await run(
        {
          a: [[], { account: { require_operator_auth: false } }],
          b: [[], { account: { require_operator_auth: true } }],
        },
        storyboard([
          { id: 'implicit_missing', task: 'sync_accounts', agent: 'a' },
          { id: 'explicit_inapplicable', task: 'sync_accounts', agent: 'b' },
        ]),
        { adcpVersion }
      );
      assert.deepEqual(sets(result), {
        selected: [],
        skipped: [
          ['implicit_missing', 'missing_tool'],
          ['explicit_inapplicable', 'not_applicable'],
        ],
        failed: [],
      });
      assert.deepEqual(calls, { a: ['get_adcp_capabilities'], b: ['get_adcp_capabilities'] });
    });
  });
}

test('routed option binding keeps tools, capabilities, auth and transport together', () => {
  const profile = {
    name: 'selected',
    tools: [{ name: 'get_products' }],
    raw_capabilities: { account: { require_operator_auth: true } },
  };
  const entry = {
    url: 'https://selected.example/a2a',
    transport: 'a2a',
    auth: { type: 'bearer', token: 'test-selected' },
  };
  const source = {
    protocol: 'mcp',
    auth: { type: 'bearer', token: 'test-primary' },
    agentTools: ['sync_accounts'],
    _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
    _profile: { name: 'primary', tools: ['sync_accounts'] },
    agents: { selected: entry },
  };
  const selected = routedAgentOptions(entry, source, profile);
  assert.equal(selected.protocol, 'a2a');
  assert.equal(selected.auth, entry.auth);
  assert.equal(selected._profile, profile);
  assert.deepEqual(selected.agentTools, ['get_products']);
  assert.equal(selected.agents, undefined);
  assert.deepEqual(selected._controllerCapabilities, { detected: false });
  assert.deepEqual(
    routedAgentOptions(entry, source, {
      ...profile,
      tools: ['comply_test_controller'],
      raw_capabilities: { compliance_testing: { scenarios: ['query_upstream_traffic'] } },
    })._controllerCapabilities,
    { detected: true, scenarios: ['query_upstream_traffic'] }
  );
  assert.deepEqual(source.agentTools, ['sync_accounts']);
  assert.deepEqual(routedAgentOptions(entry, source, { ...profile, tools: [] }).agentTools, []);
});

test('mixed MCP/A2A routes record and validate the selected transport', async () => {
  const express = require('express');
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
  const { createA2AAdapter } = require('../../dist/lib/server/a2a-adapter.js');
  const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
  const a = await startAgent([], {});
  const app = express();
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const adcp = createAdcpServer({
    name: 'routed-a2a',
    version: '1.0.0',
    mediaBuy: { getProducts: async () => ({ products: [] }) },
    stateStore: new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off' },
  });
  const a2a = createA2AAdapter({
    server: adcp,
    agentCard: { name: 'routed-a2a', description: 'transport fixture', url: `${url}/a2a`, version: '1.0.0' },
  });
  app.use(express.json());
  app.use('/.well-known/agent-card.json', a2a.agentCardHandler);
  app.use('/a2a', a2a.jsonRpcHandler);
  try {
    for (const protocol of ['mcp', 'a2a']) {
      const result = await runStoryboard(
        '',
        storyboard([
          { id: 'mcp', task: 'get_adcp_capabilities', agent: 'a' },
          { id: 'a2a', task: 'get_adcp_capabilities', agent: 'b' },
          { id: 'a2a_auth_probe', task: 'get_adcp_capabilities', agent: 'b', auth: 'none' },
        ]),
        {
          protocol,
          strictResponseSchemaValidation: false,
          invariants: [],
          agents: { a: { url: a.url, transport: 'mcp' }, b: { url, transport: 'a2a' } },
        }
      );
      assert.deepEqual(sets(result), { selected: ['mcp', 'a2a', 'a2a_auth_probe'], skipped: [], failed: [] });
      assert.deepEqual(
        result.phases[0].steps.map(s => [s.request.transport, s.response_record.transport]),
        [
          ['mcp', 'mcp'],
          ['a2a', 'a2a'],
          ['a2a', 'a2a'],
        ]
      );
    }
  } finally {
    await closeConnections();
    await a.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await adcp.close();
  }
});

// Run all authored phases without editing a declaration. Out-of-band fixture
// provisioning is the existing routed API contract; rejecting tool endpoints
// verify that declared coverage never becomes a passing/neutral report.
for (const version of ['3.1.20', '3.1.23']) {
  test(`complete governance/provenance routed rejection matrix (${version})`, async () => {
    const path = require('node:path');
    const { loadStoryboardFile } = require('../../dist/lib/testing/storyboard/loader.js');
    const manifest = require('../fixtures/routed-applicability/manifest.json');
    const observed = {};
    for (const entry of Object.values(manifest[version]).slice(2)) {
      const sb = loadStoryboardFile(path.join(__dirname, '../fixtures/routed-applicability', entry.file));
      const tasks = [...new Set(sb.phases.flatMap(p => p.steps.map(s => s.task)))];
      for (const mode of ['split', 'complete']) {
        const topology =
          mode === 'split'
            ? {
                seller: [['get_products'], { supported_protocols: ['media_buy'] }, true],
                auxiliary: [tasks.filter(t => t !== 'get_products'), { supported_protocols: ['governance'] }, true],
              }
            : {
                seller: [tasks, { supported_protocols: ['media_buy', 'governance'] }, true],
                auxiliary: [[], {}, true],
              };
        const { result } = await run(topology, sb, {
          adcpVersion: version,
          default_agent: 'seller',
          skip_controller_seeding: true,
        });
        observed[`${sb.id}/${mode}`] = sets(result);
      }
    }
    const expected = require('../fixtures/routed-applicability/routed-rejections.json');
    assert.deepEqual(observed, expected);
  });
}

test('fixture discovery uses its selected agent toolset and routing failures stay failures', async () => {
  const sb = storyboard([{ id: 'later', task: 'get_adcp_capabilities', agent: 'seller' }]);
  sb.fixtures = { products: [{ product_id: 'fixture-product' }] };
  sb.fixture_resolution = {
    products: [
      { handle: 'fixture-product', strategies: ['discover'], match: [{ path: '/product_id', operator: 'present' }] },
    ],
  };
  const { result, calls } = await run(
    {
      seller: [[], { supported_protocols: ['media_buy'] }],
      auxiliary: [['get_products', 'comply_test_controller'], { supported_protocols: ['signals'] }],
    },
    sb,
    { default_agent: 'seller' }
  );
  assert.deepEqual(calls, { seller: ['get_adcp_capabilities'], auxiliary: ['get_adcp_capabilities'] });
  assert.equal(result.failed_count, 0);
  assert.equal(result.passed_count, 0);
  assert.deepEqual(sets(result), {
    selected: [],
    skipped: [],
    failed: [],
  });
  assert.equal(result.skipped_count, 1);
  assert.deepEqual(
    result.coverage_gaps.map(gap => gap.reason),
    ['fixture_unsatisfied']
  );
  assert.equal(result.fixture_resolutions[0].strategies_attempted[0].disposition, 'unavailable');

  const healthy = await startAgent(['get_products'], { supported_protocols: ['signals'] });
  try {
    const failed = await runStoryboard('', sb, {
      discovery_resilient: true,
      default_agent: 'seller',
      agents: { seller: { url: 'http://127.0.0.1:1/mcp' }, auxiliary: { url: healthy.url } },
    });
    assert.equal(failed.failed_count, 1);
    assert.equal(failed.skipped_count, 0);
    assert.equal(failed.overall_passed, false);
    assert.match(failed.phases[0].steps[0].error, /discovery failed|no discovered profile/);
    assert.deepEqual(healthy.calls, ['get_adcp_capabilities']);
  } finally {
    await closeConnections();
    await healthy.close();
  }
});

test('a fixture coverage gap cannot conceal a failed declared route', async () => {
  const healthy = await startAgent([], { supported_protocols: ['signals'] });
  const sb = storyboard([{ id: 'broken', task: 'get_adcp_capabilities', agent: 'broken' }]);
  sb.fixtures = { products: [{ product_id: 'fixture-product' }] };
  sb.fixture_resolution = {
    products: [
      { handle: 'fixture-product', strategies: ['discover'], match: [{ path: '/product_id', operator: 'present' }] },
    ],
  };
  try {
    const result = await runStoryboard('', sb, {
      discovery_resilient: true,
      default_agent: 'broken',
      agents: { broken: { url: 'http://127.0.0.1:1/mcp' }, healthy: { url: healthy.url } },
    });
    assert.deepEqual(sets(result), { selected: ['broken'], skipped: [], failed: ['broken'] });
    assert.equal(result.failed_count, 1);
    assert.equal(result.overall_passed, false);
    assert.deepEqual(
      result.coverage_gaps.map(gap => gap.reason),
      ['fixture_unsatisfied']
    );
    assert.match(
      result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'broken').error,
      /discovery failed|no discovered profile/
    );
    assert.deepEqual(healthy.calls, ['get_adcp_capabilities']);
  } finally {
    await closeConnections();
    await healthy.close();
  }
});

test('OAuth metadata applicability and reactive absence belong to each selected agent', async () => {
  const apiKey = await startAgent([], { oauth: { supported: false } });
  const oauth = await startAgent([], { oauth: { supported: true } });
  try {
    for (const reverse of [false, true]) {
      apiKey.metadataRequests.length = 0;
      oauth.metadataRequests.length = 0;
      const entries = [
        ['apiKey', { url: apiKey.url }],
        ['oauth', { url: oauth.url }],
      ];
      const result = await runStoryboard(
        '',
        storyboard([
          { id: 'apiKey_prm', task: 'protected_resource_metadata', agent: 'apiKey' },
          { id: 'oauth_read', task: 'get_adcp_capabilities', agent: 'oauth' },
          { id: 'oauth_prm', task: 'protected_resource_metadata', agent: 'oauth' },
          { id: 'oauth_after_404', task: 'get_adcp_capabilities', agent: 'oauth' },
        ]),
        {
          allow_http: true,
          strictResponseSchemaValidation: false,
          invariants: [],
          agents: Object.fromEntries(reverse ? entries.reverse() : entries),
        }
      );
      assert.deepEqual(sets(result), {
        selected: ['oauth_read'],
        skipped: [
          ['apiKey_prm', 'oauth_not_advertised'],
          ['oauth_prm', 'oauth_not_advertised'],
          ['oauth_after_404', 'oauth_not_advertised'],
        ],
        failed: [],
      });
      assert.deepEqual(apiKey.metadataRequests, []);
      assert.ok(oauth.metadataRequests.length > 0, 'the OAuth route is actually probed');
    }
  } finally {
    await closeConnections();
    await apiKey.close();
    await oauth.close();
  }
});

test('phase-local repeated step IDs cannot share routed capability decisions', async () => {
  const sb = storyboard([]);
  sb.phases = [
    {
      id: 'inapplicable',
      title: 'Inapplicable',
      requires_capability: { path: 'request_signing.supported', equals: true },
      steps: [{ id: 'same', title: 'Same ID', task: 'get_adcp_capabilities', agent: 'a' }],
    },
    {
      id: 'applicable',
      title: 'Applicable',
      requires_capability: { path: 'request_signing.supported', equals: true },
      steps: [{ id: 'same', title: 'Same ID', task: 'get_adcp_capabilities', agent: 'b' }],
    },
  ];
  const { result, calls } = await run(
    { a: [[], { request_signing: { supported: false } }], b: [[], { request_signing: { supported: true } }] },
    sb
  );
  assert.deepEqual(sets(result), { selected: ['same'], skipped: [['same', 'not_applicable']], failed: [] });
  assert.equal(result.phases[0].steps[0].agent_index, 1);
  assert.equal(result.phases[1].steps[0].agent_index, 2);
  assert.deepEqual(calls, { a: ['get_adcp_capabilities'], b: ['get_adcp_capabilities', 'get_adcp_capabilities'] });
});

test('validation-only coverage requires no agent route', async () => {
  const { result } = await run(
    { a: [[], {}] },
    storyboard([{ id: 'coverage', validations: [{ check: 'present', path: 'value' }] }])
  );
  assert.equal(result.failed_count, 0);
  assert.deepEqual(sets(result), { selected: [], skipped: [['coverage', 'fixture_unavailable']], failed: [] });
});

test('runtime requirements remain enforced with an unresolved route', async () => {
  const sb = storyboard([{ id: 'unroutable', task: 'unknown_tool' }]);
  sb.requires = ['webhook_receiver'];
  // A capability predicate defers the runtime gate until after discovery.
  sb.requires_capability = { path: 'request_signing.supported', equals: true };
  const { result, calls } = await run({ a: [[], { request_signing: { supported: true } }] }, sb);
  assert.equal(result.phases[0].steps[0].skip.requirement, 'webhook_receiver');
  assert.deepEqual(sets(result), {
    selected: [],
    skipped: [['requirement_unmet:webhook_receiver', 'requirement_unmet']],
    failed: [],
  });
  assert.deepEqual(calls, { a: ['get_adcp_capabilities'] });
});

test('a missing any-of tool family cannot conceal an unresolved selected route', async () => {
  const sb = storyboard([{ id: 'unroutable', task: 'unknown_tool' }]);
  sb.required_tools = ['absent_tool'];
  const { result, calls } = await run({ a: [[], {}] }, sb);
  assert.deepEqual(sets(result), { selected: ['unroutable'], skipped: [], failed: ['unroutable'] });
  assert.deepEqual(calls, { a: ['get_adcp_capabilities'] });
});

test('implicit signing applicability preserves per-agent opt-in and requirement details', async () => {
  const sb = storyboard([
    { id: 'unsigned', task: 'get_adcp_capabilities', agent: 'a' },
    { id: 'signed', task: 'get_adcp_capabilities', agent: 'b' },
  ]);
  sb.id = 'signed_requests';
  const { result, calls } = await run(
    { a: [[], { request_signing: { supported: false } }], b: [[], { request_signing: { supported: true } }] },
    sb
  );
  assert.deepEqual(sets(result), { selected: ['signed'], skipped: [['unsigned', 'not_applicable']], failed: [] });
  assert.equal(result.phases[0].steps[0].skip.requirement, 'request_signer');
  assert.match(result.phases[0].steps[0].skip.detail, /pre-register the runner/);
  assert.deepEqual(calls, { a: ['get_adcp_capabilities'], b: ['get_adcp_capabilities', 'get_adcp_capabilities'] });
});

test('routed controller scenario declarations accept object maps without inheriting another agent cache', () => {
  for (const scenarios of [undefined, { query_upstream_traffic: 'supported' }]) {
    const selected = routedAgentOptions(
      { url: 'https://controller.example/mcp' },
      { _controllerCapabilities: { detected: true, scenarios: ['foreign'] } },
      { tools: ['comply_test_controller'], raw_capabilities: { compliance_testing: { scenarios } } }
    );
    assert.deepEqual(
      selected._controllerCapabilities,
      scenarios ? { detected: true, scenarios: ['query_upstream_traffic'] } : { detected: false }
    );
  }
});
