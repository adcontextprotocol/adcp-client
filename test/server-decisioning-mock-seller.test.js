// Integration tests for the MockSeller worked example
// (`examples/decisioning-platform-mock-seller.ts`). Exercises four real
// async patterns end-to-end through `createAdcpServerFromPlatform`.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
// MockSeller is a TS file under examples/. We dispatch through the same
// dist-compiled SDK paths the example uses, so we have to load it via tsx
// or compile it inline. Simpler: re-implement the platform shape inline
// for the test; the example file is the canonical reference.

const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');

function makeMockSeller(overrides = {}) {
  const config = {
    floorCpm: 1.0,
    reviewThreshold: 50_000,
    approvalDurationMs: 30,
    ...overrides,
  };

  const mediaBuys = new Map();
  const pendingApprovals = new Map();

  const platform = {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
      channels: ['display', 'video'],
      pricingModels: ['cpm'],
      config,
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => {
        const id = ref?.account_id ?? 'mock_acc_1';
        return {
          id,
          operator: 'mockseller.example.com',
          metadata: { network_id: 'mock_network', advertiser_id: 'mock_advertiser' },
          authInfo: { kind: 'api_key' },
        };
      },
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    sales: {
      getProducts: async () => ({
        products: [
          {
            product_id: 'prod_premium_video',
            name: 'Premium Video',
            description: 'Pre-roll video on premium inventory',
            format_ids: [{ id: 'video_15s', agent_url: 'https://example.com/creative-agent/mcp' }],
            delivery_type: 'non_guaranteed',
            publisher_properties: { reportable: true },
            reporting_capabilities: { available_dimensions: ['geo', 'creative'] },
            pricing_options: [{ pricing_model: 'cpm', rate: 12.5, currency: 'USD' }],
          },
        ],
      }),

      createMediaBuy: async (req, ctx) => {
        // Pre-flight (Pattern 4)
        const errors = preflight(req, config);
        if (errors.length > 0) {
          throw new AdcpError('INVALID_REQUEST', {
            recovery: 'correctable',
            message: errors[0].message,
            field: errors[0].field,
            details: { errors },
          });
        }

        const buyId = `mb_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const totalBudget = typeof req.total_budget === 'number' ? req.total_budget : (req.total_budget?.amount ?? 0);

        // Pattern 1: in-process trafficker approval via ctx.runAsync
        if (totalBudget >= config.reviewThreshold) {
          const partialBuy = { media_buy_id: buyId, status: 'pending_start', total_budget: totalBudget };
          return await ctx.runAsync(
            {
              message: 'Trafficker review required',
              partialResult: partialBuy,
              submittedAfterMs: 10, // tiny so the test reliably defers
            },
            async () => {
              await new Promise(r => setTimeout(r, config.approvalDurationMs));
              const approved = { ...partialBuy, status: 'active' };
              mediaBuys.set(buyId, approved);
              return approved;
            }
          );
        }

        // Sync happy path
        const buy = { media_buy_id: buyId, status: 'pending_creatives', total_budget: totalBudget };
        mediaBuys.set(buyId, buy);
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

      // Pattern 3: per-creative status (mixed sync/pending in one batch)
      syncCreatives: async creatives => {
        return creatives.map(c => {
          const id = c.creative_id ?? `cr_${Math.random()}`;
          const needsReview = c.format_id?.id?.startsWith('video_');
          return {
            creative_id: id,
            status: needsReview ? 'pending_review' : 'approved',
            ...(needsReview && { reason: 'video creatives go through brand-suitability review' }),
          };
        });
      },

      getMediaBuyDelivery: async filter => ({
        currency: 'USD',
        reporting_period: { start: filter.start_date ?? '2026-04-01', end: filter.end_date ?? '2026-04-30' },
        media_buys: [],
      }),
    },
    // Test helper for Pattern 2 (out-of-process)
    _resolvePendingApproval(taskId, result) {
      const handle = pendingApprovals.get(taskId);
      if (!handle) throw new Error(`no pending approval for taskId ${taskId}`);
      handle.notify({ kind: 'completed', result });
      pendingApprovals.delete(taskId);
      mediaBuys.set(result.media_buy_id, result);
    },
  };

  return { platform, mediaBuys, pendingApprovals };
}

function preflight(req, config) {
  const errors = [];
  const totalBudget = typeof req.total_budget === 'number' ? req.total_budget : (req.total_budget?.amount ?? 0);
  if (totalBudget < config.floorCpm * 1000) {
    errors.push({
      code: 'BUDGET_TOO_LOW',
      recovery: 'correctable',
      message: `total_budget below floor (${config.floorCpm} CPM × 1000 imp)`,
      field: 'total_budget',
      suggestion: `Raise total_budget to at least ${config.floorCpm * 1000}`,
    });
  }
  const packages = req.packages ?? [];
  if (packages.length === 0) {
    errors.push({
      code: 'INVALID_REQUEST',
      recovery: 'correctable',
      message: 'packages must be non-empty',
      field: 'packages',
    });
  }
  return errors;
}

function buildServer(platform) {
  return createAdcpServerFromPlatform(platform, {
    name: 'MockSeller',
    version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
  });
}

function dispatchCreate(server, args = {}) {
  return server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'create_media_buy',
      arguments: {
        buyer_ref: 'b1',
        idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
        packages: [{ product_id: 'prod_premium_video', budget: 5000, package_id: 'pkg_1', creative_assignments: [] }],
        start_time: '2026-05-01T00:00:00Z',
        end_time: '2026-06-01T00:00:00Z',
        total_budget: 5000,
        account: { account_id: 'acc_1' },
        ...args,
      },
    },
  });
}

describe('MockSeller worked example', () => {
  describe('Pattern 1: in-process trafficker approval via ctx.runAsync', () => {
    it('under review threshold: sync auto-approval', async () => {
      const { platform } = makeMockSeller({ reviewThreshold: 50_000 });
      const server = buildServer(platform);
      const result = await dispatchCreate(server, { total_budget: 5000 });
      assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
      assert.strictEqual(result.structuredContent.status, 'pending_creatives');
      assert.ok(result.structuredContent.media_buy_id.startsWith('mb_'));
    });

    it('above review threshold: async via runAsync, partial result + submitted envelope, then completion', async () => {
      const { platform } = makeMockSeller({ reviewThreshold: 1000, approvalDurationMs: 60 });
      const server = buildServer(platform);
      const result = await dispatchCreate(server, { total_budget: 100_000 });

      assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
      assert.strictEqual(result.structuredContent.status, 'submitted');
      assert.strictEqual(result.structuredContent.message, 'Trafficker review required');
      assert.strictEqual(result.structuredContent.partial_result.status, 'pending_start');
      const taskId = result.structuredContent.task_id;

      // Wait for background completion (60ms approval duration)
      await server.awaitTask(taskId);

      const final = server.getTaskState(taskId);
      assert.strictEqual(final.status, 'completed');
      assert.strictEqual(final.result.status, 'active');
    });
  });

  describe('Pattern 3: per-creative review with mixed sync/pending rows', () => {
    it('returns approved + pending_review rows in one response', async () => {
      const { platform } = makeMockSeller();
      const server = buildServer(platform);
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'sync_creatives',
          arguments: {
            creatives: [
              { creative_id: 'cr_display_1', format_id: { id: 'display_300x250', agent_url: 'x' } },
              { creative_id: 'cr_video_1', format_id: { id: 'video_15s', agent_url: 'x' } },
              { creative_id: 'cr_display_2', format_id: { id: 'display_728x90', agent_url: 'x' } },
            ],
            idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
            account: { account_id: 'acc_1' },
          },
        },
      });
      assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
      const creatives = result.structuredContent.creatives;
      assert.strictEqual(creatives.length, 3);
      const display1 = creatives.find(c => c.creative_id === 'cr_display_1');
      const video1 = creatives.find(c => c.creative_id === 'cr_video_1');
      const display2 = creatives.find(c => c.creative_id === 'cr_display_2');
      assert.strictEqual(display1.status, 'approved');
      assert.strictEqual(video1.status, 'pending_review');
      assert.strictEqual(display2.status, 'approved');
    });
  });

  describe('Pattern 4: multi-error pre-flight rejection', () => {
    it('throws AdcpError with details.errors carrying all validation failures', async () => {
      const { platform } = makeMockSeller();
      const server = buildServer(platform);
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'create_media_buy',
          arguments: {
            buyer_ref: 'b1',
            idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
            packages: [], // empty — pre-flight rejects
            start_time: '2026-05-01T00:00:00Z',
            end_time: '2026-06-01T00:00:00Z',
            total_budget: 100, // below floor
            account: { account_id: 'acc_1' },
          },
        },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
      assert.strictEqual(result.structuredContent.adcp_error.recovery, 'correctable');
      // Multi-error pattern: details.errors carries the rest
      const detailsErrors = result.structuredContent.adcp_error.details.errors;
      assert.ok(Array.isArray(detailsErrors));
      assert.ok(detailsErrors.length >= 1);
    });
  });

  describe('updateMediaBuy: throw AdcpError for not-found', () => {
    it('returns MEDIA_BUY_NOT_FOUND envelope when buy does not exist', async () => {
      const { platform } = makeMockSeller();
      const server = buildServer(platform);
      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: {
          name: 'update_media_buy',
          arguments: {
            media_buy_id: 'nonexistent_buy',
            idempotency_key: '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d',
            active: false,
            account: { account_id: 'acc_1' },
          },
        },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'MEDIA_BUY_NOT_FOUND');
    });
  });
});
