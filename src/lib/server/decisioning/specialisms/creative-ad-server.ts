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

import type { Account, NoAccountCtx } from '../account';
import type { RequestContext } from '../context';
import type { TaskHandoff } from '../async-outcome';
import type { ServerPayload } from '../../../types/server-payload';
import type {
  BuildCreativeRequest,
  CreativeManifest,
  PreviewCreativeRequest as LegacyPreviewCreativeRequest,
  PreviewCreativeResponse as LegacyPreviewCreativeResponse,
  ListCreativesRequest,
  ListCreativesResponse,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
  BuildCreativeSuccess,
  BuildCreativeMultiSuccess,
  BuildCreativeVariantSuccess,
} from '../../../types/tools.generated';
import type {
  CanonicalSyncCreativeAsset,
  CanonicalCreativeResponse,
  CanonicalListCreativesRequest,
  CanonicalListCreativesResponse,
  CanonicalPreviewCreativeRequest,
  CanonicalPreviewCreativeResponse,
} from '../../../v2/projection/creative-delivery';
import type { SyncCreativesRow } from './sales';

type SyncCreative = CanonicalSyncCreativeAsset;
type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

export type PreviewCreativePayload = ServerPayload<CanonicalPreviewCreativeResponse>;
export type LegacyPreviewCreativePayload = ServerPayload<LegacyPreviewCreativeResponse>;
export type LegacyListCreativeFormatsPayload = ServerPayload<ListCreativeFormatsResponse>;
export type ListCreativesPayload = ServerPayload<CanonicalListCreativesResponse>;
export type GetCreativeDeliveryPayload = ServerPayload<CanonicalCreativeResponse<GetCreativeDeliveryResponse>>;
export type LegacyGetCreativeDeliveryPayload = ServerPayload<GetCreativeDeliveryResponse>;
export type LegacyBuildCreativePayload = ServerPayload<BuildCreativeSuccess>;
export type LegacyBuildCreativeMultiPayload = ServerPayload<BuildCreativeMultiSuccess>;
export type BuildCreativeVariantPayload = ServerPayload<BuildCreativeVariantSuccess>;
export type LegacyBuildCreativeReturn =
  | CreativeManifest
  | CreativeManifest[]
  | LegacyBuildCreativePayload
  | LegacyBuildCreativeMultiPayload
  | BuildCreativeVariantPayload;

interface CreativeAdServerPlatformBase<TCtxMeta> {
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
   * Spec defines a Submitted arm via `async-response-data.json` but the
   * per-tool `build-creative-response.json` `oneOf` doesn't include it,
   * so codegen produces a `BuildCreativeResponse` without Submitted —
   * a SPEC inconsistency, tracked as adcontextprotocol/adcp#3392. Until
   * that lands, slow tag-generation pipelines await in-request; status
   * changes flow via `publishStatusChange`.
   */
  buildCreativeLegacy(req: BuildCreativeRequest, ctx: Ctx<TCtxMeta>): Promise<LegacyBuildCreativeReturn>;

  /**
   * Format catalog. Optional because adopters who delegate format definitions
   * to a separate creative agent (declared via `capabilities.creative_agents`)
   * don't own them; the framework returns `UNSUPPORTED_FEATURE` when omitted.
   *
   * ⚠️  NO-ACCOUNT TOOL. See `previewCreative` note above.
   */
  listCreativeFormatsLegacy?(
    req: ListCreativeFormatsRequest,
    ctx: NoAccountCtx<TCtxMeta>
  ): Promise<LegacyListCreativeFormatsPayload>;

  // sync_creatives: sync OR task — `SyncCreativesResponse` has a Submitted arm.

  /**
   * Push creatives. Return per-creative result rows (sync fast path) OR
   * `ctx.handoffToTask(fn)` to promote to a background task (HITL —
   * brand-suitability, S&P review). `action: 'created'` for new entries,
   * `'updated'` for replacements, `'unchanged'` when matching. Optional
   * `status: 'pending_review'` for sync-arm rows awaiting manual review.
   */
  syncCreatives?(
    creatives: SyncCreative[],
    ctx: Ctx<TCtxMeta>
  ): Promise<SyncCreativesRow[] | TaskHandoff<SyncCreativesRow[]>>;

  /**
   * Read creatives from the library. Filters + pagination. When
   * `req.include_assignments`, include the buyer's package-assignment
   * graph. When `req.include_pricing`, include vendor pricing options
   * on each creative.
   */
  listCreatives(req: CanonicalListCreativesRequest, ctx: Ctx<TCtxMeta>): Promise<ListCreativesPayload>;

  /**
   * Per-creative delivery actuals (impressions, spend, pacing). Sync —
   * report-running platforms with manual report cycles return the
   * latest cached actuals and emit `delivery_report` status changes
   * via `publishStatusChange` when fresh reports are available.
   *
   * **Multi-id contract.** `filter.media_buy_ids` and `filter.creative_ids`
   * are arrays — buyers may scope a delivery query to multiple buys or
   * creatives in one call. The platform MUST iterate every supplied id
   * and return one row per matching (creative, buy) pair. Reading only
   * `media_buy_ids[0]` / `creative_ids[0]` silently truncates the
   * buyer's request — a correctness bug to avoid (closes #1342).
   *
   * Pass-through is the framework contract: cross-creative aggregation
   * is platform-domain knowledge (variant-level deduplication, brand
   * mapping, attribution windows), so the framework hands the array
   * through and the platform owns fan-out. Sellers that can't compute
   * cross-cuts omit them; buyers fall back to per-row values.
   */
  getCreativeDelivery(filter: GetCreativeDeliveryRequest, ctx: Ctx<TCtxMeta>): Promise<GetCreativeDeliveryPayload>;
}

type CreativeAdServerPreview<TCtxMeta> =
  | {
      /** Canonical preview through an advertised capability or stored creative. */
      previewCreative(
        req: CanonicalPreviewCreativeRequest,
        ctx: NoAccountCtx<TCtxMeta>
      ): Promise<PreviewCreativePayload>;
      /** @deprecated Migration-only alias for requests using legacy `format_id`. */
      previewCreativeLegacy?(
        req: LegacyPreviewCreativeRequest,
        ctx: NoAccountCtx<TCtxMeta>
      ): Promise<LegacyPreviewCreativePayload>;
    }
  | {
      previewCreative?: never;
      /** @deprecated Implement canonical `previewCreative` for new integrations. */
      previewCreativeLegacy(
        req: LegacyPreviewCreativeRequest,
        ctx: NoAccountCtx<TCtxMeta>
      ): Promise<LegacyPreviewCreativePayload>;
    };

/** Stateful creative-ad-server platform with canonical preview and a legacy-compatible alias. */
export type CreativeAdServerPlatform<TCtxMeta = Record<string, unknown>> = CreativeAdServerPlatformBase<TCtxMeta> &
  CreativeAdServerPreview<TCtxMeta>;
