/**
 * MockSeller — worked example for the v6.0 alpha DecisioningPlatform
 * runtime. Exercises four real-world async patterns:
 *
 *   1. **Trafficker approval (in-process)** — `createMediaBuy` either
 *      returns sync (auto-approved) or wraps the approval wait in
 *      `ctx.runAsync`; framework auto-defers if approval takes long
 *      enough.
 *
 *   2. **Out-of-process completion (webhook)** — a separate code path
 *      uses `ctx.startTask` and exposes a `completeTask` hook the test
 *      harness (or a real webhook handler) calls hours later.
 *
 *   3. **Per-creative review (partial-batch)** — `syncCreatives` returns
 *      a mix of `approved` and `pending_review` rows in one response;
 *      no auto-defer needed.
 *
 *   4. **Multi-error pre-flight rejection** — adopter throws one
 *      `AdcpError` carrying all validation failures in `details.errors`.
 *
 * This file doubles as integration tests in
 * `test/server-decisioning-mock-seller.test.js`.
 *
 * @see `docs/proposals/decisioning-platform-v1.md`
 */

import {
  AdcpError,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
  type Account,
  type AdcpStructuredError,
  type TaskHandle,
} from '../src/lib/server/decisioning';
import type { CreativeReviewResult } from '../src/lib/server/decisioning/specialisms/creative';
import type {
  GetProductsRequest,
  GetProductsResponse,
  CreateMediaBuyRequest,
  UpdateMediaBuyRequest,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  CreativeAsset,
  AccountReference,
} from '../src/lib/types/tools.generated';

// ---------------------------------------------------------------------------
// MockSeller config + state types
// ---------------------------------------------------------------------------

export interface MockSellerConfig {
  /** Threshold (CPM) below which media buys are auto-rejected. */
  floorCpm: number;
  /** Approval-required total_budget threshold; above this, a trafficker review fires. */
  reviewThreshold: number;
  /** Simulated trafficker review duration (ms). */
  approvalDurationMs: number;
}

interface MockSellerMeta {
  network_id: string;
  advertiser_id: string;
}

type MockMediaBuy = {
  media_buy_id: string;
  status: 'pending_creatives' | 'pending_start' | 'active' | 'paused' | 'completed' | 'rejected' | 'canceled';
  total_budget: number;
};

// ---------------------------------------------------------------------------
// MockSeller implementation
// ---------------------------------------------------------------------------

export class MockSeller implements DecisioningPlatform<MockSellerConfig, MockSellerMeta> {
  /** Pending out-of-process tasks: taskId → TaskHandle (notified later via completeTask). */
  private pendingApprovals = new Map<string, TaskHandle<MockMediaBuy>>();

  /** In-memory media buy store. */
  private mediaBuys = new Map<string, MockMediaBuy>();

  capabilities = {
    specialisms: ['sales-non-guaranteed'] as const,
    creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
    channels: ['display', 'video'] as const,
    pricingModels: ['cpm'] as const,
    config: {
      floorCpm: 1.0,
      reviewThreshold: 50_000,
      approvalDurationMs: 100, // short for tests; in production this is hours
    } satisfies MockSellerConfig,
  };

  statusMappers = {};

  accounts: AccountStore<MockSellerMeta> = {
    resolve: async (ref: AccountReference) => {
      // Demo: any reference resolves to the same mock account.
      // Real adapters lookup tenant from auth principal.
      const id = 'account_id' in ref ? ref.account_id : 'mock_acc_1';
      return {
        id,
        operator: 'mockseller.example.com',
        metadata: { network_id: 'mock_network', advertiser_id: 'mock_advertiser' },
        authInfo: { kind: 'api_key' },
      };
    },
    upsert: async () => [],
    list: async () => ({ items: [], nextCursor: null }),
  };

  // ---------------------------------------------------------------------------
  // Sales — exercising the four async patterns
  // ---------------------------------------------------------------------------

