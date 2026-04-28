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
 *   - `get_rights` — sync read; available rights offerings for a brand
 *   - `acquire_rights` — buyer commits to an offering. Native spec
 *     async shape via `AcquireRightsPendingApproval` (NOT the framework
 *     task envelope) — return that arm when human counter-signature
 *     is required.
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
   * Read brand identity record — name, canonical IDs, jurisdictions, IP
   * categories. Sync; no async ceremony. Throw
   * `AdcpError('REFERENCE_NOT_FOUND')` when the brand reference doesn't
   * resolve to an identity the platform tracks.
   */
  getBrandIdentity(
    req: GetBrandIdentityRequest,
    ctx: Ctx<TMeta>
  ): Promise<GetBrandIdentitySuccess>;

  /**
   * List available rights offerings for a brand + use category. Sync
   * read; framework wraps the response in the wire envelope. Returning
   * an empty `offerings` array is valid (= "no rights available for the
   * requested terms"); throw `AdcpError` only for buyer-fixable
   * rejection (e.g., unsupported jurisdiction).
   */
  getRights(req: GetRightsRequest, ctx: Ctx<TMeta>): Promise<GetRightsSuccess>;

  /**
   * Acquire rights — buyer commits to an offering. Three wire-spec arms:
   *
   *   - `AcquireRightsAcquired` — rights granted immediately (digital-
   *     only, programmatic, pre-approved buyer). Buyer can use the
   *     `rights_grant_id` in subsequent campaigns.
   *   - `AcquireRightsPendingApproval` — clearance pending human
   *     counter-signature, legal review, or rights-holder approval.
   *     Buyer polls the spec-defined approval status (NOT the
   *     framework's `tasks_get` — `acquire_rights` has its own native
   *     async shape).
   *   - `AcquireRightsRejected` — terminal rejection (offering expired,
   *     buyer not authorized, jurisdiction unsupported).
   *
   * Throw `AdcpError` only for buyer-fixable request rejection
   * (`INVALID_REQUEST`, `BUDGET_TOO_LOW`); for spec-defined rejection
   * shapes return `AcquireRightsRejected` so the buyer sees the
   * structured wire response with `rejection_reason` etc.
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
