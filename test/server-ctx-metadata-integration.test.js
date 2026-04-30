process.env.NODE_ENV = "test";

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform, createCtxMetadataStore, memoryCtxMetadataStore } = require('../dist/lib/server');

const SPECIALISMS = ['sales-non-guaranteed'];

function buildPlatform({ getProductsImpl, createMediaBuyImpl }) {
  return {
    capabilities: {
      adcp_version: '3.0.0',
      specialisms: SPECIALISMS,
      pricingModels: ['cpm'],
      channels: ['display'],
      formats: [{ format_id: 'display_300x250' }],
      idempotency: { replay_ttl_seconds: 86400 },
    },
    accounts: {
      resolution: 'derived',
      resolve: async () => ({
        id: 'acct_default',
        operator: 'test',
        ctx_metadata: {},
      }),
      upsert: async () => ({ ok: true, items: [] }),
      list: async () => ({ items: [], nextCursor: null }),
    },
    sales: {
      getProducts: getProductsImpl,
      createMediaBuy: createMediaBuyImpl,
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      getMediaBuyDelivery: async () => ({ deliveries: [] }),
    },
  };
}

describe('createAdcpServerFromPlatform — ctx.ctxMetadata wiring', () => {
  it('ctx.ctxMetadata is undefined when store is not wired', async () => {
    let observedCtxMetadata = 'INITIAL';
    const platform = buildPlatform({
      getProductsImpl: async (params, ctx) => {
        observedCtxMetadata = ctx.ctxMetadata;
        return { products: [] };
      },
      createMediaBuyImpl: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
    });

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'b', promoted_offering: 'o' } },
    });

    assert.equal(observedCtxMetadata, undefined);
  });

  it('ctx.ctxMetadata is bound when store is wired', async () => {
    let accessor;
    const platform = buildPlatform({
      getProductsImpl: async (params, ctx) => {
        accessor = ctx.ctxMetadata;
        return { products: [] };
      },
      createMediaBuyImpl: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
    });

    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'b', promoted_offering: 'o' } },
    });

    assert.notEqual(accessor, undefined);
    assert.equal(typeof accessor.get, 'function');
    assert.equal(typeof accessor.set, 'function');
    assert.equal(typeof accessor.bulkGet, 'function');
    assert.equal(typeof accessor.product, 'function');
    assert.equal(typeof accessor.mediaBuy, 'function');
    assert.equal(typeof accessor.package, 'function');
    assert.equal(typeof accessor.creative, 'function');
  });

  it('ctx.ctxMetadata round-trips a value across two handler calls', async () => {
    let observedFromCreate;
    let getProductsCalled = false;
    let createCalled = false;
    let createCtxMetadata;
    const platform = buildPlatform({
      getProductsImpl: async (params, ctx) => {
        getProductsCalled = true;
        await ctx.ctxMetadata.set('product', 'prod_a', { gam: { ad_unit_ids: ['au_123'] } });
        return { products: [{ product_id: 'prod_a', name: 'A', formats: [], delivery_type: 'guaranteed' }] };
      },
      createMediaBuyImpl: async (params, ctx) => {
        createCalled = true;
        createCtxMetadata = ctx.ctxMetadata;
        if (ctx.ctxMetadata) {
          observedFromCreate = await ctx.ctxMetadata.product('prod_a');
        }
        return { media_buy_id: 'mb_1', status: 'pending_creatives', packages: [] };
      },
    });

    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'b', promoted_offering: 'o' } },
    });

    const createResp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_1',
          packages: [{ buyer_ref: 'pk_1', product_id: 'prod_a' }],
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          budget: { total: 1000, currency: 'USD' },
          idempotency_key: 'idem_test_round_trip_001',
        },
      },
    });
    void createResp;
    assert.equal(getProductsCalled, true, 'getProducts handler should have been invoked');
    assert.equal(createCalled, true, 'createMediaBuy handler should have been invoked');
    assert.notEqual(createCtxMetadata, undefined, 'ctx.ctxMetadata should be bound on createMediaBuy');
    assert.deepEqual(
      observedFromCreate && {
        gam: observedFromCreate.gam,
      },
      { gam: { ad_unit_ids: ['au_123'] } }
    );
  });

  it('ctx.ctxMetadata is account-scoped — same id under different account ids stays separate', async () => {
    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });
    // Simulate two tenants by writing through the store directly
    await ctxMetadata.set('acct_a', 'product', 'prod_shared', { tenant: 'a' });
    await ctxMetadata.set('acct_b', 'product', 'prod_shared', { tenant: 'b' });

    assert.deepEqual(await ctxMetadata.get('acct_a', 'product', 'prod_shared'), { tenant: 'a' });
    assert.deepEqual(await ctxMetadata.get('acct_b', 'product', 'prod_shared'), { tenant: 'b' });
  });
});
