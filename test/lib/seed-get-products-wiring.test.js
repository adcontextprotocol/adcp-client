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

  it('bridges disable when getSeededProducts is omitted', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({ products: [{ product_id: 'handler-1', name: 'Handler Own' }] }),
      },
      testController: {}, // no getSeededProducts → bridge stays off
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

  it('skips the bridge when resolveAccount resolves to a non-sandbox account', async () => {
    let bridgeCalled = false;
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      resolveAccount: async () => ({ account_id: 'prod-999', sandbox: false }),
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
    // Request-level signal says sandbox; resolved account disagrees. The
    // belt-and-suspenders cross-check must block the bridge.
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
    });
    assert.strictEqual(bridgeCalled, false, 'resolved non-sandbox account must block the bridge');
    assert.deepStrictEqual(
      result.structuredContent.products.map(p => p.product_id),
      ['handler-1']
    );
  });

  it('drops seeded entries missing product_id and keeps valid ones', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
      },
      testController: {
        getSeededProducts: () => [
          makeSeededProduct('ok-1'),
          { name: 'no id' }, // dropped
          makeSeededProduct(''), // dropped (empty string)
          makeSeededProduct('ok-2'),
        ],
      },
    });
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      context: { sandbox: true },
    });
    assert.deepStrictEqual(
      result.structuredContent.products.map(p => p.product_id),
      ['ok-1', 'ok-2']
    );
  });

  it('skips the bridge when getSeededProducts returns a non-array', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        getProducts: async () => ({ products: [{ product_id: 'handler-1', name: 'Handler Own' }] }),
      },
      testController: {
        getSeededProducts: () => 'not-an-array',
      },
    });
    const result = await callGetProducts(server, {
      brief: 'premium',
      buying_mode: 'brief',
      context: { sandbox: true },
    });
    assert.deepStrictEqual(
      result.structuredContent.products.map(p => p.product_id),
      ['handler-1']
    );
  });

  it('preserves handler sandbox: false rather than overwriting to true', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      mediaBuy: {
        // Handler declares sandbox: false explicitly. The bridge should not
        // overwrite it — the `sandbox` flag is authoritative from the handler.
        getProducts: async () => ({ products: [], sandbox: false }),
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
    assert.strictEqual(result.structuredContent.sandbox, false);
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

// Build a fully spec-conformant Product so strict response validation is
// exercised end-to-end. Covers all 8 required fields (product_id, name,
// description, publisher_properties, format_ids, delivery_type,
// pricing_options, reporting_capabilities) plus the required nested
// fields inside reporting_capabilities.
function makeStrictProduct(productId, overrides = {}) {
  return {
    product_id: productId,
    name: `Seeded ${productId}`,
    description: 'Seed fixture for strict validation wiring test',
    publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
    format_ids: [{ agent_url: 'https://creatives.adcontextprotocol.org', id: 'display_300x250' }],
    delivery_type: 'guaranteed',
    pricing_options: [{ pricing_option_id: 'default', pricing_model: 'cpm', currency: 'USD' }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 60,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range',
    },
    ...overrides,
  };
}

describe('createAdcpServer — seeded get_products under strict response validation', () => {
  it('validates clean when seeded products carry all required fields', async () => {
    const server = _createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      // Strict response validation ON — no opt-out.
      validation: { requests: 'off', responses: 'strict' },
      mediaBuy: {
        getProducts: async () => ({ products: [makeStrictProduct('handler-1')] }),
      },
      testController: {
        getSeededProducts: () => [makeStrictProduct('seed-1'), makeStrictProduct('seed-2')],
      },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          buying_mode: 'brief',
          account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
        },
      },
    });
    // isError only fires for error envelopes or failed strict validation.
    assert.notStrictEqual(result.isError, true, 'strict validation should pass');
    const payload = result.structuredContent;
    assert.ok(payload.products, 'response has products');
    assert.deepStrictEqual(
      payload.products.map(p => p.product_id),
      ['handler-1', 'seed-1', 'seed-2']
    );
    assert.strictEqual(payload.sandbox, true);
  });
});
