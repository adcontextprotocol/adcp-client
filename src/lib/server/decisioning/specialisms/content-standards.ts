/**
 * ContentStandardsPlatform — `content-standards` specialism (v6.0).
 *
 * Content standards enforcement: brand safety policies, content adjacency
 * rules, and per-creative compliance verification. Adopters who claim
 * `content-standards` in `capabilities.specialisms[]` implement this
 * interface; the framework wires the 6 wire tools that make up the
 * content-standards surface.
 *
 * Two adopter shapes:
 *
 *   - **Standalone content-standards agent** (Innovid-style): runs apart
 *     from a sales agent; buyers call `list_content_standards` /
 *     `get_content_standards` / `validate_content_delivery` directly.
 *   - **Composed within a seller** (governance overlay): seller imports
 *     content-standards into its agent surface, calls `calibrate_content`
 *     internally during creative review, and surfaces violations through
 *     `sync_creatives` review state.
 *
 * Both shapes use the same interface; difference is whether the platform
 * field is populated alongside `sales` or as the only specialism.
 *
 * The two analyzer methods (`getMediaBuyArtifacts`, `getCreativeFeatures`)
 * are listed under the same surface in the framework's `GovernanceHandlers`
 * because they're content-feature reads adopters typically expose alongside
 * the policy CRUD. Optional — adopters who don't run analyzer pipelines
 * leave them undefined.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type {
  ListContentStandardsRequest,
  ListContentStandardsResponse,
  GetContentStandardsRequest,
  GetContentStandardsResponse,
  CreateContentStandardsRequest,
  CreateContentStandardsResponse,
  UpdateContentStandardsRequest,
  UpdateContentStandardsResponse,
  CalibrateContentRequest,
  CalibrateContentResponse,
  ValidateContentDeliveryRequest,
  ValidateContentDeliveryResponse,
  GetMediaBuyArtifactsRequest,
  GetMediaBuyArtifactsResponse,
  GetCreativeFeaturesRequest,
  GetCreativeFeaturesResponse,
} from '../../../types/tools.generated';

type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

export interface ContentStandardsPlatform<TCtxMeta = Record<string, unknown>> {
  /** Discover content standards published by this agent. */
  listContentStandards(req: ListContentStandardsRequest, ctx: Ctx<TCtxMeta>): Promise<ListContentStandardsResponse>;

  /** Read a single content standard by id. */
  getContentStandards(req: GetContentStandardsRequest, ctx: Ctx<TCtxMeta>): Promise<GetContentStandardsResponse>;

  /**
   * Create a new content standard. Adopter validates the policy schema
   * and returns the persisted record. Idempotent on the buyer's
   * `idempotency_key`.
   */
  createContentStandards(
    req: CreateContentStandardsRequest,
    ctx: Ctx<TCtxMeta>
  ): Promise<CreateContentStandardsResponse>;

  /** Update an existing content standard. */
  updateContentStandards(
    req: UpdateContentStandardsRequest,
    ctx: Ctx<TCtxMeta>
  ): Promise<UpdateContentStandardsResponse>;

  /**
   * Calibrate content against the published standards. Returns the
   * standard's current calibration profile + any flags raised against
   * the submitted content.
   */
  calibrateContent(req: CalibrateContentRequest, ctx: Ctx<TCtxMeta>): Promise<CalibrateContentResponse>;

  /**
   * Validate that a delivered media-buy / creative meets the buyer's
   * declared content-standards. Sellers call this post-flight to confirm
   * adjacency and policy conformance before issuing a
   * `validate_content_delivery_artifact` to a governance agent.
   */
  validateContentDelivery(
    req: ValidateContentDeliveryRequest,
    ctx: Ctx<TCtxMeta>
  ): Promise<ValidateContentDeliveryResponse>;

  /**
   * Read content artifacts produced during a media buy's flight (creative
   * proofs, ad-server tags, completed log captures). Optional — adopters
   * who don't expose artifact archival omit. Required by governance
   * receivers running adjacency validation.
   */
  getMediaBuyArtifacts?(req: GetMediaBuyArtifactsRequest, ctx: Ctx<TCtxMeta>): Promise<GetMediaBuyArtifactsResponse>;

  /**
   * Read per-creative analyzed features (object detection, scene
   * classification, transcript) the agent extracted during calibration.
   * Optional — adopters without analyzer pipelines omit.
   */
  getCreativeFeatures?(req: GetCreativeFeaturesRequest, ctx: Ctx<TCtxMeta>): Promise<GetCreativeFeaturesResponse>;
}
