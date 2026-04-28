// Integration tests for the MockSeller worked example
// (`examples/decisioning-platform-mock-seller.ts`). Exercises four real
// adopter patterns end-to-end through `createAdcpServerFromPlatform`
// under the v2.1 dual-method shape:
//
//   1. Sync createMediaBuy (auto-approve happy path).
//   2. HITL createMediaBuyTask (trafficker-review variant).
//   3. Per-creative status (mixed approved/pending in one batch).
//   4. Multi-error pre-flight rejection via AdcpError.details.errors.
//
// Each platform variant exposes EXACTLY ONE of each method-pair. A single
// platform implementation that wanted both shapes would be a v2.1 violation
// (validatePlatform throws). Buyers that need both modes call different
// agent endpoints — that's the multi-tenant routing story, not per-call
// shape selection.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');

function basePlatformShape(salesOverrides) {
  const mediaBuys = new Map();
  return {
    mediaBuys,
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
      channels: ['display', 'video'],
      pricingModels: ['cpm'],
      config: {},
    },
    statusMappers: {},
    accounts: {
      resolve: async ref => ({
        id: ref?.account_id ?? 'mock_acc_1',
        operator: 'mockseller.example.com',
        metadata: { network_id: 'mock_network', advertiser_id: 'mock_advertiser' },
        authInfo: { kind: 'api_key' },
      }),
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

      ...salesOverrides,
    },
  };
}

function makeSyncMockSeller({ floorCpm = 1.0 } = {}) {
  const platform = basePlatformShape({
    createMediaBuy: async req => {
      const errors = preflight(req, { floorCpm });
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
      const buy = { media_buy_id: buyId, status: 'pending_creatives', total_budget: totalBudget };
      platform.mediaBuys.set(buyId, buy);
      return buy;
    },
  });
  return platform;
}

function makeHitlMockSeller({ floorCpm = 1.0, approvalDurationMs = 30 } = {}) {
  const platform = basePlatformShape({
    createMediaBuy: (req, ctx) => ctx.handoffToTask(async () => {
      const errors = preflight(req, { floorCpm });
      if (errors.length > 0) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'correctable',
          message: errors[0].message,
          field: errors[0].field,
          details: { errors },
        });
      }
      // Trafficker review window
      await new Promise(r => setTimeout(r, approvalDurationMs));
      const buyId = `mb_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const totalBudget = typeof req.total_budget === 'number' ? req.total_budget : (req.total_budget?.amount ?? 0);
      const buy = { media_buy_id: buyId, status: 'active', total_budget: totalBudget };
      platform.mediaBuys.set(buyId, buy);
      return buy;
    }),
  });
  return platform;
}

function preflight(req, { floorCpm }) {
  const errors = [];
  const totalBudget = typeof req.total_budget === 'number' ? req.total_budget : (req.total_budget?.amount ?? 0);
  if (totalBudget < floorCpm * 1000) {
    errors.push({
      code: 'BUDGET_TOO_LOW',
      recovery: 'correctable',
      message: `total_budget below floor (${floorCpm} CPM × 1000 imp)`,
      field: 'total_budget',
      suggestion: `Raise total_budget to at least ${floorCpm * 1000}`,
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

describe('MockSeller worked example — v2.1 dual-method', () => {
  describe('Pattern 1: sync createMediaBuy (auto-approve)', () => {
    it('valid request: sync success arm with media_buy_id and pending_creatives', async () => {
      const platform = makeSyncMockSeller();
      const server = buildServer(platform);
      const result = await dispatchCreate(server, { total_budget: 5000 });
      assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
      assert.strictEqual(result.structuredContent.status, 'pending_creatives');
      assert.ok(result.structuredContent.media_buy_id.startsWith('mb_'));
    });
  });

  describe('Pattern 2: HITL createMediaBuyTask (trafficker review)', () => {
    it('returns submitted envelope with task_id; background completes terminal active', async () => {
      const platform = makeHitlMockSeller({ approvalDurationMs: 30 });
      const server = buildServer(platform);
      const result = await dispatchCreate(server, { total_budget: 100_000 });

      assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
      assert.strictEqual(result.structuredContent.status, 'submitted');
      assert.ok(result.structuredContent.task_id.startsWith('task_'));
      const taskId = result.structuredContent.task_id;

      await server.awaitTask(taskId);

      const final = await server.getTaskState(taskId);
      assert.strictEqual(final.status, 'completed');
      assert.strictEqual(final.result.status, 'active');
    });

    it('background AdcpError records terminal failed with structured fields', async () => {
      const platform = makeHitlMockSeller();
      const server = buildServer(platform);
      const result = await dispatchCreate(server, {
        total_budget: 100, // below floor — pre-flight inside *Task throws AdcpError
      });

      // Pre-flight runs inside the *Task method, so the buyer first sees submitted,
      // then the registry record carries the structured rejection on the task.
      assert.strictEqual(result.structuredContent.status, 'submitted');
      const taskId = result.structuredContent.task_id;

      await server.awaitTask(taskId);

      const final = await server.getTaskState(taskId);
      assert.strictEqual(final.status, 'failed');
      assert.strictEqual(final.error.code, 'INVALID_REQUEST');
      assert.strictEqual(final.error.recovery, 'correctable');
    });
  });

  describe('Pattern 3: per-creative review with mixed sync/pending rows', () => {
    it('returns approved + pending_review rows in one response', async () => {
      const platform = makeSyncMockSeller();
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
    it('throws AdcpError with details.errors carrying all validation failures (sync mode)', async () => {
      const platform = makeSyncMockSeller();
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
      const detailsErrors = result.structuredContent.adcp_error.details.errors;
      assert.ok(Array.isArray(detailsErrors));
      assert.ok(detailsErrors.length >= 1);
    });
  });

  describe('updateMediaBuy: throw AdcpError for not-found', () => {
    it('returns MEDIA_BUY_NOT_FOUND envelope when buy does not exist', async () => {
      const platform = makeSyncMockSeller();
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
