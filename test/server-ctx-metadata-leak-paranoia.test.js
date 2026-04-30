const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createAdcpServerFromPlatform,
  createCtxMetadataStore,
  memoryCtxMetadataStore,
  hasCtxMetadata,
} = require('../dist/lib/server');

/**
 * Leak paranoia — comprehensive negative test.
 *
 * Build a platform that returns ctx_metadata on EVERY resource at EVERY
 * nesting level, dispatch every mutating + read tool, assert no buyer-
 * facing wire payload contains 'ctx_metadata' anywhere.
 *
 * Strip is enforced at multiple layers:
 *   - Compile-time: `WireShape<T>` type
 *   - Runtime: `stripCtxMetadata` shallow walk on response builders
 *   - Idempotency cache: replay payloads must be stripped BEFORE caching
 *   - Symbol tag: retrieved blobs carry `[ADCP_INTERNAL_TAG]` (won't survive JSON.stringify)
 *
 * This test asserts the runtime invariant across every tool's wire response.
 */

function makeLeakHostilePlatform(ctxMetadata) {
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
      resolve: async () => ({
        id: 'pub_main',
        name: 'Pub',
        status: 'active',
        operator: 'mypub',
        ctx_metadata: { internal: 'should not leak via metadata either' },
        authInfo: {},
      }),
      upsert: async (refs) => refs.map((r) => ({
        account_id: r.account_id ?? 'acct_x',
        name: 'X',
        status: 'active',
        operator: 'mypub',
        ctx_metadata: { LEAK_CANARY_account: 'must_not_appear_on_wire' },
      })),
      list: async () => ({
        items: [{
          id: 'pub_main',
          name: 'Pub',
          status: 'active',
          operator: 'mypub',
          ctx_metadata: { internal: 'no leak' },
          authInfo: {},
        }],
        nextCursor: null,
      }),
    },
    sales: {
      getProducts: async () => ({
        products: [{
          product_id: 'prod_a',
          name: 'A',
          description: 'A',
          format_ids: [{ id: 'display_300x250', agent_url: 'http://127.0.0.1:0/mcp' }],
          delivery_type: 'non_guaranteed',
          publisher_properties: [{ publisher_domain: 'pub.example', selection_type: 'all' }],
          pricing_options: [{ pricing_option_id: 'po1', pricing_model: 'cpm', currency: 'USD' }],
          reporting_capabilities: { available_metrics: ['impressions'] },
          ctx_metadata: { LEAK_CANARY_product: 'must_not_appear_on_wire' },
        }],
      }),
      createMediaBuy: async () => ({
        media_buy_id: 'mb_1',
        status: 'pending_creatives',
        ctx_metadata: { LEAK_CANARY_media_buy: 'must_not_appear_on_wire' },
        packages: [{
          package_id: 'pkg_1',
          status: 'pending_creatives',
          ctx_metadata: { LEAK_CANARY_package: 'must_not_appear_on_wire' },
        }],
      }),
      updateMediaBuy: async () => ({
        media_buy_id: 'mb_1',
        status: 'active',
        ctx_metadata: { LEAK_CANARY_update_buy: 'must_not_appear_on_wire' },
        packages: [{
          package_id: 'pkg_1',
          status: 'active',
          ctx_metadata: { LEAK_CANARY_update_pkg: 'must_not_appear_on_wire' },
        }],
      }),
      getMediaBuyDelivery: async () => ({
        deliveries: [{
          media_buy_id: 'mb_1',
          ctx_metadata: { LEAK_CANARY_delivery: 'must_not_appear_on_wire' },
        }],
      }),
      getMediaBuys: async () => ({
        media_buys: [{
          media_buy_id: 'mb_1',
          status: 'active',
          ctx_metadata: { LEAK_CANARY_get_media_buys: 'must_not_appear_on_wire' },
          packages: [{
            package_id: 'pkg_1',
            status: 'active',
            ctx_metadata: { LEAK_CANARY_nested_pkg: 'must_not_appear_on_wire' },
          }],
        }],
      }),
      syncCreatives: async (creatives) => creatives.map((c) => ({
        creative_id: c.creative_id ?? 'cr_1',
        action: 'created',
        status: 'approved',
        ctx_metadata: { LEAK_CANARY_creative: 'must_not_appear_on_wire' },
      })),
    },
  };
}

