// Registry pattern for v3 ↔ v2.5 adapter pairs. The dispatch logic in
// SingleAgentClient.adaptRequestForServerVersion / normalizeResponseToV3
// now reads from this registry instead of carrying tool-specific switch
// arms. Test pins the contract:
//
//   1. Every tool that had a switch case before has a registered pair.
//   2. The registered pair's adaptRequest produces the same output as
//      the underlying utils/* helper (no behavior drift).
//   3. The registered pair's normalizeResponse mirrors the previous
//      switch-case routing.
//
// Together these guarantee the registry refactor is a no-op at the
// wire level — same v2.5 output, same v3 normalized response.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { getV3ToV25Adapter, listV3ToV25AdapterTools } = require('../../dist/lib/adapters/v3-to-v2-5');
const { adaptGetProductsRequestForV2, normalizeGetProductsResponse } = require('../../dist/lib/utils/pricing-adapter');
const {
  adaptCreateMediaBuyRequestForV2,
  adaptUpdateMediaBuyRequestForV2,
  normalizeMediaBuyResponse,
} = require('../../dist/lib/utils/creative-adapter');
const { adaptSyncCreativesRequestForV2 } = require('../../dist/lib/utils/sync-creatives-adapter');
const { normalizeFormatsResponse } = require('../../dist/lib/utils/format-renders');
const { normalizePreviewCreativeResponse } = require('../../dist/lib/utils/preview-normalizer');

describe('v3 → v2.5 adapter registry', () => {
  test('registers every tool that had a request adapter or response normalizer', () => {
    const expected = new Set([
      'get_products',
      'create_media_buy',
      'update_media_buy',
      'sync_creatives',
      'list_creative_formats',
      'preview_creative',
    ]);
    const registered = new Set(listV3ToV25AdapterTools());
    for (const tool of expected) {
      assert.ok(registered.has(tool), `${tool} must be registered`);
    }
  });

  test('getV3ToV25Adapter returns undefined for unregistered tools', () => {
    assert.strictEqual(getV3ToV25Adapter('not_a_real_tool'), undefined);
  });

  describe('request-side adapters route to the existing utils/* helpers', () => {
    test('get_products', () => {
      const input = { brief: 'test', buying_mode: 'brief', brand: { domain: 'example.com' } };
      const direct = adaptGetProductsRequestForV2(structuredClone(input));
      const viaRegistry = getV3ToV25Adapter('get_products').adaptRequest(structuredClone(input));
      assert.deepStrictEqual(viaRegistry, direct);
    });

    test('create_media_buy', () => {
      const input = {
        account: { account_id: 'a' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p', budget: 1000, pricing_option_id: 'po' }],
        start_time: 'asap',
        end_time: '2027-12-31T23:59:59Z',
        idempotency_key: '11111111-1111-1111-1111-111111111111',
      };
      const direct = adaptCreateMediaBuyRequestForV2(structuredClone(input));
      const viaRegistry = getV3ToV25Adapter('create_media_buy').adaptRequest(structuredClone(input));
      assert.deepStrictEqual(viaRegistry, direct);
    });

    test('update_media_buy', () => {
      const input = { media_buy_id: 'mb', idempotency_key: '22222222-2222-2222-2222-222222222222' };
      const direct = adaptUpdateMediaBuyRequestForV2(structuredClone(input));
      const viaRegistry = getV3ToV25Adapter('update_media_buy').adaptRequest(structuredClone(input));
      assert.deepStrictEqual(viaRegistry, direct);
    });

    test('sync_creatives', () => {
      const input = {
        account: { account_id: 'a' },
        creatives: [
          {
            creative_id: 'c',
            name: 'C',
            format_id: { agent_url: 'https://example.com', id: 'fmt' },
            assets: { video: { asset_type: 'video', url: 'https://x', width: 1, height: 1, duration_ms: 1 } },
          },
        ],
        idempotency_key: '33333333-3333-3333-3333-333333333333',
      };
      const direct = adaptSyncCreativesRequestForV2(structuredClone(input));
      const viaRegistry = getV3ToV25Adapter('sync_creatives').adaptRequest(structuredClone(input));
      assert.deepStrictEqual(viaRegistry, direct);
    });

    test('list_creative_formats and preview_creative are pass-through on request side', () => {
      const formatsInput = { type: 'video' };
      assert.deepStrictEqual(getV3ToV25Adapter('list_creative_formats').adaptRequest(formatsInput), formatsInput);

      const previewInput = { creative_id: 'c' };
      assert.deepStrictEqual(getV3ToV25Adapter('preview_creative').adaptRequest(previewInput), previewInput);
    });
  });

  describe('response-side normalizers route to the existing utils/* helpers', () => {
    test('get_products', () => {
      const v25Resp = { products: [{ product_id: 'p', name: 'P' }] };
      const direct = normalizeGetProductsResponse(structuredClone(v25Resp));
      const viaRegistry = getV3ToV25Adapter('get_products').normalizeResponse(structuredClone(v25Resp));
      assert.deepStrictEqual(viaRegistry, direct);
    });

    test('create_media_buy', () => {
      const v25Resp = { media_buy_id: 'mb', status: 'completed' };
      const direct = normalizeMediaBuyResponse(structuredClone(v25Resp));
      const viaRegistry = getV3ToV25Adapter('create_media_buy').normalizeResponse(structuredClone(v25Resp));
      assert.deepStrictEqual(viaRegistry, direct);
    });

    test('update_media_buy uses the same media-buy normalizer', () => {
      const v25Resp = { media_buy_id: 'mb', status: 'completed' };
      const direct = normalizeMediaBuyResponse(structuredClone(v25Resp));
      const viaRegistry = getV3ToV25Adapter('update_media_buy').normalizeResponse(structuredClone(v25Resp));
      assert.deepStrictEqual(viaRegistry, direct);
    });

    test('list_creative_formats', () => {
      const v25Resp = { formats: [] };
      const direct = normalizeFormatsResponse(structuredClone(v25Resp));
      const viaRegistry = getV3ToV25Adapter('list_creative_formats').normalizeResponse(structuredClone(v25Resp));
      assert.deepStrictEqual(viaRegistry, direct);
    });

    test('preview_creative', () => {
      const v25Resp = { renders: [] };
      const direct = normalizePreviewCreativeResponse(structuredClone(v25Resp));
      const viaRegistry = getV3ToV25Adapter('preview_creative').normalizeResponse(structuredClone(v25Resp));
      assert.deepStrictEqual(viaRegistry, direct);
    });

    test('sync_creatives has no response normalizer (pass-through)', () => {
      const pair = getV3ToV25Adapter('sync_creatives');
      assert.strictEqual(pair.normalizeResponse, undefined);
    });
  });
});
