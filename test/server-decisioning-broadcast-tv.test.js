// Integration test for the BroadcastTvSeller worked example.
// Exercises HITL `*Task` dispatch end-to-end + post-acceptance status
// change channel via publishStatusChange.
//
// The platform shape is inlined here (mirroring the .ts example file) so
// the test stays in pure CJS and avoids tsImport bootstrap. The example
// at examples/decisioning-platform-broadcast-tv.ts is the canonical
// reference; this test mirrors it.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');
const {
  setStatusChangeBus,
  createInMemoryStatusChangeBus,
  publishStatusChange,
} = require('../dist/lib/server/decisioning/status-changes');

function makeBroadcastTvSeller({
  affiliateId = 'WCBS',
  trafficReviewMs = 30,
  standardsReviewMs = 20,
  activationOffsetMs = 30,
} = {}) {
  const mediaBuys = new Map();
  const config = { affiliateId, trafficReviewMs, standardsReviewMs, activationOffsetMs };

  return {
    capabilities: {
      specialisms: ['sales-broadcast-tv'],
      creative_agents: [{ agent_url: 'https://example.com/broadcast-creative-agent/mcp' }],
      channels: ['video'],
      pricingModels: ['cpm'],
      config,
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'broadcast_acc_1',
        operator: 'broadcast.example.com',
        metadata: { agency_buyer_id: 'agc_42', affiliate_advertiser_id: 'aff_99' },
        authInfo: { kind: 'api_key' },
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    sales: {
      getProducts: async req => {
        const promotedOffering = req?.promoted_offering ?? '';
        if (/political|cannabis|gambling/i.test(promotedOffering)) {
          throw new AdcpError('POLICY_VIOLATION', {
            recovery: 'terminal',
            message: 'Affiliate does not carry this category',
            field: 'promoted_offering',
          });
        }
        return {
          products: [
            {
              product_id: 'prod_primetime_30s',
              name: 'Primetime 30s',
              description: 'Local broadcast primetime',
              format_ids: [{ id: 'video_30s', agent_url: 'https://example.com/c/mcp' }],
              delivery_type: 'guaranteed',
              publisher_properties: { reportable: true },
              reporting_capabilities: { available_dimensions: ['daypart'] },
              pricing_options: [{ pricing_model: 'cpm', rate: 42, currency: 'USD' }],
            },
          ],
        };
      },

      createMediaBuyTask: async (req) => {
        const totalBudget = typeof req.total_budget === 'number' ? req.total_budget : (req.total_budget?.amount ?? 0);
        if (totalBudget < 5000) {
          throw new AdcpError('BUDGET_TOO_LOW', {
            recovery: 'correctable',
            message: 'Broadcast minimum is $5,000 per IO',
            field: 'total_budget',
          });
        }
        await new Promise(r => setTimeout(r, config.trafficReviewMs));
        const buyId = `mb_${config.affiliateId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const buy = { media_buy_id: buyId, status: 'pending_start', daypart: 'primetime' };
        mediaBuys.set(buyId, buy);

        const accountId = req?.account?.account_id ?? 'broadcast_acc_1';
        setTimeout(() => {
          buy.status = 'active';
          publishStatusChange({
            account_id: accountId,
            resource_type: 'media_buy',
            resource_id: buyId,
            payload: { status: 'active', activated_at: new Date().toISOString() },
          });
        }, config.activationOffsetMs).unref?.();

        return buy;
      },

      updateMediaBuy: async (buyId, patch) => {
        const existing = mediaBuys.get(buyId);
        if (!existing) {
          throw new AdcpError('MEDIA_BUY_NOT_FOUND', {
            recovery: 'terminal',
            message: `media buy ${buyId} not found`,
            field: 'media_buy_id',
          });
        }
        if (patch.active === false) existing.status = 'rejected';
        return existing;
      },

      syncCreativesTask: async (creatives) => {
        await new Promise(r => setTimeout(r, config.standardsReviewMs));
        return creatives.map(c => {
          const id = c.creative_id ?? `cr_${Math.random()}`;
          const tags = (c.tags ?? []).map(t => t.toLowerCase());
          if (tags.includes('political')) {
            return {
              creative_id: id,
              action: 'failed',
              status: 'rejected',
              errors: [{ code: 'CREATIVE_REJECTED', message: 'FCC + station GM sign-off required' }],
            };
          }
          return { creative_id: id, action: 'created', status: 'approved' };
        });
      },

      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buys: [],
      }),
    },
  };
}

function buildServer(platform) {
  return createAdcpServerFromPlatform(platform, {
    name: 'BroadcastTV',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
  });
}

describe('BroadcastTvSeller — HITL via *Task variants', () => {
  it('createMediaBuyTask returns submitted envelope; background completes terminal accepted', async () => {
    const platform = makeBroadcastTvSeller({ trafficReviewMs: 20, activationOffsetMs: 100_000 });
    const server = buildServer(platform);

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [
            { product_id: 'prod_primetime_30s', budget: 10000, package_id: 'pkg_1', creative_assignments: [] },
          ],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          total_budget: 10000,
          account: { account_id: 'acc_1' },
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.status, 'submitted');
    const taskId = result.structuredContent.task_id;

    await server.awaitTask(taskId);
    const final = await server.getTaskState(taskId);
    assert.strictEqual(final.status, 'completed');
    assert.strictEqual(final.result.status, 'pending_start');
    assert.ok(final.result.media_buy_id.startsWith('mb_WCBS_'));
  });

  it('post-acceptance media_buy lifecycle change fires via publishStatusChange', async () => {
    const platform = makeBroadcastTvSeller({ trafficReviewMs: 15, activationOffsetMs: 25 });

    const bus = createInMemoryStatusChangeBus();
    const prevBus = setStatusChangeBus(bus);
    const received = [];
    bus.subscribe(evt => received.push(evt));

    try {
      const server = buildServer(platform);
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'create_media_buy',
          arguments: {
            buyer_ref: 'b1',
            idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
            packages: [
              { product_id: 'prod_primetime_30s', budget: 10000, package_id: 'pkg_1', creative_assignments: [] },
            ],
            start_time: '2026-05-01T00:00:00Z',
            end_time: '2026-06-01T00:00:00Z',
            total_budget: 10000,
            account: { account_id: 'acc_1' },
          },
        },
      });

      const taskId = result.structuredContent.task_id;
      await server.awaitTask(taskId);
      await new Promise(r => setTimeout(r, 60));

      const activations = received.filter(e => e.resource_type === 'media_buy' && e.payload.status === 'active');
      assert.strictEqual(activations.length, 1, 'one media_buy active event post-acceptance');
      assert.ok(activations[0].resource_uri.startsWith('adcp://acc_1/media_buy/'));
    } finally {
      setStatusChangeBus(prevBus);
    }
  });

  it('rejected category throws POLICY_VIOLATION sync (getProducts is sync-only per v2.1)', async () => {
    const platform = makeBroadcastTvSeller();
    const server = buildServer(platform);

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'targeted local political ads in swing markets',
          promoted_offering: 'political campaign — congressional race',
          account: { account_id: 'acc_1' },
        },
      },
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'POLICY_VIOLATION');
    assert.strictEqual(result.structuredContent.adcp_error.recovery, 'terminal');
  });

  it('syncCreativesTask rejects political tags; approves rest', async () => {
    const platform = makeBroadcastTvSeller({ standardsReviewMs: 15 });
    const server = buildServer(platform);

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          creatives: [
            { creative_id: 'cr_brand', format_id: { id: 'video_30s', agent_url: 'x' }, tags: ['cpg'] },
            { creative_id: 'cr_pol', format_id: { id: 'video_30s', agent_url: 'x' }, tags: ['Political'] },
          ],
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          account: { account_id: 'acc_1' },
        },
      },
    });

    const taskId = result.structuredContent.task_id;
    await server.awaitTask(taskId);

    const final = await server.getTaskState(taskId);
    assert.strictEqual(final.status, 'completed');
    const reviews = final.result;
    assert.strictEqual(reviews.length, 2);
    const brand = reviews.find(r => r.creative_id === 'cr_brand');
    const pol = reviews.find(r => r.creative_id === 'cr_pol');
    assert.strictEqual(brand.action, 'created');
    assert.strictEqual(brand.status, 'approved');
    assert.strictEqual(pol.action, 'failed');
    assert.strictEqual(pol.status, 'rejected');
    assert.ok(/FCC|GM/.test(pol.errors?.[0]?.message ?? ''));
  });
});
