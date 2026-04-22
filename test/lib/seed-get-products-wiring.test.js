const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServer: _createAdcpServer } = require('../../dist/lib/server/create-adcp-server');

// Opt out of strict response validation — test fixtures are deliberately
// sparse (just product_id + name) to keep the wiring test focused on the
// merge behavior rather than on a full spec-conformant Product.
function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

async function callGetProducts(server, args) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_products', arguments: args },
  });
}

function makeSeededProduct(productId, overrides = {}) {
  return {
    product_id: productId,
    name: `Seeded ${productId}`,
    description: 'from seed',
    publisher_properties: [],
    format_ids: [],
    delivery_type: 'guaranteed',
    pricing_options: [],
    reporting_capabilities: {},
    ...overrides,
  };
}

describe('createAdcpServer — test-controller seeded get_products wiring', () => {
  it('appends seeded products to handler output on sandbox requests', async () => {
    const seeded = [makeSeededProduct('seed-1'), makeSeededProduct('seed-2')];
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({ products: [{ product_id: 'handler-1', name: 'Handler Own' }] }),
      },
      testController: {
        getSeededProducts: () => seeded,
      },
    });
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
    });
    const payload = result.structuredContent;
    const ids = payload.products.map(p => p.product_id);
    assert.deepStrictEqual(ids, ['handler-1', 'seed-1', 'seed-2']);
    assert.strictEqual(payload.sandbox, true);
  });

  it('does not leak seeded products when no sandbox marker is present', async () => {
    let bridgeCalled = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({ products: [{ product_id: 'handler-1', name: 'Handler Own' }] }),
      },
      testController: {
        getSeededProducts: () => {
          bridgeCalled = true;
          return [makeSeededProduct('seed-1')];
        },
      },
    });
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      account: { brand: { domain: 'example.com' }, operator: 'example.com' },
    });
    const payload = result.structuredContent;
    assert.deepStrictEqual(
      payload.products.map(p => p.product_id),
      ['handler-1']
    );
    assert.strictEqual(bridgeCalled, false, 'bridge must not run on non-sandbox requests');
    // `sandbox: true` must not be stamped when nothing was merged.
    assert.notStrictEqual(payload.sandbox, true);
  });

  it('honors context.sandbox as a sandbox marker', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
      },
      testController: {
        getSeededProducts: () => [makeSeededProduct('seed-1')],
      },
    });
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      context: { sandbox: true },
    });
    const payload = result.structuredContent;
    assert.deepStrictEqual(
      payload.products.map(p => p.product_id),
      ['seed-1']
    );
  });

  it('dedupes by product_id — seeded wins on collision', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({
          products: [
            { product_id: 'shared', name: 'Handler Copy' },
            { product_id: 'handler-only', name: 'Handler Only' },
          ],
        }),
      },
      testController: {
        getSeededProducts: () => [makeSeededProduct('shared', { name: 'Seeded Copy' })],
      },
    });
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
    });
    const payload = result.structuredContent;
    const byId = Object.fromEntries(payload.products.map(p => [p.product_id, p.name]));
    assert.strictEqual(byId.shared, 'Seeded Copy', 'seeded product should win collision');
    assert.strictEqual(byId['handler-only'], 'Handler Only');
  });

  it('respects augmentGetProducts: false to disable the bridge', async () => {
    let bridgeCalled = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({ products: [{ product_id: 'handler-1', name: 'Handler Own' }] }),
      },
      testController: {
        augmentGetProducts: false,
        getSeededProducts: () => {
          bridgeCalled = true;
          return [makeSeededProduct('seed-1')];
        },
      },
    });
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
    });
    const payload = result.structuredContent;
    assert.deepStrictEqual(
      payload.products.map(p => p.product_id),
      ['handler-1']
    );
    assert.strictEqual(bridgeCalled, false);
  });

  it('does not call the bridge when handler returned an error envelope', async () => {
    const { adcpError } = require('../../dist/lib/server/errors');
    let bridgeCalled = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => adcpError('SERVICE_UNAVAILABLE', { message: 'backend down' }),
      },
      testController: {
        getSeededProducts: () => {
          bridgeCalled = true;
          return [makeSeededProduct('seed-1')];
        },
      },
    });
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
    });
    assert.strictEqual(bridgeCalled, false, 'bridge must not run on error envelopes');
    assert.ok(result.structuredContent.adcp_error, 'error envelope should pass through');
  });

  it('receives resolved account in the bridge context', async () => {
    let captured;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      resolveAccount: async () => ({ account_id: 'resolved-123', sandbox: true }),
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
      },
      testController: {
        getSeededProducts: ctx => {
          captured = ctx;
          return [];
        },
      },
    });
    await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
    });
    assert.ok(captured, 'bridge should have run');
    assert.strictEqual(captured.account.account_id, 'resolved-123');
    assert.strictEqual(captured.input.buying_mode, 'brief');
  });

  it('is a no-op when testController is not configured', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({ products: [{ product_id: 'handler-1', name: 'Handler Own' }] }),
      },
    });
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
    });
    const payload = result.structuredContent;
    assert.deepStrictEqual(
      payload.products.map(p => p.product_id),
      ['handler-1']
    );
  });
});
