// Integration tests for v6 capability projections: audience_targeting,
// conversion_tracking, and content_standards declared on platform.capabilities
// must surface on get_adcp_capabilities.media_buy via the framework's
// overrides.media_buy deep-merge seam.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function basePlatform(capabilityOverrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
      ...capabilityOverrides,
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'cap_acc_1',
        operator: 'caps.example.com',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({
        media_buy_id: 'mb_1',
        status: 'pending_creatives',
        confirmed_at: '2026-04-28T00:00:00Z',
        packages: [],
      }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buy_deliveries: [],
      }),
    },
  };
}

async function dispatchCapabilities(server) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: {} },
  });
}

describe('Capability projections — declarative capability blocks on DecisioningCapabilities', () => {
  it('audience_targeting projects onto get_adcp_capabilities.media_buy', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        audience_targeting: {
          supported_identifier_types: ['hashed_email', 'hashed_phone'],
          minimum_audience_size: 100,
          matching_latency_hours: { min: 1, max: 24 },
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const at = result.structuredContent?.media_buy?.audience_targeting;
    assert.ok(at, `audience_targeting missing: ${JSON.stringify(result.structuredContent?.media_buy)}`);
    assert.deepStrictEqual(at.supported_identifier_types, ['hashed_email', 'hashed_phone']);
    assert.strictEqual(at.minimum_audience_size, 100);
    assert.deepStrictEqual(at.matching_latency_hours, { min: 1, max: 24 });
  });

  it('conversion_tracking projects onto get_adcp_capabilities.media_buy', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        conversion_tracking: {
          multi_source_event_dedup: true,
          supported_action_sources: ['website', 'app'],
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const ct = result.structuredContent?.media_buy?.conversion_tracking;
    assert.ok(ct, `conversion_tracking missing: ${JSON.stringify(result.structuredContent?.media_buy)}`);
    assert.strictEqual(ct.multi_source_event_dedup, true);
    assert.deepStrictEqual(ct.supported_action_sources, ['website', 'app']);
  });

  it('content_standards projects onto get_adcp_capabilities.media_buy', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        content_standards: {
          supports_local_evaluation: true,
          supported_channels: ['display', 'olv'],
          supports_webhook_delivery: false,
        },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const cs = result.structuredContent?.media_buy?.content_standards;
    assert.ok(cs, `content_standards missing: ${JSON.stringify(result.structuredContent?.media_buy)}`);
    assert.strictEqual(cs.supports_local_evaluation, true);
    assert.deepStrictEqual(cs.supported_channels, ['display', 'olv']);
    assert.strictEqual(cs.supports_webhook_delivery, false);
  });

  it('all three blocks project together when declared together', async () => {
    const server = createAdcpServerFromPlatform(
      basePlatform({
        audience_targeting: { supported_identifier_types: ['hashed_email'], minimum_audience_size: 50 },
        conversion_tracking: { multi_source_event_dedup: false },
        content_standards: { supports_local_evaluation: false },
      }),
      { name: 'h', version: '0.0.1', validation: { requests: 'off', responses: 'off' } }
    );
    const result = await dispatchCapabilities(server);
    const mb = result.structuredContent?.media_buy;
    assert.ok(mb?.audience_targeting, 'audience_targeting missing');
    assert.ok(mb?.conversion_tracking, 'conversion_tracking missing');
    assert.ok(mb?.content_standards, 'content_standards missing');
  });

  it('omitting all three leaves get_adcp_capabilities unchanged (no empty media_buy block)', async () => {
    const server = createAdcpServerFromPlatform(basePlatform(), {
      name: 'h',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchCapabilities(server);
    const mb = result.structuredContent?.media_buy;
    // media_buy may exist with framework-derived defaults — what we want is
    // that the three projection blocks are absent when not declared.
    assert.strictEqual(mb?.audience_targeting, undefined);
    assert.strictEqual(mb?.conversion_tracking, undefined);
    assert.strictEqual(mb?.content_standards, undefined);
  });
});
