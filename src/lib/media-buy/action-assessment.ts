import type { ActionNotAllowedReason, UpdateMediaBuyRequestLike } from './types';
import type {
  ActionBuy,
  ActionProduct,
  ActionProposal,
  ConstraintAssessment,
  LiveMediaBuyAction,
  MediaBuyAction,
  MediaBuyStatus,
  MediaBuyTask,
  ProductActionAssessment,
  ProposalActionAssessment,
  ProposalChangeTerm,
} from './action-types';
import {
  actionAllowedStatuses,
  changeTermIssues,
  mediaBuyActionTasks,
  productTemplateIssues,
  slaWithin,
} from './action-contracts';
import { evaluateChangeTermConstraints, type ConstraintEvaluationOptions } from './action-constraints';
import { decomposeUpdateMediaBuy } from './mutations';

export interface ActionAssessmentOptions extends ConstraintEvaluationOptions {
  /** Seller-served wire version. 3.1 term references are always opaque. Defaults to the current 3.2 shape. */
  adcpVersion?: string;
  /** Explicit 3.2 compatibility projection declaring terms_ref an alias for change_term_id. */
  termsRefIsAlias?: boolean;
  /** Optional route being attempted. Omission does not turn a live route into a default route. */
  task?: MediaBuyTask;
  request?: UpdateMediaBuyRequestLike;
}
export type ActionAvailability =
  | {
      status: 'available_now';
      action: MediaBuyAction;
      mode: LiveMediaBuyAction['mode'];
      nonDefaultRoute?: MediaBuyTask;
      term: ProposalChangeTerm;
      entry: LiveMediaBuyAction;
      revision?: number;
      constraints?: ConstraintAssessment;
    }
  | {
      status: 'currently_unavailable';
      action: MediaBuyAction;
      reason: ActionNotAllowedReason;
      message: string;
      certainty: 'blocked' | 'unknown';
      allowedStatuses?: MediaBuyStatus[];
      nonDefaultRoute?: MediaBuyTask;
      constraints?: ConstraintAssessment;
      code?: 'REQUOTE_REQUIRED' | 'CONFLICT';
      compat?: { reason: 'no_change_terms'; message: string };
    };

export interface MediaBuyActionAssessment {
  action: MediaBuyAction;
  possibility: ProductActionAssessment;
  promise: ProposalActionAssessment;
  availability: ActionAvailability;
}

/** Product templates are possibility, including their advisory bounds, never acceptance. */
export function assessProductAction(
  product: ActionProduct | undefined,
  action: MediaBuyAction
): ProductActionAssessment {
  if (product?.allowed_actions === undefined)
    return { status: 'unknown', binding: false, message: 'Product action information is absent.' };
  if (productTemplateIssues(product.allowed_actions).length)
    return { status: 'unknown', binding: false, message: 'Product action information is invalid or ambiguous.' };
  const template = product.allowed_actions.find(t => t.action === action);
  return template ? { status: 'possible', binding: false, template } : { status: 'unsupported', binding: false };
}

/** Reports what the proposal promises; it does not verify a digest or accept the proposal. */
export function assessProposalAction(
  proposal: ActionProposal | undefined,
  action: MediaBuyAction
): ProposalActionAssessment {
  const terms = proposal?.commercial_terms?.change_terms;
  if (terms === undefined) return { status: 'unknown', message: 'Proposal change terms are absent.' };
  if (changeTermIssues(terms).length)
    return { status: 'unknown', message: 'Proposal change terms are invalid or ambiguous.' };
  const term = terms.find(t => t.action === action);
  return term ? { status: 'promised', term } : { status: 'not_negotiated' };
}

/**
 * Join the current accepted snapshot and action projection. Pure, synchronous,
 * browser-safe, and read-only. This is preflight evidence, not authorization or
 * an atomic revision check. Submit with the existing client lifecycle safeguards.
 */
