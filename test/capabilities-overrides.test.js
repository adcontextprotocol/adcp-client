const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServer } = require('../dist/lib/server/create-adcp-server.js');

async function callCapabilities(server) {
  const result = await server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: {} },
  });
  return result.structuredContent;
}

describe('capabilities.overrides — per-domain merge (#654)', () => {
  it('adds fields that the framework does not auto-derive', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      capabilities: {
        overrides: {
          media_buy: {
            execution: {
              targeting: {
                geo_countries: true,
                language: true,
                keyword_targets: { supported_match_types: ['broad', 'phrase', 'exact'] },
              },
            },
            audience_targeting: {
              supported_identifier_types: ['hashed_email'],
              minimum_audience_size: 500,
            },
            content_standards: {
              supports_local_evaluation: true,
              supported_channels: ['display', 'ctv'],
              supports_webhook_delivery: false,
            },
            conversion_tracking: {
              supported_event_types: ['purchase', 'add_to_cart'],
              supported_hashed_identifiers: ['hashed_email'],
              supported_action_sources: ['website'],
            },
          },
          compliance_testing: {
            scenarios: ['force_media_buy_status', 'simulate_delivery'],
          },
        },
      },
    });
    const caps = await callCapabilities(server);
    assert.strictEqual(caps.media_buy.execution.targeting.geo_countries, true);
    assert.strictEqual(caps.media_buy.execution.targeting.language, true);
    assert.deepStrictEqual(caps.media_buy.execution.targeting.keyword_targets.supported_match_types, [
      'broad',
      'phrase',
      'exact',
    ]);
    assert.deepStrictEqual(caps.media_buy.audience_targeting.supported_identifier_types, ['hashed_email']);
    assert.strictEqual(caps.media_buy.audience_targeting.minimum_audience_size, 500);
    assert.deepStrictEqual(caps.media_buy.content_standards.supported_channels, ['display', 'ctv']);
    assert.deepStrictEqual(caps.compliance_testing.scenarios, ['force_media_buy_status', 'simulate_delivery']);
  });

  it('preserves framework-derived fields when overrides target different keys', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      capabilities: {
        features: { inlineCreativeManagement: true, contentStandards: true },
        overrides: {
          media_buy: {
            execution: { targeting: { geo_countries: true } },
          },
        },
      },
    });
    const caps = await callCapabilities(server);
    assert.strictEqual(caps.media_buy.features.inline_creative_management, true);
    assert.strictEqual(caps.media_buy.features.content_standards, true);
    assert.strictEqual(caps.media_buy.execution.targeting.geo_countries, true);
  });

  it('deep-merges nested objects so overrides add leaf fields without blowing away siblings', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      capabilities: {
        features: { audienceTargeting: true },
        overrides: {
          media_buy: {
            features: { inline_creative_management: true },
          },
        },
      },
    });
    const caps = await callCapabilities(server);
    assert.strictEqual(caps.media_buy.features.audience_targeting, true);
    assert.strictEqual(caps.media_buy.features.inline_creative_management, true);
  });

  it('arrays replace (not concat) — override cardinality stays in caller control', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      capabilities: {
        portfolio: {
          publisher_domains: ['a.example.com', 'b.example.com'],
        },
        overrides: {
          media_buy: {
            portfolio: { publisher_domains: ['c.example.com'] },
          },
        },
      },
    });
    const caps = await callCapabilities(server);
    assert.deepStrictEqual(caps.media_buy.portfolio.publisher_domains, ['c.example.com']);
  });

  it('null on a top-level override removes the auto-derived block', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      capabilities: {
        features: { inlineCreativeManagement: true },
        overrides: {
          media_buy: null,
        },
      },
    });
    const caps = await callCapabilities(server);
    assert.strictEqual(caps.media_buy, undefined);
  });

  it('creative override merges with auto-derived creative block', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      creative: { buildCreative: async () => ({ creative_manifest: {} }) },
      capabilities: {
        creative: { supportsGeneration: true },
        overrides: {
          creative: {
            has_creative_library: true,
          },
        },
      },
    });
    const caps = await callCapabilities(server);
    assert.strictEqual(caps.creative.supports_generation, true);
    assert.strictEqual(caps.creative.has_creative_library, true);
  });

  it('accepts per-domain blocks the framework does not otherwise populate (signals, governance, brand)', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      capabilities: {
        overrides: {
          signals: { owned_supported: true },
          governance: { spend_authority_supported: true },
          brand: { rights_supported: true },
        },
      },
    });
    const caps = await callCapabilities(server);
    assert.deepStrictEqual(caps.signals, { owned_supported: true });
    assert.deepStrictEqual(caps.governance, { spend_authority_supported: true });
    assert.deepStrictEqual(caps.brand, { rights_supported: true });
  });

  it('request_signing override wins over capabilities.request_signing direct config', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      capabilities: {
        request_signing: {
          supported: true,
          required_for: ['create_media_buy'],
          covers_content_digest: 'required',
        },
        overrides: {
          request_signing: {
            supported: true,
            required_for: [],
            covers_content_digest: 'either',
          },
        },
      },
    });
    const caps = await callCapabilities(server);
    assert.deepStrictEqual(caps.request_signing.required_for, []);
    assert.strictEqual(caps.request_signing.covers_content_digest, 'either');
  });

  it('undefined overrides are no-ops', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: { getProducts: async () => ({ products: [] }) },
      capabilities: {
        features: { inlineCreativeManagement: true },
        overrides: {
          creative: undefined,
          signals: undefined,
        },
      },
    });
    const caps = await callCapabilities(server);
    assert.strictEqual(caps.media_buy.features.inline_creative_management, true);
    assert.strictEqual(caps.creative, undefined);
  });
});
