import { createHash } from 'node:crypto';
import { canonicalize } from '../utils/jcs';
import type {
  CanonicalProposal,
  ProposalConstraints,
  ProposalProductChanges,
  ProposalRefinement,
  ProposalRefinementReason,
  ProposalVerificationIssue,
  ProposalVerificationResult,
  RefineProposalsCompletedResponse,
  RefineProposalsRequest,
  RefineProposalsResponse,
} from './types';

export class ProposalResponseVerificationError extends Error {
  readonly issues: ProposalVerificationIssue[];

  constructor(issues: ProposalVerificationIssue[]) {
    super(`refine_proposals response failed verification: ${issues.map(issue => issue.message).join('; ')}`);
    this.name = 'ProposalResponseVerificationError';
    this.issues = issues;
  }
}

/** Normative `sha256:` + base64url(SHA-256(RFC 8785 JCS(terms))). */
export function proposalTermsDigest(commercialTerms: unknown): string {
  const digest = createHash('sha256').update(canonicalize(commercialTerms)).digest('base64url');
  return `sha256:${digest}`;
}

export function verifyProposalTermsDigest(proposal: CanonicalProposal): boolean {
  return proposal.terms_digest === proposalTermsDigest(proposal.commercial_terms);
}

/** Strict RFC 3339 date-time accepted by the AdCP `format: date-time` contract. */
export function isStrictDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

export function verifyRefineProposalsResponse(
  request: RefineProposalsRequest,
  response: unknown,
  options: { now?: Date } = {}
): ProposalVerificationResult {
  const issues: ProposalVerificationIssue[] = [];

  // Untrusted wire values are shape-checked completely before any semantic
  // verification. This keeps discriminated-union access fail-closed.
  if (!validateResponseShape(response, issues)) return { ok: false, issues };
  if (response.status === 'submitted') {
    push(issues, 'shape', 'status', 'semantic proposal verification requires a completed response');
    return { ok: false, issues };
  }

  const now = options.now ?? new Date();
  const nowMs = safeDateTime(now);
  const results = response.results;
  if (results.length !== request.refinements.length) {
    push(issues, 'result_count', 'results', 'response must contain exactly one result per refinement');
  }

  const sourceIds = new Set(request.refinements.map(refinement => refinement.proposal_id));
  const successorIds = new Set<string>();
  const count = Math.min(results.length, request.refinements.length);
  for (let index = 0; index < count; index++) {
    const refinement = request.refinements[index]!;
    const result = results[index]!;
    const base = `results[${index}]`;
    if (result.source_proposal_id !== refinement.proposal_id) {
      push(issues, 'result_order', `${base}.source_proposal_id`, 'results must preserve source request order');
    }
    if (refinement.action === 'finalize' && result.outcome !== 'finalized' && result.outcome !== 'unable') {
      push(issues, 'outcome', `${base}.outcome`, 'finalize may return only finalized or unable');
    }
    if (refinement.action === 'revise' && result.outcome === 'finalized') {
      push(issues, 'outcome', `${base}.outcome`, 'revise must not return finalized');
    }

    verifyUnsatisfiedSubsets(refinement, result, base, issues);
    if (result.outcome === 'unable') continue;
    const proposals = result.outcome === 'finalized' ? [result.proposal] : result.proposals;
    verifyProposalSet(refinement, result.outcome, proposals, base, nowMs, sourceIds, successorIds, issues);
  }

  const outcomes = new Set(results.map(result => result.outcome));
  if (outcomes.has('finalized') && outcomes.size !== 1) {
    push(issues, 'outcome', 'results', 'a successful finalize batch must finalize every entry atomically');
  }
  return { ok: issues.length === 0, issues };
}

export function assertRefineProposalsResponse(
  request: RefineProposalsRequest,
  response: unknown,
  options: { now?: Date } = {}
): asserts response is RefineProposalsCompletedResponse {
  const result = verifyRefineProposalsResponse(request, response, options);
  if (!result.ok) throw new ProposalResponseVerificationError(result.issues);
}

/** Validate the finalized 3.2 completed or compact-submitted wire shape, without source semantics. */
export function validateRefineProposalsResponseShape(response: unknown): ProposalVerificationResult {
  const issues: ProposalVerificationIssue[] = [];
  validateResponseShape(response, issues);
  return { ok: issues.length === 0, issues };
}

/** Assert the finalized 3.2 completed or compact-submitted wire shape, without requiring a source request. */
export function assertRefineProposalsResponseShape(response: unknown): asserts response is RefineProposalsResponse {
  const result = validateRefineProposalsResponseShape(response);
  if (!result.ok) throw new ProposalResponseVerificationError(result.issues);
}

