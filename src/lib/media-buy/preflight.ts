// Buyer-side preflight helpers for `update_media_buy`. See RFC #4480.
//
// Three layers, each usable on its own:
//   1. Boolean gates: `canPause(buy)`, `canExtendFlight(buy)`, ... - single
//      question, single answer. Drives UI affordances.
//   2. Resolver: `getActionForMutation(buy, request)` - turns a request diff
//      into the set of fine-grained actions it covers. Drives dispatch.
//   3. Preflight: `preflightUpdateMediaBuy(buy, request)` - composes
//      resolver + gate checks into a single ok/not-ok decision.

import { findAvailableAction, getAvailableActions, type AvailableActionsResult } from './available-actions';
import { ACTIONS_BY_FIELD } from './update-fields.generated';
import type {
  ActionNotAllowedReason,
  MediaBuyActionContext,
  MediaBuyActionMode,
  MediaBuyAvailableAction,
  MediaBuyValidAction,
  UpdateMediaBuyRequestLike,
} from './types';

// ---------------------------------------------------------------------------
// Boolean gates
// ---------------------------------------------------------------------------

function isAvailable(buy: MediaBuyActionContext, action: MediaBuyValidAction): boolean {
  return findAvailableAction(buy, action, { silent: true }) !== undefined;
}

export const canPause = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'pause');
export const canResume = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'resume');
export const canCancel = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'cancel');
export const canExtendFlight = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'extend_flight');
export const canShortenFlight = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'shorten_flight');
export const canUpdateFlightDates = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'update_flight_dates');
export const canIncreaseBudget = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'increase_budget');
export const canDecreaseBudget = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'decrease_budget');
export const canReallocateBudget = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'reallocate_budget');
export const canUpdateTargeting = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'update_targeting');
export const canUpdatePacing = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'update_pacing');
export const canUpdateFrequencyCaps = (buy: MediaBuyActionContext): boolean =>
  isAvailable(buy, 'update_frequency_caps');
export const canReplaceCreative = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'replace_creative');
export const canUpdateCreativeAssignments = (buy: MediaBuyActionContext): boolean =>
  isAvailable(buy, 'update_creative_assignments');
export const canAddPackages = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'add_packages');
export const canRemovePackages = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'remove_packages');

/**
 * Whether a creative can be removed from the buy. The current spec keys
 * removability at the buy level, not the creative - the `creativeId` arg
 * is reserved so future spec revisions that distinguish per-creative
 * removability don't require a signature change.
 */
export const canRemoveCreative = (buy: MediaBuyActionContext, _creativeId?: string): boolean =>
  isAvailable(buy, 'remove_creative');

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * One action a request body covers, plus the direction inference where the
 * fine-grained vocabulary distinguishes increase/decrease or
 * extend/shorten. `touched_fields` lists the dotted paths that triggered
 * this entry (useful for debugging).
 */
export interface ResolvedAction {
  action: MediaBuyValidAction;
  /**
   * Direction tag. Present when the resolver picked between fine-grained
   * siblings (e.g. `increase_budget` vs `decrease_budget`).
   */
  direction?: 'increase' | 'decrease' | 'reallocate' | 'extend' | 'shorten' | 'shift';
  touched_fields: string[];
}

/**
 * Walk the request body and return the set of fine-grained actions it
 * covers. Uses `ACTIONS_BY_FIELD` from the generated table to map dotted
 * paths back to actions, then compares against `currentBuy` to pick
 * direction-specific siblings.
 *
 * Returns an empty array when the request touches no recognized field
 * (e.g. only `idempotency_key` / `revision` / `account` were set).
 */
