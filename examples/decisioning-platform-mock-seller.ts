/**
 * MockSeller — worked example for the v6.0 alpha DecisioningPlatform
 * runtime under the v2.1 dual-method shape.
 *
 * Two variants exist because v2.1 enforces exactly-one method per pair:
 *
 *   - **MockSyncSeller** — implements `createMediaBuy` (sync). Buyer gets
 *     `media_buy_id` immediately; lifecycle changes (pending → active) flow
 *     via `publishStatusChange()` (event bus, separate commit).
 *
 *   - **MockHitlSeller** — implements `createMediaBuyTask` (HITL). Buyer
 *     sees `submitted` envelope with `task_id`; framework runs the trafficker
 *     review in background, terminal state lands on the task record.
 *
 * Patterns demonstrated:
 *
 *   1. **Sync happy path** (`MockSyncSeller`): plain `Promise<T>`; no async
 *      ceremony.
 *   2. **HITL background work** (`MockHitlSeller`): framework allocates
 *      `taskId`, returns submitted envelope, runs `*Task` in background.
 *   3. **Per-creative review** (both variants): `syncCreatives` returns mixed
 *      `approved` + `pending_review` rows in one response.
 *   4. **Multi-error pre-flight rejection** (both variants): adopter throws
 *      one `AdcpError` carrying all validation failures in `details.errors`.
 *
 * This file doubles as integration tests in
 * `test/server-decisioning-mock-seller.test.js`.
 *
 * @see `docs/proposals/decisioning-platform-v2-hitl-split.md`
 */

import {
  AdcpError,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
  type AdcpStructuredError,
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
}

type MockMediaBuy = {
  media_buy_id: string;
  status: 'pending_creatives' | 'pending_start' | 'active' | 'paused' | 'completed' | 'rejected' | 'canceled';
  total_budget: number;
};

const DEFAULT_CONFIG: MockSellerConfig = {
  floorCpm: 1.0,
  approvalDurationMs: 100,
};

// Shared cross-variant helpers — preflight, account store, syncCreatives,
// getProducts. Variant classes only differ on createMediaBuy{,Task}.

function makeAccounts(): AccountStore<MockSellerMeta> {
  return {
    resolve: async (ref: AccountReference) => {
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
}

function preflight(req: CreateMediaBuyRequest, config: MockSellerConfig): AdcpStructuredError[] {
  const errors: AdcpStructuredError[] = [];
  const totalBudget =
    typeof req.total_budget === 'number'
      ? req.total_budget
      : ((req.total_budget as { amount?: number })?.amount ?? 0);

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
      format_ids: [{ id: 'video_15s', agent_url: 'https://example.com/creative-agent/mcp' }],
      delivery_type: 'non_guaranteed',
      publisher_properties: { reportable: true },
      reporting_capabilities: { available_dimensions: ['geo', 'creative'] },
      pricing_options: [{ pricing_model: 'cpm', rate: 12.5, currency: 'USD' }],
    } as never,
  ],
});

const SHARED_SYNC_CREATIVES = async (creatives: CreativeAsset[]): Promise<CreativeReviewResult[]> => {
  return creatives.map(c => {
    const id = (c as { creative_id?: string }).creative_id ?? `cr_${Math.random()}`;
    const needsReview = (c as { format_id?: { id?: string } }).format_id?.id?.startsWith('video_');
    return {
      creative_id: id,
      status: needsReview ? 'pending_review' : 'approved',
      ...(needsReview && { reason: 'video creatives go through brand-suitability review' }),
    };
  });
};

const SHARED_GET_MEDIA_BUY_DELIVERY = async (
  filter: GetMediaBuyDeliveryRequest
): Promise<GetMediaBuyDeliveryResponse> =>
  ({
    currency: 'USD',
    reporting_period: {
      start: filter.start_date ?? '2026-04-01',
      end: filter.end_date ?? '2026-04-30',
    },
    media_buys: [],
  }) as never;

// ---------------------------------------------------------------------------
// MockSyncSeller — sync createMediaBuy (auto-approve)
// ---------------------------------------------------------------------------

export class MockSyncSeller implements DecisioningPlatform<MockSellerConfig, MockSellerMeta> {
  private mediaBuys = new Map<string, MockMediaBuy>();

  capabilities = {
    specialisms: ['sales-non-guaranteed'] as const,
    creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
    channels: ['display', 'video'] as const,
    pricingModels: ['cpm'] as const,
    config: { ...DEFAULT_CONFIG } satisfies MockSellerConfig,
  };

  statusMappers = {};
  accounts = makeAccounts();

  sales: SalesPlatform = {
    getProducts: SHARED_GET_PRODUCTS,

    /** Sync happy path: pre-flight; auto-approve; return MediaBuy immediately. */
    createMediaBuy: async (req: CreateMediaBuyRequest) => {
      const errors = preflight(req, this.capabilities.config);
      if (errors.length > 0) rejectPreflight(errors);

      const buyId = `mb_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const totalBudget =
        typeof req.total_budget === 'number'
          ? req.total_budget
          : ((req.total_budget as { amount?: number })?.amount ?? 0);
      const buy: MockMediaBuy = { media_buy_id: buyId, status: 'pending_creatives', total_budget: totalBudget };
      this.mediaBuys.set(buyId, buy);
      return buy as never;
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
      if (patch.active === false) existing.status = 'paused';
      if (patch.active === true && existing.status === 'paused') existing.status = 'active';
      return existing as never;
    },

    syncCreatives: SHARED_SYNC_CREATIVES,
    getMediaBuyDelivery: SHARED_GET_MEDIA_BUY_DELIVERY,
  };
}

// ---------------------------------------------------------------------------
// MockHitlSeller — HITL createMediaBuyTask (trafficker review)
// ---------------------------------------------------------------------------

export class MockHitlSeller implements DecisioningPlatform<MockSellerConfig, MockSellerMeta> {
  private mediaBuys = new Map<string, MockMediaBuy>();

  capabilities = {
    specialisms: ['sales-non-guaranteed'] as const,
    creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
    channels: ['display', 'video'] as const,
    pricingModels: ['cpm'] as const,
    config: { ...DEFAULT_CONFIG } satisfies MockSellerConfig,
  };

  statusMappers = {};
  accounts = makeAccounts();

  sales: SalesPlatform = {
    getProducts: SHARED_GET_PRODUCTS,

    /**
     * HITL: framework allocates `taskId` BEFORE invoking, returns submitted
     * envelope to buyer immediately, runs this method in background. Method's
     * return value becomes terminal `result`; thrown `AdcpError` becomes
     * terminal `error`.
     */
    createMediaBuyTask: async (_taskId: string, req: CreateMediaBuyRequest) => {
      const errors = preflight(req, this.capabilities.config);
      if (errors.length > 0) rejectPreflight(errors);

      // Trafficker review window
      await new Promise(r => setTimeout(r, this.capabilities.config.approvalDurationMs));

      const buyId = `mb_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const totalBudget =
        typeof req.total_budget === 'number'
          ? req.total_budget
          : ((req.total_budget as { amount?: number })?.amount ?? 0);
      const buy: MockMediaBuy = { media_buy_id: buyId, status: 'active', total_budget: totalBudget };
      this.mediaBuys.set(buyId, buy);
      return buy as never;
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
      if (patch.active === false) existing.status = 'paused';
      if (patch.active === true && existing.status === 'paused') existing.status = 'active';
      return existing as never;
    },

    syncCreatives: SHARED_SYNC_CREATIVES,
    getMediaBuyDelivery: SHARED_GET_MEDIA_BUY_DELIVERY,
  };
}
