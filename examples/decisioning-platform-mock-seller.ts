/**
 * MockHybridSeller — worked example for the v6.0 DecisioningPlatform
 * runtime under the unified hybrid shape.
 *
 * One method per tool. The same `createMediaBuy` returns either:
 *
 *   - The wire success arm directly (sync fast path) — buyer gets
 *     `media_buy_id` on the immediate response. No polling.
 *   - `ctx.handoffToTask(fn)` (HITL slow path) — buyer gets
 *     `{ status: 'submitted', task_id }`, framework runs `fn` in
 *     background; `fn`'s return value becomes the task's terminal
 *     artifact, `throw AdcpError` becomes the terminal error.
 *
 * Adopter branches per call on whatever signal determines the path
 * (product type, buyer pre-approval, amount thresholds, etc.). Hybrid
 * sellers — programmatic remnant + guaranteed inventory in one tenant —
 * are the canonical case. Pure-sync adopters never call
 * `ctx.handoffToTask`; pure-HITL adopters always call it. Same
 * signature handles all three deployment shapes.
 *
 * Patterns demonstrated:
 *
 *   1. **Sync fast path** — `MockHybridSeller.createMediaBuy` returns
 *      `CreateMediaBuySuccess` directly when `req.buyer_ref` is
 *      pre-approved. No `tasks_get` polling needed.
 *   2. **HITL slow path** — when not pre-approved, returns
 *      `ctx.handoffToTask(...)` and the trafficker-review work runs
 *      in background.
 *   3. **Per-creative review** — `syncCreatives` returns mixed
 *      `approved` + `pending_review` rows in one response. Or hands
 *      off the whole batch to background review when needed.
 *   4. **Multi-error pre-flight rejection** — adopter throws one
 *      `AdcpError` carrying all validation failures in `details.errors`.
 *
 * This file doubles as integration tests in
 * `test/server-decisioning-mock-seller.test.js`.
 *
 * @see `docs/proposals/decisioning-platform-v2-hitl-split.md`
 */

import {
  AdcpError,
  createAdcpServerFromPlatform,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
  type AdcpStructuredError,
  type SyncCreativesRow,
} from '@adcp/client/server/decisioning';
import type {
  GetProductsRequest,
  GetProductsResponse,
  CreateMediaBuyRequest,
  CreateMediaBuySuccess,
  UpdateMediaBuyRequest,
  UpdateMediaBuySuccess,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  CreativeAsset,
  AccountReference,
} from '@adcp/client/types';

// ---------------------------------------------------------------------------
// Shared config + state
// ---------------------------------------------------------------------------

export interface MockSellerConfig {
  /** Threshold (CPM) below which media buys are auto-rejected. */
  floorCpm: number;
  /** Simulated trafficker review duration (ms) — only used by HITL variant. */
  approvalDurationMs: number;
}

interface MockSellerMeta {
  network_id: string;
  advertiser_id: string;
  [key: string]: unknown;
}

type MockMediaBuy = CreateMediaBuySuccess;

const DEFAULT_CONFIG: MockSellerConfig = {
  floorCpm: 1.0,
  approvalDurationMs: 100,
};

// Shared cross-variant helpers — preflight, account store, syncCreatives,
// getProducts. Variant classes only differ on createMediaBuy{,Task}.

function makeAccounts(): AccountStore<MockSellerMeta> {
  return {
    // Multi-tenant: MockSeller accepts buyer-supplied account_id refs.
    // Single-tenant adopters declare resolution: 'derived' instead and
    // ignore `ref`. See SKILL § "Account resolution".
    resolution: 'explicit',
    resolve: async (ref: AccountReference) => {
      const id = 'account_id' in ref ? ref.account_id : 'mock_acc_1';
      return {
        id,
        name: 'Mock Account',
        status: 'active',
        operator: 'mockseller.example.com',
        metadata: { network_id: 'mock_network', advertiser_id: 'mock_advertiser' },
        authInfo: { kind: 'api_key' },
      };
    },
  };
}

