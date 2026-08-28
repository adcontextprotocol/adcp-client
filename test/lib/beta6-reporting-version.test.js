const { describe, test } = require('node:test');
const assert = require('node:assert');

const { SingleAgentClient, ProtocolClient, ProtocolFeatureUnsupportedError } = require('../../dist/lib/index.js');

function clientForSellerVersion(version) {
  const client = new SingleAgentClient(
    {
      id: 'seller',
      name: 'Seller',
      agent_uri: 'https://seller.example.com/mcp',
      protocol: 'mcp',
    },
    {
      adcpVersion: '3.2.0-beta.8',
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    }
  );
  client.getCapabilities = async () => ({
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [version],
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    _synthetic: false,
  });
  client.ensureEndpointDiscovered = async () => client.agent;
  return client;
}

function beta6MetricRequests(client) {
  return [
    () => client.getProducts({ filters: { required_metrics: ['viewable_rate'] } }),
    () =>
      client.createMediaBuy({
        account: { account_id: 'account-1' },
        brand: { domain: 'advertiser.example' },
        start_time: '2026-09-01T00:00:00Z',
        end_time: '2026-09-30T00:00:00Z',
        packages: [
          {
            package_id: 'package-1',
            product_id: 'product-1',
            pricing_option_id: 'price-1',
            committed_metrics: [{ scope: 'standard', metric_id: 'quartile_25' }],
          },
        ],
      }),
    () =>
      client.updateMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'buy-1',
        packages: [
          { package_id: 'package-1', committed_metrics: [{ scope: 'standard', metric_id: 'viewed_seconds' }] },
        ],
      }),
    () =>
      client.providePerformanceFeedback({
        account: { account_id: 'account-1' },
        idempotency_key: 'feedback-key-0001',
        metric: { scope: 'standard', metric_id: 'measurable_impressions' },
      }),
    () =>
      client.providePerformanceFeedback({
        account: { account_id: 'account-1' },
        idempotency_key: 'feedback-key-0002',
        metric: {
          scope: 'vendor',
          vendor: { domain: 'measurement.example' },
          metric_id: 'attention_units',
          qualifier: { attribution_methodology: 'modeled' },
        },
      }),
  ];
}

describe('beta.6 reporting version gates', () => {
  test('direct client rejects beta.6 delivery controls for beta.5 without dispatch', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let calls = 0;
    ProtocolClient.callTool = async () => {
      calls += 1;
      return { status: 'completed', media_buy_deliveries: [] };
    };
    try {
      await assert.rejects(
        clientForSellerVersion('3.2.0-beta.5').getMediaBuyDelivery({
          requested_metrics: ['viewable_rate'],
          reporting_dimensions: { format: { sort_direction: 'asc' } },
        }),
        error => error instanceof ProtocolFeatureUnsupportedError && error.details.required_version === '3.2.0-beta.6'
      );
      assert.strictEqual(calls, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('direct client dispatches beta.6 delivery controls to beta.6 sellers', async () => {
    const originalCallTool = ProtocolClient.callTool;
    const calls = [];
    ProtocolClient.callTool = async (_agent, taskName, params) => {
      calls.push({ taskName, params });
      return { status: 'completed', media_buy_deliveries: [] };
    };
    try {
      await clientForSellerVersion('3.2.0-beta.6').getMediaBuyDelivery({
        requested_metrics: ['viewable_rate'],
        reporting_dimensions: { format: { sort_direction: 'asc' } },
      });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].taskName, 'get_media_buy_delivery');
      assert.deepStrictEqual(calls[0].params.requested_metrics, ['viewable_rate']);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('direct client rejects beta.6 metric identities across established tools for beta.5', async () => {
    const originalCallTool = ProtocolClient.callTool;
    let calls = 0;
    ProtocolClient.callTool = async () => {
      calls += 1;
      return { status: 'completed' };
    };
    try {
      for (const request of beta6MetricRequests(clientForSellerVersion('3.2.0-beta.5'))) {
        await assert.rejects(
          request(),
          error => error instanceof ProtocolFeatureUnsupportedError && error.details.required_version === '3.2.0-beta.6'
        );
      }
      assert.strictEqual(calls, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('configured beta.5 pin rejects beta.6 reporting before capability discovery', async () => {
    const client = clientForSellerVersion('3.2.0-beta.6');
    client.config.wireAdcpVersion = '3.2.0-beta.5';
    let capabilityCalls = 0;
    client.getCapabilities = async () => {
      capabilityCalls += 1;
      throw new Error('capability discovery must not run');
    };

    await assert.rejects(
      client.getMediaBuyDelivery({ requested_metrics: ['viewable_rate'] }),
      error => error instanceof ProtocolFeatureUnsupportedError && error.details.current_version === '3.2.0-beta.5'
    );
    assert.strictEqual(capabilityCalls, 0);
  });

  test('synthetic v2 capability fallback still rejects beta.6 reporting without dispatch', async () => {
    const client = clientForSellerVersion('3.2.0-beta.6');
    client.getCapabilities = async () => ({
      version: 'v2',
      majorVersions: [2],
      supportedVersions: [],
      protocols: ['media_buy'],
      features: {},
      extensions: [],
      _synthetic: true,
    });
    const originalCallTool = ProtocolClient.callTool;
    let calls = 0;
    ProtocolClient.callTool = async () => {
      calls += 1;
      return { status: 'completed' };
    };
    try {
      await assert.rejects(
        client.getProductsLegacy({ filters: { required_metrics: ['viewable_rate'] } }),
        error => error instanceof ProtocolFeatureUnsupportedError && error.details.required_version === '3.2.0-beta.6'
      );
      assert.strictEqual(calls, 0);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });
});