export function getActionForMutation(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): ResolvedAction[] {
  const touched = collectTouchedFields(request);
  if (touched.size === 0) return [];

  // Map each touched path to candidate actions, then resolve direction
  // for budget/flight clusters.
  const resolved = new Map<MediaBuyValidAction, ResolvedAction>();

  for (const field of touched) {
    const candidates = ACTIONS_BY_FIELD[field];
    if (!candidates) continue;

    let pick: { action: MediaBuyValidAction; direction?: ResolvedAction['direction'] };

    if (field === 'paused') {
      pick = { action: request.paused === false ? 'resume' : 'pause' };
    } else if (field === 'packages[].budget') {
      pick = resolveBudgetDirection(currentBuy, request);
    } else if (field === 'end_time' || field === 'packages[].end_time') {
      pick = resolveFlightEndDirection(currentBuy, request, field);
    } else if (field === 'start_time' || field === 'packages[].start_time') {
      pick = { action: 'update_flight_dates', direction: 'shift' };
    } else {
      // Unambiguous: every other field has exactly one fine-grained
      // action in ACTIONS_BY_FIELD.
      pick = { action: candidates[0]! };
    }

    const existing = resolved.get(pick.action);
    if (existing) {
      existing.touched_fields.push(field);
    } else {
      resolved.set(pick.action, {
        action: pick.action,
        direction: pick.direction,
        touched_fields: [field],
      });
    }
  }

  return [...resolved.values()];
}

function collectTouchedFields(request: UpdateMediaBuyRequestLike): Set<string> {
  const touched = new Set<string>();
  if (request.paused !== undefined) touched.add('paused');
  if (request.canceled !== undefined) touched.add('canceled');
  if (request.cancellation_reason !== undefined) touched.add('cancellation_reason');
  if (request.start_time !== undefined) touched.add('start_time');
  if (request.end_time !== undefined) touched.add('end_time');
  if (request.new_packages !== undefined && request.new_packages.length > 0) {
    touched.add('new_packages');
  }

  if (request.packages) {
    for (const pkg of request.packages) {
      if (pkg.canceled !== undefined) touched.add('packages[].canceled');
      if (pkg.paused !== undefined) touched.add('paused');
      if (pkg.budget !== undefined) touched.add('packages[].budget');
      if (pkg.pacing !== undefined) touched.add('packages[].pacing');
      if (pkg.start_time !== undefined) touched.add('packages[].start_time');
      if (pkg.end_time !== undefined) touched.add('packages[].end_time');
      if (pkg.creative_assignments !== undefined) {
        touched.add('packages[].creative_assignments');
      }
      if (pkg.creatives !== undefined) touched.add('packages[].creatives');
      if (pkg.keyword_targets_add !== undefined) touched.add('packages[].keyword_targets_add');
      if (pkg.keyword_targets_remove !== undefined) {
        touched.add('packages[].keyword_targets_remove');
      }
      if (pkg.negative_keywords_add !== undefined) touched.add('packages[].negative_keywords_add');
      if (pkg.negative_keywords_remove !== undefined) {
        touched.add('packages[].negative_keywords_remove');
      }
      if (pkg.targeting_overlay !== undefined) {
        // `frequency_cap` is the only nested field with its own action.
        // Touching the whole overlay falls through to update_targeting.
        const overlayKeys = Object.keys(pkg.targeting_overlay);
        if (overlayKeys.length === 1 && overlayKeys[0] === 'frequency_cap') {
          touched.add('packages[].targeting_overlay.frequency_cap');
        } else {
          touched.add('packages[].targeting_overlay');
        }
      }
    }
  }

  return touched;
}

function resolveBudgetDirection(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): { action: MediaBuyValidAction; direction: ResolvedAction['direction'] } {
  const currentByPkg = new Map<string, number>();
  for (const pkg of currentBuy.packages ?? []) {
    if (pkg.package_id && typeof pkg.budget === 'number') {
      currentByPkg.set(pkg.package_id, pkg.budget);
    }
  }

  let currentTotal = 0;
  let proposedTotal = 0;
  let sawIncrease = false;
  let sawDecrease = false;

  for (const pkg of request.packages ?? []) {
    if (typeof pkg.budget !== 'number') continue;
    const prev = currentByPkg.get(pkg.package_id);
    if (prev === undefined) {
      // No baseline - treat as increase (mirrors how sellers see a new
      // budget on a previously-zero line).
      sawIncrease = true;
      proposedTotal += pkg.budget;
      continue;
    }
    currentTotal += prev;
    proposedTotal += pkg.budget;
    if (pkg.budget > prev) sawIncrease = true;
    if (pkg.budget < prev) sawDecrease = true;
  }

  // Reallocate: per-package movement in both directions but total
  // unchanged (within float tolerance to absorb cent rounding).
  if (sawIncrease && sawDecrease && Math.abs(proposedTotal - currentTotal) < 0.005) {
    return { action: 'reallocate_budget', direction: 'reallocate' };
  }
  if (proposedTotal > currentTotal) return { action: 'increase_budget', direction: 'increase' };
  if (proposedTotal < currentTotal) return { action: 'decrease_budget', direction: 'decrease' };

  // Equal totals with no per-package movement (e.g. budget set to same
  // value) - defaults to reallocate so the request still has *some*
  // action attached for the preflight to check against.
  return { action: 'reallocate_budget', direction: 'reallocate' };
}

