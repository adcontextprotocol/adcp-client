/**
 * SalesPlatform — sales specialism platform interface (v1.0).
 *
 * One interface for all sales specialisms (sales-non-guaranteed in v1.0;
 * sales-guaranteed and sales-broadcast-tv in v1.1). Behavioral variation is
 * driven by capabilities (channels, pricing models) and by the
 * `MediaBuy.status` enum the platform sets in its responses — NOT by
 * splitting into per-variant interfaces.
 *
 * Five methods. Each maps 1:1 to an AdCP wire tool.
 *
 * Status: Preview / 6.0. Not yet wired into the framework.
 *
 * @public
 */

import type { AsyncOutcome } from '../async-outcome';
import type { Account } from '../account';
import type {
  GetProductsRequest,
  GetProductsResponse,
  CreateMediaBuyRequest,
  UpdateMediaBuyRequest,
  GetMediaBuyDeliveryRequest,
  CreativeAsset,
} from '../../../types/tools.generated';

type Creative = CreativeAsset;
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
  getProducts(req: GetProductsRequest, account: Account): Promise<GetProductsResponse>;

  /**
   * Single-shot media-buy creation. Returns one of three outcomes:
   *   - `{ kind: 'sync', result: MediaBuy }` — immediate state (active OR
   *     pending_creatives, depending on whether creative_assignments arrived)
   *   - `{ kind: 'submitted', taskHandle }` — IO signing or governance review
   *     pending; framework emits A2A task envelope; platform calls
   *     taskHandle.notify when its workflow completes
   *   - `{ kind: 'rejected', error }` — TERMS_REJECTED, GOVERNANCE_DENIED,
   *     INVALID_REQUEST, etc.
   *
   * The MediaBuy.status enum (pending_creatives / pending_start / active /
   * paused / completed / rejected / canceled) carries the wire status from
   * the spec verbatim; outcome.kind is orthogonal (sync vs async completion).
   */
  createMediaBuy(req: CreateMediaBuyRequest, account: Account): Promise<AsyncOutcome<MediaBuy>>;

  /**
   * Mutate an existing buy: bid, budget, dates, status, packages.
   * Async-eligible because some patches trigger approval workflows
   * (e.g., increasing total_budget past a credit-line threshold).
   *
   * The patch is the wire shape. Adopters whose underlying platform exposes
   * action verbs (GAM's `PauseLineItems` / `ResumeLineItems` / `ArchiveLineItems`,
   * Prebid's action-string convention) dispatch locally on the patch fields:
   *
   * ```ts
   * updateMediaBuy: async (buyId, patch, account) => {
   *   if (patch.active === false) return this.pause(buyId, account);
   *   if (patch.active === true)  return this.resume(buyId, account);
   *   // ... fall through to a generic patch apply
   * };
   * ```
   *
   * Don't ask the framework for an action-based convenience surface — it
   * would duplicate the wire shape and drift as the spec evolves.
   */
  updateMediaBuy(buyId: string, patch: UpdateMediaBuyRequest, account: Account): Promise<AsyncOutcome<MediaBuy>>;

  /**
   * Unified creative review. Framework normalizes both wire paths
   * (sync_creatives push AND inline creative_assignments[]) so the platform
   * sees one decision per creative regardless of intake channel.
   *
   * Async-eligible because platforms with manual review (Innovid, broadcast
   * TV approval) take 4-72 hours; platform returns submitted, framework polls
   * or accepts notify pushes.
   */
  syncCreatives(creatives: Creative[], account: Account): Promise<AsyncOutcome<CreativeReviewResult[]>>;

  /**
   * Delivery + spend reporting.
   *
   * Async-eligible because large reports run async (GAM runReportJob, BigQuery
   * exports). Small reports return sync. Framework owns the wire-shape
   * mapping (top-level currency, billing-quintet on package rows, ISO 8601
   * date-time on reporting_period).
   */
  getMediaBuyDelivery(filter: GetMediaBuyDeliveryRequest, account: Account): Promise<AsyncOutcome<DeliveryActuals>>;
}

// ---------------------------------------------------------------------------
// Shared shapes — re-export from generated for now; tighten later.
// ---------------------------------------------------------------------------

/** Re-exported from tools.generated; matches wire schema's MediaBuy shape. */
export type MediaBuy = import('../../../types/tools.generated').GetMediaBuysResponse['media_buys'][number];

/** Re-exported from tools.generated; matches wire schema's delivery row shape. */
export type DeliveryActuals = import('../../../types/tools.generated').GetMediaBuyDeliveryResponse;
