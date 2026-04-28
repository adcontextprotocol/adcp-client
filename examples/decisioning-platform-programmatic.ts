/**
 * ProgrammaticSeller — worked example for `sales-non-guaranteed`.
 *
 * Programmatic non-guaranteed is the canonical sync case: buyer hits
 * `create_media_buy`, gets a `media_buy_id` immediately, the SSP queues
 * the line item for serving. Lifecycle changes (`pending_creatives` →
 * `active` once creatives clear review; `active` → `completed` at
 * end_time; pacing-driven `paused` events) flow via `publishStatusChange`.
 *
 * Demonstrates the v2.1 sync-first shape:
 *
 *   - Sync `getProducts` (catalog read; no async ceremony).
 *   - Sync `createMediaBuy` (returns MediaBuy immediately on commit).
 *   - Sync `syncCreatives` (per-creative status; mixed approved/pending in
 *     one response — review continues async, status-change fires when
 *     review terminal).
 *   - `publishStatusChange` for everything that happens *after* the
 *     synchronous request returns.
 *
 * @see `docs/proposals/decisioning-platform-v2-hitl-split.md`
 */

import {
  AdcpError,
  publishStatusChange,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
} from '@adcp/client/server/decisioning';
import type { SyncCreativesRow } from '@adcp/client/server/decisioning';
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

export interface ProgrammaticConfig {
  /** SSP network identifier. */
  networkId: string;
  /** Floor CPM in USD. */
  floorCpm: number;
  /**
   * Latency (ms) between sync `createMediaBuy` returning and the
   * `pending_creatives` → `active` status-change firing. Demo simulates
   * the time creative review takes after the buy is committed.
   */
  creativeReviewMs: number;
}

interface ProgrammaticMeta {
  network_id: string;
  advertiser_id: string;
}

type ProgrammaticBuy = CreateMediaBuySuccess;

export class ProgrammaticSeller implements DecisioningPlatform<ProgrammaticConfig, ProgrammaticMeta> {
  private mediaBuys = new Map<string, ProgrammaticBuy>();

  capabilities = {
    specialisms: ['sales-non-guaranteed'] as const,
    creative_agents: [{ agent_url: 'https://example.com/programmatic-creative-agent/mcp' }],
    channels: ['display', 'video', 'native'] as const,
    pricingModels: ['cpm'] as const,
    config: {
      networkId: 'NET_42',
      floorCpm: 1.5,
      creativeReviewMs: 60,
    } satisfies ProgrammaticConfig,
  };

  statusMappers = {};

  accounts: AccountStore<ProgrammaticMeta> = {
    resolve: async (ref: AccountReference) => {
      const id = 'account_id' in ref ? ref.account_id : 'prog_acc_1';
      return {
        id,
        name: `Programmatic — ${id}`,
        status: 'active',
        operator: 'programmatic.example.com',
        metadata: { network_id: this.capabilities.config.networkId, advertiser_id: 'adv_42' },
        authInfo: { kind: 'api_key' },
      };
    },
  };