function resolveFlightEndDirection(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike,
  field: 'end_time' | 'packages[].end_time'
): { action: MediaBuyValidAction; direction: ResolvedAction['direction'] } {
  // If start_time is being touched at the same time, the action is
  // update_flight_dates regardless of end direction (shift semantics).
  if (request.start_time !== undefined) {
    return { action: 'update_flight_dates', direction: 'shift' };
  }
  const packageStartTouched = (request.packages ?? []).some(pkg => pkg.start_time !== undefined);
  if (packageStartTouched) {
    return { action: 'update_flight_dates', direction: 'shift' };
  }

  if (field === 'end_time') {
    const currentEnd = currentBuy.end_time;
    const proposedEnd = request.end_time;
    if (currentEnd && proposedEnd) {
      const cur = Date.parse(currentEnd);
      const next = Date.parse(proposedEnd);
      if (!Number.isNaN(cur) && !Number.isNaN(next)) {
        if (next > cur) return { action: 'extend_flight', direction: 'extend' };
        if (next < cur) return { action: 'shorten_flight', direction: 'shorten' };
      }
    }
    // Can't tell - default to extend (most common request).
    return { action: 'extend_flight', direction: 'extend' };
  }

  // packages[].end_time
  let extending = false;
  let shortening = false;
  const currentByPkg = new Map<string, string | undefined>();
  for (const pkg of currentBuy.packages ?? []) {
    if (pkg.package_id) currentByPkg.set(pkg.package_id, pkg.end_time);
  }
  for (const pkg of request.packages ?? []) {
    if (!pkg.end_time) continue;
    const prev = currentByPkg.get(pkg.package_id);
    if (!prev) {
      extending = true;
      continue;
    }
    const cur = Date.parse(prev);
    const next = Date.parse(pkg.end_time);
    if (Number.isNaN(cur) || Number.isNaN(next)) continue;
    if (next > cur) extending = true;
    if (next < cur) shortening = true;
  }
  if (extending && !shortening) return { action: 'extend_flight', direction: 'extend' };
  if (shortening && !extending) return { action: 'shorten_flight', direction: 'shorten' };
  // Mixed or indeterminate - fall through to update_flight_dates.
  return { action: 'update_flight_dates', direction: 'shift' };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightAllowed {
  ok: true;
  /** Every action the request body covers. Multi-entry for mixed mutations. */
  actions: ResolvedAction[];
  /** Per-action mode resolved from `available_actions[]`. Same order as `actions`. */
  modes: MediaBuyActionMode[];
  /** Echo of the buy's available_actions[] entries the preflight matched. */
  matched: MediaBuyAvailableAction[];
  /** True when any matched action carries a non-`self_serve` mode. */
  requiresAsyncFlow: boolean;
  /** Set when only `valid_actions[]` (legacy 3.0) was available. */
  compat?: { source: AvailableActionsResult['source']; message: string };
}

export interface PreflightDenied {
  ok: false;
  /** The action the request mapped to that the buy doesn't currently allow. */
  action: MediaBuyValidAction;
  reason: ActionNotAllowedReason;
  /** Snapshot of the buy's available_actions[] for caller-side recovery UI. */
  currently_available_actions: MediaBuyAvailableAction[];
  /** Structured recovery hint when `reason: 'mode_mismatch'`. */
  recovery?: ModeMismatchRecovery;
  compat?: { source: AvailableActionsResult['source']; message: string };
}

export type PreflightResult = PreflightAllowed | PreflightDenied;

export type ModeMismatchRecovery =
  | { kind: 'createProposal'; message: string }
  | { kind: 'waitForApproval'; message: string }
  | { kind: 'reissueAsDirect'; message: string };

/**
 * Decide whether an `update_media_buy` request is reachable against the
 * current buy state. When the buy carries only legacy `valid_actions[]`,
 * the preflight passes (with `compat.source: 'valid_actions'`) for any
 * matching action - mode is not knowable, so it's reported as `self_serve`
 * but flagged as a compat fallback.
 *
 * Multi-action requests: every resolved action must be present in
 * `available_actions[]`. First missing action wins the denial.
 */
export function preflightUpdateMediaBuy(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): PreflightResult {
  const resolved = getActionForMutation(currentBuy, request);
  const result = getAvailableActions(currentBuy, { silent: true });
  const compat =
    result.source === 'valid_actions' ? { source: result.source, message: result.deprecationHint ?? '' } : undefined;

  if (resolved.length === 0) {
    // Request didn't touch any recognized field. Treat as a no-op the
    // SDK shouldn't dispatch; the caller probably forgot to set something.
    return {
      ok: false,
      action: 'pause',
      reason: 'not_supported_on_buy',
      currently_available_actions: result.actions,
      recovery: undefined,
      compat,
    };
  }

  const matched: MediaBuyAvailableAction[] = [];
  const modes: MediaBuyActionMode[] = [];

  for (const resolvedAction of resolved) {
    const lookup = findAvailableAction(currentBuy, resolvedAction.action, { silent: true });
    if (!lookup) {
      return {
        ok: false,
        action: resolvedAction.action,
        // Without product allowed_actions on the buy we can't distinguish
        // not_supported_on_product vs not_supported_on_buy. wrong_status
        // is server-side. Default to not_supported_on_buy - the most
        // common preflight failure when a seller doesn't advertise the
        // action on this specific buy.
        reason: 'not_supported_on_buy',
        currently_available_actions: result.actions,
        compat,
      };
    }
    matched.push(lookup.entry);
    modes.push(lookup.entry.mode);
  }

  return {
    ok: true,
    actions: resolved,
    modes,
    matched,
    requiresAsyncFlow: modes.some(m => m !== 'self_serve'),
    compat,
  };
}

/**
 * Build a typed recovery hint from a `mode_mismatch` rejection. Exported
 * so callers handling `ActionNotAllowedError` outside of the preflight
 * surface (e.g. when an in-flight mutation races a buy state change) get
 * the same structured recovery path.
 */
export function recoveryForModeMismatch(
  attemptedAction: MediaBuyValidAction,
  currentlyAvailable: ReadonlyArray<MediaBuyAvailableAction>
): ModeMismatchRecovery | undefined {
  const entry = currentlyAvailable.find(a => a.action === attemptedAction);
  if (!entry) return undefined;
  switch (entry.mode) {
    case 'requires_proposal':
      return {
        kind: 'createProposal',
        message:
          `seller now resolves \`${attemptedAction}\` as requires_proposal. ` +
          'reissue via the proposal lifecycle (`create_proposal` / `finalize_proposal`).',
      };
    case 'requires_approval':
      return {
        kind: 'waitForApproval',
        message:
          `seller now resolves \`${attemptedAction}\` as requires_approval. ` +
          'expect an async approval callback rather than a direct response.',
      };
    case 'conditional_self_serve':
      return {
        kind: 'reissueAsDirect',
        message:
          `seller resolves \`${attemptedAction}\` as conditional_self_serve: ` +
          'small mutations clear automatically, larger ones queue. retry; expect a possible async escalation.',
      };
    case 'self_serve':
      return {
        kind: 'reissueAsDirect',
        message: `seller resolves \`${attemptedAction}\` as self_serve. retry the same request.`,
      };
    default:
      return undefined;
  }
}

// Re-export shared types so consumers can import a single module.
export type {
  ActionNotAllowedReason,
  MediaBuyAvailableAction,
  MediaBuyActionMode,
  MediaBuyValidAction,
  MediaBuyActionContext,
  UpdateMediaBuyRequestLike,
} from './types';
