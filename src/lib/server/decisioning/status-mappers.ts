/**
 * Native status mapping. Real ad systems have their own status models
 * (GAM uses DRAFT/APPROVED/etc.; Spotify uses PENDING/ACTIVE; LiveRamp
 * uses INGESTING/MATCHED/ACTIVATED). The platform implements one mapper
 * per AdCP-typed status; framework calls them where wire responses need
 * the AdCP-typed value.
 *
 * **Scope**: each mapper is a wire-status decoder for a single native
 * status string. Rollup logic — taking N native statuses across multiple
 * objects (GAM Order + LineItems, Criteo campaign + line items + creatives)
 * and computing one AdCP-typed status — is platform-specific and lives in
 * adapter code, NOT here. The mapper answers "what does GAM's `READY` mean
 * in AdCP terms?"; the adapter answers "if any LineItem is `DISAPPROVED`,
 * the buy is `rejected`; if all are `DELIVERING`, the buy is `active`".
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { AdcpAccountStatus } from './account';

/**
 * One method per AdCP-typed status. All optional — platforms only map the
 * statuses their AdCP-claimed specialisms expose.
 */
export interface StatusMappers {
  account?(native: string): AdcpAccountStatus;
  mediaBuy?(native: string): AdcpMediaBuyStatus;
  creative?(native: string): AdcpCreativeStatus;
  plan?(native: string): AdcpPlanStatus;
}

export type AdcpMediaBuyStatus =
  | 'pending_creatives'
  | 'pending_start'
  | 'active'
  | 'paused'
  | 'completed'
  | 'rejected'
  | 'canceled';

export type AdcpCreativeStatus = 'pending_review' | 'approved' | 'rejected' | 'archived';

export type AdcpPlanStatus = 'active' | 'exhausted' | 'expired' | 'paused';
