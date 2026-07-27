process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { AgentClient, packageRefsForFormatOptions } = require('../dist/lib/index.js');
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter.js');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform.js');
const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry.js');
const { InMemoryStateStore } = require('../dist/lib/server/state-store.js');

test('A2A client discovers canonical capability and sends only canonical creative identities', async () => {
  let observedCreate;
  let observedUpdate;
  let observedSync;
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
        id: ref?.account_id ?? 'acct-a2a',
        operator: 'buyer.example',
        ctx_metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    sales: {
      getProducts: async () => ({
        cache_scope: 'account',
        products: [
          {
            product_id: 'canonical-a2a-product',
            name: 'Canonical A2A Product',
            description: 'Canonical transport fixture',
            format_options: [
              {
                format_option_id: 'hero-image',
                format_kind: 'image',
                params: { width: 300, height: 250 },
              },
            ],
            pricing_options: [{ pricing_option_id: 'po-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
          },
        ],
      }),
      createMediaBuy: async request => {
        observedCreate = request;
        return { media_buy_id: 'mb-a2a', status: 'pending_creatives', packages: [] };
      },
      updateMediaBuy: async (_mediaBuyId, request) => {
        observedUpdate = request;
        return { media_buy_id: 'mb-a2a', status: 'active', packages: [] };
      },
      syncCreatives: async creatives => {
        observedSync = creatives;
        return [];
      },
      getMediaBuyDelivery: async () => ({ media_buy_deliveries: [] }),
    },
  };

  const adcp = createAdcpServerFromPlatform(platform, {
    name: 'canonical-a2a',
    version: '1.0.0',
    validation: { requests: 'off', responses: 'off' },
    stateStore: new InMemoryStateStore(),
    taskRegistry: createInMemoryTaskRegistry(),
  });
  const app = express();
  app.use(express.json());
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/a2a`;
  createA2AAdapter({
    server: adcp,
    agentCard: {
      name: 'Canonical A2A',
      description: 'Canonical creative transport fixture',
      url,
      version: '1.0.0',
      provider: { organization: 'Test', url: 'https://test.example' },
      securitySchemes: {},
    },
  }).mount(app);

  try {
    let handledProducts;
    const client = new AgentClient(
      { id: 'canonical-a2a', name: 'Canonical A2A', agent_uri: url, protocol: 'a2a' },
      {
        handlers: {
          onGetProductsStatusChange: response => {
            handledProducts = response;
          },
        },
      }
    );
    const capabilities = await client.getCapabilities();
    assert.strictEqual(capabilities.features.canonicalCreatives, true);

    const productsResult = await client.getProducts({ buying_mode: 'brief', brief: 'Canonical image placement' });
    assert.strictEqual(productsResult.success, true);
    const product = productsResult.data.products[0];
    assert.strictEqual(product.format_ids, undefined);
    assert.strictEqual(product.format_options[0].v1_format_ref, undefined);
    assert.ok(handledProducts, 'completion handler received the response');
    assert.doesNotMatch(JSON.stringify(handledProducts), /agent_url|format_id/);

    const selectedFormats = packageRefsForFormatOptions(product, ['hero-image']);
    const creative = {
      creative_id: 'creative-a2a',
      name: 'Canonical image',
      format_kind: 'image',
      format_option_ref: { scope: 'product', format_option_id: 'hero-image' },
      assets: {},
    };
    const result = await client.createMediaBuy({
      account: { account_id: 'acct-a2a' },
      brand: { domain: 'buyer.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      packages: [
        {
          buyer_ref: 'pkg-a2a',
          product_id: product.product_id,
          pricing_option_id: 'po-cpm',
          budget: 1000,
          ...selectedFormats,
          creatives: [creative],
        },
      ],
    });
    assert.strictEqual(result.success, true);
    assert.ok(observedCreate, 'platform create handler was called through A2A');
    assert.strictEqual(observedCreate.packages[0].creatives[0].format_kind, 'image');
    assert.strictEqual(observedCreate.packages[0].creatives[0].format_id, undefined);
    assert.doesNotMatch(JSON.stringify(observedCreate), /agent_url|format_id/);

    const update = await client.updateMediaBuy({
      media_buy_id: 'mb-a2a',
      packages: [{ package_id: 'pkg-a2a', ...selectedFormats, creatives: [creative] }],
    });
    assert.strictEqual(update.success, true);
    assert.ok(observedUpdate, 'platform update handler was called through A2A');
    assert.strictEqual(observedUpdate.packages[0].creatives[0].format_kind, 'image');
    assert.strictEqual(observedUpdate.packages[0].creatives[0].format_id, undefined);

    const sync = await client.syncCreatives({
      account: { account_id: 'acct-a2a' },
      creatives: [creative],
      assignments: [{ creative_id: creative.creative_id, package_id: 'pkg-a2a' }],
    });
    assert.strictEqual(sync.success, true);
    assert.ok(observedSync, 'platform sync handler was called through A2A');
    assert.strictEqual(observedSync[0].format_kind, 'image');
    assert.strictEqual(observedSync[0].format_id, undefined);
    assert.doesNotMatch(JSON.stringify({ observedUpdate, observedSync }), /agent_url|format_id/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
