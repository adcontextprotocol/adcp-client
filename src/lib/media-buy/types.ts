// Buyer-side type surface for the available_actions / ACTION_NOT_ALLOWED flow.
// Wire-shape types come from the generated AdCP schema; the helper-local
// types in this file are convenience subsets that the preflight resolver
// reads against (kept narrow so a schema bump that adds optional fields
// to MediaBuy / UpdateMediaBuyRequest doesn't churn the resolver
// signature).

export type {
  ActionNotAllowedDetails,
  ActionNotAllowedReason,
  MediaBuyActionMode,
  MediaBuyAvailableAction,
  MediaBuyValidAction,
  SLAWindow,
} from '../types/core.generated';

import type { MediaBuyAvailableAction, MediaBuyValidAction } from '../types/core.generated';
import type { SLAWindow } from '../types/core.generated';
import type { ControlMediaBuyRequest } from '../types/tools.generated';
import type { MediaBuyUpdateFieldAction } from './update-fields.generated';
import type { CANONICAL_ACTION_TASKS } from './action-metadata.generated';

/**
 * Every action id the structured `available_actions[].action` surface can
 * carry. Derived from the generated wire type plus the generated
 * `update_media_buy` dispatch table, preserving the legacy vocabulary on schema pins that predate
 * `core/media-buy-available-action-id.json` (AdCP <= 3.2.0-rc.2) and widens
 * to include structured-only ids such as `update_media_buy_frequency_cap`
 * once the pin picks that schema up. Canonical task metadata keeps the union
 * narrow even when a generated oneOf wire type flattens action to string.
 * Use this — not `MediaBuyValidAction` —
 * wherever code reads `available_actions[].action`, `allowed_actions[].action`,
 * or `ACTION_NOT_ALLOWED.attempted_action`. `MediaBuyValidAction` remains the
 * correct type for the deprecated flat `valid_actions[]` list only.
 */
export type MediaBuyActionId =
  | MediaBuyAvailableAction['action']
  | MediaBuyUpdateFieldAction
  | keyof typeof CANONICAL_ACTION_TASKS;

/**
 * @deprecated Use `SLAWindow`. Kept as an import-compatibility alias for the
 * pre-codegen draft export name; the shape is the generated wire contract.
 */
export type SlaWindow = SLAWindow;

/**
 * Coarse-vocabulary actions retained for backwards compatibility with 3.x
 * sellers that haven't migrated to the fine-grained set. Each rolls up to
 * one or more fine-grained values per `enumMetadata[<value>].rollup`.
 * Removed from the spec in 4.0.
 */
export const LEGACY_COARSE_ACTIONS = [
  'update_budget',
  'update_dates',
  'update_packages',
  'sync_creatives',
] as const satisfies readonly MediaBuyValidAction[];

export type LegacyCoarseAction = (typeof LEGACY_COARSE_ACTIONS)[number];

/**
 * Minimum surface a media buy needs to expose for the preflight helpers to
 * operate. Picks the fields the helpers actually read so callers can pass
 * either a `MediaBuy`, a `CreateMediaBuySuccess`, an `UpdateMediaBuySuccess`,
 * or a `get_media_buys` entry. Optional fields match the schema; required
 * fields are required by the helpers themselves.
 */
export interface MediaBuyActionContext {
  accepted_proposal?: import('./action-types').ActionProposal;
  accepted_proposal_id?: string;
  media_buy_id?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  revision?: number;
  currency?: string;
  total_budget?: number | { amount: number; currency: string };
  daily_budget_cap?: number | null;
  packages?: ReadonlyArray<{
    package_id?: string;
    budget?: number;
    start_time?: string;
    end_time?: string;
    canceled?: boolean;
    paused?: boolean;
    status?: string;
    daily_budget_cap?: number | null;
    min_spend_target?: number | null;
  }>;
  available_actions?: readonly import('./action-types').LiveMediaBuyAction[];
  valid_actions?: MediaBuyValidAction[];
}

/**
 * Subset of `UpdateMediaBuyRequest` the resolver introspects. Reusing a
 * minimal interface keeps the preflight independent of the generated
 * request type so a schema bump that adds optional fields doesn't churn the
 * resolver signature.
 */
export interface UpdateMediaBuyRequestLike {
  media_buy_id?: string;
  account?: unknown;
  context?: unknown;
  governance_context?: unknown;
  push_notification_config?: unknown;
  ext?: unknown;
  budget_cap_timezone?: string | null;
  invoice_recipient?: unknown;
  revision?: number;
  idempotency_key?: string;
  name?: string;
  total_budget?: { amount: number; currency: string };
  daily_budget_cap?: number | null;
  budget_allocation?: unknown;
  pacing?: unknown;
  bidding?: unknown;
  reporting_webhook?: unknown;
  paused?: boolean;
  canceled?: true;
  cancellation_reason?: string;
  start_time?: { datetime?: string } | string;
  end_time?: string;
  /** MediaBuy-level shared frequency cap (AdCP 3.2); `null` clears it. */
  frequency_cap?: unknown;
  new_packages?: ReadonlyArray<unknown>;
  packages?: ReadonlyArray<{
    package_id: string;
    context?: unknown;
    ext?: unknown;
    cancellation_reason?: string;
    catalogs?: unknown;
    catalog_ids?: readonly string[];
    bid_price?: number;
    optimization_goals?: unknown;
    impressions?: number;
    budget?: number | null;
    daily_budget_cap?: number | null;
    min_spend_target?: number | null;
    bidding?: unknown;
    pacing?: unknown;
    start_time?: string;
    end_time?: string;
    paused?: boolean;
    canceled?: true;
    targeting_overlay?:
      | NonNullable<ControlMediaBuyRequest['packages']>[number]['targeting_overlay']
      | { frequency_cap?: unknown; [k: string]: unknown };
    keyword_targets_add?: unknown;
    keyword_targets_remove?: unknown;
    negative_keywords_add?: unknown;
    negative_keywords_remove?: unknown;
    creative_assignments?: unknown;
    creatives?: unknown;
  }>;
}
