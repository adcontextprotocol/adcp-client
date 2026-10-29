const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');

// The legacy 3.0.28 reports use these two shapes: a literal seeded product
// purchase, and an assertion whose contributing phases require that fixture.
// No cached/published storyboard is edited to establish this regression.
function storyboard() {
  return {
    id: 'standalone_legacy_fixture',
    version: '1.0.0',
    title: 'Standalone legacy fixture',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    prerequisites: { controller_seeding: true },
    fixtures: { products: [{ product_id: 'async_signed_io_q2', delivery_type: 'guaranteed' }] },
    phases: [
      {
        id: 'exercise',
        title: 'Exercise fixture',
        steps: [
          { id: 'capabilities', title: 'Discover capabilities', task: 'get_adcp_capabilities', validations: [] },
          {
            id: 'purchase',
            title: 'Purchase seeded product',
            task: 'create_media_buy',
            stateful: true,
            raw_tool_call: true,
            sample_request: {
              account: { sandbox: true },
              idempotency_key: '11111111-1111-4111-8111-111111111111',
              packages: [{ product_id: 'async_signed_io_q2', pricing_option_id: 'cpm', budget: 100 }],
            },
            validations: [{ check: 'field_value', path: 'status', value: 'submitted', description: 'Task submitted' }],
          },
          {
            id: 'assertion',
            title: 'Assert seeded branch',
            task: 'assert_contribution',
            validations: [{ check: 'any_of', allowed_values: ['past_start_handled'], description: 'A branch ran' }],
          },
        ],
      },
    ],
  };
}

