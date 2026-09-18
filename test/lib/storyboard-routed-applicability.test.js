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
async function startAgent(
  tools,
  capabilities = {},
  rejectTools = false,
  products = [],
  metadataStatus = 404,
  metadataResponse = {},
  rejectedAuthorization
) {
  const calls = [];
  const authorization = [];
  const connections = [];
  const metadataRequests = [];
  const server = http.createServer(async (req, res) => {
    if (rejectedAuthorization && req.headers.authorization === rejectedAuthorization) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized test credential' }));
      return;
    }
    if (req.url.includes('/.well-known/')) {
      metadataRequests.push(req.url);
      res.writeHead(metadataStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(typeof metadataResponse === 'function' ? metadataResponse(req) : metadataResponse));
      return;
    }
    const mcp = new McpServer({ name: 'routing-contract-test', version: '1.0.0' });
    for (const name of new Set([...(capabilities === null ? [] : ['get_adcp_capabilities']), ...tools])) {
      mcp.registerTool(name, {}, async () => {
        calls.push(name);
        authorization.push(req.headers.authorization);
        if (rejectTools && name !== 'get_adcp_capabilities') {
          if (rejectTools === 'structured') {
            const error = { errors: [{ code: 'INVALID_REQUEST', message: 'Deterministic agent rejection' }] };
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify(error) }],
              structuredContent: error,
            };
          }
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
                ? { products, cache_scope: 'public' }
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
    Object.entries(topology).map(async ([key, [tools, caps, reject, products]]) => [
      key,
      await startAgent(tools, caps, reject, products),
    ])
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
    selected: ['unroutable'],
    skipped: [['requirement_unmet:webhook_receiver', 'requirement_unmet']],
    failed: ['unroutable'],
  });
  assert.deepEqual(calls, { a: ['get_adcp_capabilities'] });
});

