/**
 * SalesPlatform — sales specialism platform interface (v1.0).
 *
 * One interface for all sales specialisms (sales-non-guaranteed in v1.0;
 * sales-guaranteed and sales-broadcast-tv in v1.1). Behavioral variation is
 * driven by capabilities (channels, pricing models) and by the
 * `MediaBuy.status` enum the platform sets in its responses — NOT by
 * splitting into per-variant interfaces.
 *
 * Five methods. Each maps 1:1 to an AdCP wire tool. Each returns a plain
 * `Promise<T>`: the framework projects the resolved value to the wire success
 * arm, and catches `AdcpError` thrown from the method to project the
 * structured error envelope. Generic thrown errors (`Error`, `TypeError`)
 * surface as `SERVICE_UNAVAILABLE`. Adopters who need explicit async-task
 * envelopes use `ctx.runAsync(opts, fn)` (in-process) or `ctx.startTask()`
 * (out-of-process) — see `RequestContext` JSDoc.
 *
 * Status: Preview / 6.0. Not yet wired into the framework.
 *
 * @public
 */

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type {
  GetProductsRequest,
  GetProductsResponse,
  CreateMediaBuyRequest,
  UpdateMediaBuyRequest,
  GetMediaBuyDeliveryRequest,
  CreativeAsset,
} from '../../../types/tools.generated';

type Creative = CreativeAsset;
type Ctx = RequestContext<Account>;
import type { CreativeReviewResult } from './creative';

export interface SalesPlatform {
  /**
   * Discovery — given a brief, what products do I offer?
   *
   * Synchronous in nearly every real platform. Framework auto-tracks
   * proposal_id values in the response so they round-trip to subsequent
   * get_products(refine) calls and create_media_buy without the platform
   * re-resolving them.
   */
  getProducts(req: GetProductsRequest, ctx: Ctx): Promise<GetProductsResponse>;

  /**
   * Create a media buy. Return the resolved `MediaBuy` for the success arm;
   * `throw new AdcpError(...)` for buyer-facing rejection
   * (`BUDGET_TOO_LOW`, `TERMS_REJECTED`, `GOVERNANCE_DENIED`, etc.).
   *
   * If the platform's underlying workflow can take longer than the
   * framework's auto-defer threshold (~30s by default), wrap with
   * `ctx.runAsync({ message, partialResult }, async () => ...)` to opt
   * into the submitted-task envelope. Adopters whose async approval
   * happens out-of-process (operator webhook arrives hours later, possibly
   * in a different request) use `ctx.startTask()` for explicit handle
   * management.
   *
   * The MediaBuy.status enum (pending_creatives / pending_start / active /
   * paused / completed / rejected / canceled) carries the wire status from
   * the spec verbatim.
   */
  createMediaBuy(req: CreateMediaBuyRequest, ctx: Ctx): Promise<MediaBuy>;

  /**
   * Mutate an existing buy: bid, budget, dates, status, packages.
   *
   * The patch is the wire shape. Adopters whose underlying platform exposes
   * action verbs (GAM's `PauseLineItems` / `ResumeLineItems` / `ArchiveLineItems`,
   * Prebid's action-string convention) dispatch locally on the patch fields:
   *
   * ```ts
   * updateMediaBuy: async (buyId, patch, ctx) => {
   *   if (patch.active === false) return this.pause(buyId, ctx);
   *   if (patch.active === true)  return this.resume(buyId, ctx);
   *   // ... fall through to a generic patch apply
   * };
   * ```
   *
   * Don't ask the framework for an action-based convenience surface — it
   * would duplicate the wire shape and drift as the spec evolves.
   *
   * `update_media_buy` has no wire submitted arm. If a patch triggers an
   * async re-approval workflow, return the current state (with `paused`
   * status if applicable); the buyer polls `get_media_buys` for resolution.
   */
  updateMediaBuy(buyId: string, patch: UpdateMediaBuyRequest, ctx: Ctx): Promise<MediaBuy>;

  /**
   * Unified creative review. Framework normalizes both wire paths
   * (sync_creatives push AND inline creative_assignments[]) so the platform
   * sees one decision per creative regardless of intake channel.
   *
   * Per-creative review status is the natural shape: return
   * `CreativeReviewResult[]` with each row carrying its own status
   * (`approved` / `rejected` / `pending_review`). Buyers see partial
   * approvals immediately; the framework projects per-row status onto the
   * wire response.
   *
   * For platforms whose entire batch goes through async manual review
   * (Innovid, broadcast TV approval — 4-72h SLA), return rows with
   * `status: 'pending_review'` and use `ctx.startTask()` to issue a handle
   * the platform's review pipeline calls `notify(...)` on per-creative.
   */
  syncCreatives(creatives: Creative[], ctx: Ctx): Promise<CreativeReviewResult[]>;

  /**
   * Delivery + spend reporting.
   *
   * Synchronous in most paths; large reports (GAM runReportJob, BigQuery
   * exports) take longer than the auto-defer threshold — wrap with
   * `ctx.runAsync(...)` to issue a task envelope. Framework owns the
   * wire-shape mapping (top-level currency, billing-quintet on package
   * rows, ISO 8601 date-time on reporting_period).
   */
  getMediaBuyDelivery(filter: GetMediaBuyDeliveryRequest, ctx: Ctx): Promise<DeliveryActuals>;
}

// ---------------------------------------------------------------------------
// Shared shapes — re-export from generated for now; tighten later.
// ---------------------------------------------------------------------------

/** Re-exported from tools.generated; matches wire schema's MediaBuy shape. */
export type MediaBuy = import('../../../types/tools.generated').GetMediaBuysResponse['media_buys'][number];

/** Re-exported from tools.generated; matches wire schema's delivery row shape. */
export type DeliveryActuals = import('../../../types/tools.generated').GetMediaBuyDeliveryResponse;
