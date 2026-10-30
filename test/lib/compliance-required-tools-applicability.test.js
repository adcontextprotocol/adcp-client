const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { comply, partitionStoryboardsByRequiredTools } = require('../../dist/lib/testing/compliance/comply');
const { ADCP_VERSION, toReleasePrecisionVersion } = require('../../dist/lib/version');

function storyboard(id, requiredTools) {
  return {
    id,
    version: '1.0.0',
    title: id,
    category: 'test',
    track: 'core',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    required_tools: requiredTools,
    phases: [],
  };
}

describe('compliance storyboard required-tool applicability', () => {
  test('keeps media-buy and unrelated specialism storyboards out of an SI-only run', () => {
    const siTools = ['si_get_offering', 'si_initiate_session', 'si_send_message', 'si_terminate_session'];
    const result = partitionStoryboardsByRequiredTools(
      [
        storyboard('si_baseline', ['si_initiate_session']),
        storyboard('si_partial_surface', ['si_initiate_session', 'si_optional_tool']),
        storyboard('media_buy', ['get_products']),
        storyboard('creative_transformers', ['list_transformers']),
      ],
      siTools
    );

    assert.deepStrictEqual(
      result.runnable.map(item => item.id),
      ['si_baseline', 'si_partial_surface']
    );
    assert.deepStrictEqual(
      result.missing.map(item => item.storyboard_id),
      ['media_buy', 'creative_transformers']
    );
  });

  test('preserves root-gated candidates and stable order for authoritative runner applicability', () => {
    const root = {
      ...storyboard('root', ['get_products']),
      requires_capability: { path: 'supported_protocols', contains: 'media_buy' },
    };
    const all = {
      ...storyboard('all', ['get_signals']),
      requires_all_capabilities: [
        { path: 'supported_protocols', contains: 'signals' },
        { path: 'account.require_operator_auth', equals: false },
      ],
    };
    const phaseOnly = {
      ...storyboard('phase_only', ['get_products']),
      phases: [{ id: 'flow', title: 'Flow', requires_capability: root.requires_capability, steps: [] }],
    };
    const result = partitionStoryboardsByRequiredTools(
      [root, storyboard('ungated', ['get_products']), all, phaseOnly, storyboard('independent', [])],
      ['get_adcp_capabilities'],
      { preserveRootCapabilityGates: true }
    );
    assert.deepEqual(
      result.runnable.map(board => board.id),
      ['root', 'all', 'independent']
    );
    assert.deepEqual(
      result.missing.map(board => board.storyboard_id),
      ['ungated', 'phase_only']
    );
    const topology = partitionStoryboardsByRequiredTools([root, all], ['get_adcp_capabilities']);
    assert.deepEqual(topology.runnable, []);
    assert.deepEqual(
      topology.missing.map(board => board.storyboard_id),
      ['root', 'all']
    );
  });
});

const PROTOCOL_CASES = [
  ['media-errors', 'media_buy', 'get_products'],
  ['media-schema', 'media_buy', 'get_products'],
  ['signals-errors', 'signals', 'get_signals'],
  ['signals-schema', 'signals', 'get_signals'],
];