function validateResponseShape(value: unknown, issues: ProposalVerificationIssue[]): value is RefineProposalsResponse {
  if (!isRecord(value)) {
    push(issues, 'shape', 'response', 'response must be an object');
    return false;
  }
  let valid = allowedKeys(value, RESPONSE_KEYS, 'response', issues);
  if (value.adcp_version !== undefined && value.adcp_version !== '3.2') {
    valid = shape(issues, 'adcp_version', 'refine_proposals response adcp_version must be 3.2');
  }
  if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 2000)) {
    valid = shape(issues, 'message', 'message must be a string of at most 2000 characters');
  }
  if (!validateAdvisoryErrors(value.errors, issues)) valid = false;
  if (value.replayed !== undefined && value.replayed !== true) {
    valid = shape(issues, 'replayed', 'replayed may only be true when present');
  }
  for (const key of ['context', 'ext'] as const) {
    if (value[key] !== undefined && !isRecord(value[key])) {
      valid = shape(issues, key, `${key} must be an object`);
    }
  }

  if (value.status === 'submitted') {
    if (!nonempty(value.task_id)) valid = shape(issues, 'task_id', 'submitted response requires a non-empty task_id');
    for (const key of ['results', 'products'] as const) {
      if (Object.hasOwn(value, key)) {
        valid = shape(issues, key, `${key} is forbidden on a compact submitted response`);
      }
    }
    return valid;
  }

  if (value.status !== undefined && value.status !== 'completed') {
    valid = shape(issues, 'status', 'response status must be completed or submitted');
  }
  if (Object.hasOwn(value, 'task_id')) {
    valid = shape(issues, 'task_id', 'task_id is forbidden on a completed response');
  }
  if (!Array.isArray(value.results) || value.results.length === 0) {
    valid = shape(issues, 'results', 'results must be a non-empty array');
  } else {
    value.results.forEach((result, index) => {
      if (!validateResultShape(result, `results[${index}]`, issues)) valid = false;
    });
  }
  if (!Array.isArray(value.products)) {
    valid = shape(issues, 'products', 'products must be an array');
  } else {
    value.products.forEach((product, index) => {
      if (!isRecord(product)) {
        valid = shape(issues, `products[${index}]`, 'product must be an object');
      } else if (!nonempty(product.product_id) || !nonempty(product.name)) {
        valid = shape(issues, `products[${index}]`, 'product requires non-empty product_id and name');
      }
    });
  }
  return valid;
}

function validateAdvisoryErrors(value: unknown, issues: ProposalVerificationIssue[]): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return shape(issues, 'errors', 'errors must be an array');
  let valid = true;
  value.forEach((error, index) => {
    if (!isRecord(error) || !nonempty(error.code) || !nonempty(error.message)) {
      valid = shape(issues, `errors[${index}]`, 'error requires non-empty code and message');
    }
  });
  return valid;
}

function validateResultShape(value: unknown, path: string, issues: ProposalVerificationIssue[]): boolean {
  if (!isRecord(value)) return shape(issues, path, 'result must be an object');
  let valid = allowedKeys(value, RESULT_KEYS, path, issues);
  if (!nonempty(value.source_proposal_id))
    valid = shape(issues, `${path}.source_proposal_id`, 'source_proposal_id is required');
  if (!OUTCOMES.has(value.outcome as string)) {
    shape(issues, `${path}.outcome`, 'outcome must be revised, partial, finalized, or unable');
    return false;
  }

  const outcome = value.outcome as 'revised' | 'partial' | 'finalized' | 'unable';
  const forbidden = (keys: string[]) => {
    for (const key of keys) {
      if (Object.hasOwn(value, key)) valid = shape(issues, `${path}.${key}`, `${key} is forbidden for ${outcome}`);
    }
  };
  if (outcome === 'revised') {
    forbidden(['proposal', 'reason_code', 'reason', 'unsatisfied_constraints', 'unsatisfied_product_changes']);
    if (!validateProposalArray(value.proposals, `${path}.proposals`, issues)) valid = false;
  } else if (outcome === 'partial') {
    forbidden(['proposal']);
    if (!validateProposalArray(value.proposals, `${path}.proposals`, issues)) valid = false;
    if (!validateReason(value, path, issues)) valid = false;
  } else if (outcome === 'finalized') {
    forbidden(['proposals', 'reason_code', 'reason', 'unsatisfied_constraints', 'unsatisfied_product_changes']);
    if (!validateCanonicalProposalShape(value.proposal, `${path}.proposal`, issues)) valid = false;
  } else {
    forbidden(['proposal', 'proposals']);
    if (!validateReason(value, path, issues)) valid = false;
  }

  if (value.unsatisfied_constraints !== undefined) {
    const constraints = value.unsatisfied_constraints;
    if (
      !Array.isArray(constraints) ||
      constraints.length === 0 ||
      constraints.some(item => !nonempty(item)) ||
      new Set(constraints).size !== constraints.length
    ) {
      valid = shape(
        issues,
        `${path}.unsatisfied_constraints`,
        'unsatisfied_constraints must contain unique non-empty strings'
      );
    }
  }
  if (value.unsatisfied_product_changes !== undefined) {
    if (!validateProductChanges(value.unsatisfied_product_changes)) {
      valid = shape(
        issues,
        `${path}.unsatisfied_product_changes`,
        'unsatisfied_product_changes must be a non-empty include/omit map'
      );
    }
  }
  if (value.suggestions !== undefined) {
    if (
      !Array.isArray(value.suggestions) ||
      value.suggestions.length === 0 ||
      value.suggestions.some(item => !nonempty(item))
    ) {
      valid = shape(issues, `${path}.suggestions`, 'suggestions must contain non-empty strings');
    }
  }
  if (value.targeting_resolution !== undefined && !isRecord(value.targeting_resolution)) {
    valid = shape(issues, `${path}.targeting_resolution`, 'targeting_resolution must be an object');
  }
  return valid;
}

