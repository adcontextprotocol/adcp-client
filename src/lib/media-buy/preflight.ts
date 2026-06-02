// Buyer-side preflight helpers for `update_media_buy`. See RFC #4480.
//
// Three layers, each usable on its own:
//   1. Boolean gates: `canPause(buy)`, `canExtendFlight(buy)`, ... - single
//      question, single answer. Drives UI affordances.
//   2. Decomposer: `decomposeUpdateMediaBuy(buy, request)` - turns a patch
//      into concrete requested mutations plus the actions they cover.
//   3. Resolver: `getActionForMutation(buy, request)` - compatibility wrapper
//      returning just the fine-grained actions. Drives dispatch.
//   4. Preflight: `preflightUpdateMediaBuy(buy, request)` - composes
//      resolver + gate checks into a single ok/not-ok decision.

import { ValidationError } from '../errors';
import { findAvailableAction, getAvailableActions, type AvailableActionsResult } from './available-actions';
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

export const canRemoveCreative = (buy: MediaBuyActionContext): boolean => isAvailable(buy, 'remove_creative');

// Float tolerance for comparing summed budgets across packages. Below this
// difference, two totals are treated as equal (absorbs cent-rounding from
// per-package decimal math). Half a cent is the smallest representable
// difference any current AdCP currency cares about. If a future spec
// extension allows sub-cent / micro-amount pricing (e.g. programmatic
// auction-side bidding) this tolerance would mask real reallocations and
// should be tightened or made currency-aware.
const BUDGET_EQUAL_TOLERANCE = 0.005;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export type MediaBuyMutationDirection = 'increase' | 'decrease' | 'reallocate' | 'extend' | 'shorten' | 'shift';

/**
 * One action a request body covers, plus the direction inference where the
 * fine-grained vocabulary distinguishes increase/decrease or
 * extend/shorten. `touched_fields` lists the normalized dotted paths that
 * triggered this entry (useful for debugging).
 */
export interface ResolvedAction {
  action: MediaBuyValidAction;
  /**
   * Direction tag. Present when the resolver picked between fine-grained
   * siblings (e.g. `increase_budget` vs `decrease_budget`).
   */
  direction?: MediaBuyMutationDirection;
  touched_fields: string[];
}

export type MediaBuyMutationScope = 'buy' | 'package' | 'packages';

/**
 * One concrete requested mutation inside an `update_media_buy` patch.
 *
 * `field` is the normalized schema path used for action mapping
 * (`packages[].budget`), while `path` is the concrete request path
 * (`packages[0].budget`) that adopter code can use for diagnostics or
 * dispatch. `from` is best-effort and only populated for fields the helper can
 * read from the supplied current buy snapshot.
 */
export interface DecomposedUpdateMediaBuyMutation {
  action: MediaBuyValidAction;
  direction?: MediaBuyMutationDirection;
  field: string;
  path: string;
  scope: MediaBuyMutationScope;
  package_id?: string;
  package_index?: number;
  from?: unknown;
  to?: unknown;
}

export interface DecomposedUpdateMediaBuy {
  /** Concrete mutations requested by the patch. Empty when no known fields were touched. */
  mutations: DecomposedUpdateMediaBuyMutation[];
  /** Aggregated action view, preserving the legacy `getActionForMutation()` shape. */
  actions: ResolvedAction[];
  /** Unique normalized fields touched by this patch, in request traversal order. */
  touched_fields: string[];
}

/**
 * Walk the request body and return the set of fine-grained actions it
 * covers. Compatibility wrapper over `decomposeUpdateMediaBuy()` for callers
 * that only need the action-level view.
 *
 * Returns an empty array when the request touches no recognized field
 * (e.g. only `idempotency_key` / `revision` / `account` were set).
 */
export function getActionForMutation(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): ResolvedAction[] {
  return decomposeUpdateMediaBuy(currentBuy, request).actions;
}