async function assess({
  protocols,
  tools = [],
  requires = ['controller'],
  invalid = false,
  rejectClaim = false,
  version = ADCP_VERSION,
  explicit = false,
  routeStoryboard,
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-protocol-applicability-'));
  fs.mkdirSync(path.join(dir, 'universal'));
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      adcp_version: version,
      generated_at: new Date().toISOString(),
      universal: PROTOCOL_CASES.map(([id]) => id),
      protocols: [],
      specialisms: [],
    })
  );
  for (const [id, protocol, tool] of PROTOCOL_CASES) {
    fs.writeFileSync(
      path.join(dir, 'universal', `${id}.yaml`),
      YAML.stringify({
        ...storyboard(id, [tool]),
        ...(requires.length ? { requires } : {}),
        requires_capability: { path: 'supported_protocols', contains: protocol },
        phases: [
          {
            id: 'flow',
            title: 'Flow',
            steps: [
              {
                id: 'capability-contract',
                title: 'Check capability contract',
                task: 'get_adcp_capabilities',
                sample_request: {},
                validations: [
                  {
                    check: 'field_value',
                    path: 'account.require_operator_auth',
                    value: false,
                    description: 'This fixture supports caller-declared accounts',
                  },
                ],
              },
            ],
          },
        ],
      })
    );
  }
  const connections = [];
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'Protocol applicability fixture', version: '1.0.0' });
    for (const name of ['get_adcp_capabilities', ...tools]) {
      mcp.registerTool(name, { inputSchema: z.object({}).passthrough() }, async params => {
        calls.push(name);
        const data =
          name === 'get_adcp_capabilities'
            ? {
                status: 'completed',
                adcp: {
                  major_versions: [3],
                  supported_versions: ['3.1', '3.2', toReleasePrecisionVersion(ADCP_VERSION)],
                  idempotency: { supported: false },
                },
                ...(invalid ? {} : { supported_protocols: protocols }),
                specialisms: [],
                account: { require_operator_auth: rejectClaim, supported_billing: ['operator'] },
                context: params.context,
              }
            : { status: 'completed', products: [] };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      });
    }
    connections.push(mcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await comply(`http://127.0.0.1:${server.address().port}/mcp`, {
      complianceDir: dir,
      complianceVersion: version,
      protocol: 'mcp',
      allow_http: true,
      transport: { allowPrivateIp: true },
      routeStoryboard,
      ...(explicit ? { storyboards: PROTOCOL_CASES.map(([id]) => id) } : {}),
    });
    assert.ok(
      calls.every(name => name === 'get_adcp_capabilities'),
      'applicability must not dispatch fixture tasks'
    );
    return result;
  } finally {
    await Promise.all(connections.map(connection => connection.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('capability-driven compliance keeps unrelated protocols out of required coverage', () => {
  for (const protocol of ['media_buy', 'signals']) {
    test(`${protocol}-only: unrelated gates run before missing tools; claimants retain controller gaps`, async () => {
      const result = await assess({ protocols: [protocol] });
      assert.deepEqual(result.storyboards_missing_tools ?? [], []);
      for (const [id, requiredProtocol] of PROTOCOL_CASES) {
        const bundle = result.bundle_results.find(entry => entry.id === id);
        assert.equal(bundle.status, protocol === requiredProtocol ? 'partial' : 'not_applicable', id);
        const phase = protocol === requiredProtocol ? 'requirement_unmet' : 'capability_unsupported';
        const scenario = result.tracks.flatMap(track => track.scenarios).find(row => row.scenario === `${id}/${phase}`);
        assert.ok(scenario, `expected canonical ${id}/${phase} evidence`);
        if (protocol === requiredProtocol) assert.equal(scenario.steps[0].requirement, 'controller');
        else assert.equal(scenario.steps[0].skip_reason, 'capability_unsupported');
      }
    });
  }

  test('a declared protocol without its required tool stays partial after passing the capability gate', async () => {
    const result = await assess({ protocols: ['media_buy', 'signals'], requires: [] });
    assert.deepEqual(result.storyboards_missing_tools ?? [], []);
    assert.equal(result.bundle_results.length, 4);
    assert.ok(result.bundle_results.every(bundle => bundle.status === 'partial'));
    const steps = result.tracks.flatMap(track => track.scenarios).flatMap(scenario => scenario.steps);
    assert.ok(steps.length >= 4);
    assert.ok(steps.some(step => step.skip_reason === 'missing_tool' || step.skip?.reason === 'missing_tool'));
  });

  test('an unrelated root gate is resolved against the agent under test before a routing callback', async () => {
    const routed = [];
    await assess({
      protocols: ['signals'],
      routeStoryboard(board) {
        routed.push(board.id);
      },
    });
    assert.deepEqual(routed, ['signals-errors', 'signals-schema']);
  });

  test('dual claimants execute both families and real failed assertions remain blocking', async () => {
    for (const rejectClaim of [false, true]) {
      const result = await assess({
        protocols: ['media_buy', 'signals'],
        tools: ['get_products', 'get_signals'],
        requires: [],
        rejectClaim,
      });
      assert.equal(result.bundle_results.length, 4);
      assert.ok(
        result.bundle_results.every(bundle => bundle.status === (rejectClaim ? 'failing' : 'passing')),
        JSON.stringify({ bundles: result.bundle_results, tracks: result.tracks })
      );
    }
  });

  test('invalid capability discovery is a blocking diagnostic, never protocol absence', async () => {
    const result = await assess({ protocols: ['media_buy'], invalid: true });
    assert.ok(result.bundle_results.length > 0);
    assert.ok(result.bundle_results.every(bundle => bundle.status !== 'not_applicable'));
    assert.equal(result.overall_status, 'failing');
  });

  test('pre-3.2 capability skips retain their previous incomplete rollup', async () => {
    const result = await assess({ protocols: ['media_buy'], version: '3.1.29' });
    assert.ok(result.bundle_results.every(bundle => bundle.status === 'partial'));
  });

  test('explicit storyboard selection keeps the same authoritative missing-tool behavior', async () => {
    const result = await assess({ protocols: ['media_buy', 'signals'], requires: [], explicit: true });
    assert.deepEqual(result.storyboards_missing_tools ?? [], []);
    assert.ok(
      result.tracks
        .flatMap(track => track.scenarios)
        .some(scenario =>
          scenario.steps.some(step => step.skip_reason === 'missing_tool' || step.skip?.reason === 'missing_tool')
        )
    );
  });
});
