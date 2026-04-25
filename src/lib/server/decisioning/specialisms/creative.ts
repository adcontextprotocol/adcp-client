/**
 * Creative specialism platform interfaces (v1.0).
 *
 * Three creative archetypes:
 *   - CreativeTemplatePlatform: stateless transform (AudioStack, Celtra)
 *   - CreativeGenerativePlatform: brief-to-creative (DALL-E-style)
 *   - CreativeAdServerPlatform: stateful library + tags (Innovid, GAM-creative)
 *
 * v1.0 ships CreativeTemplatePlatform + CreativeGenerativePlatform.
 * CreativeAdServerPlatform follows in v1.1.
 *
 * Status: Preview / 6.0. Not yet wired into the framework.
 *
 * @public
 */

import type { AsyncOutcome } from '../async-outcome';
import type { Account } from '../account';
import type { RequestContext } from '../context';
import type { CursorPage, CursorRequest } from '../pagination';
import type {
  CreativeAsset,
  CreativeManifest,
  BuildCreativeRequest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
} from '../../../types/tools.generated';

// Re-alias for clarity in the platform interface (the wire type is `CreativeAsset`).
type Creative = CreativeAsset;
type Ctx = RequestContext<Account>;

// ---------------------------------------------------------------------------
// CreativeTemplatePlatform — stateless transform
// ---------------------------------------------------------------------------

/**
 * Stateless creative transformer (AudioStack, Celtra, format-conversion services).
 * Input: inline creative_manifest + target format. Output: rendered manifest.
 * No persistent library; every call self-contained.
 */
export interface CreativeTemplatePlatform {
  /**
   * Build a rendered creative from inline manifest + target format.
   * Mostly synchronous; platforms with TTS / audio mixing pipelines may submit.
   */
  buildCreative(req: BuildCreativeRequest, ctx: Ctx): Promise<AsyncOutcome<CreativeManifest>>;

  /**
   * Preview-only variant — sandbox URL or inline HTML, expires.
   */
  previewCreative(req: PreviewCreativeRequest, ctx: Ctx): Promise<AsyncOutcome<PreviewCreativeResponse>>;

  /**
   * Unified review surface. Framework normalizes both wire paths
   * (sync_creatives push to library AND inline creative_assignments
   * carried inside create_media_buy.packages[]) so the platform sees
   * one decision per creative.
   *
   * Stateless template platforms typically accept any well-formed manifest;
   * the review usually returns sync.
   */
  syncCreatives(creatives: Creative[], ctx: Ctx): Promise<AsyncOutcome<CreativeReviewResult[]>>;
}

// ---------------------------------------------------------------------------
// CreativeGenerativePlatform — brief-to-creative (async-first)
// ---------------------------------------------------------------------------

/**
 * Brief-to-creative agent. Input: creative brief + brand reference.
 * Output: generated assets. Async-first — most platforms take seconds-to-minutes.
 */
export interface CreativeGenerativePlatform {
  /**
   * Generate a new creative from brief. Almost always returns
   * `{ kind: 'submitted' }` for real generation pipelines.
   */
  buildCreative(req: BuildCreativeRequest, ctx: Ctx): Promise<AsyncOutcome<CreativeManifest>>;

  /**
   * Refine an in-flight or completed generation. `taskId` references
   * a prior buildCreative submission. Framework threads task continuity.
   */
  refineCreative(taskId: string, refinement: RefinementMessage, ctx: Ctx): Promise<AsyncOutcome<CreativeManifest>>;

  /** Same unified review surface as CreativeTemplatePlatform. */
  syncCreatives(creatives: Creative[], ctx: Ctx): Promise<AsyncOutcome<CreativeReviewResult[]>>;
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
