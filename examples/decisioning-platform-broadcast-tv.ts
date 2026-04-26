/**
 * BroadcastTvSeller — worked example for `sales-broadcast-tv`.
 *
 * Broadcast linear TV is the canonical HITL case: a media buy isn't real
 * until the trafficker confirms inventory holds and the plan clears
 * standards & practices. Buyers don't get an `media_buy_id` until the
 * trafficker accepts; the v2.1 dual-method shape projects this directly:
 *
 *   - `getProductsTask` — proposal-style discovery (sales rep packages
 *     inventory in response to brief; happens off-line in 1-3 business
 *     days).
 *   - `createMediaBuyTask` — trafficker review + IO sign-off; ranges from
 *     hours to days.
 *   - `syncCreativesTask` — mandatory standards-and-practices review on
 *     every spot; can take 24-48 hours.
 *
 * The framework allocates `taskId` BEFORE invoking each `*Task` method,
 * returns the submitted envelope to the buyer, and runs the method in
 * background. Method's return value becomes terminal `result`; thrown
 * `AdcpError` becomes terminal `error`.
 *
 * Lifecycle changes after acceptance (plan goes from `accepted` →
 * `active` → `completed` over the campaign window) flow via
 * `publishStatusChange` — the seller's traffic system has the truth and
 * the framework projects it to subscribed buyers.
 *
 * @see `docs/proposals/decisioning-platform-v2-hitl-split.md`
 */

