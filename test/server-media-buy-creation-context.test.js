process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createAdcpServerFromPlatform,
  createMediaBuyStore,
  InMemoryStateStore,
} = require('../dist/lib/server/index.js');

function buildPlatform() {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      features: { canonicalCreatives: true },
      config: {},
    },
    accounts: {
      resolve: async ref => ({ id: ref?.account_id ?? 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [], cache_scope: 'account' }),
      updateMediaBuy: async () => ({ media_buy_id: 'context-buy' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
  };
}

describe('media-buy creation context readback', () => {
  for (const asynchronous of [false, true]) {
    it(`retains creation context after ${asynchronous ? 'task completion' : 'synchronous creation'}`, async () => {
      const base = buildPlatform();
      const created = { media_buy_id: 'context-buy', packages: [{ package_id: 'context-package', product_id: 'p1' }] };
      const platform = {
        ...base,
        sales: {
          ...base.sales,
          createMediaBuy: async (_request, ctx) =>
            asynchronous ? ctx.handoffToTask(async () => structuredClone(created)) : structuredClone(created),
          getMediaBuys: async () => ({ media_buys: [structuredClone(created)] }),
        },
      };
      const server = createAdcpServerFromPlatform(platform, {
        name: 'creation-context',
        version: '1.0.0',
        validation: { requests: 'off', responses: 'off' },
        mediaBuyStore: createMediaBuyStore({ store: new InMemoryStateStore() }),
      });
      const createContext = { campaign: 'original', optional: null };
      const packageContext = { line: 'original', nested: { optional: null } };
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'create_media_buy',
          arguments: {
            account: { account_id: 'acc_1' },
            idempotency_key: `creation-context-${asynchronous}`,
            context: createContext,
            packages: [{ product_id: 'p1', pricing_option_id: 'cpm', budget: 100, context: packageContext }],
          },
        },
      });
      assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
      if (asynchronous) {
        assert.strictEqual(result.structuredContent.status, 'submitted');
        await server.awaitTaskUnsafe(result.structuredContent.task_id);
        const task = await server.getTaskState(result.structuredContent.task_id, {
          accountId: 'acc_1',
          ownerScope: 'account:acc_1',
        });
        assert.strictEqual(task.status, 'completed');
      }
      const readContext = { operation: 'read', optional: null };
      const read = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'get_media_buys',
          arguments: { account: { account_id: 'acc_1' }, context: readContext },
        },
      });
      assert.notStrictEqual(read.isError, true, JSON.stringify(read.structuredContent));
      assert.deepStrictEqual(read.structuredContent.context, readContext);
      assert.deepStrictEqual(read.structuredContent.media_buys[0].context, createContext);
      assert.deepStrictEqual(read.structuredContent.media_buys[0].packages[0].context, packageContext);
    });
  }
});
