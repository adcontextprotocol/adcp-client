const { describe, test, mock, afterEach } = require('node:test');
const assert = require('node:assert');

const { AdCPClient } = require('../../dist/lib/index.js');
const { ProtocolClient } = require('../../dist/lib/protocols');

const originalCallTool = ProtocolClient.callTool;

afterEach(() => {
  ProtocolClient.callTool = originalCallTool;
});

const CPM = [{ pricing_option_id: 'po_cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }];

function makeProduct(product_id, overrides = {}) {
  return {
    product_id,
    name: product_id,
    publisher_properties: [{ selection_type: 'all', publisher_domain: 'example.com' }],
    pricing_options: CPM,
    ...overrides,
  };
}

function makeClient(config = {}) {
  const agent = {
    id: 'seller',
    name: 'Seller',
    agent_uri: 'https://seller.example/mcp',
    protocol: 'mcp',
  };
  const client = new AdCPClient([agent], {
    validateFeatures: false,
    validation: {
      responses: 'off',
      ...config.validation,
    },
    ...(config.handlers ? { handlers: config.handlers } : {}),
  });
  const agentClient = client.agent('seller');
  const inner = agentClient.client;
  inner.discoveredEndpoint = agent.agent_uri;
  inner.cachedCapabilities = {
    version: 'v3',
    majorVersions: [3],
    protocols: ['media_buy'],
    features: {
      inlineCreativeManagement: false,
      conversionTracking: false,
      audienceTargeting: false,
      propertyListFiltering: false,
      contentStandards: false,
    },
    extensions: [],
    _synthetic: false,
  };
  return agentClient;
}

function stubGetProducts(products) {
  ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
    assert.strictEqual(taskName, 'get_products');
    return { status: 'completed', products, cache_scope: 'public' };
  });
}

describe('client rejects products without pricing_options', () => {
  test('drops products with no pricing_options by default before caller and handler', async () => {
    const handlerCalls = [];
    stubGetProducts([
      makeProduct('priced'),
      makeProduct('unpriced', { pricing_options: undefined }),
    ]);

    const agent = makeClient({
      handlers: { onGetProductsStatusChange: response => handlerCalls.push(response) },
    });

    const result = await agent.getProducts({ brief: 'sports' }, undefined, { project: false });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(
      result.data.products.map(p => p.product_id),
      ['priced']
    );
    assert.deepStrictEqual(
      handlerCalls[0].products.map(p => p.product_id),
      ['priced']
    );
    assert.strictEqual(result.metadata.productPricingPolicy.rejected_count, 1);
    assert.strictEqual(result.metadata.productPricingPolicy.accepted_count, 1);
    assert.deepStrictEqual(result.metadata.productPricingPolicy.rejected_products, [
      { index: 1, product_id: 'unpriced' },
    ]);
    assert.ok(
      result.debug_logs.some(entry => entry.details?.code === 'product_missing_pricing_options'),
      'expected a product_missing_pricing_options debug-log notice'
    );
  });

  test('treats an empty pricing_options array as missing pricing', async () => {
    stubGetProducts([makeProduct('priced'), makeProduct('empty', { pricing_options: [] })]);

    const agent = makeClient();
    const result = await agent.getProducts({ brief: 'sports' }, undefined, { project: false });

    assert.deepStrictEqual(
      result.data.products.map(p => p.product_id),
      ['priced']
    );
    assert.strictEqual(result.metadata.productPricingPolicy.rejected_count, 1);
  });

  test('passes unpriced products through when rejectProductsWithoutPricingOptions is false', async () => {
    stubGetProducts([makeProduct('priced'), makeProduct('unpriced', { pricing_options: undefined })]);

    const agent = makeClient({ validation: { rejectProductsWithoutPricingOptions: false } });
    const result = await agent.getProducts({ brief: 'sports' }, undefined, { project: false });

    assert.deepStrictEqual(
      result.data.products.map(p => p.product_id),
      ['priced', 'unpriced']
    );
    assert.strictEqual(result.metadata.productPricingPolicy, undefined);
  });

  test('drops unpriced products from completed get_products webhooks before the handler', async () => {
    const handlerCalls = [];

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      assert.strictEqual(taskName, 'get_products');
      return { status: 'submitted', task_id: 'seller-task-1' };
    });

    const agent = makeClient({
      handlers: {
        onGetProductsStatusChange: (response, metadata) => handlerCalls.push({ response, metadata }),
      },
    });

    const submitted = await agent.getProducts({ brief: 'sports' }, undefined, { project: false });
    assert.strictEqual(submitted.status, 'submitted');

    const handled = await agent.handleWebhook(
      {
        idempotency_key: 'webhook-event-1',
        operation_id: submitted.metadata.taskId,
        task_id: 'seller-task-1',
        task_type: 'get_products',
        status: 'completed',
        timestamp: '2026-06-02T12:00:00.000Z',
        result: {
          products: [makeProduct('priced'), makeProduct('unpriced', { pricing_options: undefined })],
          cache_scope: 'public',
        },
      },
      'get_products',
      submitted.metadata.taskId
    );

    assert.strictEqual(handled, true);
    assert.strictEqual(handlerCalls.length, 1);
    assert.deepStrictEqual(
      handlerCalls[0].response.products.map(p => p.product_id),
      ['priced']
    );
    assert.strictEqual(handlerCalls[0].metadata.productPricingPolicy.rejected_count, 1);
  });

  test('leaves the response untouched when every product is priced', async () => {
    stubGetProducts([makeProduct('a'), makeProduct('b')]);

    const agent = makeClient();
    const result = await agent.getProducts({ brief: 'sports' }, undefined, { project: false });

    assert.deepStrictEqual(
      result.data.products.map(p => p.product_id),
      ['a', 'b']
    );
    assert.strictEqual(result.metadata.productPricingPolicy, undefined);
    assert.ok(
      !result.debug_logs?.some(entry => entry.details?.code === 'product_missing_pricing_options'),
      'no pricing notice expected when all products are priced'
    );
  });
});
