/**
 * CreativeAdServerPlatform — third creative archetype (v6.0).
 *
 * Stateful creative library + per-creative pricing + tag generation. The
 * canonical shape for creative-ad-server adopters: Innovid, Flashtalking,
 * GAM-creative, CMP-style platforms.
 *
 * Distinct from `CreativeTemplatePlatform` (stateless transform) and
 * `CreativeGenerativePlatform` (brief-driven generation):
 *
 *   - **Stateful** — adopter persists creatives in a library; `syncCreatives`
 *     pushes assets in, `listCreatives` reads them back, `buildCreative`
 *     either looks up an existing creative by id OR pushes a new one
 *   - **Pricing per creative** — vendor pricing options on each creative;
 *     `pricing_option_id` selected at activation, billed via `report_usage`
 *   - **Tag generation** — `buildCreative` returns ad-server tags (VAST,
 *     placement-specific tracking pixels, macro-substituted creative HTML)
 *     when invoked with `media_buy_id` + `package_id` context
 *   - **Per-creative delivery reports** — `get_creative_delivery` returns
 *     pacing data per creative across the library
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type {
  BuildCreativeRequest,
  CreativeManifest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  ListCreativesRequest,
  ListCreativesResponse,
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
  CreativeAsset,
} from '../../../types/tools.generated';
import type { SyncCreativesRow } from './sales';

type Creative = CreativeAsset;
type Ctx = RequestContext<Account>;

export interface CreativeAdServerPlatform {
  /**
   * Build / retrieve creative tags. Two invocation modes per the spec:
   *
   *   - **Library lookup**: `req.creative_id` references an existing
   *     creative; return the manifest with tag fields populated
   *     (`vast_tag`, click trackers, etc.). When `req.media_buy_id` +
   *     `req.package_id` are also set, generate placement-specific tags
   *     with macro substitution baked in.
   *   - **Inline build**: `req.creative_manifest` is provided directly;
   *     transform / wrap it (similar to template archetype but with
   *     ad-server side effects: register the creative in the library,
   *     generate the tag, etc.).
   *
   * Sync only — `BuildCreativeResponse` has no `Submitted` arm. Slow
   * tag-generation pipelines await in-request; status changes for
   * downstream effects flow via `publishStatusChange`.
   */
  buildCreative(req: BuildCreativeRequest, ctx: Ctx): Promise<CreativeManifest>;

  /** Preview-only variant — sandbox URL or inline HTML, expires. Always sync. */
  previewCreative(req: PreviewCreativeRequest, ctx: Ctx): Promise<PreviewCreativeResponse>;

  // sync_creatives: sync OR task — `SyncCreativesResponse` has a Submitted arm.

  /**
   * Sync creative push. Persist the assets into your library and return
   * per-creative result rows. `action: 'created'` for new entries,
   * `'updated'` for replacements, `'unchanged'` when the asset already
   * matches. Optional `status: 'pending_review'` for assets awaiting
   * manual review.
   */
  syncCreatives?(creatives: Creative[], ctx: Ctx): Promise<SyncCreativesRow[]>;

  /**
   * HITL creative review. Framework returns the submitted envelope to the
   * buyer; this method runs in background. Returns per-creative result
   * rows once review is complete. Use when your platform requires
   * mandatory pre-persist approval (brand-suitability, S&P).
   */
  syncCreativesTask?(taskId: string, creatives: Creative[], ctx: Ctx): Promise<SyncCreativesRow[]>;

  /**
   * Read creatives from the library. Filters + pagination. When
   * `req.include_assignments`, include the buyer's package-assignment
   * graph. When `req.include_pricing`, include vendor pricing options
   * on each creative.
   */
  listCreatives(req: ListCreativesRequest, ctx: Ctx): Promise<ListCreativesResponse>;

  /**
   * Per-creative delivery actuals (impressions, spend, pacing). Sync —
   * report-running platforms with manual report cycles return the
   * latest cached actuals and emit `delivery_report` status changes
   * via `publishStatusChange` when fresh reports are available.
   */
  getCreativeDelivery(filter: GetCreativeDeliveryRequest, ctx: Ctx): Promise<GetCreativeDeliveryResponse>;
}
