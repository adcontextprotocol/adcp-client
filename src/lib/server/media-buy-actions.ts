import { ADCP_VERSION } from '../version';
import {
  actionFitsErrorDetails,
  liveActionFitsVersion,
  liveActionIssues,
  supportsChangeTermIdentity,
} from '../media-buy/action-contracts';
import type { LiveMediaBuyAction as MediaBuyAvailableAction } from '../media-buy/action-types';
/**
 * Server/adopter helpers for enforcing the update_media_buy action surface.
 *
 * The media-buy module owns pure decomposition and preflight. This wrapper
 * converts denied preflights into the canonical server-side `AdcpError` shape
 * so DecisioningPlatform implementations can reject unavailable mutations
 * without hand-building ACTION_NOT_ALLOWED envelopes.
 */

import { ValidationError } from '../errors';
import {
  getAvailableActions,
  findAvailableAction,
  preflightUpdateMediaBuy,
  type ActionNotAllowedReason,
  type MediaBuyActionContext,
  type MediaBuyActionMode,
  type PreflightAllowed,
  type PreflightDenied,
  type PreflightDenial,
  type UpdateMediaBuyRequestLike,
} from '../media-buy';
import { AdcpError } from './decisioning/async-outcome';

export interface AssertUpdateMediaBuyAllowedOptions {
  /** Exact error-details schema version; defaults to the SDK pin. */
  adcpVersion?: string;
  /** Defaults to update_media_buy compatibility. Compact handlers must pass their own task explicitly. */
  task?: import('../media-buy/action-types').MediaBuyTask;
  proposal?: import('../media-buy/action-types').ActionProposal;
  termsRefIsAlias?: boolean;
  now?: number;
  /**
   * Restrict the modes this call path may execute directly. Omit to enforce
   * availability only. Pass `['self_serve']` when the handler cannot queue
   * proposal / approval flows and should reject those as `mode_mismatch`.
   */
  allowedModes?: readonly MediaBuyActionMode[];
  /**
   * Override the reason used for missing actions. Defaults to the preflight
   * denial reason (`not_supported_on_buy` for buyer-side preflight misses).
   */
  reason?: ActionNotAllowedReason | ((denial: PreflightDenial, result: PreflightDenied) => ActionNotAllowedReason);
}

/**
 * Assert that an `update_media_buy` patch only requests actions currently
 * available on the supplied media buy. On success, returns the same enriched
 * preflight result callers can use to dispatch `result.mutations`.
 *
 * Throws:
 * - `AdcpError('INVALID_REQUEST')` when the patch contains no recognized
 *   update mutation.
 * - `AdcpError('ACTION_NOT_ALLOWED')` with spec details when at least one
 *   requested action is unavailable or disallowed by `allowedModes`.
 */
