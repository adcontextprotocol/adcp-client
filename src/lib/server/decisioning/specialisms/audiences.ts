/**
 * AudiencePlatform — cross-cutting audience-sync specialism (v1.0).
 *
 * Used standalone (LiveRamp, Oracle Data Cloud, Salesforce CDP) or
 * composed with sales-social (Snap/Meta/TikTok). Framework owns
 * cross-platform threading; platform answers "given this audience, what
 * happened on my system?"
 *
 * Status: Preview / 6.0. Not yet wired into the framework.
 *
 * @public
 */

import type { AsyncOutcome } from '../async-outcome';
import type { Account } from '../account';
import type { RequestContext } from '../context';
import type { SyncAudiencesRequest } from '../../../types/tools.generated';

type Ctx = RequestContext<Account>;

/**
 * The wire schema doesn't export a top-level `Audience` type; the shape lives
 * inline on `SyncAudiencesRequest.audiences[]`. Extract it here so platform
 * implementations have a name to type against.
 */
export type Audience = NonNullable<SyncAudiencesRequest['audiences']>[number];

export interface AudiencePlatform {
  /**
   * Push audiences to the platform. Framework handles batching, idempotency,
   * cross-tenant scoping. Platform handles match-rate computation and
   * activation lifecycle.
   *
   * Real-world: LiveRamp returns `{ kind: 'submitted' }` because match-rate
   * computation against the identity graph takes minutes; the platform's
   * webhook ingress (via taskHandle.notify) pushes the terminal result.
   */
  syncAudiences(audiences: Audience[], ctx: Ctx): Promise<AsyncOutcome<AudienceSyncResult[]>>;

  /**
   * Read current audience status. Sync — this is a state-read, not a
   * mutating operation. Useful for buyer-side polling outside the framework's
   * task envelope (e.g., querying long-lived audiences).
   */
  getAudienceStatus(audienceId: string, ctx: Ctx): Promise<AudienceStatus>;
}

export interface AudienceSyncResult {
  audience_id: string;
  action: 'created' | 'updated' | 'unchanged' | 'rejected';
  /** Number of identifiers matched against the platform's graph. */
  matched_count?: number;
  /** Match rate (0..1). 0.4 = 40% of submitted identifiers matched. */
  match_rate?: number;
  /** Status of activation. */
  status: AudienceStatus;
  /** Optional rejection reason if action === 'rejected'. */
  reason?: string;
}

export type AudienceStatus =
  | 'pending' // received, not yet processed
  | 'matching' // identity-graph match in progress
  | 'matched' // matched, ready to activate
  | 'activating' // pushing to destinations
  | 'active' // available for targeting
  | 'failed' // permanent failure
  | 'archived'; // explicitly retired by buyer or seller
