// Compat shim between the legacy `valid_actions[]` flat shape and the
// 3.1 `available_actions[]` structured shape (RFC #4480).
//
// Buyer-side code should always read through `getAvailableActions(buy)`
// rather than reaching for either field directly - the shim picks the
// authoritative source and surfaces a deprecation hint when only the
// legacy field is populated.

import type {
  MediaBuyActionContext,
  MediaBuyAvailableAction,
  MediaBuyValidAction,
} from './types';

/**
 * Source the normalized `available_actions[]` came from. Callers branch on
 * this to decide whether to enforce mode constraints (`available_actions`)
 * or treat the result as a best-effort hint (`valid_actions`, no mode info).
 */
export type AvailableActionsSource = 'available_actions' | 'valid_actions' | 'absent';

export interface AvailableActionsResult {
  /** Normalized available actions. Empty array when the source is `'absent'`. */
  actions: MediaBuyAvailableAction[];
  source: AvailableActionsSource;
  /**
   * One-line hint when the buy carries only the legacy `valid_actions[]`
   * field. Helpers surface this on their results so callers can render it
   * to the developer.
   */
  deprecationHint?: string;
}

const DEPRECATION_HINT =
  'seller emitted `valid_actions[]` only (legacy 3.0). mode and sla unknown; preflight assumes self_serve. ' +
  'sellers SHOULD populate `available_actions[]` during 3.x.';

// One-shot log gate. Module-scoped so a buyer process that hits the same
// shape on every poll doesn't drown its logs. Tests reset via
// `__resetValidActionsWarningForTests`.
let warnedOnce = false;

function emitDeprecationWarning(): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[@adcp/sdk] ${DEPRECATION_HINT}`);
}

/**
 * Hook for tests to reset the one-shot warning gate. Not exported from the
 * public barrel.
 */
export function __resetValidActionsWarningForTests(): void {
  warnedOnce = false;
}

/**
 * Normalize the buy's available actions. Reads `available_actions[]` when
 * present; falls back to synthesizing entries from `valid_actions[]` with
 * `mode: 'self_serve'` (best-effort - legacy callers had no mode info).
 *
 * `options.silent` suppresses the one-shot console warning so libraries
 * that surface their own diagnostics don't double-log.
 */
export function getAvailableActions(
  buy: MediaBuyActionContext,
  options: { silent?: boolean } = {}
): AvailableActionsResult {
  if (buy.available_actions && buy.available_actions.length > 0) {
    return { actions: [...buy.available_actions], source: 'available_actions' };
  }
  if (buy.valid_actions && buy.valid_actions.length > 0) {
    if (!options.silent) emitDeprecationWarning();
    const seen = new Set<MediaBuyValidAction>();
    const actions: MediaBuyAvailableAction[] = [];
    for (const action of buy.valid_actions) {
      if (seen.has(action)) continue;
      seen.add(action);
      actions.push({ action, mode: 'self_serve' });
    }
    return { actions, source: 'valid_actions', deprecationHint: DEPRECATION_HINT };
  }
  return { actions: [], source: 'absent' };
}

/**
 * Look up the available-action entry for a given action ID. Returns the
 * entry as emitted by the seller (so callers can read `mode`, `sla`,
 * `terms_ref`) or `undefined` if the action isn't currently available.
 *
 * Honors rollup: when only a legacy coarse action is emitted by the seller
 * (`valid_actions[]` flat list or `available_actions[]` with coarse keys)
 * and the caller asks for a fine-grained child action, the lookup falls
 * through to the rollup parent. The returned entry carries the seller's
 * emitted action ID, not the caller's requested ID.
 */
export function findAvailableAction(
  buy: MediaBuyActionContext,
  action: MediaBuyValidAction,
  options: { silent?: boolean } = {}
): { entry: MediaBuyAvailableAction; result: AvailableActionsResult } | undefined {
  const result = getAvailableActions(buy, options);
  const direct = result.actions.find(a => a.action === action);
  if (direct) return { entry: direct, result };

  const rollupParent = ROLLUP_PARENT_OF[action];
  if (rollupParent) {
    const parent = result.actions.find(a => a.action === rollupParent);
    if (parent) return { entry: parent, result };
  }
  return undefined;
}

// Inverse of `enumMetadata[<legacy>].rollup`: given a fine-grained action,
// the legacy coarse action that subsumes it. Built from the schema's
// rollup mapping but inverted here for O(1) child -> parent lookup.
const ROLLUP_PARENT_OF: Partial<Record<MediaBuyValidAction, MediaBuyValidAction>> = {
  increase_budget: 'update_budget',
  decrease_budget: 'update_budget',
  reallocate_budget: 'update_budget',
  extend_flight: 'update_dates',
  shorten_flight: 'update_dates',
  update_flight_dates: 'update_dates',
  update_targeting: 'update_packages',
  update_pacing: 'update_packages',
  update_frequency_caps: 'update_packages',
  remove_packages: 'update_packages',
  replace_creative: 'sync_creatives',
  update_creative_assignments: 'sync_creatives',
  remove_creative: 'sync_creatives',
};

/**
 * Public read of the rollup table for callers that need to walk legacy
 * coarse vocabulary themselves (e.g. UI rendering that wants to group
 * fine-grained actions under their coarse parent).
 */
export function getRollupParent(action: MediaBuyValidAction): MediaBuyValidAction | undefined {
  return ROLLUP_PARENT_OF[action];
}