test('missing any-of tool gates cannot conceal an unresolved selected route', async () => {
  for (const field of ['required_tools', 'required_any_of_tools']) {
    const sb = storyboard([{ id: 'unroutable', task: 'unknown_tool' }]);
    sb[field] = field === 'required_tools' ? ['absent_tool'] : [{ tools: ['absent_tool', 'another_absent_tool'] }];
    const { result, calls } = await run({ a: [[], {}] }, sb);
    assert.deepEqual(sets(result), { selected: ['unroutable'], skipped: [], failed: ['unroutable'] });
    assert.deepEqual(calls, { a: ['get_adcp_capabilities'] });
  }
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

test('routed controller scenarios require a valid selected-agent declaration', () => {
  for (const scenarios of [
    undefined,
    {},
    { query_upstream_traffic: 'supported' },
    [],
    [1],
    ['query_upstream_traffic'],
  ]) {
    const selected = routedAgentOptions(
      { url: 'https://controller.example/mcp' },
      { _controllerCapabilities: { detected: true, scenarios: ['foreign'] } },
      { tools: ['comply_test_controller'], raw_capabilities: { compliance_testing: { scenarios } } }
    );
    assert.deepEqual(
      selected._controllerCapabilities,
      Array.isArray(scenarios) && scenarios.length && typeof scenarios[0] === 'string'
        ? { detected: true, scenarios: ['query_upstream_traffic'] }
        : { detected: false }
    );
  }
});

for (const strategies of [['discover'], ['discover', 'seed']]) {
  test(`fixture ${strategies.join(' then ')} never resolves an unused ambiguous controller`, async () => {
    const sb = storyboard([{ id: 'later', task: 'get_adcp_capabilities', agent: 'seller' }]);
    sb.fixtures = { products: [{ product_id: 'fixture-product' }] };
    sb.fixture_resolution = {
      products: [{ handle: 'fixture-product', strategies, match: [{ path: '/product_id', operator: 'present' }] }],
    };
    const { result, calls } = await run(
      {
        seller: [
          ['get_products'],
          { supported_protocols: ['media_buy'] },
          false,
          [
            require('./test-fixtures').createTestProduct({
              product_id: 'seller-product',
              format_ids: undefined,
              format_options: [
                {
                  format_option_id: 'display',
                  format_kind: 'image',
                  params: { width: 300, height: 250 },
                  canonical_formats_only: true,
                },
              ],
            }),
          ],
        ],
        controller_a: [['comply_test_controller'], { compliance_testing: { scenarios: ['seed_product'] } }],
        controller_b: [['comply_test_controller'], { compliance_testing: { scenarios: ['seed_product'] } }],
      },
      sb
    );
    assert.deepEqual(
      sets(result),
      { selected: ['seed_product.fixture-product', 'later'], skipped: [], failed: [] },
      JSON.stringify({ result, calls })
    );
    assert.equal(result.fixture_resolutions[0].strategy, 'discover');
    assert.deepEqual(
      result.fixture_resolutions[0].strategies_attempted.map(attempt => attempt.strategy),
      ['discover']
    );
    assert.deepEqual(calls, {
      seller: ['get_adcp_capabilities', 'get_adcp_capabilities', 'get_products', 'get_adcp_capabilities'],
      controller_a: ['get_adcp_capabilities'],
      controller_b: ['get_adcp_capabilities'],
    });
  });
}

test('controller applicability cannot conceal a failed route or authorize dependent stateful calls', async () => {
  const healthy = await startAgent(['get_signals'], { supported_protocols: ['signals'] });
  const sb = storyboard([
    { id: 'broken', task: 'get_adcp_capabilities', agent: 'broken', stateful: true },
    { id: 'dependent', task: 'get_signals', agent: 'healthy', stateful: true },
    { id: 'read', task: 'get_adcp_capabilities', agent: 'healthy' },
  ]);
  sb.requires = ['controller'];
  try {
    const result = await runStoryboard('', sb, {
      discovery_resilient: true,
      strictResponseSchemaValidation: false,
      invariants: [],
      agents: { broken: { url: 'http://127.0.0.1:1/mcp' }, healthy: { url: healthy.url } },
    });
    assert.deepEqual(sets(result), {
      selected: ['broken', 'read'],
      skipped: [['dependent', 'prerequisite_failed']],
      failed: ['broken', 'dependent'],
    });
    assert.equal(result.overall_passed, false);
    assert.deepEqual(healthy.calls, ['get_adcp_capabilities', 'get_adcp_capabilities']);
  } finally {
    await closeConnections();
    await healthy.close();
  }
});

test('a legacy routed agent without capability discovery did not opt into signing', async () => {
  const sb = storyboard([
    { id: 'legacy', task: 'get_signals', agent: 'legacy' },
    { id: 'signed', task: 'get_signals', agent: 'signed' },
  ]);
  sb.id = 'signed_requests';
  const { result, calls } = await run(
    {
      legacy: [['get_signals'], null],
      signed: [['get_signals'], { supported_protocols: ['signals'], request_signing: { supported: true } }],
    },
    sb
  );
  assert.deepEqual(
    sets(result),
    { selected: ['signed'], skipped: [['legacy', 'not_applicable']], failed: [] },
    JSON.stringify(result)
  );
  assert.equal(result.phases[0].steps[0].skip.requirement, 'request_signer');
  assert.deepEqual(calls, { legacy: [], signed: ['get_adcp_capabilities', 'get_adcp_capabilities', 'get_signals'] });
});

test('reachable routed agents still enforce the controller prerequisite', async () => {
  const sb = storyboard([{ id: 'later', task: 'get_adcp_capabilities', agent: 'a' }]);
  sb.requires = ['controller'];
  const { result, calls } = await run({ a: [[], {}], b: [[], {}] }, sb);
  assert.deepEqual(sets(result), {
    selected: [],
    skipped: [['requirement_unmet:controller', 'missing_test_controller']],
    failed: [],
  });
  assert.equal(result.phases[0].steps[0].skip.requirement, 'controller');
  assert.deepEqual(calls, { a: ['get_adcp_capabilities'], b: ['get_adcp_capabilities'] });
});

test('validation-only rows do not prevent a whole-storyboard capability skip', async () => {
  const sb = storyboard([
    { id: 'probe', task: 'get_adcp_capabilities', agent: 'a' },
    { id: 'coverage', validations: [{ check: 'present', path: 'value' }] },
  ]);
  sb.requires_capability = { path: 'request_signing.supported', equals: true };
  const { result, calls } = await run({ a: [[], { request_signing: { supported: false } }] }, sb);
  assert.deepEqual(sets(result), {
    selected: [],
    skipped: [['capability_unsupported', 'capability_unsupported']],
    failed: [],
  });
  assert.deepEqual(calls, { a: ['get_adcp_capabilities'] });
});

test('validation-only rows do not trigger fixture routes for a capability-skipped phase', async () => {
  const sb = storyboard([
    { id: 'probe', task: 'get_adcp_capabilities', agent: 'seller' },
    { id: 'coverage', validations: [{ check: 'present', path: 'value' }] },
  ]);
  sb.phases[0].requires_capability = { path: 'request_signing.supported', equals: true };
  sb.fixtures = { products: [{ product_id: 'fixture-product' }] };
  sb.fixture_resolution = { products: [{ handle: 'fixture-product', strategies: ['seed'] }] };
  const { result, calls } = await run(
    {
      seller: [[], { request_signing: { supported: false } }],
      controller_a: [['comply_test_controller'], { compliance_testing: { scenarios: ['seed_product'] } }],
      controller_b: [['comply_test_controller'], { compliance_testing: { scenarios: ['seed_product'] } }],
    },
    sb
  );
  assert.deepEqual(sets(result), {
    selected: [],
    skipped: [
      ['probe', 'not_applicable'],
      ['coverage', 'not_applicable'],
    ],
    failed: [],
  });
  assert.deepEqual(calls, {
    seller: ['get_adcp_capabilities'],
    controller_a: ['get_adcp_capabilities'],
    controller_b: ['get_adcp_capabilities'],
  });
});

test('a skipped phase cannot erase its failed route or confuse a repeated step ID', async () => {
  const sb = storyboard([]);
  sb.context = { skip: true };
  sb.phases = [
    { id: 'read', title: 'Read', steps: [{ id: 'same', title: 'Same', task: 'get_adcp_capabilities', agent: 'a' }] },
    {
      id: 'skipped',
      title: 'Skipped',
      skip_if: 'context.skip',
      steps: [{ id: 'same', title: 'Same', task: 'unknown_tool' }],
    },
  ];
  const { result, calls } = await run({ a: [[], {}] }, sb);
  assert.deepEqual(sets(result), { selected: ['same', 'same'], skipped: [], failed: ['same'] });
  assert.equal(result.phases[0].steps[0].passed, true);
  assert.equal(result.phases[1].steps[0].passed, false);
  assert.equal(result.failed_count, 1);
  assert.equal(result.overall_passed, false);
  assert.deepEqual(calls, { a: ['get_adcp_capabilities', 'get_adcp_capabilities'] });
});

test('skipped-phase routing failures block dependent stateful dispatch before reconciliation', async () => {
  for (const dependency of ['explicit', 'implicit', 'independent', 'non_stateful']) {
    const sb = storyboard([]);
    sb.context = { skip: true };
    sb.phases = [
      {
        id: 'skipped',
        title: 'Skipped',
        skip_if: 'context.skip',
        steps: [
          { id: 'unroutable', title: 'Unroutable', task: 'unknown_tool', stateful: dependency !== 'non_stateful' },
        ],
      },
      {
        id: 'dependent',
        title: 'Dependent',
        ...(dependency === 'explicit' ? { depends_on: ['skipped'] } : {}),
        ...(dependency === 'independent' ? { depends_on: [] } : {}),
        steps: [{ id: 'mutation', title: 'Mutation', task: 'get_adcp_capabilities', agent: 'a', stateful: true }],
      },
      {
        id: 'later',
        title: 'Later',
        depends_on: ['dependent'],
        steps: [
          { id: 'later_mutation', title: 'Later mutation', task: 'get_adcp_capabilities', agent: 'a', stateful: true },
        ],
      },
    ];
    const { result, calls } = await run({ a: [[], {}] }, sb);
    const executes = dependency === 'independent' || dependency === 'non_stateful';
    for (const phase of result.phases.slice(1)) {
      const row = phase.steps[0];
      assert.equal(row.skip_reason, executes ? undefined : 'prerequisite_failed', dependency);
      assert.equal(row.passed, executes, dependency);
    }
    assert.equal(result.failed_count, 1, dependency);
    assert.equal(result.overall_passed, false, dependency);
    assert.equal(calls.a.length, executes ? 3 : 1, dependency);
  }
});

test('neutral routed stateful cascades survive explicit dependency hops without hiding local hard state', async () => {
  for (const mode of ['neutral', 'hard_peer', 'independent']) {
    const sb = storyboard([]);
    sb.phases = [
      {
        id: 'capability',
        title: 'Capability',
        requires_capability: { path: 'account.require_operator_auth', equals: true },
        steps: [{ id: 'producer', title: 'Producer', task: 'get_adcp_capabilities', agent: 'a', stateful: true }],
      },
      ...['b', 'c', 'd'].map((id, index) => ({
        id,
        title: id,
        depends_on: index === 0 ? ['capability'] : mode === 'independent' && index === 1 ? [] : [['b', 'c'][index - 1]],
        steps: [
          { id, title: id, task: 'get_adcp_capabilities', agent: 'b', stateful: true },
          ...(mode === 'hard_peer' && index === 0
            ? [
                {
                  id: 'missing',
                  title: 'Missing',
                  task: 'get_adcp_capabilities',
                  requires_tool: 'get_signals',
                  agent: 'b',
                  stateful: true,
                },
              ]
            : []),
        ],
      })),
      {
        id: 'read',
        title: 'Read',
        depends_on: ['capability'],
        steps: [{ id: 'read', title: 'Read', task: 'get_adcp_capabilities', agent: 'b' }],
      },
    ];
    const { result, calls } = await run({ a: [[], { account: { require_operator_auth: false } }], b: [[], {}] }, sb);
    for (const id of ['b', 'c', 'd']) {
      const row = result.phases.find(p => p.phase_id === id).steps[0];
      const executed = mode === 'independent' && id !== 'b';
      const hard = mode === 'hard_peer' && id !== 'b';
      assert.equal(
        row.skip_reason,
        executed ? undefined : hard ? 'prerequisite_failed' : 'capability_prerequisite_unavailable',
        `${mode}/${id}`
      );
      assert.equal(row.passed, !hard, `${mode}/${id}`);
    }
    assert.equal(result.failed_count, 0, mode);
    assert.equal(result.overall_passed, mode !== 'hard_peer', mode);
    assert.equal(calls.b.length, mode === 'independent' ? 4 : 2, mode);
  }
});

test('failed prerequisite rows grade required phases consistently across routing modes', async () => {
  for (const mode of ['single', 'replica', 'routed']) {
    for (const optional of [false, true]) {
      const a = await startAgent(['get_signals'], { supported_protocols: ['signals'] });
      const b = await startAgent(['get_signals'], { supported_protocols: ['signals'] });
      try {
        const sb = storyboard([
          {
            id: 'missing',
            task: 'get_signals',
            sample_request: { signal_spec: '$context.missing' },
            ...(mode === 'routed' ? { agent: 'a' } : {}),
          },
          { id: 'read', task: 'get_adcp_capabilities', ...(mode === 'routed' ? { agent: 'a' } : {}) },
        ]);
        sb.phases[0].optional = optional;
        if (optional) {
          sb.phases.push({
            id: 'independent',
            title: 'Independent',
            depends_on: [],
            steps: [
              {
                id: 'independent',
                title: 'Independent',
                task: 'get_adcp_capabilities',
                ...(mode === 'routed' ? { agent: 'a' } : {}),
              },
            ],
          });
        }
        const result = await runStoryboard(mode === 'routed' ? '' : mode === 'replica' ? [a.url, b.url] : a.url, sb, {
          strictResponseSchemaValidation: false,
          invariants: [],
          ...(mode === 'routed' ? { agents: { a: { url: a.url }, b: { url: b.url } } } : {}),
        });
        const label = `${mode}/${optional}`;
        const missing = result.phases[0].steps[0];
        assert.equal(missing.skip_reason, 'prerequisite_failed', label);
        assert.equal(missing.passed, false, label);
        assert.equal(result.phases[0].passed, false, label);
        assert.equal(result.overall_passed, optional, label);
        assert.equal(result.failed_count, 0, label);
        assert.equal(result.passed_count, optional ? 2 : 1, label);
        assert.equal(result.skipped_count, 1, label);
        assert.equal([...a.calls, ...b.calls].filter(task => task === 'get_signals').length, 0, label);
      } finally {
        await closeConnections();
        await Promise.all([a.close(), b.close()]);
      }
    }
  }
});

test('routing failures retain unavailable outputs through normal and skipped phases', async () => {
  for (const skippedPhase of [false, true]) {
    for (const dependency of ['implicit', 'explicit', 'independent', 'restored']) {
      const sb = storyboard([]);
      sb.context = { skip: true, ...(dependency === 'restored' ? { needed: 'restored' } : {}) };
      sb.phases = [
        {
          id: 'producer',
          title: 'Producer',
          ...(skippedPhase ? { skip_if: 'context.skip' } : {}),
          steps: [
            {
              id: 'unroutable',
              title: 'Unroutable',
              task: 'unknown_tool',
              context_outputs: [{ key: 'needed', path: 'value' }],
            },
          ],
        },
        {
          id: 'consumer',
          title: 'Consumer',
          ...(dependency === 'explicit' ? { depends_on: ['producer'] } : {}),
          ...(dependency === 'independent' ? { depends_on: [] } : {}),
          steps: [
            {
              id: 'negative',
              title: 'Negative',
              task: 'get_signals',
              agent: 'a',
              expect_error: true,
              sample_request: { signal_spec: '$context.needed' },
            },
          ],
        },
      ];
      const { result, calls } = await run({ a: [['get_signals'], { supported_protocols: ['signals'] }, true] }, sb);
      const executes = dependency === 'independent' || dependency === 'restored';
      const label = `${skippedPhase}/${dependency}`;
      const consumer = result.phases[1].steps[0];
      assert.equal(consumer.skip_reason, executes ? undefined : 'prerequisite_failed', label);
      assert.equal(consumer.passed, executes, label);
      assert.equal(calls.a.filter(task => task === 'get_signals').length, executes ? 1 : 0, label);
      assert.equal(result.failed_count, 1, label);
      assert.equal(result.overall_passed, false, label);
    }
  }
});

test('selected capability skips retain output protection before OAuth absence handling', async () => {
  for (const eligible of [false, true]) {
    const sb = storyboard([
      { id: 'probe', task: 'protected_resource_metadata', agent: 'a' },
      {
        id: 'producer',
        task: 'get_adcp_capabilities',
        agent: 'a',
        context_outputs: [{ key: 'needed', path: 'identity.brand_json_url' }],
      },
      {
        id: 'consumer',
        task: 'get_signals',
        agent: 'b',
        expect_error: true,
        sample_request: { signal_spec: '$context.needed' },
      },
    ]);
    sb.phases[0].requires_capability = { path: 'account.require_operator_auth', equals: true };
    const { result, calls } = await run(
      {
        a: [[], { account: { require_operator_auth: eligible }, oauth: { supported: false } }],
        b: [
          ['get_signals'],
          { account: { require_operator_auth: true }, oauth: { supported: true }, supported_protocols: ['signals'] },
          true,
        ],
      },
      sb
    );
    const [probe, producer, consumer] = result.phases[0].steps;
    assert.equal(probe.skip_reason, eligible ? 'oauth_not_advertised' : 'not_applicable');
    assert.equal(producer.skip_reason, eligible ? 'oauth_not_advertised' : 'not_applicable');
    assert.equal(consumer.skip_reason, eligible ? undefined : 'capability_prerequisite_unavailable');
    assert.equal(calls.b.filter(task => task === 'get_signals').length, eligible ? 1 : 0);
  }
});

test('mixed skipped phases retain only known routed capability output gaps', async () => {
  for (const origin of ['capability', 'eligible', 'mixed_hard']) {
    const eligible = origin === 'eligible';
    const hard = origin === 'mixed_hard';
    for (const dependency of ['implicit', 'explicit', 'independent', 'restored']) {
      const sb = storyboard([]);
      sb.context = { skip: true, ...(dependency === 'restored' ? { needed: 'restored' } : {}) };
      sb.phases = [
        {
          id: 'producer',
          title: 'Producer',
          skip_if: 'context.skip',
          requires_capability: { path: 'account.require_operator_auth', equals: true },
          steps: [
            {
              id: 'producer',
              title: 'Producer',
              task: 'get_adcp_capabilities',
              agent: 'a',
              context_outputs: [{ key: 'needed', path: 'identity.brand_json_url' }],
            },
            { id: 'eligible_peer', title: 'Eligible peer', task: 'get_adcp_capabilities', agent: 'b' },
            ...(hard
              ? [
                  {
                    id: 'failed_route',
                    title: 'Failed route',
                    task: 'unknown_tool',
                    context_outputs: [{ key: 'needed', path: 'value' }],
                  },
                ]
              : []),
          ],
        },
        {
          id: 'consumer',
          title: 'Consumer',
          ...(dependency === 'explicit' ? { depends_on: ['producer'] } : {}),
          ...(dependency === 'independent' ? { depends_on: [] } : {}),
          steps: [
            {
              id: 'negative',
              title: 'Negative',
              task: 'get_signals',
              agent: 'b',
              expect_error: true,
              sample_request: { signal_spec: '$context.needed' },
            },
            { id: 'read', title: 'Read', task: 'get_adcp_capabilities', agent: 'b' },
          ],
        },
      ];
      const { result, calls } = await run(
        {
          a: [[], { account: { require_operator_auth: eligible } }],
          b: [['get_signals'], { account: { require_operator_auth: true }, supported_protocols: ['signals'] }, true],
        },
        sb
      );
      const executes = eligible || dependency === 'independent' || dependency === 'restored';
      const label = `${origin}/${dependency}`;
      assert.deepEqual(
        result.phases[0].steps.map(step => step.step_id),
        hard ? ['failed_route'] : [],
        label
      );
      assert.equal(
        result.phases[1].steps[0].skip_reason,
        executes ? undefined : hard ? 'prerequisite_failed' : 'capability_prerequisite_unavailable',
        label
      );
      assert.equal(calls.b.filter(task => task === 'get_signals').length, executes ? 1 : 0, label);
      assert.equal(result.overall_passed, !hard, label);
      assert.equal(result.failed_count, hard ? 1 : 0, label);
    }
  }
});

test('routed rate-limit targets respect known unavailable context after normalization', async () => {
  for (const origin of ['capability', 'hard', 'mixed']) {
    for (const mode of ['token', 'explicit', 'restored', 'independent', 'override', 'missing_target']) {
      const sb = storyboard([]);
      sb.context = mode === 'restored' ? { needed: 'restored' } : {};
      sb.phases = [
        {
          id: 'producer',
          title: 'Producer',
          ...(origin !== 'hard'
            ? { requires_capability: { path: 'account.require_operator_auth', equals: true } }
            : {}),
          steps: [
            {
              id: 'producer',
              title: 'Producer',
              task: 'get_adcp_capabilities',
              agent: 'a',
              ...(origin === 'hard' ? { requires_tool: 'get_signals' } : {}),
              context_outputs: [{ key: 'needed', path: 'identity.brand_json_url' }],
            },
            ...(origin === 'mixed'
              ? [
                  {
                    id: 'hard',
                    title: 'Hard',
                    task: 'unknown_tool',
                    context_outputs: [{ key: 'needed', path: 'value' }],
                  },
                ]
              : []),
          ],
        },
        {
          id: 'consumer',
          title: 'Consumer',
          ...(mode === 'independent' ? { depends_on: [] } : {}),
          steps: [
            {
              id: 'trip',
              title: 'Trip',
              task: 'expect_rate_limit_not_replayed',
              agent: 'b',
              expect_error: true,
              requires_contract: 'rate_limit_trip_runner',
              ...(mode === 'explicit' ? { context_inputs: [{ key: 'needed', inject_at: 'signal_spec' }] } : {}),
              rate_limit_trip: {
                trip_target_task: 'get_signals',
                trip_target_sample_request: mode === 'explicit' ? {} : { signal_spec: '$context.needed' },
                max_attempts: 50,
                replay_max_wait_seconds: 1,
              },
            },
            { id: 'read', title: 'Read', task: 'get_adcp_capabilities', agent: 'b' },
          ],
        },
      ];
      const { result, calls } = await run(
        {
          a: [[], { account: { require_operator_auth: false } }],
          b: [mode === 'missing_target' ? [] : ['get_signals'], { supported_protocols: ['signals'] }, 'structured'],
        },
        sb,
        {
          contracts: ['rate_limit_trip_runner'],
          allowLiveSideEffects: true,
          ...(mode === 'override' ? { request: { signal_spec: 'override' } } : {}),
        }
      );
      const blocked = mode === 'token' || mode === 'explicit';
      const label = `${origin}/${mode}`;
      const trip = result.phases[1].steps[0];
      assert.equal(
        calls.b.filter(task => task === 'get_signals').length,
        blocked || mode === 'missing_target' ? 0 : 1,
        label
      );
      assert.equal(
        trip.skip_reason,
        blocked
          ? origin === 'capability'
            ? 'capability_prerequisite_unavailable'
            : 'prerequisite_failed'
          : mode === 'missing_target'
            ? 'missing_tool'
            : undefined,
        label
      );
      if (blocked) assert.equal(trip.passed, origin === 'capability', label);
    }
  }
});

test('failed discovery retains route identity when credentials share a URL', async () => {
  const agent = await startAgent([], {}, false, [], 404, {}, 'Bearer failed-route');
  try {
    const result = await runStoryboard('', storyboard([{ id: 'failed', task: 'get_adcp_capabilities', agent: 'b' }]), {
      invariants: [],
      discovery_resilient: true,
      agents: {
        a: { url: agent.url, auth: { type: 'bearer', token: 'healthy-route' } },
        b: { url: agent.url, auth: { type: 'bearer', token: 'failed-route' } },
      },
    });
    const step = result.phases[0].steps[0];
    assert.equal(step.passed, false);
    assert.equal(step.agent_index, 2);
    const source = require('node:fs').readFileSync(require.resolve('../../bin/adcp.js'), 'utf8');
    const start = source.indexOf(
      "let agentTag = '';",
      source.indexOf('async function handleAgentsRoutedStoryboardRun')
    );
    const end = source.indexOf('console.log(', start);
    const rendered = require('node:vm').runInNewContext(`${source.slice(start, end)} agentTag;`, { step, result });
    assert.equal(rendered, '[b] ');
  } finally {
    await closeConnections();
    await agent.close();
  }
});

test('OAuth presence escalates optional failures only on the agent that served metadata', async () => {
  const present = await startAgent(
    ['get_signals'],
    { oauth: { supported: true }, supported_protocols: ['signals'] },
    true,
    [],
    200
  );
  const other = await startAgent(
    ['get_signals'],
    { oauth: { supported: true }, supported_protocols: ['signals'] },
    true
  );
  try {
    for (const failingAgent of ['other', 'present']) {
      const sb = storyboard([{ id: 'read', task: 'get_adcp_capabilities', agent: 'other' }]);
      sb.phases.push({
        id: 'optional',
        title: 'Optional',
        optional: true,
        steps: [
          {
            id: 'metadata',
            title: 'Metadata',
            task: 'protected_resource_metadata',
            agent: 'present',
            validations: [{ check: 'http_status', value: 200 }],
          },
          {
            id: 'rejected',
            title: 'Rejected',
            task: 'get_signals',
            agent: failingAgent,
            sample_request: { signal_spec: 'test' },
          },
        ],
      });
      const result = await runStoryboard('', sb, {
        allow_http: true,
        invariants: [],
        strictResponseSchemaValidation: false,
        agents: { present: { url: present.url }, other: { url: other.url } },
      });
      assert.deepEqual(sets(result), { selected: ['read', 'metadata', 'rejected'], skipped: [], failed: ['rejected'] });
      assert.equal(result.failed_count, failingAgent === 'present' ? 1 : 0);
      assert.equal(result.overall_passed, failingAgent !== 'present');
    }
    assert.ok(present.metadataRequests.length > 0);
    assert.deepEqual(other.metadataRequests, []);
  } finally {
    await closeConnections();
    await present.close();
    await other.close();
  }
});

test('unavailable seed resolution retains its coverage gap and a known routing failure', async () => {
  const sb = storyboard([{ id: 'unroutable', task: 'unknown_tool' }]);
  sb.fixtures = { products: [{ product_id: 'declared-product' }] };
  sb.fixture_resolution = { products: [{ handle: 'declared-product', strategies: ['seed'] }] };
  const { result, calls } = await run(
    { controller: [['comply_test_controller'], { compliance_testing: { scenarios: ['unrelated'] } }] },
    sb
  );
  assert.deepEqual(
    sets(result),
    {
      selected: ['unroutable'],
      skipped: [],
      failed: ['unroutable'],
    },
    JSON.stringify(result)
  );
  assert.equal(result.failed_count, 1);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.overall_passed, false);
  assert.deepEqual(
    result.coverage_gaps.map(gap => gap.reason),
    ['fixture_unsatisfied']
  );
  assert.equal(result.fixture_resolutions[0].strategies_attempted[0].disposition, 'unavailable');
  assert.deepEqual(calls, { controller: ['get_adcp_capabilities'] });
});

test('interleaved routed OAuth probes retain each agent issuer and reject foreign fallback evidence', async () => {
  const metadata = req => ({
    authorization_servers: [`http://${req.headers.host}`],
    issuer: `http://${req.headers.host}`,
  });
  const a = await startAgent([], { oauth: { supported: true } }, false, [], 200, metadata);
  const b = await startAgent([], { oauth: { supported: true } }, false, [], 200, metadata);
  try {
    for (const includeA of [true, false]) {
      a.metadataRequests.length = 0;
      b.metadataRequests.length = 0;
      const steps = [
        ...(includeA ? [{ id: 'prm_a', task: 'protected_resource_metadata', agent: 'a' }] : []),
        { id: 'prm_b', task: 'protected_resource_metadata', agent: 'b' },
        { id: 'issuer_a', task: 'oauth_auth_server_metadata', agent: 'a' },
      ].map(step => ({ ...step, validations: [{ check: 'http_status', value: 200 }] }));
      const result = await runStoryboard('', storyboard(steps), {
        allow_http: true,
        invariants: [],
        agents: { a: { url: a.url }, b: { url: b.url } },
      });
      const issuer = result.phases[0].steps.find(step => step.step_id === 'issuer_a');
      assert.equal(issuer.agent_url, a.url);
      assert.equal(issuer.passed, includeA);
      assert.equal(b.metadataRequests.filter(path => path.includes('oauth-authorization-server')).length, 0);
      assert.equal(
        a.metadataRequests.filter(path => path.includes('oauth-authorization-server')).length,
        includeA ? 1 : 0
      );
      if (includeA) assert.equal(issuer.response.body.issuer, new URL(a.url).origin);
      else assert.match(issuer.error, /protected_resource_metadata step missing/);
    }
  } finally {
    await closeConnections();
    await a.close();
    await b.close();
  }
});

test('mixed routed capability skips propagate unavailable outputs to dependent negative vectors', async () => {
  const consumer = id => ({
    id,
    title: id,
    task: 'get_signals',
    agent: 'b',
    expect_error: true,
    sample_request: { signal_spec: '$context.absent' },
  });
  const sb = storyboard([
    { id: 'producer', task: 'get_adcp_capabilities', agent: 'a', context_outputs: [{ key: 'absent', path: 'value' }] },
    consumer('same_phase'),
  ]);
  sb.phases[0].requires_capability = { path: 'account.require_operator_auth', equals: true };
  sb.phases.push(
    {
      id: 'dependent',
      title: 'Dependent',
      steps: [
        { ...consumer('next_phase'), context_outputs: [{ key: 'derived', path: 'value' }] },
        {
          ...consumer('explicit_input'),
          sample_request: {},
          context_inputs: [{ key: 'absent', inject_at: 'signal_spec' }],
        },
      ],
    },
    {
      id: 'transitive',
      title: 'Transitive',
      depends_on: ['dependent'],
      steps: [{ ...consumer('derived_consumer'), sample_request: { signal_spec: '$context.derived' } }],
    },
    { id: 'independent', title: 'Independent', depends_on: [], steps: [consumer('intentional_malformed')] }
  );
  const { result, calls } = await run(
    {
      a: [[], { account: { require_operator_auth: false } }],
      b: [['get_signals'], { account: { require_operator_auth: true }, supported_protocols: ['signals'] }, true],
    },
    sb
  );
  assert.deepEqual(sets(result), {
    selected: ['intentional_malformed'],
    skipped: [
      ['producer', 'not_applicable'],
      ['same_phase', 'capability_prerequisite_unavailable'],
      ['next_phase', 'capability_prerequisite_unavailable'],
      ['explicit_input', 'capability_prerequisite_unavailable'],
      ['derived_consumer', 'capability_prerequisite_unavailable'],
    ],
    failed: [],
  });
  assert.equal(calls.b.filter(task => task === 'get_signals').length, 1);
});

test('a reached fixture routing failure closes its runner-owned webhook listener', async () => {
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const sb = storyboard([{ id: 'later', task: 'get_adcp_capabilities', agent: 'a' }]);
  sb.fixtures = { products: [{ product_id: 'fixture-product' }] };
  sb.fixture_resolution = { products: [{ handle: 'fixture-product', strategies: ['seed'] }] };
  const { result } = await run(
    {
      a: [['comply_test_controller'], { compliance_testing: { scenarios: ['seed_product'] } }],
      b: [['comply_test_controller'], { compliance_testing: { scenarios: ['seed_product'] } }],
    },
    sb,
    { allow_http: true, webhook_receiver: { host: '127.0.0.1', port } }
  );
  assert.equal(result.failed_count, 1);
  assert.match(result.phases[0].steps[0].error, /claimed by \[a, b\]/);
  const reused = http.createServer();
  try {
    await new Promise((resolve, reject) => {
      reused.once('error', reject);
      reused.listen(port, '127.0.0.1', resolve);
    });
  } finally {
    if (reused.listening) await new Promise(resolve => reused.close(resolve));
  }
});

test('routed probe isolation distinguishes credentials sharing the same URL', async () => {
  const agent = await startAgent([], { oauth: { supported: true } }, false, [], 200, req => ({
    authorization_servers: [`http://${req.headers.host}`],
  }));
  try {
    const result = await runStoryboard(
      '',
      storyboard([
        { id: 'prm_b', task: 'protected_resource_metadata', agent: 'b' },
        { id: 'issuer_a', task: 'oauth_auth_server_metadata', agent: 'a' },
      ]),
      {
        allow_http: true,
        invariants: [],
        agents: {
          a: { url: agent.url, auth: { type: 'bearer', token: 'test-route-a' } },
          b: { url: agent.url, auth: { type: 'bearer', token: 'test-route-b' } },
        },
      }
    );
    const issuer = result.phases[0].steps.find(step => step.step_id === 'issuer_a');
    assert.equal(issuer.passed, false);
    assert.match(issuer.error, /protected_resource_metadata step missing/);
    assert.equal(agent.metadataRequests.filter(path => path.includes('oauth-authorization-server')).length, 0);
    assert.ok(agent.authorization.includes('Bearer test-route-a'));
    assert.ok(agent.authorization.includes('Bearer test-route-b'));
  } finally {
    await closeConnections();
    await agent.close();
  }
});

test('routed JWKS purpose assertions use only their selected agent keys', async () => {
  async function agentWithKeys(purpose) {
    const caps = { identity: {}, request_signing: { supported: true } };
    const agent = await startAgent([], caps, false, [], 200, req => {
      const origin = `http://${req.headers.host}`;
      return req.url.includes('brand.json')
        ? { agents: [{ url: `${origin}/mcp`, jwks_uri: `${origin}/.well-known/jwks.json` }] }
        : { keys: [{ kty: 'RSA', kid: 'test-key', adcp_use: purpose }] };
    });
    caps.identity.brand_json_url = `${new URL(agent.url).origin}/.well-known/brand.json`;
    return agent;
  }
  const a = await agentWithKeys('request-signing');
  const b = await agentWithKeys('unsupported-purpose');
  try {
    const result = await runStoryboard(
      '',
      storyboard([
        { id: 'keys_a', task: 'fetch_brand_jwks', agent: 'a' },
        { id: 'keys_b', task: 'fetch_brand_jwks', agent: 'b' },
        { id: 'purpose_a', task: 'assert_jwks_purpose', agent: 'a' },
        { id: 'purpose_b', task: 'assert_jwks_purpose', agent: 'b' },
      ]),
      { allow_http: true, invariants: [], agents: { a: { url: a.url }, b: { url: b.url } } }
    );
    assert.deepEqual(sets(result), {
      selected: ['keys_a', 'keys_b', 'purpose_a', 'purpose_b'],
      skipped: [],
      failed: ['purpose_b'],
    });
    assert.equal(
      result.phases[0].steps.find(step => step.step_id === 'purpose_a').response.url,
      `${new URL(a.url).origin}/.well-known/jwks.json`
    );
  } finally {
    await closeConnections();
    await a.close();
    await b.close();
  }
});

test('a successful alternate producer rescues a capability-skipped context output', async () => {
  const sb = storyboard([
    {
      id: 'missing',
      task: 'get_adcp_capabilities',
      agent: 'a',
      context_outputs: [{ key: 'restored', path: 'identity.brand_json_url' }],
    },
    {
      id: 'rescue',
      task: 'get_adcp_capabilities',
      agent: 'b',
      context_outputs: [{ key: 'restored', path: 'identity.brand_json_url' }],
    },
    {
      id: 'consumer',
      task: 'get_signals',
      agent: 'b',
      expect_error: true,
      sample_request: { signal_spec: '$context.restored' },
    },
  ]);
  sb.phases[0].requires_capability = { path: 'account.require_operator_auth', equals: true };
  const { result, calls } = await run(
    {
      a: [[], { account: { require_operator_auth: false } }],
      b: [
        ['get_signals'],
        {
          account: { require_operator_auth: true },
          supported_protocols: ['signals'],
          identity: { brand_json_url: 'https://brand.example.test/brand.json' },
        },
        true,
      ],
    },
    sb
  );
  assert.deepEqual(sets(result), {
    selected: ['rescue', 'consumer'],
    skipped: [['missing', 'not_applicable']],
    failed: [],
  });
  assert.equal(calls.b.filter(task => task === 'get_signals').length, 1);
});

test('stateful routed capability cascades retain neutral origin, rescue, and real failure precedence', async () => {
  for (const mode of ['unavailable', 'rescued', 'failed']) {
    const sb = storyboard([
      {
        id: 'producer',
        task: 'get_adcp_capabilities',
        agent: 'a',
        stateful: true,
        context_outputs: [{ key: 'needed', path: 'identity.brand_json_url' }],
      },
      ...(mode === 'rescued'
        ? [
            {
              id: 'rescue',
              task: 'get_adcp_capabilities',
              agent: 'b',
              stateful: true,
              context_outputs: [{ key: 'needed', path: 'identity.brand_json_url' }],
            },
          ]
        : []),
      ...(mode === 'failed'
        ? [
            {
              id: 'real_failure',
              task: 'get_signals',
              agent: 'b',
              stateful: true,
              sample_request: { signal_spec: 'test' },
            },
          ]
        : []),
      {
        id: 'consumer',
        task: 'get_signals',
        agent: 'b',
        stateful: true,
        expect_error: true,
        sample_request: { signal_spec: '$context.needed' },
      },
    ]);
    sb.phases[0].requires_capability = { path: 'account.require_operator_auth', equals: true };
    sb.phases.push({
      id: 'dependent',
      title: 'Dependent',
      steps: [{ id: 'downstream', title: 'Downstream', task: 'get_adcp_capabilities', agent: 'b', stateful: true }],
    });
    const { result, calls } = await run(
      {
        a: [[], { account: { require_operator_auth: false } }],
        b: [
          ['get_signals'],
          {
            account: { require_operator_auth: true },
            supported_protocols: ['signals'],
            identity: { brand_json_url: 'https://brand.example.test/brand.json' },
          },
          true,
        ],
      },
      sb
    );
    const downstream = result.phases.find(phase => phase.phase_id === 'dependent').steps[0];
    assert.equal(downstream.passed, mode !== 'failed', mode);
    assert.equal(downstream.skipped === true, mode !== 'rescued', mode);
    assert.equal(
      downstream.skip_reason,
      mode === 'failed'
        ? 'prerequisite_failed'
        : mode === 'unavailable'
          ? 'capability_prerequisite_unavailable'
          : undefined,
      mode
    );
    assert.equal(result.overall_passed, mode !== 'failed', mode);
    assert.equal(calls.b.filter(task => task === 'get_signals').length, mode === 'unavailable' ? 0 : 1, mode);
  }
});

test('unrescued missing tools outrank deferred capability skips when both triggers exist', async () => {
  for (const rescued of [false, true]) {
    const sb = storyboard([
      { id: 'missing_tool', task: 'get_adcp_capabilities', requires_tool: 'get_signals', agent: 'b', stateful: true },
      { id: 'capability_skip', task: 'get_adcp_capabilities', agent: 'a', stateful: true },
      {
        id: 'substitute',
        task: 'get_adcp_capabilities',
        agent: rescued ? 'b' : 'a',
        stateful: true,
        provides_state_for: 'missing_tool',
      },
    ]);
    sb.phases[0].requires_capability = { path: 'account.require_operator_auth', equals: true };
    sb.phases.push({
      id: 'dependent',
      title: 'Dependent',
      steps: [{ id: 'downstream', title: 'Downstream', task: 'get_adcp_capabilities', agent: 'b', stateful: true }],
    });
    const { result } = await run(
      { a: [[], { account: { require_operator_auth: false } }], b: [[], { account: { require_operator_auth: true } }] },
      sb
    );
    const downstream = result.phases.find(phase => phase.phase_id === 'dependent').steps[0];
    assert.equal(downstream.passed, rescued);
    assert.equal(downstream.skipped === true, !rescued);
    assert.equal(downstream.skip_reason, rescued ? undefined : 'prerequisite_failed');
    assert.equal(result.overall_passed, rescued);
  }
});

test('hard state dependencies outrank capability-only dependencies in either declared order', async () => {
  for (const kind of ['missing_tool', 'real_failure']) {
    for (const depends_on of [
      ['capability', 'broken'],
      ['broken', 'capability'],
    ]) {
      const sb = storyboard([]);
      sb.phases = [
        {
          id: 'capability',
          title: 'Capability',
          requires_capability: { path: 'account.require_operator_auth', equals: true },
          steps: [
            { id: 'unsupported', title: 'Unsupported', task: 'get_adcp_capabilities', agent: 'a', stateful: true },
          ],
        },
        {
          id: 'broken',
          title: 'Broken',
          depends_on: [],
          steps: [
            ...(kind === 'missing_tool'
              ? [
                  {
                    id: 'missing_first',
                    title: 'Missing first',
                    task: 'get_adcp_capabilities',
                    requires_tool: 'get_signals',
                    agent: 'b',
                    stateful: true,
                  },
                  {
                    id: 'missing_second',
                    title: 'Missing second',
                    task: 'get_adcp_capabilities',
                    requires_tool: 'get_signals',
                    agent: 'b',
                    stateful: true,
                  },
                ]
              : [
                  {
                    id: 'real_failure',
                    title: 'Real failure',
                    task: 'get_signals',
                    agent: 'b',
                    stateful: true,
                    sample_request: { signal_spec: 'test' },
                  },
                ]),
            { id: 'read', title: 'Read', task: 'get_adcp_capabilities', agent: 'b' },
          ],
        },
        {
          id: 'dependent',
          title: 'Dependent',
          depends_on,
          steps: [{ id: 'downstream', title: 'Downstream', task: 'get_adcp_capabilities', agent: 'b', stateful: true }],
        },
      ];
      const { result } = await run(
        {
          a: [[], { account: { require_operator_auth: false } }],
          b: [
            kind === 'real_failure' ? ['get_signals'] : [],
            { account: { require_operator_auth: true }, supported_protocols: ['signals'] },
            true,
          ],
        },
        sb
      );
      const downstream = result.phases.find(phase => phase.phase_id === 'dependent').steps[0];
      assert.equal(downstream.passed, false, `${kind}: ${depends_on}`);
      assert.equal(downstream.skip_reason, 'prerequisite_failed');
      assert.equal(result.overall_passed, false);
      if (kind === 'missing_tool') {
        assert.deepEqual([result.passed_count, result.failed_count, result.skipped_count], [1, 0, 4]);
        sb.phases.find(phase => phase.id === 'dependent').optional = true;
        const { result: optionalResult } = await run(
          {
            a: [[], { account: { require_operator_auth: false } }],
            b: [[], { account: { require_operator_auth: true } }],
          },
          sb
        );
        assert.equal(optionalResult.overall_passed, true, 'optional prerequisite skips do not fail required phases');
        assert.equal(
          optionalResult.phases.find(phase => phase.phase_id === 'dependent').steps[0].skip_reason,
          'prerequisite_failed'
        );
        assert.deepEqual(
          [optionalResult.passed_count, optionalResult.failed_count, optionalResult.skipped_count],
          [1, 0, 4]
        );
      }
    }
  }
});

test('ordinary not-applicable state outranks capability-only state in either step order', async () => {
  for (const capabilityFirst of [true, false]) {
    for (const rescued of [false, true]) {
      const producers = [
        { id: 'capability_skip', task: 'get_adcp_capabilities', agent: 'a', stateful: true },
        { id: 'account_shape', task: 'sync_accounts', agent: 'b', stateful: true },
      ];
      if (!capabilityFirst) producers.reverse();
      if (rescued) producers.push({ id: 'rescue', task: 'get_adcp_capabilities', agent: 'b', stateful: true });
      const sb = storyboard(producers);
      sb.phases[0].requires_capability = { path: 'account.require_operator_auth', equals: true };
      sb.phases.push({
        id: 'dependent',
        title: 'Dependent',
        steps: [{ id: 'downstream', title: 'Downstream', task: 'get_adcp_capabilities', agent: 'b', stateful: true }],
      });
      const { result, calls } = await run(
        {
          a: [[], { account: { require_operator_auth: false } }],
          b: [[], { account: { require_operator_auth: true } }],
        },
        sb
      );
      const downstream = result.phases.find(phase => phase.phase_id === 'dependent').steps[0];
      assert.equal(downstream.passed, rescued);
      assert.equal(downstream.skip_reason, rescued ? undefined : 'prerequisite_failed');
      assert.equal(result.overall_passed, rescued);
      assert.equal(calls.b.filter(task => task === 'get_adcp_capabilities').length, rescued ? 3 : 1);
      if (!rescued) assert.match(downstream.skip.detail, /account_shape/);
    }
  }
});

test('routed missing-tool outputs cannot satisfy dependent negative vectors', async () => {
  for (const missingTool of ['get_signals', 'comply_test_controller']) {
    for (const rescued of [false, true]) {
      for (const earlyCascade of [false, true]) {
        const consumer = id => ({
          id,
          title: id,
          task: 'get_signals',
          agent: 'b',
          expect_error: true,
          sample_request: { signal_spec: '$context.missing_output' },
        });
        const sb = storyboard([
          ...(earlyCascade
            ? [
                {
                  id: 'earlier_missing',
                  task: 'get_adcp_capabilities',
                  requires_tool: missingTool,
                  agent: 'a',
                  stateful: true,
                },
              ]
            : []),
          {
            id: 'missing',
            task: 'get_adcp_capabilities',
            requires_tool: missingTool,
            agent: 'a',
            stateful: true,
            context_outputs: [{ key: 'missing_output', path: 'identity.brand_json_url' }],
          },
          ...(rescued
            ? [
                {
                  id: 'rescue',
                  task: 'get_adcp_capabilities',
                  agent: 'b',
                  context_outputs: [{ key: 'missing_output', path: 'identity.brand_json_url' }],
                },
              ]
            : []),
          { id: 'read', task: 'get_adcp_capabilities', agent: 'b' },
          consumer('same_phase'),
        ]);
        sb.phases.push(
          {
            id: 'dependent',
            title: 'Dependent',
            steps: [
              { ...consumer('negative'), ...(!rescued && { context_outputs: [{ key: 'derived', path: 'value' }] }) },
              {
                ...consumer('explicit_input'),
                sample_request: {},
                context_inputs: [{ key: 'missing_output', inject_at: 'signal_spec' }],
              },
            ],
          },
          ...(!rescued
            ? [
                {
                  id: 'transitive',
                  title: 'Transitive',
                  depends_on: ['dependent'],
                  steps: [{ ...consumer('derived'), sample_request: { signal_spec: '$context.derived' } }],
                },
              ]
            : []),
          {
            id: 'independent',
            title: 'Independent',
            depends_on: [],
            steps: [{ ...consumer('intentional'), sample_request: { signal_spec: '$context.intentional_bad_token' } }],
          }
        );
        const { result, calls } = await run(
          {
            a: [[], {}],
            b: [
              ['get_signals'],
              {
                supported_protocols: ['signals'],
                identity: { brand_json_url: 'https://brand.example.test/brand.json' },
              },
              true,
            ],
          },
          sb
        );
        const steps = result.phases.flatMap(phase => phase.steps);
        for (const id of ['same_phase', 'negative', 'explicit_input', ...(!rescued ? ['derived'] : [])]) {
          const step = steps.find(step => step.step_id === id);
          assert.equal(step.skipped === true, !rescued, id);
          assert.equal(step.skip_reason, rescued ? undefined : 'prerequisite_failed', id);
          assert.equal(step.passed, rescued, id);
        }
        assert.equal(calls.b.filter(task => task === 'get_signals').length, rescued ? 4 : 1);
        assert.equal(steps.find(step => step.step_id === 'intentional').passed, true);
        assert.equal(result.overall_passed, rescued);
        assert.equal(result.failed_count, 0);
      }
    }
  }
});

test('mixed explicit inputs and request tokens preserve hard prerequisite precedence', async () => {
  for (const form of ['hard_token', 'hard_input', 'both_tokens', 'both_inputs']) {
    for (const restored of ['neither', 'hard', 'capability', 'both']) {
      const hardRestored = restored === 'hard' || restored === 'both';
      const capRestored = restored === 'capability' || restored === 'both';
      const consumer = {
        id: 'consumer',
        title: 'Consumer',
        task: 'get_signals',
        agent: 'b',
        expect_error: true,
        sample_request: {},
        context_inputs: [],
      };
      for (const [key, field, token] of [
        ['hard_output', 'signal_spec', form === 'hard_token' || form === 'both_tokens'],
        ['cap_output', 'other_field', form === 'hard_input' || form === 'both_tokens'],
      ]) {
        if (token) consumer.sample_request[field] = `$context.${key}`;
        else consumer.context_inputs.push({ key, inject_at: field });
      }
      const sb = storyboard([]);
      sb.phases = [
        {
          id: 'capability',
          title: 'Capability',
          requires_capability: { path: 'account.require_operator_auth', equals: true },
          steps: [
            {
              id: 'cap',
              title: 'Cap',
              task: 'get_adcp_capabilities',
              agent: 'a',
              context_outputs: [{ key: 'cap_output', path: 'identity.brand_json_url' }],
            },
          ],
        },
        {
          id: 'missing',
          title: 'Missing',
          depends_on: [],
          steps: [
            {
              id: 'hard',
              title: 'Hard',
              task: 'get_adcp_capabilities',
              requires_tool: 'get_signals',
              agent: 'a',
              stateful: true,
              context_outputs: [{ key: 'hard_output', path: 'identity.brand_json_url' }],
            },
            ...(hardRestored || capRestored
              ? [
                  {
                    id: 'rescue',
                    title: 'Rescue',
                    task: 'get_adcp_capabilities',
                    agent: 'b',
                    context_outputs: [
                      ...(hardRestored ? ['hard_output'] : []),
                      ...(capRestored ? ['cap_output'] : []),
                    ].map(key => ({ key, path: 'identity.brand_json_url' })),
                  },
                ]
              : []),
          ],
        },
        {
          id: 'dependent',
          title: 'Dependent',
          steps: [consumer, { id: 'read', title: 'Read', task: 'get_adcp_capabilities', agent: 'b' }],
        },
      ];
      const { result, calls } = await run(
        {
          a: [[], { account: { require_operator_auth: false } }],
          b: [
            ['get_signals'],
            {
              account: { require_operator_auth: true },
              supported_protocols: ['signals'],
              identity: { brand_json_url: 'https://brand.example.test/brand.json' },
            },
            true,
          ],
        },
        sb
      );
      const row = result.phases[2].steps[0];
      const label = `${form}/${restored}`;
      assert.equal(row.passed, hardRestored, label);
      assert.equal(
        row.skip_reason,
        !hardRestored ? 'prerequisite_failed' : !capRestored ? 'capability_prerequisite_unavailable' : undefined,
        label
      );
      assert.equal(result.overall_passed, hardRestored, label);
      assert.equal(result.failed_count, 0, label);
      assert.equal(calls.b.filter(task => task === 'get_signals').length, hardRestored && capRestored ? 1 : 0, label);
    }
  }
});

test('CLI capability skip diagnostics escape controls without exposing unrelated seller details', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../bin/adcp.js'), 'utf8');
  const helper = source.slice(
    source.indexOf('function printCapabilityPrerequisiteSkip'),
    source.indexOf('async function handleStoryboardRun')
  );
  const lines = [];
  // The escaper lives in `bin/adcp-storyboard-summary.js` since the skip
  // printers were split out (adcp-client#2954); inject the real implementation
  // the CLI uses rather than a stand-in, so this still tests shipped escaping.
  const { escapeTerminalControlChars, formatStepSkipLines } = require('../../bin/adcp-storyboard-summary.js');
  const scope = { console: { log: line => lines.push(line) }, escapeTerminalControlChars, formatStepSkipLines };
  vm.runInNewContext(helper, scope);
  scope.printCapabilityPrerequisiteSkip({
    skipped: true,
    skip_reason: 'not_applicable',
    skip: { detail: 'seller-secret\u001b[2J' },
  });
  assert.deepEqual(lines, []);
  scope.printCapabilityPrerequisiteSkip({
    skipped: true,
    skip_reason: 'capability_prerequisite_unavailable',
    skip: { detail: 'missing\u001b[2J\u009b31m\nkey' },
  });
  assert.deepEqual(lines, ['   Skipped: missing\\u001b[2J\\u009b31m\\u000akey']);
  scope.printCapabilityPrerequisiteSkip({
    skipped: true,
    skip_reason: 'capability_prerequisite_unavailable',
    skip: { detail: 'duplicate' },
    error: 'already rendered',
  });
  assert.equal(lines.length, 1);
});

