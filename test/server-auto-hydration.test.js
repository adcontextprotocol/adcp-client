process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform, createCtxMetadataStore, memoryCtxMetadataStore } = require('../dist/lib/server');

function makePlatform({ getProductsImpl, createMediaBuyImpl, getMediaBuysImpl }) {
  return {
    capabilities: {
      adcp_version: '3.0.0',
      specialisms: ['sales-non-guaranteed'],
      pricingModels: ['cpm'],
      channels: ['display'],
      formats: [{ format_id: 'display_300x250' }],
      idempotency: { replay_ttl_seconds: 86400 },
    },
    accounts: {
      resolution: 'derived',
      resolve: async () => ({ id: 'acct_default', operator: 'test', ctx_metadata: {} }),
      upsert: async () => ({ ok: true, items: [] }),
      list: async () => ({ items: [], nextCursor: null }),
    },
    sales: {
      getProducts: getProductsImpl,
      createMediaBuy: createMediaBuyImpl,
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      getMediaBuyDelivery: async () => ({ deliveries: [] }),
      getMediaBuys: getMediaBuysImpl ?? (async () => ({ media_buys: [] })),
    },
  };
}

describe('createAdcpServerFromPlatform — auto-hydration of products', () => {
  it('createMediaBuy receives req.packages[i].product hydrated from prior getProducts', async () => {
    let observedPackages;
    let getProductsAccountId;

    const platform = makePlatform({
      getProductsImpl: async (req, ctx) => {
        getProductsAccountId = ctx.account?.id;
        return {
          products: [
            {
              product_id: 'prod_a',
              name: 'Sports Display Auction',
              format_ids: [{ id: 'display_300x250' }],
              delivery_type: 'non_guaranteed',
              pricing_options: [{ pricing_option_id: 'po1', model: 'cpm' }],
              ctx_metadata: { gam: { ad_unit_ids: ['au_123'] } },
            },
          ],
        };
      },
      createMediaBuyImpl: async (req, ctx) => {
        observedPackages = req.packages;
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

    // Step 1: getProducts — SDK auto-stores Product wire shape + ctx_metadata
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'sports display', promoted_offering: 'shoes' } },
    });

    // Step 2: createMediaBuy referencing prod_a — SDK auto-hydrates pkg.product
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_auto_hydrate_test',
          packages: [{ buyer_ref: 'pk_1', product_id: 'prod_a' }],
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          budget: { total: 1000, currency: 'USD' },
          idempotency_key: 'idem_auto_hydrate_001',
        },
      },
    });

    assert.ok(observedPackages, 'createMediaBuy should have been invoked');
    assert.equal(observedPackages.length, 1);
    void getProductsAccountId; // captured for diagnostic; assertion below is canonical
    const pkg = observedPackages[0];
    assert.equal(pkg.product_id, 'prod_a', 'wire product_id preserved');
    assert.ok(pkg.product, 'pkg.product should be hydrated by SDK');
    assert.equal(pkg.product.product_id, 'prod_a', 'hydrated product carries product_id');
    assert.equal(pkg.product.name, 'Sports Display Auction', 'hydrated product carries wire fields (name)');
    assert.deepEqual(pkg.product.format_ids, [{ id: 'display_300x250' }], 'hydrated product carries format_ids');
    assert.deepEqual(
      pkg.product.ctx_metadata,
      { gam: { ad_unit_ids: ['au_123'] } },
      'hydrated product carries ctx_metadata blob'
    );
  });

  it('does not hydrate when ctxMetadata store is not wired', async () => {
    let observedPackages;
    const platform = makePlatform({
      getProductsImpl: async () => ({
        products: [
          { product_id: 'prod_a', name: 'A', formats: [], delivery_type: 'guaranteed', ctx_metadata: { x: 1 } },
        ],
      }),
      createMediaBuyImpl: async (req, ctx) => {
        observedPackages = req.packages;
        return { media_buy_id: 'mb_1', status: 'pending_creatives', packages: [] };
      },
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
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_no_store',
          packages: [{ buyer_ref: 'pk_1', product_id: 'prod_a' }],
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          budget: { total: 1000, currency: 'USD' },
          idempotency_key: 'idem_test_no_store_001',
        },
      },
    });

    assert.ok(observedPackages);
    assert.equal(observedPackages[0].product_id, 'prod_a');
    assert.equal(observedPackages[0].product, undefined, 'no hydration when no store');
  });

  it('falls back gracefully when product was never seen by getProducts', async () => {
    let observedPackages;
    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [] }),
      createMediaBuyImpl: async (req, ctx) => {
        observedPackages = req.packages;
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
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_unseen',
          packages: [{ buyer_ref: 'pk_1', product_id: 'prod_unknown' }],
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          budget: { total: 1000, currency: 'USD' },
          idempotency_key: 'idem_test_unseen_001',
        },
      },
    });

    assert.ok(observedPackages);
    assert.equal(observedPackages[0].product_id, 'prod_unknown');
    assert.equal(
      observedPackages[0].product,
      undefined,
      'no hydration for unseen product — publisher falls back to its own DB'
    );
  });

  it('updateMediaBuy receives patch.mediaBuy hydrated from prior getMediaBuys', async () => {
    let observedPatch;

    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [] }),
      createMediaBuyImpl: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      getMediaBuysImpl: async () => ({
        media_buys: [
          {
            media_buy_id: 'mb_hydrate',
            status: 'active',
            packages: [{ package_id: 'pkg_1', status: 'active', ctx_metadata: { gam_line_item_id: 'li_7' } }],
            ctx_metadata: { gam_order_id: 'gam_42' },
          },
        ],
      }),
    });
    platform.sales.updateMediaBuy = async (mediaBuyId, patch, _ctx) => {
      observedPatch = patch;
      return { media_buy_id: mediaBuyId, status: 'active', packages: [] };
    };

    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    // Step 1: getMediaBuys — SDK auto-stores MediaBuy wire shape + ctx_metadata
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_media_buys', arguments: {} },
    });

    // Step 2: updateMediaBuy referencing mb_hydrate — SDK auto-hydrates patch.mediaBuy
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: {
          media_buy_id: 'mb_hydrate',
          idempotency_key: 'idem_update_hydrate_001',
        },
      },
    });

    assert.ok(observedPatch, 'updateMediaBuy should have been invoked');
    assert.equal(observedPatch.media_buy_id, 'mb_hydrate', 'wire media_buy_id preserved');
    assert.ok(observedPatch.mediaBuy, 'patch.mediaBuy should be hydrated by SDK');
    assert.equal(observedPatch.mediaBuy.media_buy_id, 'mb_hydrate', 'hydrated mediaBuy carries media_buy_id');
    assert.equal(observedPatch.mediaBuy.status, 'active', 'hydrated mediaBuy carries wire status');
    assert.deepEqual(
      observedPatch.mediaBuy.ctx_metadata,
      { gam_order_id: 'gam_42' },
      'hydrated mediaBuy carries ctx_metadata blob'
    );
    assert.ok(Array.isArray(observedPatch.mediaBuy.packages), 'hydrated mediaBuy carries packages array');
    assert.equal(
      observedPatch.mediaBuy.packages[0].ctx_metadata?.gam_line_item_id,
      'li_7',
      'package ctx_metadata round-trips'
    );
  });

  it('updateMediaBuy does not hydrate when ctxMetadata store is not wired', async () => {
    let observedPatch;
    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [] }),
      createMediaBuyImpl: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      getMediaBuysImpl: async () => ({
        media_buys: [{ media_buy_id: 'mb_hydrate', status: 'active', ctx_metadata: { x: 1 } }],
      }),
    });
    platform.sales.updateMediaBuy = async (mediaBuyId, patch, _ctx) => {
      observedPatch = patch;
      return { media_buy_id: mediaBuyId, status: 'active', packages: [] };
    };

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_media_buys', arguments: {} },
    });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: { media_buy_id: 'mb_hydrate', idempotency_key: 'idem_update_no_store_001' },
      },
    });

    assert.ok(observedPatch);
    assert.equal(observedPatch.media_buy_id, 'mb_hydrate');
    assert.equal(observedPatch.mediaBuy, undefined, 'no hydration when no store');
  });

  it('updateMediaBuy falls back gracefully when media_buy was never seen', async () => {
    let observedPatch;
    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [] }),
      createMediaBuyImpl: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
    });
    platform.sales.updateMediaBuy = async (mediaBuyId, patch, _ctx) => {
      observedPatch = patch;
      return { media_buy_id: mediaBuyId, status: 'active', packages: [] };
    };

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
      params: {
        name: 'update_media_buy',
        arguments: { media_buy_id: 'mb_unknown', idempotency_key: 'idem_update_unseen_001' },
      },
    });

    assert.ok(observedPatch);
    assert.equal(observedPatch.media_buy_id, 'mb_unknown');
    assert.equal(
      observedPatch.mediaBuy,
      undefined,
      'no hydration for unseen media_buy — publisher falls back to its own DB'
    );
  });

  it('auto-stores media buys returned from getMediaBuys', async () => {
    let storeWasCalledWith;
    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [] }),
      createMediaBuyImpl: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      getMediaBuysImpl: async () => ({
        media_buys: [{ media_buy_id: 'mb_existing', status: 'active', ctx_metadata: { gam_order_id: 'gam_42' } }],
      }),
    });

    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });

    // Patch into the store to observe the auto-store call. Auto-store path
    // uses `setResource` so prior publisher `set()` values aren't clobbered.
    const origSetResource = ctxMetadata.setResource.bind(ctxMetadata);
    ctxMetadata.setResource = async (...args) => {
      storeWasCalledWith = args;
      return origSetResource(...args);
    };

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_media_buys', arguments: {} },
    });

    assert.ok(storeWasCalledWith, 'auto-store called for media_buys');
    // setResource(accountId, kind, id, resource, publisherCtxMetadata)
    assert.equal(storeWasCalledWith[1], 'media_buy');
    assert.equal(storeWasCalledWith[2], 'mb_existing');
    assert.equal(storeWasCalledWith[3].media_buy_id, 'mb_existing', 'resource carries media_buy_id');
    assert.equal(storeWasCalledWith[3].status, 'active', 'resource carries wire status');
    assert.equal(storeWasCalledWith[3].ctx_metadata, undefined, 'ctx_metadata stripped from resource');
    assert.deepEqual(storeWasCalledWith[4], { gam_order_id: 'gam_42' }, 'publisher ctx_metadata passed as 5th arg');
  });
});
