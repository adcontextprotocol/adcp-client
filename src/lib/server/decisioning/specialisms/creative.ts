/**
 * Creative specialism platform interfaces (v2 dual-method shape).
 *
 * Three creative archetypes:
 *   - CreativeTemplatePlatform: stateless transform (AudioStack, Celtra)
 *   - CreativeGenerativePlatform: brief-to-creative (DALL-E-style)
 *   - CreativeAdServerPlatform: stateful library + tags (Innovid, GAM-creative; v1.1)
 *
 * `buildCreative` and `syncCreatives` each have sync OR task variants;
 * adopter implements exactly one per pair. `validatePlatform()` enforces
 * exactly-one at construction time.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account, NoAccountCtx } from '../account';
import type { RequestContext } from '../context';
import type { TaskHandoff } from '../async-outcome';
import type {
  CreativeAsset,
  CreativeManifest,
  BuildCreativeRequest,
  BuildCreativeSuccess,
  BuildCreativeMultiSuccess,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
} from '../../../types/tools.generated';
import type { SyncCreativesRow } from './sales';

/**
 * Adopter return shape for `buildCreative`. Discriminated by the wire
 * spec's Single vs Multi response arms — pick whichever matches the
 * request the framework dispatched:
 *
 *   - **Single manifest, no metadata**: return a `CreativeManifest`
 *     directly. Framework wraps as `{ creative_manifest: <manifest> }`.
 *     Use this for single-format requests (`target_format_id`) when
 *     you don't need to set `sandbox` / `expires_at` / `preview`.
 *   - **Multi-format manifests, no metadata**: return a
 *     `CreativeManifest[]`. Framework wraps as
 *     `{ creative_manifests: [...] }`. Use this for multi-format
 *     requests (`target_format_ids`) when you don't need rich metadata.
 *   - **Fully-shaped envelope**: return a `BuildCreativeSuccess` (single)
 *     or `BuildCreativeMultiSuccess` (multi) with `sandbox` /
 *     `expires_at` / `preview` populated. Framework passes through
 *     unchanged. Detected by the presence of `creative_manifest` (single
 *     envelope) or `creative_manifests` (multi envelope) at the top level.
 *
 * Adopters route on `req.target_format_ids` (multi) vs `req.target_format_id`
 * (single) and return the matching arm. Returning a `CreativeManifest[]`
 * for a single-format request, or a single `CreativeManifest` for a
 * multi-format request, is an adopter contract violation that surfaces
 * as schema-validation failure on the wire response.
 */
export type BuildCreativeReturn =
  | CreativeManifest
  | CreativeManifest[]
  | BuildCreativeSuccess
  | BuildCreativeMultiSuccess;

type Creative = CreativeAsset;
type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

// Re-export SyncCreativesRow so creative-specialism adopters don't need to
// reach into the sales module to import the shared row type.
export type { SyncCreativesRow };

// ---------------------------------------------------------------------------
// CreativeBuilderPlatform — produces creatives (template-driven OR generative)
// ---------------------------------------------------------------------------

/**
 * Creative-builder agent. Produces creatives from buyer inputs — equally
 * suited to template-driven dynamic creative platforms (Bannerflow,
 * Celtra), brief-to-creative AI agents (Pencil, Omneky, AdCreative.ai),
 * and hybrids that mix both modes. The wire shape doesn't distinguish
 * "transform a template" from "generate from a brief" — both produce a
 * `CreativeManifest` from a `BuildCreativeRequest`. The previous v6
 * preview separated them into `CreativeTemplatePlatform` and
 * `CreativeGenerativePlatform`, but every interface field is the same;
 * the only meaningful difference was whether `refineCreative` was
 * supported, which is now optional on the unified shape.
 *
 * Spec defines a Submitted arm via `async-response-data.json`
 * (`BuildCreativeAsyncSubmitted`) but the per-tool
 * `build-creative-response.json` `oneOf` doesn't include it — a SPEC
 * inconsistency tracked as adcontextprotocol/adcp#3392. Until the spec
 * rolls Submitted into the `oneOf`, slow operations (TTS, audio mixing,
 * long-running generation) await in-request; status changes surface via
 * `publishStatusChange` on `resource_type: 'creative'`.
 *
 * Both `creative-template` and `creative-generative` specialism claims
 * map to this interface in `RequiredPlatformsFor<S>` — the discovery
 * distinction is preserved at the buyer-facing spec level (so buyers
 * filtering for "AI brief-to-creative" still find generative agents)
 * while implementation surface stays unified.
 *
 * Adopters that ALSO want library + tag generation + delivery reporting
 * (i.e., a full ad server on top of the builder) declare
 * `CreativeAdServerPlatform` instead. Multi-archetype omni agents
 * (rare in the wild) front each archetype as a separate tenant via
 * `TenantRegistry`.
 */
