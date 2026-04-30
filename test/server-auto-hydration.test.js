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

// ---------------------------------------------------------------------------
// updateMediaBuy auto-hydration
// ---------------------------------------------------------------------------

function makeSalesPlatformWithUpdate({ createMediaBuyImpl, updateMediaBuyImpl }) {
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
      getProducts: async () => ({ products: [] }),
      createMediaBuy: createMediaBuyImpl,
      updateMediaBuy: updateMediaBuyImpl,
      getMediaBuyDelivery: async () => ({ deliveries: [] }),
      getMediaBuys: async () => ({ media_buys: [] }),
    },
  };
}

describe('createAdcpServerFromPlatform — auto-hydration of media_buy for updateMediaBuy', () => {
  it('updateMediaBuy receives req.media_buy hydrated from prior createMediaBuy', async () => {
    let observedMediaBuy;

    const platform = makeSalesPlatformWithUpdate({
      createMediaBuyImpl: async () => ({
        media_buy_id: 'mb_upd_1',
        status: 'pending_creatives',
        packages: [],
        ctx_metadata: { gam_order_id: 'gam_99' },
      }),
      updateMediaBuyImpl: async (mediaBuyId, patch) => {
        observedMediaBuy = patch.media_buy;
        return { media_buy_id: mediaBuyId, status: 'active', packages: [] };
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

    // Step 1: createMediaBuy — SDK auto-stores the created media_buy
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_upd_test',
          packages: [],
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          budget: { total: 5000, currency: 'USD' },
          idempotency_key: 'idem_create_upd_001',
        },
      },
    });

    // Step 2: updateMediaBuy — SDK auto-hydrates req.media_buy
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: {
          media_buy_id: 'mb_upd_1',
          idempotency_key: 'idem_update_upd_001',
        },
      },
    });

    assert.ok(observedMediaBuy, 'updateMediaBuy should receive hydrated req.media_buy');
    assert.equal(observedMediaBuy.media_buy_id, 'mb_upd_1', 'hydrated media_buy carries media_buy_id');
    assert.equal(observedMediaBuy.status, 'pending_creatives', 'hydrated media_buy carries status');
    assert.deepEqual(
      observedMediaBuy.ctx_metadata,
      { gam_order_id: 'gam_99' },
      'hydrated media_buy carries ctx_metadata'
    );
  });

  it('updateMediaBuy falls back gracefully when media_buy was never stored', async () => {
    let observedMediaBuy;

    const platform = makeSalesPlatformWithUpdate({
      createMediaBuyImpl: async () => ({ media_buy_id: 'mb_other', status: 'active', packages: [] }),
      updateMediaBuyImpl: async (mediaBuyId, patch) => {
        observedMediaBuy = patch.media_buy;
        return { media_buy_id: mediaBuyId, status: 'active', packages: [] };
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
        name: 'update_media_buy',
        arguments: {
          media_buy_id: 'mb_unseen',
          idempotency_key: 'idem_update_unseen_001',
        },
      },
    });

    assert.equal(observedMediaBuy, undefined, 'no hydration for unseen media_buy — publisher falls back to its own DB');
  });
});

// ---------------------------------------------------------------------------
// activateSignal auto-hydration
// ---------------------------------------------------------------------------

function makeSignalsPlatform({ getSignalsImpl, activateSignalImpl }) {
  return {
    capabilities: {
      adcp_version: '3.0.0',
      specialisms: ['signal-marketplace'],
      pricingModels: ['cpm'],
      channels: ['display'],
      formats: [],
      idempotency: { replay_ttl_seconds: 86400 },
    },
    accounts: {
      resolution: 'derived',
      resolve: async () => ({ id: 'acct_signals', operator: 'test', ctx_metadata: {} }),
      upsert: async () => ({ ok: true, items: [] }),
      list: async () => ({ items: [], nextCursor: null }),
    },
    signals: {
      getSignals: getSignalsImpl,
      activateSignal: activateSignalImpl,
    },
  };
}

describe('createAdcpServerFromPlatform — auto-hydration of signal for activateSignal', () => {
  it('activateSignal receives req.signal hydrated from prior getSignals', async () => {
    let observedSignal;

    const platform = makeSignalsPlatform({
      getSignalsImpl: async () => ({
        signals: [
          {
            signal_agent_segment_id: 'seg_sports_fans',
            name: 'Sports Fans 18-34',
            match_rate: 0.72,
            ctx_metadata: { dmp_segment_id: 'dmp_42' },
          },
        ],
      }),
      activateSignalImpl: async req => {
        observedSignal = req.signal;
        return { deployments: [{ platform: 'meta', status: 'pending' }] };
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

    // Step 1: getSignals — SDK auto-stores each signal by signal_agent_segment_id
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_signals',
        arguments: { signal_spec: 'sports fans' },
      },
    });

    // Step 2: activateSignal — SDK auto-hydrates req.signal
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'activate_signal',
        arguments: {
          signal_agent_segment_id: 'seg_sports_fans',
          destinations: [{ platform: 'meta' }],
          idempotency_key: 'idem_activate_001',
        },
      },
    });

    assert.ok(observedSignal, 'activateSignal should receive hydrated req.signal');
    assert.equal(observedSignal.signal_agent_segment_id, 'seg_sports_fans', 'hydrated signal carries segment id');
    assert.equal(observedSignal.name, 'Sports Fans 18-34', 'hydrated signal carries name');
    assert.deepEqual(observedSignal.ctx_metadata, { dmp_segment_id: 'dmp_42' }, 'hydrated signal carries ctx_metadata');
  });

  it('activateSignal falls back gracefully when signal was never seen by getSignals', async () => {
    let observedSignal;

    const platform = makeSignalsPlatform({
      getSignalsImpl: async () => ({ signals: [] }),
      activateSignalImpl: async req => {
        observedSignal = req.signal;
        return { deployments: [] };
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
        name: 'activate_signal',
        arguments: {
          signal_agent_segment_id: 'seg_unknown',
          destinations: [{ platform: 'meta' }],
          idempotency_key: 'idem_activate_unseen_001',
        },
      },
    });

    assert.equal(observedSignal, undefined, 'no hydration for unseen signal — publisher falls back to its own catalog');
  });
});