/**
 * Decompose an `update_media_buy` patch into the concrete mutations it
 * requests plus the fine-grained actions those mutations require.
 *
 * This is intentionally read-only: it does not validate availability or
 * mutate the request. Buyer code can use it for previews and preflight;
 * seller/adopter code can use it to dispatch individual patch operations
 * without re-walking the raw request.
 */
export function decomposeUpdateMediaBuy(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): DecomposedUpdateMediaBuy {
  const mutations: DecomposedUpdateMediaBuyMutation[] = [];
  const currentPackages = new Map<string, NonNullable<MediaBuyActionContext['packages']>[number]>();

  for (const pkg of currentBuy.packages ?? []) {
    if (pkg.package_id) currentPackages.set(pkg.package_id, pkg);
  }

  const push = (mutation: DecomposedUpdateMediaBuyMutation): void => {
    mutations.push(mutation);
  };

  if (request.paused !== undefined) {
    push({
      action: request.paused === false ? 'resume' : 'pause',
      field: 'paused',
      path: 'paused',
      scope: 'buy',
      to: request.paused,
    });
  }

  if (request.canceled !== undefined) {
    push({
      action: 'cancel',
      field: 'canceled',
      path: 'canceled',
      scope: 'buy',
      to: request.canceled,
    });
  }

  if (request.cancellation_reason !== undefined) {
    push({
      action: 'cancel',
      field: 'cancellation_reason',
      path: 'cancellation_reason',
      scope: 'buy',
      to: request.cancellation_reason,
    });
  }

  if (request.start_time !== undefined) {
    push({
      action: 'update_flight_dates',
      direction: 'shift',
      field: 'start_time',
      path: 'start_time',
      scope: 'buy',
      from: currentBuy.start_time,
      to: request.start_time,
    });
  }

  if (request.end_time !== undefined) {
    const pick = resolveFlightEndDirection(currentBuy, request, 'end_time');
    push({
      ...pick,
      field: 'end_time',
      path: 'end_time',
      scope: 'buy',
      from: currentBuy.end_time,
      to: request.end_time,
    });
  }

  if (request.new_packages !== undefined && request.new_packages.length > 0) {
    push({
      action: 'add_packages',
      field: 'new_packages',
      path: 'new_packages',
      scope: 'packages',
      to: request.new_packages,
    });
  }

  if (request.packages) {
    const budgetPick = resolveBudgetDirection(currentBuy, request);
    const packageEndPick = resolveFlightEndDirection(currentBuy, request, 'packages[].end_time');

    request.packages.forEach((pkg, index) => {
      const currentPkg = currentPackages.get(pkg.package_id);
      const base = {
        scope: 'package' as const,
        package_id: pkg.package_id,
        package_index: index,
      };

      if (pkg.canceled !== undefined) {
        push({
          action: 'remove_packages',
          field: 'packages[].canceled',
          path: `packages[${index}].canceled`,
          ...base,
          to: pkg.canceled,
        });
      }
      // `pkg.paused` has no entry in the generated action mapping - the
      // spec keys pause/resume at the buy level only. Drop silently so the
      // resolver doesn't conflate it with the top-level `paused` action.

      if (pkg.budget !== undefined) {
        push({
          ...budgetPick,
          field: 'packages[].budget',
          path: `packages[${index}].budget`,
          ...base,
          from: currentPkg?.budget,
          to: pkg.budget,
        });
      }

      if (pkg.pacing !== undefined) {
        push({
          action: 'update_pacing',
          field: 'packages[].pacing',
          path: `packages[${index}].pacing`,
          ...base,
          to: pkg.pacing,
        });
      }

      if (pkg.start_time !== undefined) {
        push({
          action: 'update_flight_dates',
          direction: 'shift',
          field: 'packages[].start_time',
          path: `packages[${index}].start_time`,
          ...base,
          from: currentPkg?.start_time,
          to: pkg.start_time,
        });
      }

      if (pkg.end_time !== undefined) {
        push({
          ...packageEndPick,
          field: 'packages[].end_time',
          path: `packages[${index}].end_time`,
          ...base,
          from: currentPkg?.end_time,
          to: pkg.end_time,
        });
      }

      if (pkg.creative_assignments !== undefined) {
        push({
          action: 'update_creative_assignments',
          field: 'packages[].creative_assignments',
          path: `packages[${index}].creative_assignments`,
          ...base,
          to: pkg.creative_assignments,
        });
      }

      if (pkg.creatives !== undefined) {
        push({
          action: 'replace_creative',
          field: 'packages[].creatives',
          path: `packages[${index}].creatives`,
          ...base,
          to: pkg.creatives,
        });
      }

      if (pkg.keyword_targets_add !== undefined) {
        push({
          action: 'update_targeting',
          field: 'packages[].keyword_targets_add',
          path: `packages[${index}].keyword_targets_add`,
          ...base,
          to: pkg.keyword_targets_add,
        });
      }

      if (pkg.keyword_targets_remove !== undefined) {
        push({
          action: 'update_targeting',
          field: 'packages[].keyword_targets_remove',
          path: `packages[${index}].keyword_targets_remove`,
          ...base,
          to: pkg.keyword_targets_remove,
        });
      }

      if (pkg.negative_keywords_add !== undefined) {
        push({
          action: 'update_targeting',
          field: 'packages[].negative_keywords_add',
          path: `packages[${index}].negative_keywords_add`,
          ...base,
          to: pkg.negative_keywords_add,
        });
      }

      if (pkg.negative_keywords_remove !== undefined) {
        push({
          action: 'update_targeting',
          field: 'packages[].negative_keywords_remove',
          path: `packages[${index}].negative_keywords_remove`,
          ...base,
          to: pkg.negative_keywords_remove,
        });
      }

      if (pkg.targeting_overlay !== undefined) {
        // `frequency_cap` is the only nested field with its own action.
        // Touching the whole overlay falls through to update_targeting.
        const overlayKeys = Object.keys(pkg.targeting_overlay);
        if (overlayKeys.length === 1 && overlayKeys[0] === 'frequency_cap') {
          push({
            action: 'update_frequency_caps',
            field: 'packages[].targeting_overlay.frequency_cap',
            path: `packages[${index}].targeting_overlay.frequency_cap`,
            ...base,
            to: pkg.targeting_overlay.frequency_cap,
          });
        } else {
          push({
            action: 'update_targeting',
            field: 'packages[].targeting_overlay',
            path: `packages[${index}].targeting_overlay`,
            ...base,
            to: pkg.targeting_overlay,
          });
        }
      }
    });
  }

  return {
    mutations,
    actions: aggregateResolvedActions(mutations),
    touched_fields: uniqueFields(mutations),
  };
}

