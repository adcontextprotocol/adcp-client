// Tests for #1342 — multi-id pass-through contract on
// `getMediaBuyDelivery`. Framework MUST forward `media_buy_ids[]` to the
// platform without truncation; platform owns fan-out + aggregation
// because cross-buy fields (reach, new_to_brand_rate, frequency) are
// platform-domain knowledge.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function buildPlatform(getMediaBuyDeliveryImpl) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async () => ({
        id: 'acc_1',
        name: 'Acme',
        status: 'active',
        ctx_metadata: {},
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: getMediaBuyDeliveryImpl,
    },
  };
}

const SERVER_OPTS = {
  name: 'media-buy-ids-fanout-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
};

describe('#1342 — getMediaBuyDelivery multi-id pass-through', () => {
  it('forwards the full media_buy_ids array to the platform without truncation', async () => {
    let sawIds;
    const platform = buildPlatform(async filter => {
      sawIds = filter.media_buy_ids;
      return {
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: (filter.media_buy_ids ?? []).map(id => ({
          media_buy_id: id,
          impressions: 100,
          spend: 50,
        })),
      };
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buy_delivery',
        arguments: {
          account: { account_id: 'acc_1' },
          media_buy_ids: ['mb_1', 'mb_2', 'mb_3'],
        },
      },
    });
    assert.notStrictEqual(result.isError, true, `expected success, got ${JSON.stringify(result.structuredContent)}`);
    assert.deepStrictEqual(sawIds, ['mb_1', 'mb_2', 'mb_3'], 'platform must see all three ids');
    assert.strictEqual(result.structuredContent.media_buy_deliveries.length, 3);
  });

  it('preserves ordering of media_buy_ids when the platform iterates in order', async () => {
    const platform = buildPlatform(async filter => ({
      reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
      media_buy_deliveries: (filter.media_buy_ids ?? []).map(id => ({
        media_buy_id: id,
        impressions: 0,
        spend: 0,
      })),
    }));
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buy_delivery',
        arguments: {
          account: { account_id: 'acc_1' },
          media_buy_ids: ['mb_z', 'mb_a', 'mb_m'],
        },
      },
    });
    assert.deepStrictEqual(
      result.structuredContent.media_buy_deliveries.map(d => d.media_buy_id),
      ['mb_z', 'mb_a', 'mb_m']
    );
  });

  it('handles single-id requests as a one-element array (no special-case)', async () => {
    let sawIds;
    const platform = buildPlatform(async filter => {
      sawIds = filter.media_buy_ids;
      return {
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: (filter.media_buy_ids ?? []).map(id => ({
          media_buy_id: id,
          impressions: 100,
          spend: 50,
        })),
      };
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buy_delivery',
        arguments: {
          account: { account_id: 'acc_1' },
          media_buy_ids: ['mb_solo'],
        },
      },
    });
    assert.deepStrictEqual(sawIds, ['mb_solo']);
  });

  it('omitted media_buy_ids passes through as undefined (paginated-list contract)', async () => {
    let sawIds = 'sentinel';
    const platform = buildPlatform(async filter => {
      sawIds = filter.media_buy_ids;
      return {
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      };
    });
    const server = createAdcpServerFromPlatform(platform, SERVER_OPTS);
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buy_delivery',
        arguments: {
          account: { account_id: 'acc_1' },
        },
      },
    });
    assert.strictEqual(sawIds, undefined, 'omitted media_buy_ids must reach the platform as undefined');
  });
});