test('neutral stateful cascades cannot conceal hard declared input dependencies', async () => {
  for (const mode of ['missing', 'restored', 'unreferenced', 'override', 'independent']) {
    const restored = mode === 'restored';
    const shouldFail = mode === 'missing';
    for (const explicit of [false, true]) {
      if (mode === 'override' && explicit) continue;
      for (const depends_on of [
        ['capability', 'hard'],
        ['hard', 'capability'],
      ]) {
        const sb = storyboard([]);
        sb.phases = [
          {
            id: 'capability',
            title: 'Capability',
            requires_capability: { path: 'account.require_operator_auth', equals: true },
            steps: [{ id: 'cap', title: 'Cap', task: 'get_adcp_capabilities', agent: 'a', stateful: true }],
          },
          {
            id: 'hard',
            title: 'Hard',
            depends_on: [],
            steps: [
              {
                id: 'missing',
                title: 'Missing',
                task: 'get_adcp_capabilities',
                requires_tool: 'get_signals',
                agent: 'a',
                context_outputs: [{ key: 'hard_output', path: 'identity.brand_json_url' }],
              },
              ...(restored
                ? [
                    {
                      id: 'rescue',
                      title: 'Rescue',
                      task: 'get_adcp_capabilities',
                      agent: 'b',
                      context_outputs: [{ key: 'hard_output', path: 'identity.brand_json_url' }],
                    },
                  ]
                : []),
            ],
          },
          {
            id: 'dependent',
            title: 'Dependent',
            depends_on: mode === 'independent' ? ['capability'] : depends_on,
            steps: [
              {
                id: 'consumer',
                title: 'Consumer',
                task: 'get_signals',
                agent: 'b',
                stateful: true,
                ...(explicit
                  ? { sample_request: {}, context_inputs: [{ key: 'hard_output', inject_at: 'signal_spec' }] }
                  : { sample_request: { signal_spec: '$context.hard_output' } }),
              },
              { id: 'read', title: 'Read', task: 'get_adcp_capabilities', agent: 'b' },
            ],
          },
        ];
        if (mode === 'missing') {
          sb.phases.push({
            id: 'transitive',
            title: 'Transitive',
            depends_on: ['dependent'],
            steps: [
              {
                id: 'later',
                title: 'Later',
                task: 'get_signals',
                agent: 'b',
                stateful: true,
                sample_request: { signal_spec: 'later' },
              },
            ],
          });
        }
        if (mode === 'missing') {
          sb.phases.push({
            id: 'further',
            title: 'Further',
            depends_on: ['transitive'],
            steps: [
              {
                id: 'last',
                title: 'Last',
                task: 'get_signals',
                agent: 'b',
                stateful: true,
                sample_request: { signal_spec: 'last' },
              },
            ],
          });
        }
        if (mode === 'unreferenced') {
          sb.phases[2].steps[0].sample_request = { signal_spec: 'unrelated' };
          sb.phases[2].steps[0].context_inputs = [];
        }
        const { result, calls } = await run(
          {
            a: [[], { account: { require_operator_auth: false } }],
            b: [
              ['get_signals'],
              {
                account: { require_operator_auth: true },
                supported_protocols: ['signals'],
                identity: { brand_json_url: 'https://brand.example.test/brand.json' },
              },
            ],
          },
          sb,
          mode === 'override' ? { request: { signal_spec: 'operator-supplied' } } : {}
        );
        const row = result.phases[2].steps[0];
        assert.equal(row.passed, !shouldFail);
        assert.equal(row.skip_reason, shouldFail ? 'prerequisite_failed' : 'capability_prerequisite_unavailable');
        assert.equal(result.overall_passed, !shouldFail);
        assert.equal(result.failed_count, 0);
        if (mode === 'missing') {
          assert.equal(result.phases[3].steps[0].skip_reason, 'prerequisite_failed');
          assert.equal(result.phases[4].steps[0].skip_reason, 'prerequisite_failed');
        }
        assert.equal(calls.b.filter(task => task === 'get_signals').length, 0);
      }
    }
  }
});

