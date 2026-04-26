/**
 * SalesPlatform — sales specialism platform interface (v2.1).
 *
 * **HITL coverage matches the AdCP wire spec.** Only `create_media_buy` and
 * `sync_creatives` define `Submitted` arms in their sync response unions;
 * those are the two tools where the v2.1 dual-method shape applies. Every
 * other tool is sync-only:
 *
 *   - `get_products` — sync. Brief in, products out.
 *   - `create_media_buy` — sync OR `*Task` HITL.
 *   - `update_media_buy` — sync only. Re-approval flows that need HITL run
 *     out-of-band; `publishStatusChange` carries the result.
 *   - `sync_creatives` — sync OR `*Task` HITL.
 *   - `get_media_buy_delivery` — sync only.
 *
 * For the two HITL-eligible tools, adopter implements EXACTLY ONE per pair:
 *
 *   - **Sync variant** (`xxx`): adopter returns the wire success arm
 *     synchronously. Framework awaits in foreground; projects the value to
 *     the wire response. Lifecycle changes flow via `publishStatusChange(...)`.
 *
 *   - **HITL variant** (`xxxTask`): framework allocates `taskId` BEFORE
 *     calling the platform, returns the spec-defined submitted envelope
 *     (`{ status: 'submitted', task_id }`) to the buyer immediately, then
 *     runs the task method in background. Method's return value becomes
 *     the task's terminal artifact.
 *
 * Sync-only tools that need long completion semantics use
 * `publishStatusChange` (see `status-changes.ts`) — that's the spec-aligned
 * channel for tools whose wire response unions don't define a Submitted
 * arm. See `docs/proposals/decisioning-platform-v2-hitl-split.md`
 * § "v2.1 spec-alignment" for rationale.
 *
 * Each method either returns the value or throws `AdcpError` for structured
 * rejection. Generic thrown errors map to `SERVICE_UNAVAILABLE`.
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
  CreateMediaBuySuccess,
  UpdateMediaBuyRequest,
  UpdateMediaBuySuccess,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  SyncCreativesSuccess,
  CreativeAsset,
} from '../../../types/tools.generated';

type Creative = CreativeAsset;
type Ctx = RequestContext<Account>;

/**
 * Wire success-row shape for `sync_creatives`. Returning the array of these
 * rows from `syncCreatives` is what adopters write — the framework wraps
 * with `{ creatives: [...] }` to form `SyncCreativesSuccess`.
 */
export type SyncCreativesRow = SyncCreativesSuccess['creatives'][number];

export interface SalesPlatform {
  // ── get_products: sync only ─────────────────────────────────────────
  // Spec doesn't define a Submitted arm in GetProductsResponse. Long-form
  // proposal/offline workflows surface the eventual proposal via per-account
  // notification channels, not this tool.
  /** Sync discovery: brief in, products out. */
  getProducts(req: GetProductsRequest, ctx: Ctx): Promise<GetProductsResponse>;

  // ── create_media_buy: sync OR task ──────────────────────────────────

  /**
   * Sync media-buy creation. Return the wire success-arm shape immediately.
   * Status changes (pending_creatives → active → completed) flow via
   * `publishStatusChange(...)` after creation.
   *
   * Required: `media_buy_id`. Other fields optional — populate the ones
   * your platform tracks at creation time.
   */
  createMediaBuy?(req: CreateMediaBuyRequest, ctx: Ctx): Promise<CreateMediaBuySuccess>;

  /**
   * HITL media-buy creation. Framework returns the submitted envelope to
   * the buyer; this method runs in background. Method's return value
   * becomes the task's terminal artifact.
   */
  createMediaBuyTask?(taskId: string, req: CreateMediaBuyRequest, ctx: Ctx): Promise<CreateMediaBuySuccess>;

  // ── update_media_buy: sync only ─────────────────────────────────────
  // Spec doesn't define a Submitted arm in UpdateMediaBuyResponse. Operator
  // re-approval flows return the patched buy synchronously after the
  // operator confirms (or with the previous state if a re-approval is queued
  // off-band) and `publishStatusChange` carries the eventual transition.
  /** Sync update. Returns the patched buy. */
  updateMediaBuy(buyId: string, patch: UpdateMediaBuyRequest, ctx: Ctx): Promise<UpdateMediaBuySuccess>;

  // ── sync_creatives: sync OR task ────────────────────────────────────

  /**
   * Sync creative push. Returns the array of wire success rows — one per
   * creative processed. Each row carries `action` (CRUD outcome) and
   * optional `status` (review state). Buyers see mixed `approved` /
   * `pending_review` rows in one response. Subsequent review state changes
   * flow via `publishStatusChange(...)`.
   */
  syncCreatives?(creatives: Creative[], ctx: Ctx): Promise<SyncCreativesRow[]>;

  /**
   * HITL creative review. Framework returns the submitted envelope to the
   * buyer; this method runs in background. Returns per-creative result rows
   * once review is complete.
   */
  syncCreativesTask?(taskId: string, creatives: Creative[], ctx: Ctx): Promise<SyncCreativesRow[]>;

  // ── get_media_buy_delivery: sync only ───────────────────────────────

  getMediaBuyDelivery(filter: GetMediaBuyDeliveryRequest, ctx: Ctx): Promise<GetMediaBuyDeliveryResponse>;
}
