/**
 * BroadcastTvSeller — worked example for `sales-broadcast-tv`.
 *
 * Broadcast linear TV is the canonical HITL case: a media buy isn't real
 * until the trafficker confirms inventory holds and the plan clears
 * standards & practices. Buyers don't get a `media_buy_id` until the
 * trafficker accepts; the unified hybrid shape projects this directly:
 *
 *   - `getProducts` — sync catalog read of the affiliate's standing
 *     inventory packages (no trafficker review for catalog reads). Brief-
 *     based proposal generation is a separate verb (`request_proposal`,
 *     adcp#3407) and rides on a status-change channel, not on
 *     `get_products`.
 *   - `createMediaBuy(req, ctx)` — returns `ctx.handoffToTask(fn)` for
 *     trafficker review + IO sign-off (hours to days). The handoff fn
 *     does the actual work and returns the wire `Success` arm when the
 *     trafficker accepts; `throw AdcpError` becomes the terminal error.
 *   - `syncCreatives(creatives, ctx)` — returns `ctx.handoffToTask(fn)`
 *     for the standards-and-practices review (24-48 hour SLA in
 *     production; demo uses `standardsReviewMs`).
 *
 * Lifecycle changes after acceptance (plan goes from `pending_start` →
 * `active` → `completed` over the campaign window) flow via
 * `publishStatusChange`.
 *
 * @see `skills/build-decisioning-platform/SKILL.md`
 */

import {
  AdcpError,
  publishStatusChange,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
  type SyncCreativesRow,
} from '@adcp/sdk/server';
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
} from '@adcp/sdk/types';

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
  [key: string]: unknown;
}

type BroadcastBuy = CreateMediaBuySuccess & { daypart?: string };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class BroadcastTvSeller implements DecisioningPlatform<BroadcastTvConfig, BroadcastTvMeta> {
  private mediaBuys = new Map<string, BroadcastBuy>();

  capabilities = {
    specialisms: ['sales-broadcast-tv'] as const,
    creative_agents: [{ agent_url: 'https://example.com/broadcast-creative-agent/mcp' }],
    channels: ['linear_tv'] as const,
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
        name: `Broadcast TV — ${id}`,
        status: 'active',
        operator: 'broadcast.example.com',
        ctx_metadata: { agency_buyer_id: 'agc_42', affiliate_advertiser_id: 'aff_99' },
        authInfo: { kind: 'api_key' },
      };
    },
  };

  sales: SalesPlatform<BroadcastTvMeta> = {
    /**
     * Sync catalog read. Returns the affiliate's standing packages —
     * primetime daypart, sports tentpoles, etc. Brief-based proposal
     * generation is a separate verb the spec is consolidating
     * (adcp#3407 `request_proposal`); proposal-mode adopters surface
     * the eventual products via `publishStatusChange` on
     * `resource_type: 'proposal'`.
     */
    getProducts: async (req: GetProductsRequest): Promise<GetProductsResponse> => {
      const promotedOffering = (req as { promoted_offering?: string }).promoted_offering ?? '';
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
            publisher_properties: [{ publisher_domain: 'broadcast.example.com', selection_type: 'all' }],
            reporting_capabilities: {
              available_reporting_frequencies: ['daily'],
              expected_delay_minutes: 240,
              timezone: 'UTC',
              supports_webhooks: false,
              available_metrics: [],
              date_range_support: 'date_range',
            },
            pricing_options: [
              {
                pricing_option_id: 'cpm_42_00',
                pricing_model: 'cpm',
                fixed_price: 42.0,
                currency: 'USD',
                min_spend_per_package: 5_000,
              },
            ],
          },
        ],
      };
    },

    /**
     * Hybrid HITL: trafficker review + IO sign-off. Buyer sees `submitted`
     * envelope with `task_id` immediately; the framework runs the handoff
     * fn in background. Trafficker accepts → handoff returns the wire
     * `Success` arm with `media_buy_id`; trafficker rejects → handoff
     * throws `AdcpError`, framework surfaces terminal error.
     *
     * Pre-flight runs sync (rejects bad budgets before allocating a task
     * id). Lifecycle after acceptance flows via `publishStatusChange`.
     */
    createMediaBuy: (req, ctx) => {
      // Pre-flight runs sync regardless of path
      const errors = this.preflight(req);
      if (errors.length > 0) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'correctable',
          message: errors[0]!.message,
          field: errors[0]!.field,
          details: { errors },
        });
      }

      return Promise.resolve(
        ctx.handoffToTask(async taskCtx => {
          void taskCtx; // taskCtx.id available if you need to log it
          // Trafficker review window
          await new Promise(r => setTimeout(r, this.capabilities.config.trafficReviewMs));

          const buyId = `mb_${this.capabilities.config.affiliateId}_${Date.now()}`;
          const buy: BroadcastBuy = {
            media_buy_id: buyId,
            status: 'pending_start',
            confirmed_at: new Date().toISOString(),
            revision: 1,
            daypart: 'primetime',
            packages: [],
          };
          this.mediaBuys.set(buyId, buy);

          // After acceptance, the broadcast traffic system controls the
          // campaign window. Schedule the post-acceptance status-change.
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

          return buy;
        })
      );
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
      // Broadcast: pause = preempt the schedule; canceled is irreversible
      // (cannot reactivate without a fresh IO).
      if (patch.paused === true) existing.status = 'paused';
      if (patch.paused === false && existing.status === 'paused') existing.status = 'active';
      return { media_buy_id: existing.media_buy_id, status: existing.status, revision: existing.revision };
    },

    /**
     * Hybrid HITL S&P review: every spot goes through standards-and-
     * practices before it can air. 24-48 hour SLA in production. Returns
     * `ctx.handoffToTask(fn)` so the buyer sees the submitted envelope
     * immediately and the review runs in background.
     */
    syncCreatives: (creatives, ctx) =>
      Promise.resolve(
        ctx.handoffToTask(async taskCtx => {
          void taskCtx;
          await new Promise(r => setTimeout(r, this.capabilities.config.standardsReviewMs));
          // Mock policy: anything tagged "political" rejects; rest approve.
          return creatives.map(c => {
            const id = (c as { creative_id?: string }).creative_id ?? `cr_${Math.random()}`;
            const tags = ((c as { tags?: string[] }).tags ?? []).map(t => t.toLowerCase());
            if (tags.includes('political')) {
              return {
                creative_id: id,
                action: 'failed',
                status: 'rejected',
                errors: [
                  {
                    code: 'CREATIVE_REJECTED',
                    message: 'Political ads require FCC disclosure file + station GM sign-off',
                  },
                ],
              } satisfies SyncCreativesRow;
            }
            return { creative_id: id, action: 'created', status: 'approved' } satisfies SyncCreativesRow;
          });
        })
      ),

    getMediaBuyDelivery: async (filter: GetMediaBuyDeliveryRequest): Promise<GetMediaBuyDeliveryResponse> => {
      return {
        currency: 'USD',
        reporting_period: {
          start: filter.start_date ?? '2026-04-01',
          end: filter.end_date ?? '2026-04-30',
        },
        media_buy_deliveries: [],
      };
    },
  };

  private preflight(req: CreateMediaBuyRequest): { code: string; recovery: string; message: string; field: string }[] {
    const errors = [];
    const totalBudget =
      typeof req.total_budget === 'number'
        ? req.total_budget
        : ((req.total_budget as { amount?: number })?.amount ?? 0);
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