function validateReason(value: Record<string, unknown>, path: string, issues: ProposalVerificationIssue[]): boolean {
  let valid = true;
  if (!REASONS.has(value.reason_code as ProposalRefinementReason)) {
    valid = shape(issues, `${path}.reason_code`, 'reason_code is not recognized');
  }
  if (!nonempty(value.reason)) valid = shape(issues, `${path}.reason`, 'reason must be a non-empty string');
  return valid;
}

function validateProposalArray(
  value: unknown,
  path: string,
  issues: ProposalVerificationIssue[]
): value is CanonicalProposal[] {
  if (!Array.isArray(value) || value.length === 0) return shape(issues, path, 'proposals must be a non-empty array');
  let valid = true;
  value.forEach((proposal, index) => {
    if (!validateCanonicalProposalShape(proposal, `${path}[${index}]`, issues)) valid = false;
  });
  return valid;
}

function validateCanonicalProposalShape(
  value: unknown,
  path: string,
  issues: ProposalVerificationIssue[]
): value is CanonicalProposal {
  if (!isRecord(value)) return shape(issues, path, 'proposal must be an object');
  let valid = allowedKeys(value, PROPOSAL_KEYS, path, issues);
  if (!boundedString(value.proposal_id, 1, 255))
    valid = shape(issues, `${path}.proposal_id`, 'proposal_id must be non-empty');
  if (!PROPOSAL_KINDS.has(value.proposal_kind as string))
    valid = shape(issues, `${path}.proposal_kind`, 'proposal_kind is not recognized');
  if (!nonempty(value.parent_proposal_id))
    valid = shape(issues, `${path}.parent_proposal_id`, 'parent_proposal_id is required');
  if (!PROPOSAL_STATUSES.has(value.proposal_status as string))
    valid = shape(issues, `${path}.proposal_status`, 'proposal_status is not recognized');
  if (!boundedString(value.name, 1, 500)) valid = shape(issues, `${path}.name`, 'name must be non-empty');
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(typeof value.terms_digest === 'string' ? value.terms_digest : '')) {
    valid = shape(issues, `${path}.terms_digest`, 'terms_digest must be a sha256 base64url digest');
  }
  for (const key of ['description', 'brief_alignment'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 2000)) {
      valid = shape(issues, `${path}.${key}`, `${key} must be a string of at most 2000 characters`);
    }
  }
  for (const key of ['media_buy_id', 'opportunity_id'] as const) {
    if (value[key] !== undefined && !nonempty(value[key]))
      valid = shape(issues, `${path}.${key}`, `${key} must be non-empty`);
  }
  if (
    value.base_media_buy_revision !== undefined &&
    (!Number.isInteger(value.base_media_buy_revision) || value.base_media_buy_revision < 1)
  ) {
    valid = shape(issues, `${path}.base_media_buy_revision`, 'base_media_buy_revision must be a positive integer');
  }
  for (const key of ['accepted_at', 'expires_at'] as const) {
    if (value[key] !== undefined && !isStrictDateTime(value[key]))
      valid = shape(issues, `${path}.${key}`, `${key} must be an RFC 3339 date-time`);
  }
  if (value.insertion_order !== undefined && !isRecord(value.insertion_order))
    valid = shape(issues, `${path}.insertion_order`, 'insertion_order must be an object');

  if (
    (value.proposal_kind === 'media_buy_update' || value.proposal_kind === 'media_buy_cancellation') &&
    (!nonempty(value.media_buy_id) || !Number.isInteger(value.base_media_buy_revision))
  ) {
    valid = shape(issues, path, 'media-buy successor proposals require media_buy_id and base_media_buy_revision');
  }
  if (value.proposal_status === 'accepted' && (!nonempty(value.media_buy_id) || !isStrictDateTime(value.accepted_at))) {
    valid = shape(issues, path, 'accepted proposals require media_buy_id and accepted_at');
  }
  if (value.proposal_status === 'committed' && !isStrictDateTime(value.expires_at)) {
    valid = shape(issues, `${path}.expires_at`, 'committed proposals require expires_at');
  }
  if (!validateCommercialTerms(value.commercial_terms, `${path}.commercial_terms`, issues)) valid = false;
  return valid;
}