function preflight(req: CreateMediaBuyRequest, config: MockSellerConfig): AdcpStructuredError[] {
  const errors: AdcpStructuredError[] = [];
  const totalBudget =
    typeof req.total_budget === 'number' ? req.total_budget : ((req.total_budget as { amount?: number })?.amount ?? 0);

  if (totalBudget < config.floorCpm * 1000) {
    errors.push({
      code: 'BUDGET_TOO_LOW',
      recovery: 'correctable',
      message: `total_budget below floor (${config.floorCpm} CPM × 1000 imp)`,
      field: 'total_budget',
      suggestion: `Raise total_budget to at least ${config.floorCpm * 1000}`,
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

function rejectPreflight(errors: AdcpStructuredError[]): never {
  throw new AdcpError('INVALID_REQUEST', {
    recovery: 'correctable',
    message: errors[0]!.message,
    field: errors[0]!.field,
    details: { errors },
  });
}

const SHARED_GET_PRODUCTS = async (_req: GetProductsRequest): Promise<GetProductsResponse> => ({
  products: [
    {
      product_id: 'prod_premium_video',
      name: 'Premium Video',
      description: 'Pre-roll video on premium inventory',
      delivery_type: 'non_guaranteed',
      format_ids: [{ id: 'video_15s', agent_url: 'https://example.com/creative-agent/mcp' }],
      publisher_properties: [{ publisher_domain: 'publisher.example.com', selection_type: 'all' }],
      pricing_options: [{
        pricing_option_id: 'cpm_12_50',
        pricing_model: 'cpm',
        fixed_price: 12.5,
        currency: 'USD',
      }],
      reporting_capabilities: {
        available_reporting_frequencies: ['hourly', 'daily'],
        expected_delay_minutes: 30,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: [],
        date_range_support: 'date_range',
      },
    },
  ],
});

const SHARED_SYNC_CREATIVES = async (creatives: CreativeAsset[]): Promise<SyncCreativesRow[]> => {
  return creatives.map(c => {
    const id = (c as { creative_id?: string }).creative_id ?? `cr_${Math.random()}`;
    const needsReview = (c as { format_id?: { id?: string } }).format_id?.id?.startsWith('video_');
    return {
      creative_id: id,
      action: 'created',
      status: needsReview ? 'pending_review' : 'approved',
    };
  });
};

const SHARED_GET_MEDIA_BUY_DELIVERY = async (
  filter: GetMediaBuyDeliveryRequest
): Promise<GetMediaBuyDeliveryResponse> => ({
  currency: 'USD',
  reporting_period: {
    start: filter.start_date ?? '2026-04-01',
    end: filter.end_date ?? '2026-04-30',
  },
  media_buy_deliveries: [],
});

// ---------------------------------------------------------------------------
// MockHybridSeller — unified hybrid shape (sync fast path + HITL slow path)
// ---------------------------------------------------------------------------

/**
 * Whether a request takes the fast (sync) path or the slow (HITL) path
 * is encoded in the request itself — `buyer_ref: 'pre_approved'` skips
 * trafficker review; everything else hands off to background.
 *
 * Real-world signal would be a join against the seller's pre-approved
 * buyer list, an amount threshold, or a product type check. The shape
 * is the same: branch in the method body, return `Success` directly OR
 * return `ctx.handoffToTask(fn)`.
 */
function isPreApprovedBuyer(req: CreateMediaBuyRequest): boolean {
  return (req as { buyer_ref?: string }).buyer_ref === 'pre_approved';
}

export class MockHybridSeller implements DecisioningPlatform<MockSellerConfig, MockSellerMeta> {
  private mediaBuys = new Map<string, MockMediaBuy>();

  capabilities = {
    specialisms: ['sales-non-guaranteed'] as const,
    creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
    channels: ['display', 'olv'] as const,
    pricingModels: ['cpm'] as const,
    config: { ...DEFAULT_CONFIG } satisfies MockSellerConfig,
  };

  statusMappers = {};
  accounts = makeAccounts();

  sales: SalesPlatform<MockSellerMeta> = {
    getProducts: SHARED_GET_PRODUCTS,

    /**
     * Unified hybrid shape. Pre-approved buyers get the wire `Success` arm
     * directly (`media_buy_id` + `packages` on the immediate response, no
     * polling). Everything else hands off to a background task — buyer
     * sees `{ status: 'submitted', task_id }`, framework runs the
     * trafficker-review work, and the task's terminal artifact lands on
     * `tasks_get` / webhook delivery.
     *
     * Same method, dynamic decision per call. Buyer pattern-matches on
     * the response shape — predictable per request (deterministic given
     * the buyer_ref / products / amount), dynamic per call.
     */
    createMediaBuy: (req, ctx) => {
      // Pre-flight runs sync regardless of path — bad requests reject
      // before allocating a task id.
      const errors = preflight(req, this.capabilities.config);
      if (errors.length > 0) rejectPreflight(errors);

      // Fast path: pre-approved buyer → return Success directly.
      if (isPreApprovedBuyer(req)) {
        const buyId = `mb_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const buy: MockMediaBuy = {
          media_buy_id: buyId,
          status: 'pending_creatives',
          confirmed_at: new Date().toISOString(),
          packages: [],
        };
        this.mediaBuys.set(buyId, buy);
        return Promise.resolve(buy);
      }

      // Slow path: hand off to background task.
      return Promise.resolve(ctx.handoffToTask(async (taskCtx) => {
        void taskCtx;  // taskCtx.id available if you need to persist it
        // Trafficker review window
        await new Promise(r => setTimeout(r, this.capabilities.config.approvalDurationMs));

        const buyId = `mb_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const buy: MockMediaBuy = {
          media_buy_id: buyId,
          status: 'active',
          confirmed_at: new Date().toISOString(),
          packages: [],
        };
        this.mediaBuys.set(buyId, buy);
        return buy;
      }));
    },

    updateMediaBuy: async (buyId: string, patch: UpdateMediaBuyRequest): Promise<UpdateMediaBuySuccess> => {
      const existing = this.mediaBuys.get(buyId);
      if (!existing) {
        throw new AdcpError('MEDIA_BUY_NOT_FOUND', {
          recovery: 'terminal',
          message: `media buy ${buyId} not found`,
          field: 'media_buy_id',
        });
      }
      if (patch.paused === true) existing.status = 'paused';
      if (patch.paused === false && existing.status === 'paused') existing.status = 'active';
      return { media_buy_id: existing.media_buy_id, status: existing.status };
    },

    syncCreatives: SHARED_SYNC_CREATIVES,
    getMediaBuyDelivery: SHARED_GET_MEDIA_BUY_DELIVERY,
  };
}

// ---------------------------------------------------------------------------
// Merge-seam demonstration: v6 platform + v5 leftover handlers
// ---------------------------------------------------------------------------
//
// Adopters migrating from v5.x's `createAdcpServer({ mediaBuy: { ... } })`
// don't have to rewrite all of it. `createAdcpServerFromPlatform` accepts
// v5-style handler entries on `opts` that fill gaps the v6 specialism
// interfaces don't yet model (e.g., `listCreativeFormats`,
// `providePerformanceFeedback`, content-standards CRUD).
//
// The seam logs collisions so v6.x silently shadowing your override is
// loud, not silent. Set `mergeSeam: 'strict'` in CI for migration safety.

export function buildHybridServerExample(platform: MockHybridSeller) {
  return createAdcpServerFromPlatform(platform, {
    name: 'mock-hybrid', version: '0.0.1',
    validation: { requests: 'off', responses: 'off' },
    mergeSeam: 'strict',
    mediaBuy: {
      // v5 leftover — listCreativeFormats isn't on SalesPlatform v1.0
      // (deferred to rc.1). Custom handler here fills the gap until then.
      listCreativeFormats: async () => ({ formats: [] }),
    },
  });
}
