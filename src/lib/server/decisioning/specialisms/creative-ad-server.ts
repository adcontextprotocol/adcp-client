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
import type {
  BuildCreativeRequest,
  CreativeManifest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  ListCreativesRequest,
  ListCreativesResponse,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
  CreativeAsset,
  BuildCreativeSuccess,
  BuildCreativeMultiSuccess,
} from '../../../types/tools.generated';
import type { SyncCreativesRow } from './sales';

type Creative = CreativeAsset;
type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

export interface CreativeAdServerPlatform<TCtxMeta = Record<string, unknown>> {
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
  buildCreative(
    req: BuildCreativeRequest,
    ctx: Ctx<TCtxMeta>
  ): Promise<CreativeManifest | CreativeManifest[] | BuildCreativeSuccess | BuildCreativeMultiSuccess>;

  /**
   * Preview-only variant — sandbox URL or inline HTML, expires. Always sync.
   *
   * ⚠️  NO-ACCOUNT TOOL — `ctx: NoAccountCtx<TCtxMeta>`. The wire request
   * does not carry an `account` field; narrow `ctx.account` before reading
   * `ctx_metadata` / `id`. See {@link NoAccountCtx}.
   */
  previewCreative(req: PreviewCreativeRequest, ctx: NoAccountCtx<TCtxMeta>): Promise<PreviewCreativeResponse>;

  /**
   * Format catalog. Optional because adopters who delegate format definitions
   * to a separate creative agent (declared via `capabilities.creative_agents`)
   * don't own them; the framework returns `UNSUPPORTED_FEATURE` when omitted.
   *
   * ⚠️  NO-ACCOUNT TOOL. See `previewCreative` note above.
   */
  listCreativeFormats?(
    req: ListCreativeFormatsRequest,
    ctx: NoAccountCtx<TCtxMeta>
  ): Promise<ListCreativeFormatsResponse>;

  // sync_creatives: sync OR task — `SyncCreativesResponse` has a Submitted arm.

  /**
   * Push creatives. Return per-creative result rows (sync fast path) OR
   * `ctx.handoffToTask(fn)` to promote to a background task (HITL —
   * brand-suitability, S&P review). `action: 'created'` for new entries,
   * `'updated'` for replacements, `'unchanged'` when matching. Optional
   * `status: 'pending_review'` for sync-arm rows awaiting manual review.
   */
  syncCreatives?(
    creatives: Creative[],
    ctx: Ctx<TCtxMeta>
  ): Promise<SyncCreativesRow[] | TaskHandoff<SyncCreativesRow[]>>;

  /**
   * Read creatives from the library. Filters + pagination. When
   * `req.include_assignments`, include the buyer's package-assignment
   * graph. When `req.include_pricing`, include vendor pricing options
   * on each creative.
   */
  listCreatives(req: ListCreativesRequest, ctx: Ctx<TCtxMeta>): Promise<ListCreativesResponse>;

  /**
   * Per-creative delivery actuals (impressions, spend, pacing). Sync —
   * report-running platforms with manual report cycles return the
   * latest cached actuals and emit `delivery_report` status changes
   * via `publishStatusChange` when fresh reports are available.
   */
  getCreativeDelivery(filter: GetCreativeDeliveryRequest, ctx: Ctx<TCtxMeta>): Promise<GetCreativeDeliveryResponse>;

  /**
   * Format catalog. Same shape as `SalesPlatform.listCreativeFormats` —
   * ad servers expose what formats their library supports so buyers can
   * size brief / asset combinations against the platform before pushing.
   * Optional; adopters who delegate format definitions to external
   * `creative_agents` declared in capabilities can omit.
   *
   * ⚠️  NO-ACCOUNT TOOL — see {@link CreativeBuilderPlatform.listCreativeFormats}.
   */
  listCreativeFormats?(req: ListCreativeFormatsRequest, ctx: Ctx<TCtxMeta>): Promise<ListCreativeFormatsResponse>;
}