export interface CreativeBuilderPlatform<TCtxMeta = Record<string, unknown>> {
  /**
   * Build the creative. Single method covers template-driven transform
   * (`req.template_id` + asset slots), brief-to-creative generation
   * (`req.brief`), and any hybrid the platform supports — adopters
   * route internally on `req` shape.
   *
   * Return shape is discriminated; see {@link BuildCreativeReturn}:
   * single `CreativeManifest`, `CreativeManifest[]` for multi-format
   * requests, OR a fully-shaped `BuildCreativeSuccess` /
   * `BuildCreativeMultiSuccess` envelope when you need to set
   * `sandbox` / `expires_at` / `preview`.
   */
  buildCreative(req: BuildCreativeRequest, ctx: Ctx<TCtxMeta>): Promise<BuildCreativeReturn>;

  /**
   * Preview-only variant — sandbox URL or inline HTML, expires. Always
   * sync. Optional because generative-only adopters that don't render
   * preview ahead of generation can omit it; the framework returns
   * `UNSUPPORTED_FEATURE` to buyers calling `preview_creative` against
   * a platform that didn't wire this.
   *
   * ⚠️  NO-ACCOUNT TOOL — `ctx: NoAccountCtx<TCtxMeta>`. The wire request
   * does not carry an `account` field, so `ctx.account` may be `undefined`
   * when `accounts.resolve(undefined)` returned null. Narrow before reading
   * `ctx.account.ctx_metadata`. See {@link NoAccountCtx}.
   */
  previewCreative?(req: PreviewCreativeRequest, ctx: NoAccountCtx<TCtxMeta>): Promise<PreviewCreativeResponse>;

  /**
   * Format catalog. Buyers call `list_creative_formats` to discover the
   * formats this agent supports. Optional because adopters who declare
   * their formats via `capabilities.creative_agents` (delegating to a
   * separate creative agent) don't own format definitions; the framework
   * surfaces `UNSUPPORTED_FEATURE` when omitted.
   *
   * ⚠️  NO-ACCOUNT TOOL — `ctx: NoAccountCtx<TCtxMeta>`. The wire request
   * does not carry an `account` field. The framework dispatches with
   * `ctx.account === undefined` for `'explicit'`-resolution adopters that
   * don't return a synthetic singleton from `accounts.resolve(undefined)`.
   * Format catalogs are typically publisher-wide; if yours is per-tenant
   * (Bannerflow / Celtra-style multi-tenant catalogs), return a synthetic
   * account from `accounts.resolve(undefined)` keyed on
   * `ctx.authInfo.clientId` and narrow `ctx.account` inside the handler.
   */
  listCreativeFormats?(
    req: ListCreativeFormatsRequest,
    ctx: NoAccountCtx<TCtxMeta>
  ): Promise<ListCreativeFormatsResponse>;

  /**
   * Refine a prior generation. `taskId` references a prior submission.
   * Sync — refinement is a mutation on existing state, not a new task
   * creation. Optional because pure template platforms iterate by
   * re-calling `buildCreative` with different inputs and don't carry
   * generation state across calls.
   */
  refineCreative?(taskId: string, refinement: RefinementMessage, ctx: Ctx<TCtxMeta>): Promise<CreativeManifest>;

  /**
   * Sync review surface. Stateless platforms typically auto-approve;
   * adopters needing mandatory pre-persist review return
   * `ctx.handoffToTask(fn)` to defer to a background task. Unified
   * hybrid shape — return rows OR `ctx.handoffToTask(fn)`.
   */
  syncCreatives?(
    creatives: Creative[],
    ctx: Ctx<TCtxMeta>
  ): Promise<SyncCreativesRow[] | TaskHandoff<SyncCreativesRow[]>>;
}

/**
 * @deprecated Use `CreativeBuilderPlatform` — the unified interface
 * covering both template-driven and brief-to-creative agents. The
 * v6 preview's separation of `CreativeTemplatePlatform` and
 * `CreativeGenerativePlatform` had no meaningful interface
 * distinction; this alias preserves source compatibility for one
 * release while adopters migrate. Will be removed in a future
 * release.
 */
export type CreativeTemplatePlatform<TCtxMeta = Record<string, unknown>> = CreativeBuilderPlatform<TCtxMeta>;

/**
 * @deprecated Use `CreativeBuilderPlatform` — the unified interface
 * covering both template-driven and brief-to-creative agents. See
 * `CreativeTemplatePlatform` deprecation note. Will be removed in a
 * future release.
 */
export type CreativeGenerativePlatform<TCtxMeta = Record<string, unknown>> = CreativeBuilderPlatform<TCtxMeta>;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface RefinementMessage {
  /** Free-text instruction from the buyer. */
  message: string;
  /** Optional structured changes (e.g., "make headline say X"). */
  changes?: Record<string, unknown>;
}