test('intrinsic missing tools under a capability cascade retain local hard-state rules', async () => {
  for (const kind of ['requires_tool', 'missing_task', 'controller']) {
    for (const statefulPeer of [true, false]) {
      const sb = storyboard([]);
      sb.phases = [
        {
          id: 'capability',
          title: 'Capability',
          requires_capability: { path: 'account.require_operator_auth', equals: true },
          steps: [{ id: 'cap', title: 'Cap', task: 'get_adcp_capabilities', agent: 'a', stateful: true }],
        },
        {
          id: 'dependent',
          title: 'Dependent',
          steps: [
            {
              id: 'missing',
              title: 'Missing',
              task:
                kind === 'missing_task'
                  ? 'get_signals'
                  : kind === 'controller'
                    ? 'comply_test_controller'
                    : 'get_adcp_capabilities',
              ...(kind === 'requires_tool' ? { requires_tool: 'get_signals' } : {}),
              agent: 'a',
              stateful: true,
            },
            { id: 'peer', title: 'Peer', task: 'get_adcp_capabilities', agent: 'b', stateful: statefulPeer },
            { id: 'read', title: 'Read', task: 'get_adcp_capabilities', agent: 'b' },
          ],
        },
      ];
      const { result } = await run(
        {
          a: [[], { account: { require_operator_auth: false } }],
          b: [['get_signals', 'comply_test_controller'], { supported_protocols: ['signals'] }],
        },
        sb
      );
      const [missing, peer] = result.phases[1].steps;
      assert.equal(missing.skip_reason, kind === 'controller' ? 'missing_test_controller' : 'missing_tool');
      assert.equal(peer.passed, !statefulPeer);
      assert.equal(peer.skip_reason, statefulPeer ? 'prerequisite_failed' : undefined);
      assert.equal(result.overall_passed, !statefulPeer);
      assert.equal(result.failed_count, 0);
    }
  }
});