function validateCommercialTerms(value: unknown, path: string, issues: ProposalVerificationIssue[]): boolean {
  if (!isRecord(value)) return shape(issues, path, 'commercial_terms must be an object');
  let valid = allowedKeys(value, COMMERCIAL_KEYS, path, issues);
  if (!isRecord(value.brand)) valid = shape(issues, `${path}.brand`, 'brand must be an object');
  if (!Array.isArray(value.purchases) || value.purchases.length === 0) {
    valid = shape(issues, `${path}.purchases`, 'purchases must be a non-empty array');
  } else {
    value.purchases.forEach((purchase, index) => {
      if (!validatePurchase(purchase, `${path}.purchases[${index}]`, issues)) valid = false;
    });
  }
  if (value.start_time !== 'asap' && !isStrictDateTime(value.start_time))
    valid = shape(issues, `${path}.start_time`, 'start_time must be asap or an RFC 3339 date-time');
  if (!isStrictDateTime(value.end_time))
    valid = shape(issues, `${path}.end_time`, 'end_time must be an RFC 3339 date-time');
  for (const key of ['source_feed_version', 'source_pricing_version', 'purchase_order_ref'] as const) {
    if (value[key] !== undefined && !nonempty(value[key]))
      valid = shape(issues, `${path}.${key}`, `${key} must be non-empty`);
  }
  if (value.advertiser_industry !== undefined && typeof value.advertiser_industry !== 'string')
    valid = shape(issues, `${path}.advertiser_industry`, 'advertiser_industry must be a string');
  if (
    value.agency_estimate_number !== undefined &&
    (typeof value.agency_estimate_number !== 'string' || value.agency_estimate_number.length > 100)
  )
    valid = shape(
      issues,
      `${path}.agency_estimate_number`,
      'agency_estimate_number must be a string of at most 100 characters'
    );
  if (value.total_budget !== undefined && !validateMoney(value.total_budget, `${path}.total_budget`, issues, true))
    valid = false;
  for (const key of ['budget_allocation', 'bidding', 'invoice_recipient'] as const) {
    if (value[key] !== undefined && !isRecord(value[key]))
      valid = shape(issues, `${path}.${key}`, `${key} must be an object`);
  }
  if (value.pacing !== undefined && typeof value.pacing !== 'string')
    valid = shape(issues, `${path}.pacing`, 'pacing must be a string');
  if (
    value.reporting_commitments !== undefined &&
    (!Array.isArray(value.reporting_commitments) || value.reporting_commitments.length === 0)
  )
    valid = shape(issues, `${path}.reporting_commitments`, 'reporting_commitments must be a non-empty array');
  if (
    value.cancellation_terms !== undefined &&
    !validateCancellationTerms(value.cancellation_terms, `${path}.cancellation_terms`, issues)
  )
    valid = false;
  return valid;
}

function validatePurchase(value: unknown, path: string, issues: ProposalVerificationIssue[]): boolean {
  if (!isRecord(value)) return shape(issues, path, 'purchase must be an object');
  let valid = allowedKeys(value, PURCHASE_KEYS, path, issues);
  if (!nonempty(value.product_id)) valid = shape(issues, `${path}.product_id`, 'product_id is required');
  if (!nonempty(value.pricing_option_id))
    valid = shape(issues, `${path}.pricing_option_id`, 'pricing_option_id is required');
  if (!isStrictDateTime(value.start_time))
    valid = shape(issues, `${path}.start_time`, 'purchase start_time must be an RFC 3339 date-time');
  if (!isStrictDateTime(value.end_time))
    valid = shape(issues, `${path}.end_time`, 'purchase end_time must be an RFC 3339 date-time');
  for (const key of ['budget', 'min_spend_target', 'impressions'] as const) {
    if (value[key] !== undefined && (!finite(value[key]) || value[key] < 0))
      valid = shape(issues, `${path}.${key}`, `${key} must be a finite non-negative number`);
  }
  for (const key of [
    'format_option_refs',
    'catalog_ids',
    'optimization_goals',
    'audience_evidence_pins',
    'performance_standards',
  ] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length === 0))
      valid = shape(issues, `${path}.${key}`, `${key} must be a non-empty array`);
  }
  for (const key of [
    'bidding',
    'targeting_overlay',
    'audience_evidence_requirements',
    'context',
    'ext',
    'measurement_terms',
  ] as const) {
    if (value[key] !== undefined && !isRecord(value[key]))
      valid = shape(issues, `${path}.${key}`, `${key} must be an object`);
  }
  if (value.pacing !== undefined && typeof value.pacing !== 'string')
    valid = shape(issues, `${path}.pacing`, 'pacing must be a string');
  if (
    value.agency_estimate_number !== undefined &&
    (typeof value.agency_estimate_number !== 'string' || value.agency_estimate_number.length > 100)
  )
    valid = shape(
      issues,
      `${path}.agency_estimate_number`,
      'agency_estimate_number must be a string of at most 100 characters'
    );
  if (!validatePricing(value.pricing, `${path}.pricing`, issues, value.pricing_option_id)) valid = false;
  return valid;
}

