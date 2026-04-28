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

import type { Account } from '../account';
import type { RequestContext } from '../context';
import type { SyncAudiencesRequest, SyncAudiencesSuccess } from '../../../types/tools.generated';

type Ctx<TMeta> = RequestContext<Account<TMeta>>;

/**
 * The wire schema doesn't export a top-level `Audience` type; the shape lives
 * inline on `SyncAudiencesRequest.audiences[]`. Extract it here so platform
 * implementations have a name to type against.
 */
export type Audience = NonNullable<SyncAudiencesRequest['audiences']>[number];

/**
 * Wire success-row shape for `sync_audiences`. Returning the array of these
 * rows from `syncAudiences` is what adopters write — the framework wraps
 * with `{ audiences: [...] }` to form `SyncAudiencesSuccess`.
 *
 * `action` enum is the wire spec's: `'created' | 'updated' | 'unchanged' |
 * 'deleted' | 'failed'`. Note: `'rejected'` is NOT a valid wire action
 * value — use `'failed'` for buyer-rejected audiences.
 */
export type SyncAudiencesRow = SyncAudiencesSuccess['audiences'][number];

export type AudienceStatus = NonNullable<SyncAudiencesRow['status']>;

export interface AudiencePlatform<TMeta = Record<string, unknown>> {
  /**
   * Push audiences to the platform. Framework handles batching, idempotency,
   * cross-tenant scoping. Platform handles match-rate computation and
   * activation lifecycle.
   *
   * Sync acknowledgment with status changes via `publishStatusChange`:
   * return per-audience result rows immediately (`pending` / `matching` are
   * valid sync outcomes). The match-rate computation and activation
   * pipeline run in the background — the platform calls
   * `publishStatusChange({ resource_type: 'audience', ... })` from its
   * webhook handler / job queue / cron when each audience reaches a
   * terminal state.
   *
   * Throw `new AdcpError(...)` for buyer-fixable rejection
   * (`AUDIENCE_TOO_SMALL`, etc.).
   */
  syncAudiences(audiences: Audience[], ctx: Ctx<TMeta>): Promise<SyncAudiencesRow[]>;

  /**
   * Batch-poll current status for one or more audiences. Sync — this is a
   * state-read, not a mutating operation. Useful for buyer-side polling
   * outside the framework's task envelope (e.g., querying long-lived
   * audiences) and for adapter code that needs to check N audiences at
   * once.
   *
   * Returns a `Map<audience_id, AudienceStatus>`. Audiences not found are
   * omitted from the map (callers handle missing keys); throw
   * `AdcpError('REFERENCE_NOT_FOUND')` only when the entire batch is
   * unresolvable for the tenant.
   *
   * Single-audience polling is `pollAudienceStatuses([id], ctx).then(m =>
   * m.get(id))`. The batch shape composes with upstream identity-graph
   * APIs that natively return per-audience-id arrays — adopters do NOT
   * need to wrap a single-id lookup over an N-call loop.
   */
  pollAudienceStatuses(
    audienceIds: readonly string[],
    ctx: Ctx<TMeta>
  ): Promise<Map<string, AudienceStatus>>;
}