function assertNoLeak(payload, where) {
  const serialized = JSON.stringify(payload);
  assert.equal(
    serialized.includes('LEAK_CANARY'),
    false,
    `LEAK detected in ${where}: payload contained LEAK_CANARY string`
  );
  assert.equal(
    hasCtxMetadata(payload),
    false,
    `LEAK detected in ${where}: hasCtxMetadata returned true`
  );
  // Defensive: regex for raw 'ctx_metadata' string anywhere in the JSON
  assert.equal(
    /["']ctx_metadata["']\s*:/.test(serialized),
    false,
    `LEAK detected in ${where}: 'ctx_metadata' key appeared in serialized payload`
  );
}

describe('ctx_metadata leak paranoia — every wire response is clean', () => {
  it('get_products', async () => {
    const ctxMetadata = createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) });
    const server = createAdcpServerFromPlatform(makeLeakHostilePlatform(ctxMetadata), {
      name: 'leak', version: '1.0.0', ctxMetadata, validation: { requests: 'off', responses: 'off' },
    });
    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'b', promoted_offering: 'o' } },
    });
    assertNoLeak(resp, 'get_products response');
  });

  it('create_media_buy', async () => {
    const ctxMetadata = createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) });
    const server = createAdcpServerFromPlatform(makeLeakHostilePlatform(ctxMetadata), {
      name: 'leak', version: '1.0.0', ctxMetadata, validation: { requests: 'off', responses: 'off' },
    });
    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_leak',
          packages: [{ buyer_ref: 'pk_1', product_id: 'prod_a' }],
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          budget: { total: 1000, currency: 'USD' },
          idempotency_key: 'idem_leak_create_001',
        },
      },
    });
    assertNoLeak(resp, 'create_media_buy response');
  });

  it('update_media_buy', async () => {
    const ctxMetadata = createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) });
    const server = createAdcpServerFromPlatform(makeLeakHostilePlatform(ctxMetadata), {
      name: 'leak', version: '1.0.0', ctxMetadata, validation: { requests: 'off', responses: 'off' },
    });
    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: {
          media_buy_id: 'mb_1',
          packages: [{ package_id: 'pkg_1', impressions: 1000 }],
          idempotency_key: 'idem_leak_update_001',
        },
      },
    });
    assertNoLeak(resp, 'update_media_buy response');
  });

  it('get_media_buys', async () => {
    const ctxMetadata = createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) });
    const server = createAdcpServerFromPlatform(makeLeakHostilePlatform(ctxMetadata), {
      name: 'leak', version: '1.0.0', ctxMetadata, validation: { requests: 'off', responses: 'off' },
    });
    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_media_buys', arguments: {} },
    });
    assertNoLeak(resp, 'get_media_buys response');
  });

  it('get_media_buy_delivery', async () => {
    const ctxMetadata = createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) });
    const server = createAdcpServerFromPlatform(makeLeakHostilePlatform(ctxMetadata), {
      name: 'leak', version: '1.0.0', ctxMetadata, validation: { requests: 'off', responses: 'off' },
    });
    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_media_buy_delivery', arguments: { media_buy_ids: ['mb_1'] } },
    });
    assertNoLeak(resp, 'get_media_buy_delivery response');
  });

  it('sync_creatives', async () => {
    const ctxMetadata = createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) });
    const server = createAdcpServerFromPlatform(makeLeakHostilePlatform(ctxMetadata), {
      name: 'leak', version: '1.0.0', ctxMetadata, validation: { requests: 'off', responses: 'off' },
    });
    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          creatives: [{
            creative_id: 'cr_1',
            format_ids: [{ id: 'display_300x250', agent_url: 'http://127.0.0.1:0/mcp' }],
            assets: [],
          }],
          idempotency_key: 'idem_leak_sync_001',
        },
      },
    });
    assertNoLeak(resp, 'sync_creatives response');
  });

  it('sync_accounts', async () => {
    const ctxMetadata = createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) });
    const server = createAdcpServerFromPlatform(makeLeakHostilePlatform(ctxMetadata), {
      name: 'leak', version: '1.0.0', ctxMetadata, validation: { requests: 'off', responses: 'off' },
    });
    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          accounts: [{ account_id: 'acct_x' }],
          idempotency_key: 'idem_leak_sync_acct_01',
        },
      },
    });
    assertNoLeak(resp, 'sync_accounts response');
  });

  it('list_accounts', async () => {
    const ctxMetadata = createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) });
    const server = createAdcpServerFromPlatform(makeLeakHostilePlatform(ctxMetadata), {
      name: 'leak', version: '1.0.0', ctxMetadata, validation: { requests: 'off', responses: 'off' },
    });
    const resp = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'list_accounts', arguments: {} },
    });
    assertNoLeak(resp, 'list_accounts response');
  });

  it('idempotency replay does not leak ctx_metadata', async () => {
    // First call writes the cache; second call with the same idempotency_key
    // should replay the cached response. Both must be ctx_metadata-clean.
    const ctxMetadata = createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) });
    const server = createAdcpServerFromPlatform(makeLeakHostilePlatform(ctxMetadata), {
      name: 'leak', version: '1.0.0', ctxMetadata, validation: { requests: 'off', responses: 'off' },
    });
    const args = {
      buyer_ref: 'br_replay',
      packages: [{ buyer_ref: 'pk_1', product_id: 'prod_a' }],
      start_time: '2026-01-01T00:00:00Z',
      end_time: '2026-01-08T00:00:00Z',
      budget: { total: 1000, currency: 'USD' },
      idempotency_key: 'idem_leak_replay_canary_001',
    };
    const first = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'create_media_buy', arguments: args },
    });
    assertNoLeak(first, 'create_media_buy first call');
    const second = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'create_media_buy', arguments: args },
    });
    assertNoLeak(second, 'create_media_buy idempotency replay');
  });
});