import {
  AdcpError,
  publishStatusChange,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
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
// BroadcastTvSeller config + state
// ---------------------------------------------------------------------------

export interface BroadcastTvConfig {
  /** Affiliate the trafficker IO desk maps to (e.g., 'WCBS'). */
  affiliateId: string;
  /** Simulated trafficker review duration (ms). */
  trafficReviewMs: number;
  /** Simulated S&P review duration (ms). */
  standardsReviewMs: number;
  /** Day-of-week and hour the schedule "activates" relative to start_time. */
  activationOffsetMs: number;
}

interface BroadcastTvMeta {
  agency_buyer_id: string;
  affiliate_advertiser_id: string;
}

type BroadcastBuy = {
  media_buy_id: string;
  status: 'pending_acceptance' | 'accepted' | 'active' | 'completed' | 'rejected';
  total_budget: number;
  daypart: string;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class BroadcastTvSeller implements DecisioningPlatform<BroadcastTvConfig, BroadcastTvMeta> {
  private mediaBuys = new Map<string, BroadcastBuy>();

  capabilities = {
    specialisms: ['sales-broadcast-tv'] as const,
    creative_agents: [{ agent_url: 'https://example.com/broadcast-creative-agent/mcp' }],
    channels: ['video'] as const,
    pricingModels: ['cpm'] as const,
    config: {
      affiliateId: 'WCBS',
      trafficReviewMs: 100,
      standardsReviewMs: 80,
      activationOffsetMs: 50,
    } satisfies BroadcastTvConfig,
  };

  statusMappers = {};

  accounts: AccountStore<BroadcastTvMeta> = {
    resolve: async (ref: AccountReference) => {
      const id = 'account_id' in ref ? ref.account_id : 'broadcast_acc_1';
      return {
        id,
        operator: 'broadcast.example.com',
        metadata: { agency_buyer_id: 'agc_42', affiliate_advertiser_id: 'aff_99' },
        authInfo: { kind: 'api_key' },
      };
    },
    upsert: async () => [],
    list: async () => ({ items: [], nextCursor: null }),
  };

  // ---------------------------------------------------------------------------
  // Sales — every spec-HITL tool uses the *Task variant
  // ---------------------------------------------------------------------------

  sales: SalesPlatform = {
    /**
     * HITL discovery: sales rep reads the brief, packages inventory off-line,
     * returns when the proposal is ready. Buyer initially sees submitted
     * envelope with task_id; resource lands on completion.
     */
    getProductsTask: async (_taskId: string, req: GetProductsRequest) => {
      // Simulate the rep's packaging window
      await new Promise(r => setTimeout(r, 50));

      const promotedOffering = (req as { promoted_offering?: string }).promoted_offering ?? '';
      // Reject categories the affiliate doesn't carry (Pattern: AdcpError throw)
      if (/political|cannabis|gambling/i.test(promotedOffering)) {
        throw new AdcpError('POLICY_VIOLATION', {
          recovery: 'terminal',
          message: 'Affiliate does not carry this category under FCC + station policy',
          field: 'promoted_offering',
          details: { affiliate: this.capabilities.config.affiliateId },
        });
      }

      return {
        products: [
          {
            product_id: 'prod_primetime_30s',
            name: 'Primetime 30s — M-F 8-11pm',
            description: 'Local broadcast primetime, :30 spots',
            format_ids: [{ id: 'video_30s', agent_url: 'https://example.com/broadcast-creative-agent/mcp' }],
            delivery_type: 'guaranteed',
            publisher_properties: { reportable: true },
            reporting_capabilities: { available_dimensions: ['daypart', 'creative'] },
            pricing_options: [{ pricing_model: 'cpm', rate: 42.0, currency: 'USD' }],
          } as never,
        ],
      } satisfies GetProductsResponse;
    },

    /**
     * HITL media-buy creation: trafficker review + IO sign-off. Buyer sees
     * submitted envelope; final media_buy_id only exists once the trafficker
     * accepts. Subsequent lifecycle (active → completed) flows via
     * publishStatusChange.
     */
    createMediaBuyTask: async (_taskId: string, req: CreateMediaBuyRequest) => {
      // Pre-flight (Pattern: multi-error AdcpError throw)
      const errors = this.preflight(req);
      if (errors.length > 0) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'correctable',
          message: errors[0]!.message,
          field: errors[0]!.field,
          details: { errors },
        });
      }

      // Trafficker review window
      await new Promise(r => setTimeout(r, this.capabilities.config.trafficReviewMs));

      const buyId = `mb_${this.capabilities.config.affiliateId}_${Date.now()}`;
      const totalBudget =
        typeof req.total_budget === 'number'
          ? req.total_budget
          : ((req.total_budget as { amount?: number })?.amount ?? 0);
      const buy: BroadcastBuy = {
        media_buy_id: buyId,
        status: 'accepted',
        total_budget: totalBudget,
        daypart: 'primetime',
      };
      this.mediaBuys.set(buyId, buy);

      // After acceptance, the broadcast traffic system controls the campaign
      // window. The SDK demo schedules a status-change at activationOffsetMs
      // to demonstrate the post-acceptance lifecycle channel.
      const account = (req as { account?: { account_id?: string } }).account;
      const accountId = account?.account_id ?? 'broadcast_acc_1';
      setTimeout(() => {
        buy.status = 'active';
        publishStatusChange({
          account_id: accountId,
          resource_type: 'media_buy',
          resource_id: buyId,
          payload: { status: 'active', activated_at: new Date().toISOString() },
        });
      }, this.capabilities.config.activationOffsetMs).unref?.();

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
      // Broadcast: pause = preempt the schedule; can resume only with re-IO.
      if (patch.active === false) existing.status = 'rejected';
      return existing as never;
    },

    /**
     * HITL S&P review: every spot goes through standards-and-practices
     * before it can air. 24-48 hour SLA in production; demo uses
     * standardsReviewMs.
     */
    syncCreativesTask: async (_taskId: string, creatives: CreativeAsset[]): Promise<CreativeReviewResult[]> => {
      await new Promise(r => setTimeout(r, this.capabilities.config.standardsReviewMs));
      // Mock policy: anything tagged "political" rejects; rest approve.
      return creatives.map(c => {
        const id = (c as { creative_id?: string }).creative_id ?? `cr_${Math.random()}`;
        const tags = ((c as { tags?: string[] }).tags ?? []).map(t => t.toLowerCase());
        if (tags.includes('political')) {
          return {
            creative_id: id,
            status: 'rejected',
            reason: 'Political ads require FCC disclosure file + station GM sign-off',
          };
        }
        return { creative_id: id, status: 'approved' };
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

  private preflight(req: CreateMediaBuyRequest): { code: string; recovery: string; message: string; field: string }[] {
    const errors = [];
    const totalBudget =
      typeof req.total_budget === 'number'
        ? req.total_budget
        : ((req.total_budget as { amount?: number })?.amount ?? 0);
    // Broadcast minimum: $5k (low for a demo; real station floors are higher)
    if (totalBudget < 5_000) {
      errors.push({
        code: 'BUDGET_TOO_LOW',
        recovery: 'correctable',
        message: 'Broadcast minimum is $5,000 per IO',
        field: 'total_budget',
      });
    }
    return errors;
  }
}
