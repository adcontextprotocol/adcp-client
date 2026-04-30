const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createAdcpServerFromPlatform,
  createCtxMetadataStore,
  memoryCtxMetadataStore,
} = require('../dist/lib/server');

function makePlatform({ resolveImpl, getProductsImpl }) {
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
      resolve: resolveImpl,
      upsert: async () => ({ ok: true, items: [] }),
      list: async () => ({ items: [], nextCursor: null }),
    },
    sales: {
      getProducts: getProductsImpl ?? (async () => ({ products: [] })),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      getMediaBuyDelivery: async () => ({ deliveries: [] }),
      getMediaBuys: async () => ({ media_buys: [] }),
    },
  };
}

describe('Account ctx_metadata — round-trip via accounts.resolve', () => {
  it('publisher attaches ctx_metadata on resolve → SDK persists → next request hydrates from store', async () => {
    let resolveCallCount = 0;
    let observedAccountInGetProducts;

    const platform = makePlatform({
      resolveImpl: async () => {
        resolveCallCount++;
        const account = {
          id: 'acct_main',
          name: 'Main Pub',
          status: 'active',
          operator: 'mypub',
          metadata: {},
          authInfo: {},
        };
        // Only the FIRST resolve attaches ctx_metadata — second call simulates
        // a publisher whose accounts.resolve doesn't always include adapter
        // state (e.g., light-weight DB read). SDK should hydrate from store.
        if (resolveCallCount === 1) {
          account.ctx_metadata = { gam: { network_code: '12345', advertiser_id: 'adv_xyz' } };
        }
        return account;
      },
      getProductsImpl: async (req, ctx) => {
        observedAccountInGetProducts = ctx.account;
        return { products: [] };
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

    // First call — publisher returns account with ctx_metadata
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'b', promoted_offering: 'o' } },
    });
    assert.deepEqual(
      observedAccountInGetProducts.ctx_metadata,
      { gam: { network_code: '12345', advertiser_id: 'adv_xyz' } },
      'first call: ctx.account.ctx_metadata reflects publisher return'
    );

    // Second call — publisher returns account WITHOUT ctx_metadata; SDK hydrates from store
    observedAccountInGetProducts = undefined;
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'b2', promoted_offering: 'o2' } },
    });
    assert.deepEqual(
      observedAccountInGetProducts.ctx_metadata,
      { gam: { network_code: '12345', advertiser_id: 'adv_xyz' } },
      'second call: ctx.account.ctx_metadata hydrated from store when publisher omits'
    );
  });

  it('ctx_metadata is NOT in the wire shape projected to buyers', async () => {
    // toWireAccount uses a whitelist projection — ctx_metadata never appears.
    // Validate with list_accounts response shape.
    const platform = makePlatform({
      resolveImpl: async () => ({
        id: 'acct_x',
        name: 'X',
        status: 'active',
        operator: 'mypub',
        metadata: {},
        authInfo: {},
        ctx_metadata: { secret: 'should_not_leak' },
      }),
    });
    // Override accounts.list to return an account with ctx_metadata
    platform.accounts.list = async () => ({
      items: [{
        id: 'acct_x',
        name: 'X',
        status: 'active',
        operator: 'mypub',
        metadata: {},
        authInfo: {},
        ctx_metadata: { secret: 'should_not_leak' },
      }],
      nextCursor: null,
    });

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      validation: { requests: 'off', responses: 'off' },
    });

    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'list_accounts', arguments: {} },
    });
    const body = JSON.stringify(resp.structuredContent ?? resp);
    assert.equal(body.includes('should_not_leak'), false, 'ctx_metadata MUST NOT appear in list_accounts wire response');
    assert.equal(body.includes('ctx_metadata'), false, 'ctx_metadata key MUST NOT appear in any list_accounts wire field');
  });
});