export function assessActionAvailability(
  buy: ActionBuy | undefined,
  action: MediaBuyAction,
  options: ActionAssessmentOptions = {}
): ActionAvailability {
  const deny = (
    reason: ActionNotAllowedReason,
    message: string,
    certainty: 'blocked' | 'unknown' = 'blocked',
    extra: Partial<Extract<ActionAvailability, { status: 'currently_unavailable' }>> = {}
  ): ActionAvailability => ({ status: 'currently_unavailable', action, reason, message, certainty, ...extra });
  const proposal = buy?.accepted_proposal;
  const terms = proposal?.commercial_terms?.change_terms;
  if (terms === undefined)
    return deny('condition_unresolved', 'Accepted change rights are unknown.', 'unknown', {
      compat: {
        reason: 'no_change_terms',
        message: 'Legacy action hints and opaque references do not establish a negotiated change right.',
      },
    });
  if (!buy) return deny('condition_unresolved', 'Current MediaBuy state is missing.', 'unknown');
  if (!mediaBuyActionTasks(action).length)
    return deny(
      'condition_unresolved',
      'A canonical action cannot be inferred from this legacy or incomplete mutation state.',
      'unknown'
    );
  if (
    (buy.accepted_proposal_id !== undefined && proposal?.proposal_id !== buy.accepted_proposal_id) ||
    (proposal?.media_buy_id !== undefined && proposal.media_buy_id !== buy.media_buy_id) ||
    (proposal?.proposal_status !== undefined && proposal.proposal_status !== 'accepted')
  )
    return deny('condition_unresolved', 'The supplied proposal is not the current accepted snapshot.', 'unknown');
  const promise = assessProposalAction(proposal, action);
  if (promise.status === 'unknown') return deny('condition_unresolved', promise.message, 'unknown');
  if (promise.status === 'not_negotiated')
    return deny('not_supported_on_buy', 'This action was not negotiated in the accepted proposal.');
  const term = promise.term;
  const allowedStatuses = actionAllowedStatuses(term);
  if (buy.status === undefined) return deny('condition_unresolved', 'Current MediaBuy status is missing.', 'unknown');
  if (!allowedStatuses.includes(buy.status as MediaBuyStatus))
    return deny('wrong_status', 'The negotiated action is latent in the current status.', 'blocked', {
      allowedStatuses,
    });
  if (
    options.request?.revision !== undefined &&
    (buy.revision === undefined || options.request.revision !== buy.revision)
  )
    return deny('condition_unresolved', 'Refresh the MediaBuy revision and reassess before submitting.', 'unknown', {
      code: 'CONFLICT',
    });
  if (term.conditions?.length)
    return deny(
      'condition_unresolved',
      'Opaque conditions require seller evaluation; their identifiers grant no authority.',
      'unknown'
    );
  const entries = buy.available_actions;
  if (entries === undefined)
    return deny(
      'condition_unresolved',
      'A current structured action projection is required; legacy hints have no mode or term identity.',
      'unknown'
    );
  if (!Array.isArray(entries) || entries.some((e, i) => !e || entries.findIndex(x => x?.action === e.action) !== i))
    return deny('condition_unresolved', 'The live action projection is invalid or ambiguous.', 'unknown');
  const entry = entries.find(e => e.action === action);
  if (!entry)
    return deny('not_supported_on_buy', 'The seller has not made this negotiated action available now.', 'unknown');
  if (options.adcpVersion && /^3\.[01](?:\.|-|$)/.test(options.adcpVersion))
    return deny(
      'condition_unresolved',
      'Legacy terms_ref is opaque and cannot establish the current term link.',
      'unknown'
    );
  if (entry.change_term_id === undefined || entry.change_term_id !== term.term_id)
    return deny('condition_unresolved', 'The live action does not identify its accepted change term.', 'unknown');
  if (options.termsRefIsAlias && entry.terms_ref !== undefined && entry.terms_ref !== entry.change_term_id)
    return deny('condition_unresolved', 'The deliberately emitted term aliases disagree.', 'unknown');
  if (entry.mode !== term.service_mode || !slaWithin(term.processing_sla, entry.sla))
    return deny('mode_mismatch', 'The live mode or SLA exceeds the accepted commitment.');
  if (!entry.task || !mediaBuyActionTasks(action).includes(entry.task))
    return deny('mode_mismatch', 'The live action has no compatible canonical task.');
  const nonDefaultRoute = entry.task === 'update_media_buy' ? undefined : entry.task;
  if (options.task !== undefined && options.task !== entry.task)
    return deny(
      'mode_mismatch',
      'Use the task declared by the live action; seller_managed uses its standard async lifecycle.',
      'blocked',
      { nonDefaultRoute }
    );
  let constraints: ConstraintAssessment | undefined;
  if (term.constraints !== undefined) {
    constraints = options.request
      ? evaluateChangeTermConstraints(
          term,
          buy,
          options.request,
          decomposeUpdateMediaBuy(buy as Parameters<typeof decomposeUpdateMediaBuy>[0], options.request).mutations,
          options
        )
      : {
          status: 'unknown',
          constraint: 'request',
          path: action,
          message: 'Supply the requested mutation to evaluate portable bounds.',
        };
    if (constraints.status !== 'satisfied')
      return deny(
        'condition_unresolved',
        constraints.message,
        constraints.status === 'unknown' ? 'unknown' : 'blocked',
        {
          constraints,
          ...(constraints.status === 'exceeded' && { code: 'REQUOTE_REQUIRED', nonDefaultRoute: 'refine_proposals' }),
        }
      );
  }
  return {
    status: 'available_now',
    action,
    mode: entry.mode,
    nonDefaultRoute,
    term,
    entry,
    revision: buy.revision,
    ...(constraints && { constraints }),
  };
}

