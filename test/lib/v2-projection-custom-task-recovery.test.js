const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const { AdCPClient } = require('../../dist/lib/index.js');
const { ProtocolClient } = require('../../dist/lib/protocols');
const {
  normalizeLegacyGetProductsResponse,
  toCanonicalOnlyResponse,
} = require('../../dist/lib/v2/projection/index.js');

const originalCallTool = ProtocolClient.callTool;

afterEach(() => {
  ProtocolClient.callTool = originalCallTool;
  mock.restoreAll();
});

test('public legacy normalizer supports get_products recovery through executeCustomTask(tasks_get)', async () => {
  const timestampInputs = [
    '2026-08-23T22:00:00+02:00',
    '2026-08-24t02:30:00.123456+02:30',
    ' 2026-08-23 22:00:00.123456+0200 ',
    '2026-08-23t20:00:00z',
    '2026-08-23T20:00:00 UTC',
    '2026-08-23T22:00:00+02',
    { $date: '2026-08-23T20:00:00Z' },
    { value: '2026-08-24T02:30:00+02:30' },
    null,
    {},
  ];
  const expected = [
    '2026-08-23T20:00:00Z',
    '2026-08-24T00:00:00.123456Z',
    '2026-08-23T20:00:00.123456Z',
    '2026-08-23T20:00:00Z',
    '2026-08-23T20:00:00Z',
    '2026-08-23T20:00:00Z',
    '2026-08-23T20:00:00Z',
    '2026-08-24T00:00:00Z',
    undefined,
    undefined,
  ];
  const recoveredPayload = {
    products: timestampInputs.map((generated_at, index) => ({
      product_id: `product_${index}`,
      name: `Product ${index}`,
      description: 'Custom task recovery fixture',
      format_options: [{ format_kind: 'image', params: {} }],
      forecast: { generated_at },
    })),
    cache_scope: 'public',
  };

  ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
    assert.strictEqual(taskName, 'tasks_get');
    return {
      task_id: 'task_legacy_products',
      task_type: 'get_products',
      protocol: 'media-buy',
      status: 'completed',
      created_at: '2026-08-25T18:00:00Z',
      updated_at: '2026-08-25T18:01:00Z',
      result: recoveredPayload,
    };
  });

  const client = new AdCPClient([
    {
      id: 'legacy-seller',
      name: 'Legacy seller',
      agent_uri: 'https://seller.example/mcp/',
      protocol: 'mcp',
    },
  ]);
  const agent = client.agent('legacy-seller');
  agent.client.discoveredEndpoint = 'https://seller.example/mcp/';
  agent.client.cachedCapabilities = {
    version: 'v3',
    majorVersions: [3],
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    _synthetic: false,
  };
  const polled = await agent.executeCustomTask('tasks_get', {
    task_id: 'task_legacy_products',
  });
  assert.strictEqual(polled.success, true);

  const completedTask = polled.data;
  assert.ok(completedTask && typeof completedTask === 'object');
  assert.ok(completedTask.result && typeof completedTask.result === 'object');
  const normalized = normalizeLegacyGetProductsResponse(completedTask.result);
  const { response: canonical } = toCanonicalOnlyResponse(normalized);

  assert.deepStrictEqual(
    canonical.products.map(product => product.forecast.generated_at),
    expected
  );
});
