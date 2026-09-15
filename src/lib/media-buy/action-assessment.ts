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
  findProductAction,
  NON_TERMINAL_ACTION_STATUSES,
  liveActionIssues,
  liveActionFitsVersion,
  supportsChangeTermIdentity,
  withActionProposal,
  packageActionStatus,
} from './action-contracts';
import { evaluateChangeTermConstraints, type ConstraintEvaluationOptions } from './action-constraints';
import { decomposeUpdateMediaBuy, hasUnmappedMutation, mutationShapeIssue } from './mutations';

export interface ActionAssessmentOptions extends ConstraintEvaluationOptions {
  /** Seller-served wire version. 3.1 term references are always opaque. Defaults to the current 3.2 shape. */
  adcpVersion?: string;
  /** Explicit 3.2 compatibility projection declaring terms_ref an alias for change_term_id. */
  termsRefIsAlias?: boolean;
  /** Current accepted snapshot when it is stored separately from the buy. An embedded snapshot takes precedence. */
  proposal?: ActionProposal;
  /** Optional route being attempted. update_media_buy can subsume compact tasks as a compatibility facade. */
  task?: MediaBuyTask;
  request?: UpdateMediaBuyRequestLike;
}
export type ActionAvailability =
  | {
      status: 'available_now';
      action: MediaBuyAction;
      mode: LiveMediaBuyAction['mode'];
      nonDefaultRoute?: MediaBuyTask;
      /** Metadata changes have live seller authority and no commercial promise. */
      authority: 'accepted_term' | 'live_metadata';
      term?: ProposalChangeTerm;
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
  const template = findProductAction(product.allowed_actions, action);
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
  if (options.request !== undefined && mutationShapeIssue(options.request))
    return deny(
      'condition_unresolved',
      'Invalid mutation field shape; validate against the selected wire schema.',
      'unknown'
    );
  if (!buy) return deny('condition_unresolved', 'Current MediaBuy state is missing.', 'unknown');
  if (options.request?.packages?.length) {
    const requested = options.request.packages.map(p => p.package_id);
    const current = buy.packages?.map(p => p.package_id);
    if (
      !current ||
      new Set(requested).size !== requested.length ||
      new Set(current).size !== current.length ||
      requested.some(id => !id || !current.includes(id))
    )
      return deny(
        'condition_unresolved',
        'Package identities or current package state are missing or ambiguous.',
        'unknown'
      );
  }
  if (buy.accepted_proposal === undefined && options.proposal !== undefined) {
    const supplied = options.proposal;
    const linked =
      (buy.accepted_proposal_id !== undefined && supplied.proposal_id === buy.accepted_proposal_id) ||
      (buy.media_buy_id !== undefined && supplied.media_buy_id === buy.media_buy_id);
    if (!linked || supplied.proposal_status !== 'accepted')
      return deny(
        'condition_unresolved',
        'The separately supplied snapshot must be accepted and explicitly linked to this MediaBuy.',
        'unknown'
      );
  }
  buy = withActionProposal(buy, options);
  const decomposition = options.request
    ? decomposeUpdateMediaBuy(buy as Parameters<typeof decomposeUpdateMediaBuy>[0], options.request)
    : undefined;
  if (options.request && decomposition && hasUnmappedMutation(options.request, decomposition))
    return deny(
      'condition_unresolved',
      'At least one requested field has no supported action mapping; executable-now assessment requires a fully mapped request.',
      'unknown'
    );
  const metadataOnly = action === 'update_name';
  const proposal = buy.accepted_proposal;
  const terms = proposal?.commercial_terms?.change_terms;
  if (terms === undefined && !metadataOnly)
    return deny('condition_unresolved', 'Accepted change rights are unknown.', 'unknown', {
      compat: {
        reason: 'no_change_terms',
        message: 'Legacy action hints and opaque references do not establish a negotiated change right.',
      },
    });
  if (!mediaBuyActionTasks(action).length)
    return deny(
      'condition_unresolved',
      'A canonical action cannot be inferred from this legacy or incomplete mutation state.',
      'unknown'
    );
  if (
    (proposal !== undefined &&
      buy.accepted_proposal_id !== undefined &&
      proposal.proposal_id !== buy.accepted_proposal_id) ||
    (proposal?.media_buy_id !== undefined && proposal.media_buy_id !== buy.media_buy_id) ||
    (proposal?.proposal_status !== undefined && proposal.proposal_status !== 'accepted')
  )
    return deny('condition_unresolved', 'The supplied proposal is not the current accepted snapshot.', 'unknown');
  const promise = assessProposalAction(proposal, action);
  if (!metadataOnly && promise.status === 'unknown') return deny('condition_unresolved', promise.message, 'unknown');
  if (!metadataOnly && promise.status === 'not_negotiated')
    return deny('not_supported_on_buy', 'This action was not negotiated in the accepted proposal.');
  const term = promise.status === 'promised' ? promise.term : undefined;
  const packageLifecycle =
    ['pause', 'resume'].includes(action) &&
    options.request?.packages?.filter(p => p.paused !== undefined && (p.paused ? 'pause' : 'resume') === action);
  const scopedLifecycle = packageLifecycle && packageLifecycle.length > 0 && options.request?.paused === undefined;
  // Package hold state chooses pause vs resume independently of the buy's hold.
  // Without negotiated scope, use the operational buy states where the legacy
  // helper admits either control; pending states still need explicit scope.
  const packageControlStatuses = scopedLifecycle
    ? [...actionAllowedStatuses({ action: 'pause' }), ...actionAllowedStatuses({ action: 'resume' })]
    : [];
  const allowedStatuses = metadataOnly
    ? [...NON_TERMINAL_ACTION_STATUSES]
    : scopedLifecycle
      ? NON_TERMINAL_ACTION_STATUSES.filter(status =>
          term?.allowed_statuses ? term.allowed_statuses.includes(status) : packageControlStatuses.includes(status)
        )
      : actionAllowedStatuses(term!);
  for (const pkg of packageLifecycle || []) {
    const current = buy.packages?.find(p => p.package_id === pkg.package_id);
    const status = packageActionStatus(current);
    if (!status) return deny('condition_unresolved', 'Current package lifecycle state is missing.', 'unknown');
    if (!actionAllowedStatuses({ action }).includes(status as MediaBuyStatus))
      return deny('wrong_status', 'The action is not meaningful in the current package status.');
  }
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
  if (term?.conditions?.length)
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
  if (liveActionIssues(entries).length)
    return deny('condition_unresolved', 'The live action projection is invalid or ambiguous.', 'unknown');
  const entry = entries.find(e => e.action === action);
  if (options.adcpVersion && entry && !liveActionFitsVersion(entry, options.adcpVersion))
    return deny(
      'condition_unresolved',
      'The action uses metadata introduced after the supplied seller version.',
      'unknown'
    );
  if (!entry)
    return deny('not_supported_on_buy', 'The seller has not made this negotiated action available now.', 'unknown');
  if (!metadataOnly && options.adcpVersion && !supportsChangeTermIdentity(options.adcpVersion))
    return deny(
      'condition_unresolved',
      'The supplied seller version cannot link accepted change terms; legacy terms_ref remains opaque.',
      'unknown'
    );
  if (!metadataOnly && (entry.change_term_id === undefined || entry.change_term_id !== term!.term_id))
    return deny('condition_unresolved', 'The live action does not identify its accepted change term.', 'unknown');
  if (
    options.termsRefIsAlias &&
    entry.change_term_id !== undefined &&
    entry.terms_ref !== undefined &&
    entry.terms_ref !== entry.change_term_id
  )
    return deny('condition_unresolved', 'The deliberately emitted term aliases disagree.', 'unknown');
  if (metadataOnly && entry.change_term_id !== undefined)
    return deny('condition_unresolved', 'Metadata-only actions cannot identify a commercial change term.', 'unknown');
  if (!['self_serve', 'conditional_self_serve', 'seller_managed', 'requires_approval'].includes(entry.mode))
    return deny('condition_unresolved', 'Unknown live action mode; refresh the seller declaration.', 'unknown');
  if (term && (entry.mode !== term.service_mode || !slaWithin(term.processing_sla, entry.sla)))
    return deny('mode_mismatch', 'The live mode or SLA exceeds the accepted commitment.');
  if (entry.task !== undefined && !mediaBuyActionTasks(action).includes(entry.task))
    return deny('mode_mismatch', 'The live action has no compatible canonical task.');
  const task = entry.task ?? 'update_media_buy';
  const nonDefaultRoute = task === 'update_media_buy' ? undefined : task;
  if (options.task !== undefined && options.task !== 'update_media_buy' && options.task !== task)
    return deny(
      'mode_mismatch',
      entry.task === undefined
        ? 'This task-less entry uses update_media_buy. Refresh get_media_buys for a canonical task projection before changing routes.'
        : 'Use the task declared by the live action; seller_managed uses its standard async lifecycle.',
      'blocked',
      { nonDefaultRoute }
    );
  const mutations = decomposition?.mutations ?? [];
  if (entry.applicable_package_ids !== undefined) {
    const ids = entry.applicable_package_ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some(id => typeof id !== 'string' || !id.length) ||
      new Set(ids).size !== ids.length
    )
      return deny('condition_unresolved', 'Invalid live package scope.', 'unknown');
    const relevant = mutations.filter(m => m.action === action);
    if (!relevant.length)
      return deny(
        'condition_unresolved',
        'Supply the requested packages to evaluate the live package scope.',
        'unknown'
      );
    if (relevant.some(m => m.scope !== 'package' || !m.package_id || !ids.includes(m.package_id)))
      return deny('not_supported_on_buy', 'The action is not available for every requested package.');
  }
  let constraints: ConstraintAssessment | undefined;
  if (term && (term.constraints !== undefined || options.request)) {
    constraints = options.request
      ? evaluateChangeTermConstraints(term, buy, options.request, mutations, options)
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
          ...(constraints.status === 'exceeded' && { code: 'REQUOTE_REQUIRED' }),
        }
      );
  }
  if (action === 'add_packages' && options.request?.new_packages) {
    const index = options.request.new_packages.findIndex(
      pkg =>
        pkg !== null &&
        typeof pkg === 'object' &&
        ['budget', 'min_spend_target', 'daily_budget_cap'].some(
          field => Object.hasOwn(pkg, field) && (pkg as Record<string, unknown>)[field] !== undefined
        )
    );
    if (index !== -1)
      return deny(
        'condition_unresolved',
        'Added-package monetary commitments cannot be assessed from package-count rights alone.',
        'unknown',
        {
          constraints: {
            status: 'unknown',
            constraint: 'added_package_budget',
            path: `new_packages[${index}]`,
            message:
              'Supply a verified commercial amendment for the added package commitments; their budget baseline is not represented by this portable patch assessment.',
          },
        }
      );
  }
  return {
    status: 'available_now',
    action,
    mode: entry.mode,
    nonDefaultRoute,
    authority: metadataOnly ? 'live_metadata' : 'accepted_term',
    ...(term && { term }),
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
  const availability = assessActionAvailability(input.buy, input.action, input);
  // Advisory discovery information cannot override a negotiated live grant.
  return { action: input.action, possibility, promise, availability };
}

