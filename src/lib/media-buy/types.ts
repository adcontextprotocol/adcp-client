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
