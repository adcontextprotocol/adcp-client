// Integration test for the ProgrammaticSeller worked example.
// Exercises sync dispatch + post-commit status-change channel via
// publishStatusChange.
//
// Platform shape inlined here (mirroring the .ts example file) to keep
// the test pure CJS. The example at examples/decisioning-platform-
// programmatic.ts is the canonical reference; this test mirrors it.

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

function makeProgrammaticSeller({ networkId = 'NET_42', floorCpm = 1.5, creativeReviewMs = 30 } = {}) {
  const mediaBuys = new Map();
  const config = { networkId, floorCpm, creativeReviewMs };

  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [{ agent_url: 'https://example.com/programmatic-creative-agent/mcp' }],
      channels: ['display', 'video', 'native'],
      pricingModels: ['cpm'],
      config,
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'prog_acc_1',
        operator: 'programmatic.example.com',
        metadata: { network_id: config.networkId, advertiser_id: 'adv_42' },
        authInfo: { kind: 'api_key' },
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    sales: {
      getProducts: async () => ({
        products: [
          {
            product_id: 'prod_run_of_network_display',
            name: 'RON Display',
            description: 'Run-of-network display',
            format_ids: [{ id: 'display_300x250', agent_url: 'x' }],
            delivery_type: 'non_guaranteed',
            publisher_properties: { reportable: true },
            reporting_capabilities: { available_dimensions: ['geo'] },
            pricing_options: [{ pricing_model: 'cpm', rate: 2.5, currency: 'USD' }],
          },
        ],
      }),

      createMediaBuy: async req => {
        const totalBudget = typeof req.total_budget === 'number' ? req.total_budget : (req.total_budget?.amount ?? 0);
        if (totalBudget < config.floorCpm * 1000) {
          throw new AdcpError('BUDGET_TOO_LOW', {
            recovery: 'correctable',
            message: `total_budget below floor (${config.floorCpm} CPM × 1000 imp)`,
            field: 'total_budget',
            suggestion: `Raise to at least ${config.floorCpm * 1000}`,
          });
        }

        const buyId = `mb_${config.networkId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const buy = { media_buy_id: buyId, status: 'pending_creatives', total_budget: totalBudget };
        mediaBuys.set(buyId, buy);

        const accountId = req?.account?.account_id ?? 'prog_acc_1';
        setTimeout(() => {
          buy.status = 'active';
          publishStatusChange({
            account_id: accountId,
            resource_type: 'media_buy',
            resource_id: buyId,
            payload: { status: 'active', activated_at: new Date().toISOString() },
          });
        }, config.creativeReviewMs).unref?.();

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
        if (patch.active === false) existing.status = 'paused';
        if (patch.active === true && existing.status === 'paused') existing.status = 'active';
        return existing;
      },

      syncCreatives: async creatives => {
        return creatives.map(c => {
          const id = c.creative_id ?? `cr_${Math.random()}`;
          const formatId = c.format_id?.id ?? '';
          const needsReview = formatId.startsWith('video_');
          if (needsReview) {
            setTimeout(() => {
              publishStatusChange({
                account_id: 'prog_acc_1',
                resource_type: 'creative',
                resource_id: id,
                payload: { status: 'approved', reviewed_at: new Date().toISOString() },
              });
            }, config.creativeReviewMs).unref?.();
          }
          return {
            creative_id: id,
            status: needsReview ? 'pending_review' : 'approved',
            ...(needsReview && { reason: 'video creatives go through brand-suitability review' }),
          };
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
    name: 'Programmatic',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
  });
}

describe('ProgrammaticSeller — sync first, status-change for post-commit lifecycle', () => {
  it('createMediaBuy returns synchronously with media_buy_id and pending_creatives', async () => {
    const platform = makeProgrammaticSeller({ creativeReviewMs: 1_000_000 });
    const server = buildServer(platform);

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [
            { product_id: 'prod_run_of_network_display', budget: 5000, package_id: 'pkg_1', creative_assignments: [] },
          ],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          total_budget: 5000,
          account: { account_id: 'acc_1' },
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.strictEqual(result.structuredContent.status, 'pending_creatives');
    assert.ok(result.structuredContent.media_buy_id.startsWith('mb_NET_42_'));
  });

  it('post-commit pending_creatives → active fires via publishStatusChange', async () => {
    const platform = makeProgrammaticSeller({ creativeReviewMs: 25 });

    const bus = createInMemoryStatusChangeBus();
    const prevBus = setStatusChangeBus(bus);
    const received = [];
    bus.subscribe(evt => received.push(evt));

    try {
      const server = buildServer(platform);
      await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'create_media_buy',
          arguments: {
            buyer_ref: 'b1',
            idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
            packages: [
              {
                product_id: 'prod_run_of_network_display',
                budget: 5000,
                package_id: 'pkg_1',
                creative_assignments: [],
              },
            ],
            start_time: '2026-05-01T00:00:00Z',
            end_time: '2026-06-01T00:00:00Z',
            total_budget: 5000,
            account: { account_id: 'acc_1' },
          },
        },
      });

      await new Promise(r => setTimeout(r, 60));

      const activations = received.filter(e => e.resource_type === 'media_buy' && e.payload.status === 'active');
      assert.strictEqual(activations.length, 1, 'one media_buy active event after creative review clears');
    } finally {
      setStatusChangeBus(prevBus);
    }
  });

  it('budget below floor throws BUDGET_TOO_LOW with structured fields', async () => {
    const platform = makeProgrammaticSeller();
    const server = buildServer(platform);

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'b1',
          idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
          packages: [
            { product_id: 'prod_run_of_network_display', budget: 100, package_id: 'pkg_1', creative_assignments: [] },
          ],
          start_time: '2026-05-01T00:00:00Z',
          end_time: '2026-06-01T00:00:00Z',
          total_budget: 100,
          account: { account_id: 'acc_1' },
        },
      },
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'BUDGET_TOO_LOW');
    assert.strictEqual(result.structuredContent.adcp_error.recovery, 'correctable');
    assert.strictEqual(result.structuredContent.adcp_error.field, 'total_budget');
  });

  it('syncCreatives mixed approved/pending; pending creatives emit approval status-change', async () => {
    const platform = makeProgrammaticSeller({ creativeReviewMs: 25 });

    const bus = createInMemoryStatusChangeBus();
    const prevBus = setStatusChangeBus(bus);
    const received = [];
    bus.subscribe(evt => received.push(evt));

    try {
      const server = buildServer(platform);
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'sync_creatives',
          arguments: {
            creatives: [
              { creative_id: 'cr_display', format_id: { id: 'display_300x250', agent_url: 'x' } },
              { creative_id: 'cr_video', format_id: { id: 'video_15s', agent_url: 'x' } },
            ],
            idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
            account: { account_id: 'acc_1' },
          },
        },
      });

      assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
      const creatives = result.structuredContent.creatives;
      const display = creatives.find(c => c.creative_id === 'cr_display');
      const video = creatives.find(c => c.creative_id === 'cr_video');
      assert.strictEqual(display.status, 'approved');
      assert.strictEqual(video.status, 'pending_review');

      await new Promise(r => setTimeout(r, 60));

      const creativeApprovals = received.filter(
        e => e.resource_type === 'creative' && e.payload.status === 'approved' && e.resource_id === 'cr_video'
      );
      assert.strictEqual(creativeApprovals.length, 1);
    } finally {
      setStatusChangeBus(prevBus);
    }
  });
});