async function startAgent(controller = false) {
  const calls = [];
  const connections = [];
  const server = http.createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'Standalone fixture seller', version: '1.0.0' });
    const tools = ['get_adcp_capabilities', 'create_media_buy', ...(controller ? ['comply_test_controller'] : [])];
    for (const name of tools) {
      mcp.registerTool(name, { inputSchema: z.object({}).passthrough() }, async params => {
        calls.push({ name, params });
        const data =
          name === 'get_adcp_capabilities'
            ? {
                status: 'completed',
                adcp_version: '3.0.25',
                adcp: {
                  major_versions: [3],
                  supported_versions: ['3.0'],
                  build_version: '3.0.25',
                  idempotency: { supported: false },
                },
                supported_protocols: ['media_buy'],
                specialisms: [],
                account: { require_operator_auth: false, supported_billing: ['operator'] },
                creative: { has_creative_library: false },
                context: params.context,
              }
            : {
                status: 'failed',
                errors: [{ code: 'PRODUCT_NOT_FOUND', message: 'Fixture product was never seeded' }],
              };
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
    async close() {
      await Promise.all(connections.map(mcp => mcp.close()));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const OPTIONS = { protocol: 'mcp', adcpVersion: '3.0.25', allow_http: true, transport: { allowPrivateIp: true } };

describe('standalone legacy controller setup (#8576)', () => {
  let agent;
  before(async () => {
    agent = await startAgent();
  });
  after(async () => {
    await agent.close();
  });

  for (const step of ['purchase', 'assertion']) {
    test(`${step} retains a controller coverage gap instead of a synthetic seller failure`, async () => {
      agent.calls.length = 0;
      const result = await runStoryboardStep(agent.url, storyboard(), step, OPTIONS);
      assert.equal(result.passed, true);
      assert.equal(result.skipped, true);
      assert.equal(result.skip_reason, 'missing_test_controller');
      assert.equal(result.skip.requirement, 'controller');
      assert.match(result.error, /controller-seeded fixtures/);
      if (step === 'purchase') assert.equal(result.next.step_id, 'assertion');
      assert.deepEqual(result.validations, []);
      assert.deepEqual(result.contributions, []);
      assert.ok(agent.calls.every(call => call.name === 'get_adcp_capabilities'));
    });
  }

  test('full and standalone execution never purchase an unseeded product', async () => {
    agent.calls.length = 0;
    const full = await runStoryboard(agent.url, storyboard(), OPTIONS);
    assert.equal(full.failed_count, 0);
    assert.equal(full.passed_count, 0);
    assert.ok(full.phases.flatMap(phase => phase.steps).every(step => step.skip_reason === 'missing_test_controller'));
    await runStoryboardStep(agent.url, storyboard(), 'purchase', OPTIONS);
    assert.ok(agent.calls.every(call => call.name === 'get_adcp_capabilities'));
  });

  test('independent capability discovery remains executable', async () => {
    const result = await runStoryboardStep(agent.url, storyboard(), 'capabilities', OPTIONS);
    assert.equal(result.passed, true);
    assert.notEqual(result.skipped, true);
  });

  test('explicit external-state opt-out retains the real rejected purchase', async () => {
    agent.calls.length = 0;
    const result = await runStoryboardStep(agent.url, storyboard(), 'purchase', {
      ...OPTIONS,
      skip_controller_seeding: true,
    });
    assert.equal(result.passed, false);
    assert.notEqual(result.skipped, true);
    assert.equal(agent.calls.filter(call => call.name === 'create_media_buy').length, 1);
  });

  test('controller presence does not silently pass or reseed a rejected purchase', async () => {
    const withController = await startAgent(true);
    try {
      const result = await runStoryboardStep(withController.url, storyboard(), 'purchase', OPTIONS);
      assert.equal(result.passed, false);
      assert.notEqual(result.skipped, true);
      assert.equal(withController.calls.filter(call => call.name === 'create_media_buy').length, 1);
      assert.equal(withController.calls.filter(call => call.name === 'comply_test_controller').length, 0);
    } finally {
      await withController.close();
    }
  });

  for (const [kind, decorate, reason] of [
    [
      'optional tool',
      step => {
        step.requires_tool = 'sync_creatives';
      },
      'missing_tool',
    ],
    [
      'optional contract',
      step => {
        step.requires_contract = 'fixture_contract';
      },
      'missing_test_kit_contract',
    ],
  ]) {
    test(`keeps ${kind} applicability ahead of the controller gap`, async () => {
      const board = storyboard();
      decorate(board.phases[0].steps[1]);
      const result = await runStoryboardStep(agent.url, board, 'purchase', OPTIONS);
      assert.equal(result.skipped, true);
      assert.equal(result.skip_reason, reason);
    });
  }

  test('a phase capability opt-out remains not applicable', async () => {
    const board = storyboard();
    board.phases[0].requires_capability = { path: 'creative.has_creative_library', equals: true };
    const result = await runStoryboardStep(agent.url, board, 'purchase', OPTIONS);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'not_applicable');
  });

  test('an absent called tool keeps its intrinsic missing-tool result', async () => {
    const board = storyboard();
    board.phases[0].steps[1].task = 'sync_creatives';
    agent.calls.length = 0;
    const result = await runStoryboardStep(agent.url, board, 'purchase', OPTIONS);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'missing_tool');
    assert.ok(agent.calls.every(call => call.name === 'get_adcp_capabilities'));
  });

  test('caller-supplied contributions do not bypass missing fixture setup', async () => {
    const result = await runStoryboardStep(agent.url, storyboard(), 'assertion', {
      ...OPTIONS,
      contributions: ['past_start_handled'],
    });
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'missing_test_controller');
    assert.deepEqual(result.contributions, ['past_start_handled']);
  });

  for (const [kind, decorate] of [
    [
      'malformed seed declaration',
      board => {
        delete board.fixtures.products[0].product_id;
      },
    ],
    [
      'unseeded storyboard',
      board => {
        delete board.prerequisites;
      },
    ],
    [
      'empty fixtures',
      board => {
        board.fixtures = {};
      },
    ],
    [
      'declarative fixture resolution',
      board => {
        board.fixture_resolution = {
          products: [
            {
              handle: 'async_signed_io_q2',
              strategies: ['discover'],
              match: [{ path: '/product_id', operator: 'present' }],
            },
          ],
        };
      },
    ],
  ]) {
    test(`does not impose a new controller requirement on ${kind}`, async () => {
      const board = storyboard();
      decorate(board);
      const result = await runStoryboardStep(agent.url, board, 'purchase', OPTIONS);
      assert.notEqual(result.skip_reason, 'missing_test_controller');
      assert.equal(result.passed, false);
    });
  }
});
