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

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type { TaskHandoff } from '../async-outcome';
import type {
  CreativeAsset,
  CreativeManifest,
  BuildCreativeRequest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
} from '../../../types/tools.generated';
import type { SyncCreativesRow } from './sales';

type Creative = CreativeAsset;
type Ctx<TMeta> = RequestContext<Account<TMeta>>;

// Re-export SyncCreativesRow so creative-specialism adopters don't need to
// reach into the sales module to import the shared row type.
export type { SyncCreativesRow };

// ---------------------------------------------------------------------------
// CreativeTemplatePlatform — stateless transform
// ---------------------------------------------------------------------------

export interface CreativeTemplatePlatform<TMeta = Record<string, unknown>> {
  /**
   * Build the creative. Stateless transform. Spec defines a Submitted arm
   * via `async-response-data.json` (`BuildCreativeAsyncSubmitted`) but the
   * per-tool `build-creative-response.json` `oneOf` doesn't include it —
   * a SPEC inconsistency tracked as adcontextprotocol/adcp#3392 (same
   * issue as `get_products`, `update_media_buy`, `sync_catalogs`). Until
   * the spec rolls Submitted into the `oneOf`, slow operations (TTS,
   * audio mixing) await in-request; long-running generation surfaces
   * via `publishStatusChange` on `resource_type: 'creative'`.
   */
  buildCreative(req: BuildCreativeRequest, ctx: Ctx<TMeta>): Promise<CreativeManifest>;

  /** Preview-only variant — sandbox URL or inline HTML, expires. Always sync. */
  previewCreative(req: PreviewCreativeRequest, ctx: Ctx<TMeta>): Promise<PreviewCreativeResponse>;

  // sync_creatives: unified hybrid shape — return rows OR ctx.handoffToTask(fn).
  /**
   * Sync review surface. Stateless template platforms typically auto-approve;
   * adopters needing mandatory pre-persist review return
   * `ctx.handoffToTask(fn)` to defer to a background task.
   */
  syncCreatives?(
    creatives: Creative[],
    ctx: Ctx<TMeta>
  ): Promise<SyncCreativesRow[] | TaskHandoff<SyncCreativesRow[]>>;
}

// ---------------------------------------------------------------------------
// CreativeGenerativePlatform — brief-to-creative
// ---------------------------------------------------------------------------

/**
 * Brief-to-creative agent. Generative pipelines often want HITL semantics
 * (generation takes seconds-to-minutes) but the per-tool
 * `build-creative-response.json` `oneOf` doesn't include the Submitted
 * arm (spec inconsistency — adcontextprotocol/adcp#3392), so generation
 * runs sync today. Refinement is sync (mutation on existing task state).
 */
export interface CreativeGenerativePlatform<TMeta = Record<string, unknown>> {
  /**
   * Build the creative. Same codegen-gap caveat as
   * `CreativeTemplatePlatform.buildCreative`. For long-running generation,
   * return a placeholder manifest with `expires_at` and emit
   * `publishStatusChange` events as iterations land.
   */
  buildCreative(req: BuildCreativeRequest, ctx: Ctx<TMeta>): Promise<CreativeManifest>;

  /**
   * Refine an in-flight or completed generation. `taskId` references
   * a prior submission. Sync — refinement is a mutation on existing
   * state, not a new task creation.
   */
  refineCreative(taskId: string, refinement: RefinementMessage, ctx: Ctx<TMeta>): Promise<CreativeManifest>;

  syncCreatives?(
    creatives: Creative[],
    ctx: Ctx<TMeta>
  ): Promise<SyncCreativesRow[] | TaskHandoff<SyncCreativesRow[]>>;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface RefinementMessage {
  /** Free-text instruction from the buyer. */
  message: string;
  /** Optional structured changes (e.g., "make headline say X"). */
  changes?: Record<string, unknown>;
}
