// Buyer-side types for the available_actions surface (AdCP 3.1, RFC #4480).
//
// Hand-written until schemas/cache/ catches up to the 3.1 release and the
// codegen regenerates `*.generated.ts`. Mirrors:
//   - schemas/source/core/media-buy-available-action.json
//   - schemas/source/core/sla-window.json
//   - schemas/source/enums/media-buy-action-mode.json
//   - schemas/source/enums/media-buy-valid-action.json
//   - schemas/source/enums/action-not-allowed-reason.json
//   - schemas/source/error-details/action-not-allowed.json
//
// When `sync-schemas` next runs and produces the equivalent types under
// `src/lib/types/*.generated.ts`, this file should be deleted and the public
// re-exports in `src/lib/media-buy/index.ts` should point at the generated
// names.

/**
 * Fine-grained action identifier introduced in AdCP 3.1. Includes the legacy
 * coarse values (`update_budget`, `update_dates`, `update_packages`,
 * `sync_creatives`) so sellers staying on 3.x continue to round-trip.
 */
export type MediaBuyValidAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'extend_flight'
  | 'shorten_flight'
  | 'update_flight_dates'
  | 'increase_budget'
  | 'decrease_budget'
  | 'reallocate_budget'
  | 'update_targeting'
  | 'update_pacing'
  | 'update_frequency_caps'
  | 'replace_creative'
  | 'update_creative_assignments'
  | 'remove_creative'
  | 'add_packages'
  | 'remove_packages'
  | 'update_budget'
  | 'update_dates'
  | 'update_packages'
  | 'sync_creatives';

export const LEGACY_COARSE_ACTIONS = [
  'update_budget',
  'update_dates',
  'update_packages',
  'sync_creatives',
] as const satisfies readonly MediaBuyValidAction[];

export type LegacyCoarseAction = (typeof LEGACY_COARSE_ACTIONS)[number];

/**
 * How a seller honors a given action on a media buy. Buyers branch on this to
 * pick a synchronous, conditional, proposal, or async-approval flow.
 */
export type MediaBuyActionMode =
  | 'self_serve'
  | 'conditional_self_serve'
  | 'requires_proposal'
  | 'requires_approval';

/**
 * SLA window expressed as a structured duration. Mirrors `sla-window.json`
 * as a `{ unit, value }` pair (e.g. `{ unit: 'hours', value: 24 }`). The schema
 * landed alongside #4514 but is intentionally minimal; the spec calls out
 * that absence means "no commitment", not "zero commitment".
 */
export interface SlaWindow {
  unit: 'minutes' | 'hours' | 'days' | 'business_days';
  value: number;
  response_max?: number;
}

/**
 * One entry of the per-buy `available_actions[]` array. Authoritative for
 * the buy at the moment of emission - sellers MAY resolve to a different
 * mode by the time the mutation arrives, in which case the call is rejected
 * with `ACTION_NOT_ALLOWED` (`reason: mode_mismatch`).
 *
 * The containing array is uniquely keyed by `action` (contract invariant,
 * not enforced by JSON Schema `uniqueItems`).
 */
export interface MediaBuyAvailableAction {
  action: MediaBuyValidAction;
  mode: MediaBuyActionMode;
  sla?: SlaWindow;
  /**
   * Opaque pointer into a buy-terms negotiation. The buy-terms RFC is
   * separate; until it lands the field is any string.
   */
  terms_ref?: string;
}

/**
 * Reason an `update_media_buy` request was rejected with
 * `ACTION_NOT_ALLOWED`. Buyer SDKs branch on this to choose a recovery path.
 */
export type ActionNotAllowedReason =
  | 'wrong_status'
  | 'not_supported_on_product'
  | 'not_supported_on_buy'
  | 'mode_mismatch';

/**
 * Structured details payload for `ACTION_NOT_ALLOWED` errors.
 */
export interface ActionNotAllowedDetails {
  attempted_action: MediaBuyValidAction;
  reason: ActionNotAllowedReason;
  currently_available_actions?: MediaBuyAvailableAction[];
}

/**
 * Minimum surface a media buy needs to expose for the preflight helpers to
 * operate. Picks the fields the helpers actually read so callers can pass
 * either a `MediaBuy`, a `CreateMediaBuySuccess`, an `UpdateMediaBuySuccess`,
 * or a `get_media_buys` entry. Optional fields match the schema; required
 * fields are required by the helpers themselves.
 */
export interface MediaBuyActionContext {
  media_buy_id?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  packages?: ReadonlyArray<{
    package_id?: string;
    budget?: number;
    start_time?: string;
    end_time?: string;
  }>;
  available_actions?: MediaBuyAvailableAction[];
  valid_actions?: MediaBuyValidAction[];
}

/**
 * Subset of `UpdateMediaBuyRequest` the resolver introspects. Reusing a
 * minimal interface keeps the preflight independent of the generated
 * request type so a schema bump that adds optional fields doesn't churn the
 * resolver signature.
 */
export interface UpdateMediaBuyRequestLike {
  paused?: boolean;
  canceled?: true;
  cancellation_reason?: string;
  start_time?: { datetime?: string } | string;
  end_time?: string;
  new_packages?: ReadonlyArray<unknown>;
  packages?: ReadonlyArray<{
    package_id: string;
    budget?: number;
    pacing?: unknown;
    start_time?: string;
    end_time?: string;
    paused?: boolean;
    canceled?: true;
    targeting_overlay?: { frequency_cap?: unknown; [k: string]: unknown };
    keyword_targets_add?: unknown;
    keyword_targets_remove?: unknown;
    negative_keywords_add?: unknown;
    negative_keywords_remove?: unknown;
    creative_assignments?: unknown;
    creatives?: unknown;
  }>;
}