export function assertUpdateMediaBuyAllowed(
  currentBuy: MediaBuyActionContext,
  request: UpdateMediaBuyRequestLike,
  options: AssertUpdateMediaBuyAllowedOptions = {}
): PreflightAllowed {
  let result: ReturnType<typeof preflightUpdateMediaBuy>;
  try {
    result = preflightUpdateMediaBuy(currentBuy, request, {
      task: options.task ?? 'update_media_buy',
      proposal: options.proposal,
      termsRefIsAlias: options.termsRefIsAlias,
      now: options.now,
      adcpVersion: options.adcpVersion ?? ADCP_VERSION,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new AdcpError('INVALID_REQUEST', {
        message: err.message,
        recovery: 'correctable',
        field: 'request',
      });
    }
    throw err;
  }

  const currentlyAvailable = getAvailableActions(currentBuy, { silent: true }).actions;
  if (result.ok) {
    const mismatch = result.matched.find(
      entry =>
        options.task !== undefined &&
        options.task !== 'update_media_buy' &&
        (entry.task ?? 'update_media_buy') !== options.task
    );
    if (mismatch) throw actionNotAllowed(mismatch.action, 'mode_mismatch', currentlyAvailable, options.adcpVersion);
  }

  if (!result.ok && result.denials.some(d => !d.assessment?.code && d.reason !== 'mode_mismatch'))
    throw actionNotAllowedFromDenied(
      { ...result, denials: result.denials.filter(d => !d.assessment?.code && d.reason !== 'mode_mismatch') },
      currentlyAvailable,
      options
    );

  if (options.allowedModes?.length) {
    const requested = result.ok ? result.actions : result.mutations;
    const mismatch = requested.find(({ action }) => {
      const entry = findAvailableAction(currentBuy, action, { silent: true })?.entry;
      return entry && !options.allowedModes!.includes(entry.mode as MediaBuyActionMode);
    });
    if (mismatch) throw actionNotAllowed(mismatch.action, 'mode_mismatch', currentlyAvailable, options.adcpVersion);
  }

  if (!result.ok) {
    // A hard action denial takes precedence over an amendable bound. Preserve
    // ACTION_NOT_ALLOWED and its refresh echo for the complete request.
    const hardDenial = result.denials.find(d => !d.assessment?.code);
    if (hardDenial) throw actionNotAllowedFromDenied({ ...result, denials: [hardDenial] }, currentlyAvailable, options);
    const assessment =
      result.denials.find(d => d.assessment?.code === 'CONFLICT')?.assessment ?? result.denials[0]?.assessment;
    if (assessment?.code) {
      throw new AdcpError(assessment.code, {
        message: assessment.message,
        recovery: assessment.code === 'CONFLICT' ? 'transient' : 'correctable',
        field:
          assessment.constraints && assessment.constraints.status !== 'satisfied'
            ? assessment.constraints.path
            : 'revision',
        ...(assessment.constraints &&
          assessment.constraints.status !== 'satisfied' && {
            details: {
              envelope_field: assessment.constraints.path,
              change_term_id: (currentBuy.accepted_proposal ?? options.proposal)?.commercial_terms?.change_terms?.find(
                t => t.action === assessment.action
              )?.term_id,
              constraint: assessment.constraints.constraint,
            },
          }),
      });
    }
    throw actionNotAllowedFromDenied(result, currentlyAvailable, options);
  }

  return result;
}

function actionNotAllowedFromDenied(
  result: PreflightDenied,
  currentlyAvailable: MediaBuyAvailableAction[],
  options: AssertUpdateMediaBuyAllowedOptions
): AdcpError {
  const denial = result.denials[0];
  if (!denial) {
    return new AdcpError('INVALID_REQUEST', {
      message: 'update_media_buy request could not be mapped to an allowed action',
      recovery: 'correctable',
      field: 'request',
    });
  }

  const reason =
    typeof options.reason === 'function' ? options.reason(denial, result) : (options.reason ?? denial.reason);

  return actionNotAllowed(denial.action, reason, currentlyAvailable, options.adcpVersion);
}

function actionNotAllowed(
  attemptedAction: string,
  reason: ActionNotAllowedReason,
  currentlyAvailable: MediaBuyAvailableAction[],
  version = ADCP_VERSION
): AdcpError {
  // The published details schema is narrower than canonical MediaBuy actions.
  // Never invent a rollup identity or publish a partial authoritative echo.
  const echoFits =
    !liveActionIssues(currentlyAvailable).length &&
    currentlyAvailable.every(
      entry =>
        actionFitsErrorDetails(entry.action, version) &&
        ['self_serve', 'conditional_self_serve', 'seller_managed', 'requires_approval', 'requires_proposal'].includes(
          entry.mode as string
        ) &&
        liveActionFitsVersion(entry, version)
    );
  const details =
    actionFitsErrorDetails(attemptedAction, version) &&
    (reason !== 'condition_unresolved' || supportsChangeTermIdentity(version))
      ? {
          attempted_action: attemptedAction,
          reason,
          ...(echoFits && { currently_available_actions: currentlyAvailable }),
        }
      : undefined;

  return new AdcpError('ACTION_NOT_ALLOWED', {
    message: buildActionNotAllowedMessage(attemptedAction, reason),
    recovery: 'correctable',
    field: 'update_media_buy',
    ...(details && { details }),
  });
}

function buildActionNotAllowedMessage(action: string, reason: ActionNotAllowedReason): string {
  return `update_media_buy rejected: \`${action}\` not allowed (${reason}).`;
}
