process.env.NODE_ENV = 'test';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { LIBRARY_VERSION } = require('../dist/lib/version');
const { isAdcpOperationSuccess } = require('../dist/lib/utils/response-unwrapper');

const ref = id => ({ agent_url: 'https://creative.adcontextprotocol.org/', id });
const mrec = ref('display_300x250_image');
const leaderboard = ref('display_728x90_image');
const product = (id, extra = {}) => ({
  product_id: id,
  name: id,
  description: id,
  delivery_type: 'non_guaranteed',
  publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
  pricing_options: [{ pricing_option_id: 'cpm-1', pricing_model: 'cpm', rate: 5, currency: 'USD' }],
  reporting_capabilities: {
    available_reporting_frequencies: ['daily'],
    expected_delay_minutes: 60,
    timezone: 'UTC',
    supports_webhooks: false,
    available_metrics: ['impressions'],
    date_range_support: 'date_range',
  },
  format_options: [{ format_kind: 'image', params: { width: 300, height: 250 }, v1_format_ref: [mrec] }],
  ...extra,
});
async function dispatch(response, version = '3.1.31', request = {}, responseValidation = 'off') {
  const platform = {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      features: { canonicalCreatives: true },
      config: {},
    },
    accounts: {
      resolve: async () => ({ id: 'a1', metadata: {}, authInfo: { kind: 'api_key' } }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ cache_scope: 'account', ...response }),
      createMediaBuy: async () => ({ media_buy_id: 'mb1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
  };
  const server = createAdcpServerFromPlatform(platform, {
    name: 'format-divergence',
    version: '1.0.0',
    adcpVersion: version,
    validation: { requests: 'off', responses: responseValidation },
  });
  const result = await server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'get_products',
      arguments: { account: { account_id: 'a1' }, buying_mode: 'wholesale', ...request },
    },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}
function advisory(response) {
  return (response.errors ?? []).filter(error => error.code === 'FORMAT_DECLARATION_DIVERGENT');
}
describe('get_products format divergence is non-fatal (#3685)', () => {
  it('keeps both products, prefers canonical declarations and preserves unrelated errors', async () => {
    const response = {
      cache_scope: 'account',
      products: [product('good'), product('bad', { format_ids: [leaderboard] })],
      errors: [{ code: 'CUSTOM_WARNING', message: 'Existing warning' }],
    };
    const before = structuredClone(response);
    const result = await dispatch(response);
    assert.deepEqual(
      result.products.map(p => p.product_id),
      ['good', 'bad']
    );
    assert.equal(isAdcpOperationSuccess(result, 'get_products'), true);
    assert.deepEqual(result.products[1].format_options[0].params, { width: 300, height: 250 });
    assert.deepEqual(result.products[1].format_ids, [mrec]);
    assert.equal(result.errors[0].message, 'Existing warning');
    const errors = advisory(result);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].field, 'products[1]');
    assert.equal(errors[0].source, 'sdk');
    assert.equal(errors[0].sdk_id, `@adcp/sdk@${LIBRARY_VERSION}`);
    assert.equal(errors[0].details.product_id, 'bad');
    assert.deepEqual(errors[0].details.format_ids, [leaderboard]);
    assert.ok(errors[0].details.format_options_summary.length);
    assert.equal(errors[0].details.divergence_reason, 'reference_set_mismatch');
    assert.deepEqual(response, before);
  });
  for (const [kind, params, reason] of [
    ['video_hosted', { width: 300, height: 250 }, 'kind_mismatch'],
    ['image', { width: 728, height: 90 }, 'params_mismatch'],
  ]) {
    it(`removes a contradictory legacy route for ${reason}`, async () => {
      const response = {
        products: [
          product('bad', {
            format_ids: [mrec],
            format_options: [{ format_kind: kind, params, v1_format_ref: [mrec] }],
          }),
        ],
      };
      const result = await dispatch(response);
      assert.equal(result.products[0].format_options[0].format_kind, kind);
      assert.deepEqual(result.products[0].format_options[0].params, params);
      assert.equal(result.products[0].format_options[0].v1_format_ref, undefined);
      assert.equal(result.products[0].format_ids, undefined);
      assert.ok(advisory(result)[0].details.divergence_reason.includes(reason));
    });
  }
  it('keeps an earlier-hop advisory for the same product instead of duplicating it', async () => {
    const previous = {
      code: 'FORMAT_DECLARATION_DIVERGENT',
      field: 'products[0]',
      source: 'sdk',
      sdk_id: 'upstream@1',
      message: 'Already detected',
      details: { product_id: 'bad' },
    };
    const result = await dispatch({ products: [product('bad', { format_ids: [leaderboard] })], errors: [previous] });
    assert.deepEqual(advisory(result), [previous]);
  });
  it('preserves a schema-valid 3.1 response with strict response validation', async () => {
    const result = await dispatch(
      { products: [product('bad', { format_ids: [leaderboard] })] },
      '3.1.31',
      {},
      'strict'
    );
    assert.equal(result.products.length, 1);
    assert.equal(advisory(result).length, 1);
    assert.deepEqual(advisory(result)[0].details.format_ids, [leaderboard]);
  });
  it('does not warn for aligned declarations', async () => {
    const result = await dispatch({ products: [product('aligned', { format_ids: [mrec] })] });
    assert.deepEqual(advisory(result), []);
    assert.deepEqual(result.products[0].format_ids, [mrec]);
  });
  it('retains safe legacy 3.0 delivery and the advisory', async () => {
    const result = await dispatch({ products: [product('bad', { format_ids: [leaderboard] })] }, '3.0.25');
    assert.equal(result.products.length, 1);
    assert.deepEqual(result.products[0].format_ids, [mrec]);
    assert.equal(advisory(result).length, 1);
  });
  it('reports nested placement divergence at its own field', async () => {
    const result = await dispatch({
      products: [
        product('outer', {
          placements: [
            {
              placement_id: 'placement-1',
              format_ids: [leaderboard],
              format_options: [{ format_kind: 'image', params: { width: 300, height: 250 }, v1_format_ref: [mrec] }],
            },
          ],
        }),
      ],
    });
    assert.equal(advisory(result)[0].field, 'products[0].placements[0]');
    assert.equal(advisory(result)[0].details.product_id, 'outer');
    assert.equal(advisory(result)[0].details.placement_id, 'placement-1');
  });
  it('remaps the advisory after an earlier canonical-only product is omitted from a 3.0 response', async () => {
    const result = await dispatch(
      {
        products: [
          product('omitted', { format_options: [{ format_kind: 'responsive_creative', params: {} }] }),
          product('divergent', { format_ids: [leaderboard] }),
        ],
      },
      '3.0.25'
    );
    assert.deepEqual(
      result.products.map(p => p.product_id),
      ['divergent']
    );
    assert.equal(advisory(result)[0].field, 'products[0]');
    assert.equal(advisory(result)[0].details.product_id, 'divergent');
    assert.deepEqual(advisory(result)[0].details.format_ids, [leaderboard]);
  });
  it('points at the collection when the divergent product itself is omitted from a 3.0 response', async () => {
    const result = await dispatch(
      {
        products: [
          product('good'),
          product('omitted', {
            format_ids: [mrec],
            format_options: [{ format_kind: 'responsive_creative', params: {} }],
          }),
        ],
      },
      '3.0.25'
    );
    assert.deepEqual(
      result.products.map(p => p.product_id),
      ['good']
    );
    assert.equal(advisory(result)[0].field, 'products');
    assert.equal(advisory(result)[0].details.product_id, 'omitted');
  });
});