  sales: SalesPlatform = {
    /** Sync discovery: catalog read; no async ceremony. */
    getProducts: async (_req: GetProductsRequest): Promise<GetProductsResponse> => ({
      products: [
        {
          product_id: 'prod_run_of_network_display',
          name: 'RON Display',
          description: 'Run-of-network display, 300x250 + 728x90',
          format_ids: [{ id: 'display_300x250', agent_url: 'https://example.com/programmatic-creative-agent/mcp' }],
          delivery_type: 'non_guaranteed',
          publisher_properties: { reportable: true },
          reporting_capabilities: { available_dimensions: ['geo', 'creative', 'site'] },
          pricing_options: [{ pricing_model: 'cpm', rate: 2.5, currency: 'USD' }],
        },
        {
          product_id: 'prod_premium_video_15s',
          name: 'Premium Video 15s',
          description: 'In-stream video on premium publishers',
          format_ids: [{ id: 'video_15s', agent_url: 'https://example.com/programmatic-creative-agent/mcp' }],
          delivery_type: 'non_guaranteed',
          publisher_properties: { reportable: true },
          reporting_capabilities: { available_dimensions: ['geo', 'creative', 'site'] },
          pricing_options: [{ pricing_model: 'cpm', rate: 18.0, currency: 'USD' }],
        },
      ],
    }),

    /**
     * Sync media-buy creation. Buyer gets media_buy_id immediately; status
     * transitions out of `pending_creatives` flow via publishStatusChange.
     */
    createMediaBuy: async (req: CreateMediaBuyRequest) => {
      const totalBudget =
        typeof req.total_budget === 'number'
          ? req.total_budget
          : ((req.total_budget as { amount?: number })?.amount ?? 0);
      if (totalBudget < this.capabilities.config.floorCpm * 1000) {
        throw new AdcpError('BUDGET_TOO_LOW', {
          recovery: 'correctable',
          message: `total_budget below floor (${this.capabilities.config.floorCpm} CPM × 1000 imp)`,
          field: 'total_budget',
          suggestion: `Raise to at least ${this.capabilities.config.floorCpm * 1000}`,
        });
      }

      const buyId = `mb_${this.capabilities.config.networkId}_${Date.now()}`;
      const buy: ProgrammaticBuy = {
        media_buy_id: buyId,
        status: 'pending_creatives',
        confirmed_at: new Date().toISOString(),
        revision: 1,
      };
      this.mediaBuys.set(buyId, buy);
      void totalBudget;

      // Demo: schedule the pending_creatives → active transition once
      // creative review clears. In production this fires from the SSP's
      // creative-review webhook handler.
      const account = (req as { account?: { account_id?: string } }).account;
      const accountId = account?.account_id ?? 'prog_acc_1';
      setTimeout(() => {
        buy.status = 'active';
        publishStatusChange({
          account_id: accountId,
          resource_type: 'media_buy',
          resource_id: buyId,
          payload: { status: 'active', activated_at: new Date().toISOString() },
        });
      }, this.capabilities.config.creativeReviewMs).unref?.();

      return buy;
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
      if (patch.active === false) existing.status = 'paused';
      if (patch.active === true && existing.status === 'paused') existing.status = 'active';
      return { media_buy_id: existing.media_buy_id, status: existing.status, revision: existing.revision };
    },

    /**
     * Sync per-creative review with mixed approved/pending rows. Review
     * continues async — the seller's review pipeline pushes status changes
     * via publishStatusChange when each creative reaches terminal state.
     */
    syncCreatives: async (creatives: CreativeAsset[]): Promise<SyncCreativesRow[]> => {
      return creatives.map(c => {
        const id = (c as { creative_id?: string }).creative_id ?? `cr_${Math.random()}`;
        const formatId = (c as { format_id?: { id?: string } }).format_id?.id ?? '';
        const needsReview = formatId.startsWith('video_');
        if (needsReview) {
          // Schedule the pending → approved transition for the demo
          setTimeout(() => {
            publishStatusChange({
              account_id: 'prog_acc_1',
              resource_type: 'creative',
              resource_id: id,
              payload: { status: 'approved', reviewed_at: new Date().toISOString() },
            });
          }, this.capabilities.config.creativeReviewMs).unref?.();
        }
        return {
          creative_id: id,
          action: 'created',
          status: needsReview ? 'pending_review' : 'approved',
        };
      });
    },

    getMediaBuyDelivery: async (filter: GetMediaBuyDeliveryRequest): Promise<GetMediaBuyDeliveryResponse> => ({
      currency: 'USD',
      reporting_period: {
        start: filter.start_date ?? '2026-04-01',
        end: filter.end_date ?? '2026-04-30',
      },
      media_buys: [],
    }),
  };
}
