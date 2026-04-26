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

type Creative = CreativeAsset;
type Ctx = RequestContext<Account>;

// ---------------------------------------------------------------------------
// CreativeTemplatePlatform — stateless transform
// ---------------------------------------------------------------------------

export interface CreativeTemplatePlatform {
  // build_creative: sync OR task

  /** Sync template build. Stateless transform. */
  buildCreative?(req: BuildCreativeRequest, ctx: Ctx): Promise<CreativeManifest>;

  /** HITL build (rare for templates — but available for slow TTS / audio mixing pipelines). */
  buildCreativeTask?(taskId: string, req: BuildCreativeRequest, ctx: Ctx): Promise<CreativeManifest>;

  /** Preview-only variant — sandbox URL or inline HTML, expires. Always sync. */
  previewCreative(req: PreviewCreativeRequest, ctx: Ctx): Promise<PreviewCreativeResponse>;

  // sync_creatives: sync OR task

  /** Sync review surface. Stateless template platforms typically auto-approve. */
  syncCreatives?(creatives: Creative[], ctx: Ctx): Promise<CreativeReviewResult[]>;

  /** HITL review (rare for templates). */
  syncCreativesTask?(taskId: string, creatives: Creative[], ctx: Ctx): Promise<CreativeReviewResult[]>;
}

// ---------------------------------------------------------------------------
// CreativeGenerativePlatform — brief-to-creative (async-first)
// ---------------------------------------------------------------------------

/**
 * Brief-to-creative agent. Generative pipelines almost always use the
 * `*Task` variant — generation takes seconds-to-minutes; framework
 * acknowledges with a task envelope, runs the work in background.
 */
export interface CreativeGenerativePlatform {
  buildCreative?(req: BuildCreativeRequest, ctx: Ctx): Promise<CreativeManifest>;
  buildCreativeTask?(taskId: string, req: BuildCreativeRequest, ctx: Ctx): Promise<CreativeManifest>;

  /**
   * Refine an in-flight or completed generation. `taskId` references
   * a prior `buildCreativeTask` submission. Sync — refinement is a
   * mutation on existing task state, not a new task creation.
   */
  refineCreative(taskId: string, refinement: RefinementMessage, ctx: Ctx): Promise<CreativeManifest>;

  syncCreatives?(creatives: Creative[], ctx: Ctx): Promise<CreativeReviewResult[]>;
  syncCreativesTask?(taskId: string, creatives: Creative[], ctx: Ctx): Promise<CreativeReviewResult[]>;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface CreativeReviewResult {
  creative_id: string;
  status: 'approved' | 'rejected' | 'pending_review';
  reason?: string;
}

export interface RefinementMessage {
  /** Free-text instruction from the buyer. */
  message: string;
  /** Optional structured changes (e.g., "make headline say X"). */
  changes?: Record<string, unknown>;
}
