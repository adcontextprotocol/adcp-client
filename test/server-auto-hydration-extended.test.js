process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform, createCtxMetadataStore, memoryCtxMetadataStore } = require('../dist/lib/server/legacy/v5');

function makeBasePlatform(overrides = {}) {
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
      createMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      getMediaBuyDelivery: async () => ({ deliveries: [] }),
      getMediaBuys: async () => ({ media_buys: [] }),
      ...overrides,
    },
  };
}

function makeStore() {
  return createCtxMetadataStore({
    backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
  });
}

describe('auto-hydration — update_media_buy', () => {
  it('updateMediaBuy receives req.media_buy hydrated from prior getMediaBuys', async () => {
    let observedReq;
    const platform = makeBasePlatform({
      getMediaBuys: async () => ({
        media_buys: [{ media_buy_id: 'mb_42', status: 'active', ctx_metadata: { gam: { order_id: '12345' } } }],
      }),
      updateMediaBuy: async (id, params, ctx) => {
        observedReq = params;
        return { media_buy_id: id, status: 'paused', packages: [] };
      },
    });

    const ctxMetadata = makeStore();
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

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: {
          media_buy_id: 'mb_42',
          paused: true,
          idempotency_key: 'idem_update_001_aaaaaaaa',
        },
      },
    });

    assert.ok(observedReq, 'updateMediaBuy was called');
    assert.ok(observedReq.media_buy, 'req.media_buy hydrated');
    assert.equal(observedReq.media_buy.media_buy_id, 'mb_42');
    assert.equal(observedReq.media_buy.status, 'active');
    assert.deepEqual(observedReq.media_buy.ctx_metadata, { gam: { order_id: '12345' } }, 'ctx_metadata round-tripped');

    // Leak prevention: hydrated field is non-enumerable so accidental
    // serialization (JSON.stringify, spread, Object.entries) does NOT
    // carry the publisher's ctx_metadata blob into request-side log
    // sinks. Direct property access (used above) still works.
    assert.equal(
      Object.keys(observedReq).includes('media_buy'),
      false,
      'hydrated field is non-enumerable — invisible to Object.keys'
    );
    assert.equal(
      JSON.stringify(observedReq).includes('"media_buy"'),
      false,
      'hydrated field does not appear in JSON.stringify output'
    );
    assert.equal(
      JSON.stringify(observedReq).includes('order_id'),
      false,
      'publisher ctx_metadata does not leak via accidental serialization'
    );
    assert.equal(
      observedReq.media_buy.__adcp_hydrated__,
      true,
      'hydrated objects carry __adcp_hydrated__ marker so middleware can disambiguate'
    );
  });

  it('error contract: hydration miss → handler runs un-hydrated, NOT a framework-thrown NOT_FOUND', async () => {
    // Pins the documented contract: the framework cache is a hint, not the
    // source of truth. A miss means "publisher's DB decides whether the id
    // exists" — NOT "framework rejects with PRODUCT_NOT_FOUND / MEDIA_BUY_NOT_FOUND".
    // Adopters who want strict existence checks implement them in the handler.
    let handlerCalled = false;
    let observedReq;
    const platform = makeBasePlatform({
      updateMediaBuy: async (id, params, ctx) => {
        handlerCalled = true;
        observedReq = params;
        return { media_buy_id: id, status: 'paused', packages: [] };
      },
    });

    const ctxMetadata = makeStore();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: {
          media_buy_id: 'mb_unseen',
          paused: true,
          idempotency_key: 'idem_unseen_001_aaaaaaaa',
        },
      },
    });

    assert.equal(handlerCalled, true, 'CONTRACT: hydration miss does NOT block the handler');
    assert.equal(observedReq.media_buy, undefined, 'CONTRACT: req.media_buy is undefined on miss');
    // Response should be whatever the handler returned — NOT a framework
    // not-found error. Adopters opt into strict checks in their handler.
    assert.equal(resp.isError, undefined, 'CONTRACT: framework does not synthesize an error on hydration miss');
  });
});