function validatePricing(
  value: unknown,
  path: string,
  issues: ProposalVerificationIssue[],
  siblingId: unknown
): boolean {
  if (!isRecord(value)) return shape(issues, path, 'pricing must be an object');
  let valid = allowedKeys(value, PRICING_KEYS, path, issues);
  if (!nonempty(value.pricing_option_id))
    valid = shape(issues, `${path}.pricing_option_id`, 'pricing_option_id is required');
  if (value.pricing_option_id !== siblingId)
    valid = shape(
      issues,
      `${path}.pricing_option_id`,
      'pricing pricing_option_id must match the purchase pricing_option_id'
    );
  if (!PRICING_MODELS.has(value.pricing_model as string))
    valid = shape(issues, `${path}.pricing_model`, 'pricing_model is not recognized');
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))
    valid = shape(issues, `${path}.currency`, 'currency must be an uppercase ISO code');
  for (const key of ['fixed_price', 'floor_price', 'min_spend_per_package'] as const) {
    if (value[key] !== undefined && (!finite(value[key]) || value[key] < 0))
      valid = shape(issues, `${path}.${key}`, `${key} must be a finite non-negative number`);
  }
  if (value.fixed_price !== undefined && value.floor_price !== undefined)
    valid = shape(issues, path, 'fixed_price and floor_price are mutually exclusive');
  if (
    value.commission_rate !== undefined &&
    (!finite(value.commission_rate) || value.commission_rate <= 0 || value.commission_rate > 1)
  )
    valid = shape(issues, `${path}.commission_rate`, 'commission_rate must be finite, greater than 0, and at most 1');
  for (const key of ['price_guidance', 'price_breakdown', 'parameters'] as const) {
    if (value[key] !== undefined && !isRecord(value[key]))
      valid = shape(issues, `${path}.${key}`, `${key} must be an object`);
  }
  if (value.eligible_adjustments !== undefined && !Array.isArray(value.eligible_adjustments))
    valid = shape(issues, `${path}.eligible_adjustments`, 'eligible_adjustments must be an array');
  for (const key of ['event_type', 'custom_event_name', 'event_source_id', 'commission_basis_description'] as const) {
    if (value[key] !== undefined && !nonempty(value[key]))
      valid = shape(issues, `${path}.${key}`, `${key} must be non-empty`);
  }
  if (value.pricing_model === 'cpa' && (value.event_type === undefined || value.fixed_price === undefined))
    valid = shape(issues, path, 'cpa pricing requires event_type and fixed_price');
  if (
    value.pricing_model === 'revenue_share' &&
    (!nonempty(value.event_type) ||
      !nonempty(value.event_source_id) ||
      value.commission_rate === undefined ||
      !nonempty(value.commission_basis_description))
  )
    valid = shape(issues, path, 'revenue_share pricing requires event and commission fields');
  if (
    (value.pricing_model === 'cpv' || value.pricing_model === 'cpp' || value.pricing_model === 'time') &&
    !isRecord(value.parameters)
  )
    valid = shape(issues, `${path}.parameters`, `${value.pricing_model} pricing requires parameters`);
  if (value.event_type === 'custom' && !nonempty(value.custom_event_name))
    valid = shape(issues, `${path}.custom_event_name`, 'custom events require custom_event_name');
  return valid;
}

function validateMoney(value: unknown, path: string, issues: ProposalVerificationIssue[], exact: boolean): boolean {
  if (!isRecord(value)) return shape(issues, path, 'money value must be an object');
  let valid = exact ? allowedKeys(value, MONEY_KEYS, path, issues) : true;
  if (!finite(value.amount) || value.amount < 0)
    valid = shape(issues, `${path}.amount`, 'amount must be a finite non-negative number');
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))
    valid = shape(issues, `${path}.currency`, 'currency must be an uppercase ISO code');
  return valid;
}

