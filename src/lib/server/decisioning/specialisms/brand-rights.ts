/**
 * BrandRightsPlatform — `brand-rights` specialism (v1.0).
 *
 * Brand-rights agents handle identity discovery + licensing for branded
 * inventory — covers IP holders (sports leagues, movie studios), CTV
 * brand-rights desks, and brand-licensing marketplaces. Adopters
 * implement the three wire tools the spec ships with stable schemas
 * AND framework dispatch infrastructure (in `AdcpToolMap`):
 *
 *   - `get_brand_identity` — sync read; brand catalog + identity record
 *   - `get_rights` — sync read; rights matching a brand + use query
 *   - `acquire_rights` — buyer commits to an offering. Async outcomes
 *     are delivered via the buyer-supplied `push_notification_config`
 *     webhook (NOT a polling tool — the spec doesn't define one for
 *     this surface).
 *
 * The two other surfaces in this domain (`update_rights`,
 * `creative_approval`) are spec-published but not yet in `AdcpToolMap`;
 * adopters wire them via the merge seam (`opts.brandRights.*`) until
 * they land in v6.1.
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
} from '../../../types/core.generated';

type Ctx<TMeta> = RequestContext<Account<TMeta>>;

export interface BrandRightsPlatform<TMeta = Record<string, unknown>> {
  /**
   * Read brand identity record — `brand_id`, `house`, localized `names`,
   * optional logos / industries / `keller_type`. Sync; no async ceremony.
   * Throw `AdcpError('REFERENCE_NOT_FOUND')` when the brand reference
   * doesn't resolve to an identity the platform tracks.
   */
  getBrandIdentity(req: GetBrandIdentityRequest, ctx: Ctx<TMeta>): Promise<GetBrandIdentitySuccess>;

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
  getRights(req: GetRightsRequest, ctx: Ctx<TMeta>): Promise<GetRightsSuccess>;

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
    ctx: Ctx<TMeta>
  ): Promise<AcquireRightsAcquired | AcquireRightsPendingApproval | AcquireRightsRejected>;
}