/** ACTION_NOT_ALLOWED echoes replace the action set, including an explicit empty set. They never update revision or accepted terms. */
export function refreshMediaBuyActions<T extends ActionBuy>(buy: T, details: unknown): T {
  if (
    !details ||
    typeof details !== 'object' ||
    !('currently_available_actions' in details) ||
    details.currently_available_actions === undefined
  )
    return buy;
  const entries = details.currently_available_actions;
  if (liveActionIssues(entries).length) throw new TypeError('Invalid ACTION_NOT_ALLOWED action echo.');
  return { ...buy, available_actions: structuredClone(entries as LiveMediaBuyAction[]) };
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
  const assessmentBuy = buy;
  buy = withActionProposal(buy, options);
  const shapeIssue = mutationShapeIssue(request);
  if (shapeIssue) return { ok: false, assessments: [], message: `Invalid mutation field shape at ${shapeIssue}.` };
  const decomposition = decomposeUpdateMediaBuy(buy as Parameters<typeof decomposeUpdateMediaBuy>[0], request);
  const unresolvedField = hasUnmappedMutation(request, decomposition);
  if (unresolvedField)
    return {
      ok: false,
      assessments: [],
      message: 'At least one requested field has no supported action mapping; do not submit a partial mutation.',
    };
  if (!decomposition.actions.length)
    return { ok: false, assessments: [], message: 'No recognized mutation could be assessed.' };
  const assessments = decomposition.actions.map(({ action }) =>
    assessActionAvailability(assessmentBuy, action, { ...options, request })
  );
  if (
    assessments.every(
      (a): a is Extract<ActionAvailability, { status: 'available_now' }> => a.status === 'available_now'
    )
  ) {
    if (
      options.task !== 'update_media_buy' &&
      new Set(assessments.map(a => a.nonDefaultRoute ?? 'update_media_buy')).size > 1
    )
      return {
        ok: false,
        assessments,
        message:
          'The requested actions declare different compact tasks. Pass task: update_media_buy to assess the whole mutation through the compatibility facade.',
      };
    return { ok: true, assessments };
  }
  return { ok: false, assessments };
}