// ---------------------------------------------------------------------------
// acquireRights auto-hydration
// ---------------------------------------------------------------------------

function makeBrandRightsPlatform({ getBrandIdentityImpl, acquireRightsImpl }) {
  return {
    capabilities: {
      adcp_version: '3.0.0',
      specialisms: ['brand-rights'],
      pricingModels: [],
      channels: [],
      formats: [],
      idempotency: { replay_ttl_seconds: 86400 },
    },
    accounts: {
      resolution: 'derived',
      resolve: async () => ({ id: 'acct_brand', operator: 'test', ctx_metadata: {} }),
      upsert: async () => ({ ok: true, items: [] }),
      list: async () => ({ items: [], nextCursor: null }),
    },
    brandRights: {
      getBrandIdentity: getBrandIdentityImpl,
      getRights: async () => ({ rights: [] }),
      acquireRights: acquireRightsImpl,
    },
  };
}

describe('createAdcpServerFromPlatform — auto-hydration of brand for acquireRights', () => {
  it('acquireRights receives req.brand hydrated from prior getBrandIdentity', async () => {
    let observedBrand;

    const platform = makeBrandRightsPlatform({
      getBrandIdentityImpl: async () => ({
        brand_id: 'acme_outdoor',
        house: { domain: 'acme.example', name: 'Acme Corporation' },
        names: [{ en_US: 'Acme Outdoor' }],
        ctx_metadata: { internal_brand_code: 'ACM-001' },
      }),
      acquireRightsImpl: async req => {
        observedBrand = req.brand;
        return {
          rights_id: 'likeness_commercial_standard',
          status: 'acquired',
          brand_id: 'acme_outdoor',
          terms: { pricing_option_id: 'po1', amount: 2500, currency: 'USD', uses: ['likeness'] },
          rights_constraint: {
            rights_id: 'likeness_commercial_standard',
            rights_agent: { domain: 'acme.example' },
            uses: ['likeness'],
          },
        };
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

    // Step 1: getBrandIdentity — SDK auto-stores the brand by brand_id
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_brand_identity',
        arguments: { brand: { domain: 'acme.example', brand_id: 'acme_outdoor' } },
      },
    });

    // Step 2: acquireRights — SDK auto-hydrates req.brand via buyer.brand_id
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'acquire_rights',
        arguments: {
          rights_id: 'likeness_commercial_standard',
          pricing_option_id: 'po1',
          buyer: { domain: 'buyer.example', brand_id: 'acme_outdoor' },
          campaign: { description: 'Summer campaign', uses: ['likeness'] },
          revocation_webhook: {
            url: 'https://buyer.example/webhooks/revoke',
            authentication: { schemes: ['Bearer'], credentials: 'test-creds-32chars-padded-here-xx' },
          },
          idempotency_key: 'idem_acquire_001',
        },
      },
    });

    assert.ok(observedBrand, 'acquireRights should receive hydrated req.brand');
    assert.equal(observedBrand.brand_id, 'acme_outdoor', 'hydrated brand carries brand_id');
    assert.ok(observedBrand.house, 'hydrated brand carries house');
    assert.deepEqual(
      observedBrand.ctx_metadata,
      { internal_brand_code: 'ACM-001' },
      'hydrated brand carries ctx_metadata'
    );
  });

  it('acquireRights falls back gracefully when brand was never seen by getBrandIdentity', async () => {
    let observedBrand;

    const platform = makeBrandRightsPlatform({
      getBrandIdentityImpl: async () => ({
        brand_id: 'other_brand',
        house: { domain: 'other.example', name: 'Other Corp' },
        names: [{ en_US: 'Other' }],
      }),
      acquireRightsImpl: async req => {
        observedBrand = req.brand;
        return {
          rights_id: 'r1',
          status: 'acquired',
          brand_id: 'acme_outdoor',
          terms: { pricing_option_id: 'po1', amount: 100, currency: 'USD', uses: ['likeness'] },
          rights_constraint: { rights_id: 'r1', rights_agent: { domain: 'other.example' }, uses: ['likeness'] },
        };
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
        name: 'acquire_rights',
        arguments: {
          rights_id: 'likeness_commercial_standard',
          pricing_option_id: 'po1',
          buyer: { domain: 'buyer.example', brand_id: 'acme_outdoor' },
          campaign: { description: 'Summer campaign', uses: ['likeness'] },
          revocation_webhook: {
            url: 'https://buyer.example/webhooks/revoke',
            authentication: { schemes: ['Bearer'], credentials: 'test-creds-32chars-padded-here-xx' },
          },
          idempotency_key: 'idem_acquire_unseen_001',
        },
      },
    });

    assert.equal(observedBrand, undefined, 'no hydration for unseen brand — publisher falls back to its own catalog');
  });
});