describe('auto-hydration — provide_performance_feedback', () => {
  it('hydrates req.media_buy and req.creative when both ids referenced', async () => {
    let observedReq;
    const platform = makeBasePlatform({
      getMediaBuys: async () => ({
        media_buys: [{ media_buy_id: 'mb_perf', status: 'active', ctx_metadata: { campaign: 'c1' } }],
      }),
      providePerformanceFeedback: async (params, ctx) => {
        observedReq = params;
        return { feedback_id: 'fb_1' };
      },
    });

    const ctxMetadata = makeStore();
    // Pre-seed creative store via direct setResource (no syncCreatives in this minimal setup)
    await ctxMetadata.setResource(
      'acct_default',
      'creative',
      'cr_99',
      {
        creative_id: 'cr_99',
        status: 'approved',
      },
      { dsp_creative_id: 'dsp_555' }
    );

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

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'provide_performance_feedback',
        arguments: {
          media_buy_id: 'mb_perf',
          creative_id: 'cr_99',
          measurement_period: { start: '2026-04-01T00:00:00Z', end: '2026-04-30T00:00:00Z' },
          performance_index: 1.2,
          idempotency_key: 'idem_perf_001_aaaaaaaaa',
        },
      },
    });

    assert.ok(observedReq, 'feedback handler called');
    assert.ok(observedReq.media_buy, 'req.media_buy hydrated');
    assert.equal(observedReq.media_buy.media_buy_id, 'mb_perf');
    assert.deepEqual(observedReq.media_buy.ctx_metadata, { campaign: 'c1' });
    assert.ok(observedReq.creative, 'req.creative hydrated');
    assert.equal(observedReq.creative.creative_id, 'cr_99');
    assert.deepEqual(observedReq.creative.ctx_metadata, { dsp_creative_id: 'dsp_555' });
  });

  it('skips creative hydration when creative_id absent', async () => {
    let observedReq;
    const platform = makeBasePlatform({
      providePerformanceFeedback: async (params, ctx) => {
        observedReq = params;
        return { feedback_id: 'fb_1' };
      },
    });

    const ctxMetadata = makeStore();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'provide_performance_feedback',
        arguments: {
          media_buy_id: 'mb_unseen',
          measurement_period: { start: '2026-04-01T00:00:00Z', end: '2026-04-30T00:00:00Z' },
          performance_index: 1.0,
          idempotency_key: 'idem_perf_002_aaaaaaaaa',
        },
      },
    });

    assert.ok(observedReq);
    assert.equal(observedReq.creative, undefined, 'no creative hydration without creative_id');
  });
});

describe('auto-hydration — activate_signal', () => {
  it('activateSignal receives req.signal hydrated from prior getSignals', async () => {
    let observedReq;
    const signalsImpl = {
      getSignals: async () => ({
        signals: [
          {
            signal_agent_segment_id: 'seg_abc',
            name: 'Sports Fans',
            ctx_metadata: { ttl_days: 30, taxonomy: 'iab-1' },
          },
        ],
      }),
      activateSignal: async (params, ctx) => {
        observedReq = params;
        return { decisioning_platform_segment_id: 'dsp_seg_abc', estimated_activation_duration_minutes: 5 };
      },
    };

    const platform = {
      ...makeBasePlatform(),
      capabilities: {
        adcp_version: '3.0.0',
        specialisms: ['signal-marketplace'],
        pricingModels: ['cpm'],
        channels: ['display'],
        formats: [{ format_id: 'display_300x250' }],
        idempotency: { replay_ttl_seconds: 86400 },
      },
      signals: signalsImpl,
    };

    const ctxMetadata = makeStore();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_signals', arguments: { signal_spec: 'sports', deliver_to: { platforms: 'all' } } },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'activate_signal',
        arguments: {
          signal_agent_segment_id: 'seg_abc',
          destinations: [{ platform: 'gam' }],
          idempotency_key: 'idem_activate_001_aaaaaa',
        },
      },
    });

    assert.ok(observedReq, 'activateSignal called');
    assert.ok(observedReq.signal, 'req.signal hydrated');
    assert.equal(observedReq.signal.signal_agent_segment_id, 'seg_abc');
    assert.equal(observedReq.signal.name, 'Sports Fans');
    assert.deepEqual(observedReq.signal.ctx_metadata, { ttl_days: 30, taxonomy: 'iab-1' });
  });
});

describe('auto-hydration — acquire_rights', () => {
  it('acquireRights receives req.rights hydrated from prior getRights', async () => {
    let observedReq;
    const brandRightsImpl = {
      getBrandIdentity: async () => ({ brand_id: 'b1', display_name: 'Acme' }),
      getRights: async () => ({
        rights: [
          {
            rights_id: 'rt_001',
            ctx_metadata: { license_type: 'commercial', territory: 'US' },
          },
        ],
      }),
      acquireRights: async (params, ctx) => {
        observedReq = params;
        return {
          rights_id: 'rt_001',
          status: 'acquired',
          brand_id: 'b1',
          terms: 'standard',
          generation_credentials: [],
          rights_constraint: {},
        };
      },
    };

    const platform = {
      ...makeBasePlatform(),
      capabilities: {
        adcp_version: '3.0.0',
        specialisms: ['brand-rights'],
        pricingModels: ['cpm'],
        channels: ['display'],
        formats: [{ format_id: 'display_300x250' }],
        idempotency: { replay_ttl_seconds: 86400 },
      },
      brandRights: brandRightsImpl,
    };

    const ctxMetadata = makeStore();
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_rights', arguments: { brand: { brand_id: 'b1' } } },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'acquire_rights',
        arguments: {
          rights_id: 'rt_001',
          pricing_option_id: 'po_basic',
          buyer: { brand_id: 'b1' },
          campaign: { description: 'Q2 launch', uses: ['display_ads'] },
          idempotency_key: 'idem_acquire_001_aaaaaaa',
        },
      },
    });

    assert.ok(observedReq, 'acquireRights called');
    assert.ok(observedReq.rights, 'req.rights hydrated');
    assert.equal(observedReq.rights.rights_id, 'rt_001');
    assert.deepEqual(observedReq.rights.ctx_metadata, { license_type: 'commercial', territory: 'US' });
  });
});
