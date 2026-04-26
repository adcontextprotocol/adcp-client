/**
 * SalesPlatform — sales specialism platform interface (v2 dual-method shape).
 *
 * Each spec-HITL-eligible tool (`get_products`, `create_media_buy`,
 * `update_media_buy`, `sync_creatives`) exposes a method-pair. Adopter
 * implements EXACTLY ONE per pair:
 *
 *   - **Sync variant** (`xxx`): adopter returns the resource synchronously.
 *     Framework awaits in foreground; projects to wire success arm.
 *     Lifecycle changes flow via `publishStatusChange(...)` or per-resource
 *     read endpoints (e.g., `getMediaBuys`).
 *
 *   - **HITL variant** (`xxxTask`): framework creates a task BEFORE calling
 *     the platform method, returns submitted envelope to buyer immediately,
 *     then runs the task method in background. Method's return value
 *     becomes the task's terminal state. The `taskId` parameter signals
 *     "you're in HITL background; framework already responded to the buyer."
 *
 * Type-level both are optional; `validatePlatform()` enforces exactly-one
 * per spec-HITL tool at construction time (and `RequiredPlatformsFor<S>`
 * enforces which variant per specialism — `sales-broadcast-tv` requires
 * `*Task`; `sales-social` requires sync; `sales-non-guaranteed` accepts
 * either).
 *
 * Each method either returns the value or throws `AdcpError` for
 * structured rejection. Generic thrown errors map to `SERVICE_UNAVAILABLE`.
 *
 * `getMediaBuyDelivery` is sync-only at the wire level today. For platforms
 * with manual report-running, return the request acknowledgment + emit
 * `delivery_status_changes` via `publishStatusChange(...)`.
 *
 * Status: Preview / 6.0.
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
  // ── get_products: sync OR task (custom proposal system) ─────────────

  /** Sync discovery: brief in, products out. Most platforms. */
  getProducts?(req: GetProductsRequest, ctx: Ctx): Promise<GetProductsResponse>;

  /**
   * HITL discovery: framework creates task; platform runs through
   * proposal/offline workflow and returns when products are ready.
   * Buyer initially sees a submitted envelope with `task_id`; resource
   * lands on the task's completion artifact.
   */
  getProductsTask?(taskId: string, req: GetProductsRequest, ctx: Ctx): Promise<GetProductsResponse>;

  // ── create_media_buy: sync OR task (broadcast TV / guaranteed) ──────

  /**
   * Sync media-buy creation. Return the resolved `MediaBuy` immediately.
   * Status changes (pending_creatives → active → completed) flow via
   * `publishStatusChange(...)` after creation.
   */
  createMediaBuy?(req: CreateMediaBuyRequest, ctx: Ctx): Promise<MediaBuy>;

  /**
   * HITL media-buy creation. Framework creates task before calling this;
   * platform reserves inventory + runs internal checks + returns the
   * MediaBuy once accepted. `media_buy_id` is unknown to the buyer until
   * the task completes.
   */
  createMediaBuyTask?(taskId: string, req: CreateMediaBuyRequest, ctx: Ctx): Promise<MediaBuy>;

  // ── update_media_buy: sync OR task (re-approval edge) ───────────────

  /**
   * Sync update. Most patches apply immediately; status changes that
   * follow (e.g., `paused` → `active` after operator confirms re-spend)
   * flow via `publishStatusChange(...)`.
   *
   * The patch is the wire shape. Adopters whose underlying platform
   * exposes action verbs dispatch locally on the patch fields.
   */
  updateMediaBuy?(buyId: string, patch: UpdateMediaBuyRequest, ctx: Ctx): Promise<MediaBuy>;

  /** HITL update. Re-approval workflows that gate the patch from applying at all. */
  updateMediaBuyTask?(taskId: string, buyId: string, patch: UpdateMediaBuyRequest, ctx: Ctx): Promise<MediaBuy>;

  // ── sync_creatives: sync OR task (mandatory pre-persist review) ─────

  /**
   * Sync creative push. Returns per-creative status array — buyers see
   * mixed `approved` / `pending_review` rows in one response. Subsequent
   * review state changes flow via `publishStatusChange(...)`.
   */
  syncCreatives?(creatives: Creative[], ctx: Ctx): Promise<CreativeReviewResult[]>;

  /**
   * HITL creative review. Framework creates task; platform queues for
   * mandatory review before persisting any creative. Return the per-
   * creative results once review is complete.
   */
  syncCreativesTask?(taskId: string, creatives: Creative[], ctx: Ctx): Promise<CreativeReviewResult[]>;

  // ── get_media_buy_delivery: sync only at the wire level ─────────────

  getMediaBuyDelivery(filter: GetMediaBuyDeliveryRequest, ctx: Ctx): Promise<DeliveryActuals>;
}

// ---------------------------------------------------------------------------
// Shared shapes — re-export from generated for now; tighten later.
// ---------------------------------------------------------------------------

/** Re-exported from tools.generated; matches wire schema's MediaBuy shape. */
export type MediaBuy = import('../../../types/tools.generated').GetMediaBuysResponse['media_buys'][number];

/** Re-exported from tools.generated; matches wire schema's delivery row shape. */
export type DeliveryActuals = import('../../../types/tools.generated').GetMediaBuyDeliveryResponse;
