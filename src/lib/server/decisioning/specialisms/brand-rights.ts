/**
 * BrandRightsPlatform — `brand-rights` specialism (v1.0).
 *
 * Brand-rights agents handle identity discovery + licensing for branded
 * inventory — covers IP holders (sports leagues, movie studios), CTV
 * brand-rights desks, and brand-licensing marketplaces. Adopters
 * implement the four wire tools the spec ships with stable schemas
 * AND framework dispatch infrastructure (in `AdcpToolMap`):
 *
 *   - `get_brand_identity` — sync read; brand catalog + identity record
 *   - `get_rights` — sync read; rights matching a brand + use query
 *   - `acquire_rights` — buyer commits to an offering. Async outcomes
 *     are delivered via the buyer-supplied `push_notification_config`
 *     webhook (NOT a polling tool — the spec doesn't define one for
 *     this surface).
 *   - `update_rights` — modify an existing rights grant. Mutating;
 *     `idempotency_key` required. Returns updated terms + re-issued
 *     credentials, or pending if the change requires rights-holder
 *     approval (signaled via `implementation_date: null`).
 *
 * `creative_approval` is also part of this domain but is webhook-only
 * (not in `AdcpToolMap`). Adopters wire {@link reviewCreativeApproval}
 * to their HTTP server's `approval_webhook` route — the URL they
 * returned to the buyer in `acquire_rights`. Use the
 * `creativeApproved` / `creativeApprovalRejected` /
 * `creativeApprovalPendingReview` / `creativeApprovalError` builders
 * from `@adcp/sdk/server` to construct the webhook response.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account } from '../account';
import type { RequestContext } from '../context';
// Brand-rights wire types only live in `core.generated`; the other
// specialism files import from `tools.generated` (where most
// per-tool wire types are emitted). Don't "consistency-fix" this
// import path — `tools.generated` doesn't re-export the brand-rights
// shapes.
import type {
  GetBrandIdentityRequest,
  GetBrandIdentitySuccess,
  GetRightsRequest,
  GetRightsSuccess,
  AcquireRightsRequest,
  AcquireRightsAcquired,
  AcquireRightsPendingApproval,
  AcquireRightsRejected,
  UpdateRightsRequest,
  UpdateRightsSuccess,
  CreativeApprovalRequest,
  CreativeApproved,
  CreativeRejected,
  CreativePendingReview,
} from '../../../types/core.generated';

type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

export interface BrandRightsPlatform<TCtxMeta = Record<string, unknown>> {
  /**
   * Read brand identity record — `brand_id`, `house`, localized `names`,
   * optional logos / industries / `keller_type`. Sync; no async ceremony.
   * Throw `AdcpError('REFERENCE_NOT_FOUND')` when the brand reference
   * doesn't resolve to an identity the platform tracks.
   */
  getBrandIdentity(req: GetBrandIdentityRequest, ctx: Ctx<TCtxMeta>): Promise<GetBrandIdentitySuccess>;

  /**
   * List rights matching a brand + use query. Sync read; framework
   * wraps the response in the wire envelope. Returning an empty
   * `rights` array is valid (= "no rights available for the requested
   * terms"); throw `AdcpError` only for buyer-fixable rejection (e.g.,
   * unsupported jurisdiction).
   *
   * Note: the wire field is `rights`, NOT `offerings`. Adopters who
   * named their internal model `offerings` translate at this seam.
   */
  getRights(req: GetRightsRequest, ctx: Ctx<TCtxMeta>): Promise<GetRightsSuccess>;

  /**
   * Acquire rights — buyer commits to an offering. Four wire-spec arms:
   *
   *   - `AcquireRightsAcquired` — rights granted immediately. Carries
   *     `rights_id`, `status: 'acquired'`, `brand_id`, `terms`,
   *     `generation_credentials` (scoped per-LLM-provider keys), and
   *     `rights_constraint` so the buyer can plumb the grant directly
   *     into creative generation.
   *   - `AcquireRightsPendingApproval` — clearance pending counter-
   *     signature, legal review, or rights-holder approval. Carries
   *     `rights_id`, `status: 'pending_approval'`, `brand_id`, plus
   *     optional `detail` and `estimated_response_time` (e.g., '48h').
   *     **Async delivery is webhook-only** — the buyer's
   *     `push_notification_config.url` receives the eventual
   *     `Acquired` or `Rejected` outcome. The spec does NOT define
   *     a polling tool for `acquire_rights`; do not reach for
   *     `tasks_get` here.
   *   - `AcquireRightsRejected` — terminal rejection. Carries
   *     `rights_id`, `status: 'rejected'`, `brand_id`, `reason`,
   *     and optional `suggestions[]` for buyer remediation.
   *
   * The wire spec also defines a fourth `AcquireRightsError` arm
   * (multi-error `{ errors: Error[] }`) for batch-style failures.
   * Adopters who need that shape throw
   * `AdcpError('INVALID_REQUEST', { details: { errors: [...] } })`
   * — the framework projects to the same wire envelope. The platform
   * interface accepts only the 3 success-arm shapes by design;
   * `AdcpError` is the canonical multi-error path here, matching
   * `SalesPlatform.createMediaBuy` preflight.
   *
   * Throw `AdcpError` only for buyer-fixable REQUEST rejection
   * (`INVALID_REQUEST`, `BUDGET_TOO_LOW`). For spec-defined GRANT
   * rejection (rights unavailable in jurisdiction, talent dispute
   * pending) return the `AcquireRightsRejected` arm so the buyer sees
   * the structured wire response with `reason` + `suggestions`.
   *
   * Pre-flight (catalog availability, agency authorization) MUST run
   * sync regardless of arm — invalid requests reject before allocating
   * any state.
   */
  acquireRights(
    req: AcquireRightsRequest,
    ctx: Ctx<TCtxMeta>
  ): Promise<AcquireRightsAcquired | AcquireRightsPendingApproval | AcquireRightsRejected>;

  /**
   * Modify an existing rights grant — extend dates, adjust impression caps,
   * change pricing, pause/resume. Parallels `updateMediaBuy` semantics on
   * the media-buy side: only the fields the buyer provides are touched;
   * omitted fields remain unchanged. The framework auto-hydrates the
   * underlying grant from `req.rights_id` (mirroring `acquire_rights`'s
   * `req.rights` hydration), so the implementation reads the resolved
   * grant from `ctx.store` rather than re-fetching it.
   *
   * Return shape:
   *   - `UpdateRightsSuccess` — change applied. Carries updated `terms`,
   *     re-issued `generation_credentials` (LLM keys reflecting the new
   *     constraint), updated `rights_constraint`, and an
   *     `implementation_date`:
   *       - timestamp string when changes are live immediately
   *       - **`null`** when the change requires rights-holder approval —
   *         the buyer's `push_notification_config.url` will receive a
   *         follow-up webhook with the resolved state.
   *
   * For terminal rejection (e.g., `impression_cap` below already-delivered
   * count, `end_date` earlier than now, switching to an incompatible
   * `pricing_option_id`) throw `AdcpError('INVALID_REQUEST', { details })`
   * — the framework projects the throw into the `UpdateRightsError` wire
   * arm. The Platform method's return type is `Promise<UpdateRightsSuccess>`
   * by design: error arms are exclusively reachable via thrown `AdcpError`
   * (matching `acquireRights`'s convention — its return type carries only
   * the three success arms; the multi-error `AcquireRightsError` arm is
   * also thrown). For a multi-error batch result, throw with
   * `details: { errors: [...] }` and the framework projects the array.
   *
   * Idempotency: required (`x-mutates-state: true`). The framework caches
   * the response for replay against the same `idempotency_key`; this
   * handler runs at most once per (key, principal).
   */
  updateRights(req: UpdateRightsRequest, ctx: Ctx<TCtxMeta>): Promise<UpdateRightsSuccess>;

  /**
   * Review a creative submitted under an existing rights grant.
   *
   * **This is a WEBHOOK handler, not a tool.** The spec models creative
   * approval as an HTTP webhook: the buyer POSTs a
   * `CreativeApprovalRequest` to the `approval_webhook` URL the seller
   * returned in `acquire_rights`. The framework does NOT register this as
   * an MCP/A2A tool — adopters mount their own HTTP route at the URL they
   * advertised, parse the request body against
   * `CreativeApprovalRequestSchema`, dispatch to this method, and use
   * `creativeApproved` / `creativeApprovalRejected` /
   * `creativeApprovalPendingReview` / `creativeApprovalError` from
   * `@adcp/sdk/server` to construct the JSON response.
   *
   * Three success arms (the framework's typed signature surfaces the
   * three; the multi-error arm is reachable via thrown `AdcpError` once
   * the receiver glue lands in v6.1+):
   *
   *   - `CreativeApproved` — creative cleared for distribution; carries
   *     optional `conditions[]` (e.g. "approved for NL only").
   *   - `CreativeRejected` — terminal rejection; carries `reason` plus
   *     optional `suggestions[]` for remediation. Buyer revises and
   *     resubmits with a fresh `idempotency_key`.
   *   - `CreativePendingReview` — queued for human review. Carry
   *     `estimated_response_time` (e.g. "24h") and a `status_url` the
   *     buyer can poll.
   *
   * Pre-flight (rights grant exists, `creative_url` reachable for review)
   * runs before this method — adopters can read the resolved grant from
   * `ctx.store` after their HTTP route does the schema validation step.
   *
   * Idempotency: required (`x-mutates-state: true`). Resubmission with
   * the same `idempotency_key` returns the original verdict.
   */
  reviewCreativeApproval(
    req: CreativeApprovalRequest,
    ctx: Ctx<TCtxMeta>
  ): Promise<CreativeApproved | CreativeRejected | CreativePendingReview>;
}
