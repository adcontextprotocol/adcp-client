import type { LiveMediaBuyAction as MediaBuyAvailableAction } from './action-types';
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
import {
  withActionProposal,
  liveActionIssues,
  liveActionFitsVersion,
  mediaBuyActionTasks,
  packageActionStatus,
  actionAllowedStatuses,
} from './action-contracts';
import { assessActionAvailability, type ActionAssessmentOptions } from './action-assessment';
import { findAvailableAction, getAvailableActions, type AvailableActionsResult } from './available-actions';
import type {
  ActionNotAllowedReason,
  MediaBuyActionContext,
  MediaBuyActionId,
  MediaBuyActionMode,
  MediaBuyValidAction,
  UpdateMediaBuyRequestLike,
} from './types';
import {
  decomposeUpdateMediaBuy,
  hasUnmappedMutation,
  type ResolvedAction,
  type DecomposedUpdateMediaBuyMutation,
} from './mutations';
export * from './mutations';

// ---------------------------------------------------------------------------
// Boolean gates
// ---------------------------------------------------------------------------

function isAvailable(buy: MediaBuyActionContext, action: MediaBuyActionId): boolean {
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
  action: MediaBuyActionId;
  reason: ActionNotAllowedReason;
  /** Structured recovery hint when `reason: 'mode_mismatch'`. */
  recovery?: ModeMismatchRecovery;
  /** Portable bound or missing-state diagnostic, when accepted change terms were supplied. */
  assessment?: Extract<import('./action-assessment').ActionAvailability, { status: 'currently_unavailable' }>;
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
  | { kind: 'waitForTask'; message: string }
  | { kind: 'reissueAsDirect'; message: string };

/**
 * Decide whether an `update_media_buy` request is reachable against the
 * current buy state. When the buy carries only legacy `valid_actions[]`,
 * the preflight passes (with `compat.source: 'valid_actions'`) for any
 * matching action - mode is not knowable, so it's reported as `self_serve`
 * but flagged as a compat fallback.
 *
 * Supplying an accepted snapshot enables negotiated-term checks; separately stored
 * snapshots use options.proposal. options.task defaults to the named update facade.
 * For route-neutral strict assessment, use preflightMediaBuyActions.
 *
 * Multi-action requests: every resolved action must be present in
 * `available_actions[]`. All missing actions are reported in `denials[]`
 * so callers can render every blocker in a single pass.
 *
 * Throws `ValidationError` for unmapped mutation fields or when the request
 * touches no recognized `update_media_buy` field. This is a buyer-side bug (the SDK was asked to
 * dispatch a no-op), not a seller-side denial.
 */
export function preflightUpdateMediaBuy(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike,
  options: Omit<ActionAssessmentOptions, 'request'> = {}
): PreflightResult {
  const assessmentBuy = currentBuy;
  currentBuy = withActionProposal(currentBuy, options);
  options = { ...options, task: options.task ?? 'update_media_buy' };
  const decomposition = decomposeUpdateMediaBuy(currentBuy, request);
  const resolved = decomposition.actions;
  const strict =
    currentBuy.accepted_proposal?.commercial_terms?.change_terms !== undefined ||
    currentBuy.available_actions?.some(entry => entry?.change_term_id !== undefined) === true;
  if (hasUnmappedMutation(request, decomposition))
    throw new ValidationError(
      'request',
      undefined,
      'At least one requested mutation has no supported action mapping; do not submit a partial mutation.'
    );

  if (resolved.length === 0) {
    throw new ValidationError(
      'request',
      undefined,
      'update_media_buy request must touch at least one mutating field (paused, canceled, start_time, end_time, frequency_cap, packages[*], or new_packages)'
    );
  }

  const result = getAvailableActions(currentBuy, { silent: true });
  const compat =
    result.source === 'valid_actions' ? { source: result.source, message: result.deprecationHint ?? '' } : undefined;

  const matched: MediaBuyAvailableAction[] = [];
  const modes: MediaBuyActionMode[] = [];
  const denials: PreflightDenial[] = [];

  for (const resolvedAction of resolved) {
    // Package controls are new to this facade. Legacy grants cannot override
    // known package state or supply the missing negotiated pending-buy scope.
    if (!strict && (resolvedAction.action === 'pause' || resolvedAction.action === 'resume')) {
      const controls = decomposition.mutations.filter(
        mutation => mutation.action === resolvedAction.action && mutation.field === 'packages[].paused'
      );
      if (controls.length) {
        const statuses = controls.map(mutation =>
          packageActionStatus(currentBuy.packages?.find(pkg => pkg.package_id === mutation.package_id))
        );
        const allowed = actionAllowedStatuses({ action: resolvedAction.action });
        if (currentBuy.status === undefined || statuses.some(status => status === undefined)) {
          denials.push({ action: resolvedAction.action, reason: 'condition_unresolved' });
          continue;
        }
        if (
          !['active', 'paused'].includes(currentBuy.status) ||
          statuses.some(status => !allowed.includes(status as (typeof allowed)[number]))
        ) {
          denials.push({ action: resolvedAction.action, reason: 'wrong_status' });
          continue;
        }
      }
    }
    if (strict || options.proposal !== undefined || resolvedAction.action === 'update_name') {
      const assessment = assessActionAvailability(assessmentBuy, resolvedAction.action, { ...options, request });
      if (assessment.status === 'currently_unavailable') {
        denials.push({ action: resolvedAction.action, reason: assessment.reason, assessment });
        continue;
      }
    }
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
    // Native field bindings must not grant newer wire features to a legacy snapshot.
    if (options.adcpVersion && !liveActionFitsVersion(lookup.entry, options.adcpVersion)) {
      denials.push({
        action: resolvedAction.action,
        reason: 'condition_unresolved',
        assessment: {
          status: 'currently_unavailable',
          action: resolvedAction.action,
          reason: 'condition_unresolved',
          certainty: 'unknown',
          message: 'The action uses metadata introduced after the supplied seller version.',
        },
      });
      continue;
    }
    if (
      !strict &&
      lookup.entry.task !== undefined &&
      !mediaBuyActionTasks(resolvedAction.action).includes(lookup.entry.task)
    ) {
      denials.push({ action: resolvedAction.action, reason: 'mode_mismatch' });
      continue;
    }
    // Legacy compatibility must still honor explicit current scope and route restrictions.
    if (!strict && lookup.entry.applicable_package_ids !== undefined) {
      const scoped = decomposition.mutations.filter(m => m.action === resolvedAction.action);
      const ids = lookup.entry.applicable_package_ids;
      if (liveActionIssues([lookup.entry]).length || !scoped.length) {
        denials.push({ action: resolvedAction.action, reason: 'condition_unresolved' });
        continue;
      }
      if (scoped.some(m => m.scope !== 'package' || !m.package_id || !ids.includes(m.package_id))) {
        denials.push({ action: resolvedAction.action, reason: 'not_supported_on_buy' });
        continue;
      }
    }
    if (!strict && options.task !== 'update_media_buy' && options.task !== (lookup.entry.task ?? 'update_media_buy')) {
      denials.push({ action: resolvedAction.action, reason: 'mode_mismatch' });
      continue;
    }
    matched.push(lookup.entry);
    modes.push(lookup.entry.mode);
  }

  if (
    strict &&
    options.task !== 'update_media_buy' &&
    denials.length === 0 &&
    new Set(matched.map(entry => entry.task ?? 'update_media_buy')).size > 1
  ) {
    for (const action of resolved) denials.push({ action: action.action, reason: 'mode_mismatch' });
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
  attemptedAction: MediaBuyActionId,
  currentlyAvailable: ReadonlyArray<MediaBuyAvailableAction>
): ModeMismatchRecovery | undefined {
  const entry = currentlyAvailable.find(a => a.action === attemptedAction);
  if (!entry) return undefined;
  // `requires_proposal` was removed from the rc4+ mode enum in favor of
  // REQUOTE_REQUIRED, but older 3.1 prerelease sellers can still emit it.
  switch (entry.mode as MediaBuyActionMode | 'requires_proposal') {
    case 'seller_managed':
      return {
        kind: 'waitForTask',
        message: 'Use the declared task and follow its submitted/working/completed lifecycle.',
      };
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
  MediaBuyActionId,
  MediaBuyActionMode,
  MediaBuyValidAction,
  MediaBuyActionContext,
  UpdateMediaBuyRequestLike,
} from './types';