test('stateful hard-context skips carry failure to phases depending only on that consumer', async () => {
  const sb = storyboard([
    {
      id: 'missing',
      task: 'get_adcp_capabilities',
      requires_tool: 'get_signals',
      agent: 'a',
      context_outputs: [{ key: 'hard_output', path: 'value' }],
    },
  ]);
  sb.phases.push(
    {
      id: 'consumer',
      title: 'Consumer',
      steps: [
        {
          id: 'blocked',
          title: 'Blocked',
          task: 'get_signals',
          agent: 'b',
          stateful: true,
          sample_request: { signal_spec: '$context.hard_output' },
        },
        { id: 'read', title: 'Read', task: 'get_adcp_capabilities', agent: 'b' },
      ],
    },
    {
      id: 'transitive',
      title: 'Transitive',
      depends_on: ['consumer'],
      steps: [
        {
          id: 'later',
          title: 'Later',
          task: 'get_signals',
          agent: 'b',
          stateful: true,
          sample_request: { signal_spec: 'later' },
        },
      ],
    }
  );
  sb.phases.push({
    id: 'further',
    title: 'Further',
    depends_on: ['transitive'],
    steps: [
      {
        id: 'last',
        title: 'Last',
        task: 'get_signals',
        agent: 'b',
        stateful: true,
        sample_request: { signal_spec: 'last' },
      },
    ],
  });
  const { result, calls } = await run({ a: [[], {}], b: [['get_signals'], { supported_protocols: ['signals'] }] }, sb);
  assert.equal(result.phases[1].steps[0].skip_reason, 'prerequisite_failed');
  assert.equal(result.phases[2].steps[0].skip_reason, 'prerequisite_failed');
  assert.equal(result.phases[3].steps[0].skip_reason, 'prerequisite_failed');
  assert.equal(result.overall_passed, false);
  assert.equal(result.failed_count, 0);
  assert.equal(calls.b.filter(task => task === 'get_signals').length, 0);
});