  sales: SalesPlatform = {
    /** Pattern: synchronous discovery. Plain Promise<T>; no async ceremony. */
    getProducts: async (req: GetProductsRequest): Promise<GetProductsResponse> => {
      return {
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
          } as never,
        ],
      };
    },

    /**
     * Patterns: pre-flight validation (multi-error throw), sync happy path,
     * AND in-process trafficker review via ctx.runAsync.
     */
    createMediaBuy: async (req: CreateMediaBuyRequest, ctx) => {
      // Pattern 4: multi-error pre-flight throw.
      const errors = this.preflight(req);
      if (errors.length > 0) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'correctable',
          message: errors[0]!.message,
          field: errors[0]!.field,
          details: { errors },
        });
      }

      const buyId = `mb_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const totalBudget =
        typeof req.total_budget === 'number'
          ? req.total_budget
          : ((req.total_budget as { amount?: number })?.amount ?? 0);

      // Pattern 1: in-process trafficker approval via ctx.runAsync.
      // Race the approval wait against the framework's auto-defer timeout;
      // framework projects to submitted envelope if approval takes too long.
      if (totalBudget >= this.capabilities.config.reviewThreshold) {
        const partialBuy: MockMediaBuy = {
          media_buy_id: buyId,
          status: 'pending_start',
          total_budget: totalBudget,
        };
        return await ctx.runAsync<MockMediaBuy>(
          {
            message: `Trafficker review required for ${this.capabilities.config.reviewThreshold} CPM threshold`,
            partialResult: partialBuy,
          },
          async () => {
            await new Promise(r => setTimeout(r, this.capabilities.config.approvalDurationMs));
            const approved: MockMediaBuy = { ...partialBuy, status: 'active' };
            this.mediaBuys.set(buyId, approved);
            return approved;
          }
        );
      }

      // Sync happy path: under threshold, auto-approve.
      const buy: MockMediaBuy = {
        media_buy_id: buyId,
        status: 'pending_creatives',
        total_budget: totalBudget,
      };
      this.mediaBuys.set(buyId, buy);
      return buy;
    },

    updateMediaBuy: async (buyId: string, patch: UpdateMediaBuyRequest) => {
      const existing = this.mediaBuys.get(buyId);
      if (!existing) {
        throw new AdcpError('MEDIA_BUY_NOT_FOUND', {
          recovery: 'terminal',
          message: `media buy ${buyId} not found`,
          field: 'media_buy_id',
        });
      }
      // Local action dispatch (patch-vs-verb).
      if (patch.active === false) existing.status = 'paused';
      if (patch.active === true && existing.status === 'paused') existing.status = 'active';
      return existing;
    },

    /**
     * Pattern 3: per-creative status. Some auto-approved, some pending_review.
     * No auto-defer; the wire shape carries the partial state per-row.
     */
    syncCreatives: async (creatives: CreativeAsset[]): Promise<CreativeReviewResult[]> => {
      return creatives.map(c => {
        const id = (c as { creative_id?: string }).creative_id ?? `cr_${Math.random()}`;
        // Mock policy: video creatives need manual review; everything else auto-approves.
        const needsReview = (c as { format_id?: { id?: string } }).format_id?.id?.startsWith('video_');
        return {
          creative_id: id,
          status: needsReview ? 'pending_review' : 'approved',
          ...(needsReview && { reason: 'video creatives go through brand-suitability review' }),
        };
      });
    },

    getMediaBuyDelivery: async (filter: GetMediaBuyDeliveryRequest): Promise<GetMediaBuyDeliveryResponse> => {
      return {
        currency: 'USD',
        reporting_period: {
          start: filter.start_date ?? '2026-04-01',
          end: filter.end_date ?? '2026-04-30',
        },
        media_buys: [],
      } as never;
    },
  };

  // ---------------------------------------------------------------------------
  // Out-of-process completion (Pattern 2)
  //
  // Adopters can use ctx.startTask explicitly when async completion happens
  // OUTSIDE the request lifecycle (operator webhook arrives hours later).
  // The handle's taskId is persisted; the webhook handler later calls
  // server.completeTask(taskId, result) (or notify directly on the stored
  // handle).
  // ---------------------------------------------------------------------------

  /**
   * Test/demo helper that simulates a webhook arriving hours later.
   * Real adapters wire this to their backend's notification system.
   */
  resolvePendingApproval(taskId: string, result: MockMediaBuy): void {
    const handle = this.pendingApprovals.get(taskId);
    if (!handle) throw new Error(`no pending approval for taskId ${taskId}`);
    handle.notify({ kind: 'completed', result });
    this.pendingApprovals.delete(taskId);
    this.mediaBuys.set(result.media_buy_id, result);
  }

  // ---------------------------------------------------------------------------
  // Pre-flight validation (Pattern 4)
  // ---------------------------------------------------------------------------

  private preflight(req: CreateMediaBuyRequest): AdcpStructuredError[] {
    const errors: AdcpStructuredError[] = [];
    const totalBudget =
      typeof req.total_budget === 'number'
        ? req.total_budget
        : ((req.total_budget as { amount?: number })?.amount ?? 0);

    if (totalBudget < this.capabilities.config.floorCpm * 1000) {
      errors.push({
        code: 'BUDGET_TOO_LOW',
        recovery: 'correctable',
        message: `total_budget below floor (${this.capabilities.config.floorCpm} CPM × 1000 imp)`,
        field: 'total_budget',
        suggestion: `Raise total_budget to at least ${this.capabilities.config.floorCpm * 1000}`,
      });
    }

    const packages = (req as { packages?: unknown[] }).packages ?? [];
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
}