/** Render possible / promised / available-now from one call. Product data never creates a promise. */
export function assessMediaBuyAction(
  input: {
    action: MediaBuyAction;
    product?: ActionProduct;
    proposal?: ActionProposal;
    buy?: ActionBuy;
  } & ActionAssessmentOptions
): MediaBuyActionAssessment {
  const possibility = assessProductAction(input.product, input.action);
  const promise = assessProposalAction(input.buy?.accepted_proposal ?? input.proposal, input.action);
  let availability = assessActionAvailability(input.buy, input.action, input);
  // An explicit current product denial can narrow accepted rights. Absence is
  // not a denial and an advisory positive cannot override any other blocker.
  if (possibility.status === 'unsupported')
    availability = {
      status: 'currently_unavailable',
      action: input.action,
      reason: 'not_supported_on_product',
      message: 'The product does not currently support this action.',
      certainty: 'blocked',
    };
  return { action: input.action, possibility, promise, availability };
}

/** ACTION_NOT_ALLOWED echoes replace the action set, including an explicit empty set. They never update revision or accepted terms. */
export function refreshMediaBuyActions<T extends ActionBuy>(
  buy: T,
  details: { currently_available_actions: readonly LiveMediaBuyAction[] }
): T {
  return { ...buy, available_actions: details.currently_available_actions.map(entry => ({ ...entry })) };
}

export type MediaBuyActionsPreflight =
  | { ok: true; assessments: Extract<ActionAvailability, { status: 'available_now' }>[] }
  | { ok: false; assessments: ActionAvailability[]; message?: string };

/** Assess every decomposed action atomically; never send a partial multi-action request. */
export function preflightMediaBuyActions(
  buy: ActionBuy,
  request: UpdateMediaBuyRequestLike,
  options: Omit<ActionAssessmentOptions, 'request'> = {}
): MediaBuyActionsPreflight {
  const decomposition = decomposeUpdateMediaBuy(buy as Parameters<typeof decomposeUpdateMediaBuy>[0], request);
  const envelopeFields = new Set([
    'media_buy_id',
    'account',
    'revision',
    'idempotency_key',
    'adcp_version',
    'adcp_major_version',
    'context_id',
    'context',
    'governance_context',
    'push_notification_config',
  ]);
  const fields = new Set(decomposition.mutations.map(m => m.field));
  const unresolvedField =
    Object.entries(request).some(
      ([key, value]) =>
        value !== undefined &&
        !envelopeFields.has(key) &&
        ![...fields].some(field => field === key || field.startsWith(`${key}.`) || field.startsWith(`${key}[].`))
    ) ||
    request.packages?.some(pkg =>
      Object.entries(pkg).some(
        ([key, value]) =>
          value !== undefined &&
          key !== 'package_id' &&
          ![...fields].some(field => field === `packages[].${key}` || field.startsWith(`packages[].${key}.`))
      )
    );
  if (unresolvedField)
    return {
      ok: false,
      assessments: [],
      message: 'At least one requested field has no supported action mapping; do not submit a partial mutation.',
    };
  if (!decomposition.actions.length)
    return { ok: false, assessments: [], message: 'No recognized mutation could be assessed.' };
  const assessments = decomposition.actions.map(({ action }) =>
    assessActionAvailability(buy, action, { ...options, request })
  );
  if (
    assessments.every(
      (a): a is Extract<ActionAvailability, { status: 'available_now' }> => a.status === 'available_now'
    )
  )
    return { ok: true, assessments };
  return { ok: false, assessments };
}
