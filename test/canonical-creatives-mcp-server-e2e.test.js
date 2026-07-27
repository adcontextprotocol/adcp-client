process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform.js');

test('official MCP legacy buyer is canonicalized before modern server handlers', async () => {
  let observedCreate;
  const platform = {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'acct-mcp-server',
        operator: 'buyer.example',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async request => {
        observedCreate = request;
        return { media_buy_id: 'mb-mcp-server', status: 'pending_creatives', packages: [] };
      },
      updateMediaBuy: async () => ({ media_buy_id: 'mb-mcp-server', status: 'active', packages: [] }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buy_deliveries: [] }),
    },
  };
  const server = createAdcpServerFromPlatform(platform, {
    name: 'canonical-mcp-server',
    version: '1.0.0',
    validation: { requests: 'strict', responses: 'off' },
    legacyCreativeFormatConverter: ({ formatId }) =>
      formatId.id === 'homepage_takeover'
        ? {
            format_option_id: 'homepage-takeover',
            format_kind: 'custom',
            format_shape: 'multi_placement_takeover',
            format_schema: {
              uri: 'https://seller.example/formats/homepage_takeover.json',
              digest: `sha256:${'a'.repeat(64)}`,
            },
            params: {},
          }
        : undefined,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'legacy-buyer', version: '1.0.0' });
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: 'create_media_buy',
      arguments: {
        account: { account_id: 'acct-mcp-server' },
        brand: { domain: 'buyer.example' },
        start_time: 'asap',
        end_time: '2027-12-31T00:00:00Z',
        idempotency_key: 'legacy-buyer-create-1',
        packages: [
          {
            buyer_ref: 'pkg-known',
            product_id: 'known-product',
            pricing_option_id: 'po-cpm',
            budget: 1000,
            format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
            creatives: [
              {
                creative_id: 'known-creative',
                name: 'Known legacy creative',
                format_id: {
                  agent_url: 'https://creative.adcontextprotocol.org/',
                  id: 'display_300x250_image',
                },
                assets: {},
              },
            ],
          },
          {
            buyer_ref: 'pkg-custom',
            product_id: 'custom-product',
            pricing_option_id: 'po-cpm',
            budget: 1000,
            format_ids: [{ agent_url: 'https://seller.example/custom', id: 'homepage_takeover' }],
            creatives: [
              {
                creative_id: 'custom-creative',
                name: 'Custom legacy creative',
                format_id: { agent_url: 'https://seller.example/custom', id: 'homepage_takeover' },
                assets: {},
              },
            ],
          },
        ],
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(observedCreate, 'platform create handler was invoked');
    assert.strictEqual(observedCreate.packages[0].format_option_refs[0].scope, 'product');
    assert.match(observedCreate.packages[0].format_option_refs[0].format_option_id, /^migrated_[a-f0-9]{32}$/);
    assert.deepStrictEqual(observedCreate.packages[1].format_option_refs, [
      { scope: 'product', format_option_id: 'homepage-takeover' },
    ]);
    assert.strictEqual(observedCreate.packages[0].creatives[0].format_kind, 'image');
    assert.strictEqual(observedCreate.packages[1].creatives[0].format_kind, 'custom');
    assert.doesNotMatch(JSON.stringify(observedCreate), /"(?:format_id|format_ids|v1_format_ref|agent_url)"\s*:/);
  } finally {
    await client.close();
    await server.close();
  }
});
