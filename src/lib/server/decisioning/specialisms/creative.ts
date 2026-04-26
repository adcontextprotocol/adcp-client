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
import type {
  CreativeAsset,
  CreativeManifest,
  BuildCreativeRequest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
} from '../../../types/tools.generated';
import type { SyncCreativesRow } from './sales';

type Creative = CreativeAsset;
type Ctx = RequestContext<Account>;

// Re-export SyncCreativesRow so creative-specialism adopters don't need to
// reach into the sales module to import the shared row type.
export type { SyncCreativesRow };

// ---------------------------------------------------------------------------
// CreativeTemplatePlatform — stateless transform
// ---------------------------------------------------------------------------

export interface CreativeTemplatePlatform {
  /**
   * Build the creative. Stateless transform. **Sync only** — the spec's
   * `BuildCreativeResponse` union does not define a `Submitted` arm, so
   * HITL-shaped task envelopes aren't representable on the wire today.
   * Slow operations (TTS, audio mixing) await in-request; framework's
   * standard timeout is generous. If your operation runs past 5+ minutes
   * regularly, file an issue with adcp spec to add a Submitted arm to
   * BuildCreativeResponse.
   */
  buildCreative(req: BuildCreativeRequest, ctx: Ctx): Promise<CreativeManifest>;

  /** Preview-only variant — sandbox URL or inline HTML, expires. Always sync. */
  previewCreative(req: PreviewCreativeRequest, ctx: Ctx): Promise<PreviewCreativeResponse>;

  // sync_creatives: sync OR task — `SyncCreativesResponse` has a Submitted arm.

  /** Sync review surface. Stateless template platforms typically auto-approve. */
  syncCreatives?(creatives: Creative[], ctx: Ctx): Promise<SyncCreativesRow[]>;

  /** HITL review (rare for templates; available when review is mandatory pre-persist). */
  syncCreativesTask?(taskId: string, creatives: Creative[], ctx: Ctx): Promise<SyncCreativesRow[]>;
}

// ---------------------------------------------------------------------------
// CreativeGenerativePlatform — brief-to-creative
// ---------------------------------------------------------------------------

/**
 * Brief-to-creative agent. Generative pipelines often want HITL semantics
 * (generation takes seconds-to-minutes) but the spec's `BuildCreativeResponse`
 * union doesn't define a `Submitted` arm — generation runs sync today.
 * Refinement is sync (mutation on existing task state).
 */
export interface CreativeGenerativePlatform {
  /**
   * Build the creative. **Sync only** until the spec adds a Submitted arm
   * to `BuildCreativeResponse` (file issue against adcp). For long-running
   * generation, consider returning a placeholder manifest with `expires_at`
   * and emitting `publishStatusChange` events as iterations land.
   */
  buildCreative(req: BuildCreativeRequest, ctx: Ctx): Promise<CreativeManifest>;

  /**
   * Refine an in-flight or completed generation. `taskId` references
   * a prior submission. Sync — refinement is a mutation on existing
   * state, not a new task creation.
   */
  refineCreative(taskId: string, refinement: RefinementMessage, ctx: Ctx): Promise<CreativeManifest>;

  syncCreatives?(creatives: Creative[], ctx: Ctx): Promise<SyncCreativesRow[]>;
  syncCreativesTask?(taskId: string, creatives: Creative[], ctx: Ctx): Promise<SyncCreativesRow[]>;
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
