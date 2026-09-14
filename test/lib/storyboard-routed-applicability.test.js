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
async function startAgent(tools, capabilities = {}) {
  const calls = [];
  const connections = [];
  const server = http.createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'routing-contract-test', version: '1.0.0' });
    for (const name of new Set(['get_adcp_capabilities', ...tools])) {
      mcp.registerTool(name, {}, async () => {
        calls.push(name);
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
    failed: steps.filter(s => !s.passed && !s.skipped).map(s => s.step_id),
  };
}

async function run(topology, sb, options = {}) {
  const entries = await Promise.all(
    Object.entries(topology).map(async ([key, [tools, caps]]) => [key, await startAgent(tools, caps)])
  );
  const agents = Object.fromEntries(entries);
  try {
    const result = await runStoryboard('', sb, {
      strictResponseSchemaValidation: false,
      invariants: [],
      ...options,
      agents: Object.fromEntries(entries.map(([key, a]) => [key, { url: a.url }])),
    });
    return { result, calls: Object.fromEntries(entries.map(([key, a]) => [key, a.calls])) };
  } finally {
    await closeConnections();
    await Promise.all(Object.values(agents).map(a => a.close()));
  }
}

for (const adcpVersion of ['3.1.20', ADCP_VERSION]) {
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
    _profile: { name: 'primary', tools: ['sync_accounts'] },
    agents: { selected: entry },
  };
  const selected = routedAgentOptions(entry, source, profile);
  assert.equal(selected.protocol, 'a2a');
  assert.equal(selected.auth, entry.auth);
  assert.equal(selected._profile, profile);
  assert.deepEqual(selected.agentTools, ['get_products']);
  assert.equal(selected.agents, undefined);
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
    const result = await runStoryboard(
      '',
      storyboard([
        { id: 'mcp', task: 'get_adcp_capabilities', agent: 'a' },
        { id: 'a2a', task: 'get_adcp_capabilities', agent: 'b' },
        { id: 'a2a_auth_probe', task: 'get_adcp_capabilities', agent: 'b', auth: 'none' },
      ]),
      {
        protocol: 'mcp',
        strictResponseSchemaValidation: false,
        invariants: [],
        agents: { a: { url: a.url }, b: { url, transport: 'a2a' } },
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
  } finally {
    await closeConnections();
    await a.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await adcp.close();
  }
});