function aggregateResolvedActions(mutations: ReadonlyArray<DecomposedUpdateMediaBuyMutation>): ResolvedAction[] {
  const resolved = new Map<MediaBuyValidAction, ResolvedAction>();

  for (const mutation of mutations) {
    const existing = resolved.get(mutation.action);
    if (existing) {
      if (existing.direction === undefined && mutation.direction !== undefined) {
        existing.direction = mutation.direction;
      }
      if (!existing.touched_fields.includes(mutation.field)) {
        existing.touched_fields.push(mutation.field);
      }
      continue;
    }

    resolved.set(mutation.action, {
      action: mutation.action,
      direction: mutation.direction,
      touched_fields: [mutation.field],
    });
  }

  return [...resolved.values()];
}

function uniqueFields(mutations: ReadonlyArray<DecomposedUpdateMediaBuyMutation>): string[] {
  const fields: string[] = [];
  for (const mutation of mutations) {
    if (!fields.includes(mutation.field)) fields.push(mutation.field);
  }
  return fields;
}

function resolveBudgetDirection(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): { action: MediaBuyValidAction; direction: MediaBuyMutationDirection } {
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
  if (sawIncrease && sawDecrease && Math.abs(proposedTotal - currentTotal) < BUDGET_EQUAL_TOLERANCE) {
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
): { action: MediaBuyValidAction; direction: MediaBuyMutationDirection } {
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
    // Indeterminate (missing baseline or unparseable dates). Fall through
    // to the generic vocabulary; sellers that advertise either of the
    // direction-specific actions usually also advertise update_flight_dates.
    return { action: 'update_flight_dates', direction: 'shift' };
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
  /** Concrete requested mutations backing `actions`. */
  mutations: DecomposedUpdateMediaBuyMutation[];
  /** Per-action mode resolved from `available_actions[]`. Same order as `actions`. */
  modes: MediaBuyActionMode[];
  /** Echo of the buy's available_actions[] entries the preflight matched. */
  matched: MediaBuyAvailableAction[];
  /** True when any matched action carries a non-`self_serve` mode. */
  requiresAsyncFlow: boolean;
  /** Set when only `valid_actions[]` (legacy 3.0) was available. */
  compat?: { source: AvailableActionsResult['source']; message: string };
}

/**
 * One blocked action in a denied preflight. Multi-action requests can
 * accumulate several denials in a single result so callers can render
 * every blocker in one pass.
 */
export interface PreflightDenial {
  action: MediaBuyValidAction;
  reason: ActionNotAllowedReason;
  /** Structured recovery hint when `reason: 'mode_mismatch'`. */
  recovery?: ModeMismatchRecovery;
}

export interface PreflightDenied {
  ok: false;
  /** Concrete requested mutations backing the denied action checks. */
  mutations: DecomposedUpdateMediaBuyMutation[];
  /** Every action the request mapped to that the buy doesn't currently allow. */
  denials: PreflightDenial[];
  /** Snapshot of the buy's available_actions[] for caller-side recovery UI. */
  currently_available_actions: MediaBuyAvailableAction[];
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
 * `available_actions[]`. All missing actions are reported in `denials[]`
 * so callers can render every blocker in a single pass.
 *
 * Throws `ValidationError` when the request touches no recognized
 * `update_media_buy` field. This is a buyer-side bug (the SDK was asked to
 * dispatch a no-op), not a seller-side denial.
 */
export function preflightUpdateMediaBuy(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike
): PreflightResult {
  const decomposition = decomposeUpdateMediaBuy(currentBuy, request);
  const resolved = decomposition.actions;

  if (resolved.length === 0) {
    throw new ValidationError(
      'request',
      request,
      'update_media_buy request must touch at least one mutating field (paused, canceled, start_time, end_time, packages[*], or new_packages)'
    );
  }

  const result = getAvailableActions(currentBuy, { silent: true });
  const compat =
    result.source === 'valid_actions' ? { source: result.source, message: result.deprecationHint ?? '' } : undefined;

  const matched: MediaBuyAvailableAction[] = [];
  const modes: MediaBuyActionMode[] = [];
  const denials: PreflightDenial[] = [];

  for (const resolvedAction of resolved) {
    const lookup = findAvailableAction(currentBuy, resolvedAction.action, { silent: true });
    if (!lookup) {
      // Without product allowed_actions on the buy we can't distinguish
      // not_supported_on_product vs not_supported_on_buy. wrong_status
      // is server-side. Default to not_supported_on_buy: the most common
      // preflight failure when a seller doesn't advertise the action on
      // this specific buy.
      denials.push({ action: resolvedAction.action, reason: 'not_supported_on_buy' });
      continue;
    }
    matched.push(lookup.entry);
    modes.push(lookup.entry.mode);
  }

  if (denials.length > 0) {
    return {
      ok: false,
      mutations: decomposition.mutations,
      denials,
      currently_available_actions: result.actions,
      compat,
    };
  }

  return {
    ok: true,
    actions: resolved,
    mutations: decomposition.mutations,
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
  // `requires_proposal` was removed from the rc4+ mode enum in favor of
  // REQUOTE_REQUIRED, but older 3.1 prerelease sellers can still emit it.
  switch (entry.mode as MediaBuyActionMode | 'requires_proposal') {
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