function validateCancellationTerms(value: unknown, path: string, issues: ProposalVerificationIssue[]): boolean {
  if (!isRecord(value)) return shape(issues, path, 'cancellation_terms must be an object');
  let valid = allowedKeys(value, CANCELLATION_KEYS, path, issues);
  if (!isStrictDateTime(value.effective_at))
    valid = shape(issues, `${path}.effective_at`, 'effective_at must be an RFC 3339 date-time');
  if (value.fee !== undefined && !validateMoney(value.fee, `${path}.fee`, issues, true)) valid = false;
  if (value.reason !== undefined && !boundedString(value.reason, 1, 500))
    valid = shape(issues, `${path}.reason`, 'reason must be 1-500 characters');
  return valid;
}

function verifyProposalSet(
  refinement: ProposalRefinement,
  outcome: 'revised' | 'partial' | 'finalized',
  proposals: CanonicalProposal[],
  base: string,
  nowMs: number,
  sourceIds: ReadonlySet<string>,
  successorIds: Set<string>,
  issues: ProposalVerificationIssue[]
): void {
  const expected = refinement.action === 'revise' ? (refinement.alternatives?.count ?? 1) : 1;
  if (outcome === 'revised' && proposals.length !== expected) {
    push(issues, 'alternative_count', `${base}.proposals`, `revised must return exactly ${expected} proposal(s)`);
  }
  if (outcome === 'partial' && (proposals.length < 1 || proposals.length > expected)) {
    push(issues, 'alternative_count', `${base}.proposals`, `partial must return between 1 and ${expected} proposals`);
  }

  const canonicalTerms = new Set<string>();
  const digests = new Set<string>();
  for (const [proposalIndex, proposal] of proposals.entries()) {
    const path = outcome === 'finalized' ? `${base}.proposal` : `${base}.proposals[${proposalIndex}]`;
    if (sourceIds.has(proposal.proposal_id)) {
      push(
        issues,
        'proposal_identity',
        `${path}.proposal_id`,
        'successor proposal_id must differ from every source proposal_id'
      );
    }
    if (successorIds.has(proposal.proposal_id)) {
      push(issues, 'proposal_identity', `${path}.proposal_id`, 'successor proposal_id values must be globally unique');
    }
    successorIds.add(proposal.proposal_id);
    if (proposal.parent_proposal_id !== refinement.proposal_id) {
      push(issues, 'lineage', `${path}.parent_proposal_id`, 'parent_proposal_id must equal source_proposal_id');
    }
    const expectedStatus = outcome === 'finalized' ? 'committed' : 'draft';
    if (proposal.proposal_status !== expectedStatus) {
      push(issues, 'proposal_status', `${path}.proposal_status`, `proposal_status must be ${expectedStatus}`);
    }
    if (outcome === 'finalized') {
      const expiresAt = isStrictDateTime(proposal.expires_at) ? Date.parse(proposal.expires_at) : Number.NaN;
      if (!Number.isFinite(nowMs)) {
        push(
          issues,
          'hold_expired',
          `${path}.expires_at`,
          'finalized proposal hold cannot be verified because the current time is invalid'
        );
      } else if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
        push(issues, 'hold_expired', `${path}.expires_at`, 'finalized proposal must carry a future hold expiry');
      }
    }
    let terms: string | undefined;
    try {
      terms = canonicalize(proposal.commercial_terms);
      if (proposal.terms_digest !== proposalTermsDigest(proposal.commercial_terms)) {
        push(issues, 'terms_digest', `${path}.terms_digest`, 'terms_digest does not match commercial_terms');
      }
    } catch (error) {
      push(
        issues,
        'terms_digest',
        `${path}.commercial_terms`,
        `commercial_terms cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (terms !== undefined) {
      if (canonicalTerms.has(terms))
        push(issues, 'duplicate_terms', `${path}.commercial_terms`, 'alternatives must have distinct commercial terms');
      canonicalTerms.add(terms);
    }
    if (digests.has(proposal.terms_digest))
      push(issues, 'duplicate_digest', `${path}.terms_digest`, 'alternatives must have unique terms_digest values');
    digests.add(proposal.terms_digest);

    if (refinement.action === 'revise' && outcome === 'revised') {
      verifyConstraints(refinement.constraints, proposal, path, issues, 'constraint');
      verifyProductChanges(refinement.product_changes, proposal, path, issues, 'constraint');
    }
  }
}

function verifyUnsatisfiedSubsets(
  refinement: ProposalRefinement,
  result: RefineProposalsCompletedResponse['results'][number],
  base: string,
  issues: ProposalVerificationIssue[]
): void {
  if (result.outcome !== 'partial' && result.outcome !== 'unable') return;
  const constraintKeys = new Set(Object.keys(refinement.action === 'revise' ? (refinement.constraints ?? {}) : {}));
  for (const key of result.unsatisfied_constraints ?? []) {
    if (!constraintKeys.has(key))
      push(issues, 'unsatisfied_subset', `${base}.unsatisfied_constraints`, `${key} was not requested`);
  }
  const requestedChanges = refinement.action === 'revise' ? (refinement.product_changes ?? {}) : {};
  for (const [productId, action] of Object.entries(result.unsatisfied_product_changes ?? {})) {
    if (requestedChanges[productId] !== action)
      push(
        issues,
        'unsatisfied_subset',
        `${base}.unsatisfied_product_changes.${productId}`,
        'change was not requested'
      );
  }
  if (result.reason_code === 'constraint_unsatisfiable') {
    if (!result.unsatisfied_constraints?.length && !Object.keys(result.unsatisfied_product_changes ?? {}).length) {
      push(
        issues,
        'unsatisfied_subset',
        base,
        'constraint_unsatisfiable requires a machine-readable unsatisfied subset'
      );
    }
  } else if (result.unsatisfied_constraints?.length || Object.keys(result.unsatisfied_product_changes ?? {}).length) {
    push(issues, 'unsatisfied_subset', `${base}.reason_code`, 'typed failures must use constraint_unsatisfiable');
  }

  if (result.outcome === 'partial' && refinement.action === 'revise') {
    const omittedConstraints = new Set(result.unsatisfied_constraints ?? []);
    const omittedChanges = result.unsatisfied_product_changes ?? {};
    for (const [proposalIndex, proposal] of result.proposals.entries()) {
      const path = `${base}.proposals[${proposalIndex}]`;
      const requiredConstraints = Object.fromEntries(
        Object.entries(refinement.constraints ?? {}).filter(([key]) => !omittedConstraints.has(key))
      ) as ProposalConstraints;
      const requiredChanges = Object.fromEntries(
        Object.entries(refinement.product_changes ?? {}).filter(
          ([productId, action]) => omittedChanges[productId] !== action
        )
      ) as ProposalProductChanges;
      verifyConstraints(requiredConstraints, proposal, path, issues, 'partial_invariant');
      verifyProductChanges(requiredChanges, proposal, path, issues, 'partial_invariant');
    }
  }
}

function verifyConstraints(
  constraints: ProposalConstraints | undefined,
  proposal: CanonicalProposal,
  path: string,
  issues: ProposalVerificationIssue[],
  code: 'constraint' | 'partial_invariant'
): void {
  if (!constraints) return;
  const terms = proposal.commercial_terms;
  const budget = constraints.total_budget;
  if (budget) {
    const actual = terms.total_budget;
    if (
      !actual ||
      actual.currency !== budget.currency ||
      (budget.min !== undefined && actual.amount < budget.min) ||
      (budget.max !== undefined && actual.amount > budget.max)
    ) {
      push(issues, code, `${path}.commercial_terms.total_budget`, 'total_budget constraint is not satisfied');
    }
  }
  const cpm = constraints.cpm;
  if (
    cpm &&
    !terms.purchases.every(
      purchase =>
        (purchase.pricing.pricing_model === 'cpm' || purchase.pricing.pricing_model === 'vcpm') &&
        purchase.pricing.currency === cpm.currency &&
        typeof purchase.pricing.fixed_price === 'number' &&
        purchase.pricing.fixed_price <= cpm.max
    )
  ) {
    push(issues, code, `${path}.commercial_terms.purchases`, 'cpm constraint is not satisfied');
  }
  const impressions = constraints.impressions;
  if (
    impressions &&
    (!terms.purchases.every(purchase => typeof purchase.impressions === 'number') ||
      terms.purchases.reduce((sum, purchase) => sum + (purchase.impressions ?? 0), 0) < impressions.min)
  ) {
    push(issues, code, `${path}.commercial_terms.purchases`, 'impressions constraint is not satisfied');
  }
  const flight = constraints.flight;
  if (flight) {
    const start = terms.start_time === 'asap' ? Number.NaN : Date.parse(terms.start_time);
    const end = Date.parse(terms.end_time);
    if (
      (flight.start_no_later_than !== undefined &&
        (!Number.isFinite(start) || start > Date.parse(flight.start_no_later_than))) ||
      (flight.end_no_earlier_than !== undefined &&
        (!Number.isFinite(end) || end < Date.parse(flight.end_no_earlier_than)))
    ) {
      push(issues, code, `${path}.commercial_terms`, 'flight constraint is not satisfied');
    }
  }
}

function verifyProductChanges(
  changes: ProposalProductChanges | undefined,
  proposal: CanonicalProposal,
  path: string,
  issues: ProposalVerificationIssue[],
  code: 'constraint' | 'partial_invariant'
): void {
  if (!changes) return;
  const products = new Set(proposal.commercial_terms.purchases.map(purchase => purchase.product_id));
  for (const [productId, action] of Object.entries(changes)) {
    if ((action === 'include' && !products.has(productId)) || (action === 'omit' && products.has(productId))) {
      push(
        issues,
        code,
        `${path}.commercial_terms.purchases`,
        `product change ${productId}:${action} is not satisfied`
      );
    }
  }
}

const RESPONSE_KEYS = new Set([
  'adcp_version',
  'results',
  'products',
  'status',
  'task_id',
  'message',
  'errors',
  'context',
  'ext',
  'replayed',
]);
const RESULT_KEYS = new Set([
  'source_proposal_id',
  'outcome',
  'proposal',
  'proposals',
  'reason_code',
  'reason',
  'unsatisfied_constraints',
  'unsatisfied_product_changes',
  'suggestions',
  'targeting_resolution',
]);
const PROPOSAL_KEYS = new Set([
  'proposal_id',
  'proposal_kind',
  'parent_proposal_id',
  'media_buy_id',
  'base_media_buy_revision',
  'opportunity_id',
  'proposal_status',
  'accepted_at',
  'expires_at',
  'name',
  'description',
  'brief_alignment',
  'commercial_terms',
  'terms_digest',
  'insertion_order',
]);
const COMMERCIAL_KEYS = new Set([
  'source_feed_version',
  'source_pricing_version',
  'brand',
  'advertiser_industry',
  'purchases',
  'start_time',
  'end_time',
  'total_budget',
  'budget_allocation',
  'pacing',
  'bidding',
  'invoice_recipient',
  'purchase_order_ref',
  'agency_estimate_number',
  'reporting_commitments',
  'cancellation_terms',
]);
const PURCHASE_KEYS = new Set([
  'product_id',
  'pricing_option_id',
  'pricing',
  'format_option_refs',
  'catalog_ids',
  'budget',
  'min_spend_target',
  'impressions',
  'start_time',
  'end_time',
  'pacing',
  'bidding',
  'targeting_overlay',
  'optimization_goals',
  'audience_evidence_requirements',
  'audience_evidence_pins',
  'agency_estimate_number',
  'context',
  'ext',
  'measurement_terms',
  'performance_standards',
]);
const PRICING_KEYS = new Set([
  'pricing_option_id',
  'pricing_model',
  'currency',
  'fixed_price',
  'floor_price',
  'price_guidance',
  'min_spend_per_package',
  'price_breakdown',
  'eligible_adjustments',
  'parameters',
  'event_type',
  'custom_event_name',
  'event_source_id',
  'commission_rate',
  'commission_basis_description',
]);
const MONEY_KEYS = new Set(['amount', 'currency']);
const CANCELLATION_KEYS = new Set(['effective_at', 'fee', 'reason']);
const OUTCOMES = new Set(['revised', 'partial', 'finalized', 'unable']);
const REASONS = new Set<ProposalRefinementReason>([
  'commercially_declined',
  'constraint_unsatisfiable',
  'unsupported_dimension',
  'uninterpreted',
  'alternatives_unavailable',
  'source_unavailable',
  'hold_unavailable',
  'batch_aborted',
]);
const PROPOSAL_KINDS = new Set(['new_media_buy', 'media_buy_update', 'media_buy_cancellation']);
const PROPOSAL_STATUSES = new Set(['draft', 'committed', 'accepted']);
const PRICING_MODELS = new Set([
  'cpm',
  'vcpm',
  'cpc',
  'cpcv',
  'cpv',
  'cpp',
  'cpa',
  'revenue_share',
  'flat_rate',
  'time',
]);

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateProductChanges(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(([key, action]) => key.length > 0 && (action === 'include' || action === 'omit'))
  );
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ProposalVerificationIssue[]
): boolean {
  let valid = true;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) valid = shape(issues, `${path}.${key}`, `${key} is not allowed`);
  }
  return valid;
}

function shape(issues: ProposalVerificationIssue[], path: string, message: string): false {
  push(issues, 'shape', path, message);
  return false;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function safeDateTime(value: unknown): number {
  try {
    return value instanceof Date ? value.getTime() : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function push(
  issues: ProposalVerificationIssue[],
  code: ProposalVerificationIssue['code'],
  path: string,
  message: string
): void {
  issues.push({ code, path, message });
}
