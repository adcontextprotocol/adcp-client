import { createHash } from 'node:crypto';
import { MAX_JSON_DEPTH } from '../utils/json-depth';
import { canonicalize } from '../utils/jcs';
import { getSchemaDocumentByRef, getSchemaValidatorByRef } from '../validation/schema-loader';
import { ADCP_VERSION } from '../version';
import type {
  CanonicalProposal,
  ProposalCommercialTermsMismatch,
  ProposalCommercialTermsVerificationResult,
  ProposalConstraints,
  ProposalProductChanges,
  ProposalRefinement,
  ProposalRefinementReason,
  ProposalVerificationIssue,
  ProposalVerificationResult,
  RefineProposalsCompletedResponse,
  RefineProposalsRequest,
  RefineProposalsResponse,
  VerifyProposalCommercialTermsOptions,
} from './types';

// Release-precision wire version: `3.2` or a non-empty, dot/hyphen-separated
// prerelease whose segments are alphanumeric. Reject dangling separators such
// as `3.2-.` and `3.2-rc.` even though they begin with the right release.
const ADCP_32_RELEASE = /^3\.2(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const MAX_COMMERCIAL_TERMS_BYTES = 256 * 1024;
const MAX_COMMERCIAL_TERMS_NODES = 50_000;
const MAX_COMMERCIAL_TERMS_MISMATCHES = 100;
const MAX_COMMERCIAL_TERMS_DIAGNOSTIC_BYTES = 64 * 1024;

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
  return digestCanonicalTerms(canonicalProposalTerms(commercialTerms));
}

export function verifyProposalTermsDigest(proposal: CanonicalProposal): boolean {
  return proposal.terms_digest === proposalTermsDigest(proposal.commercial_terms);
}

export class ProposalCommercialTermsVerificationError extends Error {
  readonly mismatches: ProposalCommercialTermsMismatch[];
  readonly truncated: boolean;

  constructor(mismatches: ProposalCommercialTermsMismatch[], truncated = false) {
    super(
      `proposal commercial terms failed verification (${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}${truncated ? ', diagnostics truncated' : ''})`
    );
    this.name = 'ProposalCommercialTermsVerificationError';
    this.mismatches = mismatches;
    this.truncated = truncated;
  }
}

/**
 * Verify a proposal's binding commercial terms against the complete terms the
 * buyer reviewed.
 *
 * The comparison surface is read at runtime from `media-buy/commercial-terms.json`
 * in the selected AdCP schema bundle. This coupling is deliberate: callers
 * should pass the seller-served release through `adcpVersion`, and must ship
 * that matching bundle. A newly added optional commercial field is therefore
 * compared automatically when present instead of being omitted by a stale SDK
 * allowlist.
 *
 * The proposal's `terms_digest` is checked before schema validation or field
 * comparison. A digest failure returns only `digest_mismatch`, preventing a
 * tampered payload from being interpreted as a trustworthy field-level diff.
 * Paths are RFC 6901 JSON Pointers rooted at `/commercial_terms`.
 */
export function verifyProposalCommercialTerms(
  proposal: unknown,
  expectedCommercialTerms: unknown,
  options: VerifyProposalCommercialTermsOptions = {}
): ProposalCommercialTermsVerificationResult {
  const mismatches: ProposalCommercialTermsMismatch[] = [];
  if (!isRecord(proposal)) {
    return invalidTermsResult('proposal', '/commercial_terms', 'proposal must be an object');
  }

  let actualTerms: unknown;
  let suppliedDigest: unknown;
  let actualCanonical: string;
  try {
    const suppliedTerms = proposal.commercial_terms;
    suppliedDigest = proposal.terms_digest;
    const complexityError = commercialTermsComplexityError(suppliedTerms);
    if (complexityError) return invalidTermsResult('proposal', '/commercial_terms', complexityError);
    actualTerms = structuredClone(suppliedTerms);
    actualCanonical = canonicalProposalTerms(actualTerms);
    if (Buffer.byteLength(actualCanonical, 'utf8') > MAX_COMMERCIAL_TERMS_BYTES) {
      return invalidTermsResult('proposal', '/commercial_terms', 'proposal commercial terms exceed 256 KiB');
    }
  } catch {
    return invalidTermsResult('proposal', '/commercial_terms', 'proposal commercial terms cannot be canonicalized');
  }

  const actualDigest = digestCanonicalTerms(actualCanonical);
  if (suppliedDigest !== actualDigest) {
    return {
      ok: false,
      mismatches: [
        {
          kind: 'digest_mismatch',
          path: '/terms_digest',
          message: 'proposal terms_digest does not match commercial_terms',
        },
      ],
    };
  }

  let adcpVersion: string;
  try {
    adcpVersion = options.adcpVersion ?? ADCP_VERSION;
  } catch {
    return schemaUnavailableResult();
  }
  let document: ReturnType<typeof getSchemaDocumentByRef>;
  let validator: ReturnType<typeof getSchemaValidatorByRef>;
  try {
    document = getSchemaDocumentByRef('media-buy/commercial-terms.json', adcpVersion);
    validator = getSchemaValidatorByRef('media-buy/commercial-terms.json', adcpVersion);
  } catch {
    return schemaUnavailableResult();
  }
  if (!document || !validator) {
    return schemaUnavailableResult();
  }

  const schemaVersion = document.resolvedVersion;
  const schemaProperties = isRecord(document.schema.properties) ? document.schema.properties : undefined;
  if (!schemaProperties || document.schema.additionalProperties !== false) {
    return {
      ok: false,
      schemaVersion,
      mismatches: [
        {
          kind: 'unsupported_schema',
          path: '/commercial_terms',
          message: 'commercial-terms schema must declare a closed properties object for exhaustive comparison',
        },
      ],
    };
  }
  let changeTermSchema: Readonly<Record<string, unknown>> | undefined;
  if (Object.hasOwn(schemaProperties, 'change_terms')) {
    try {
      changeTermSchema = getSchemaDocumentByRef('media-buy/change-term.json', adcpVersion)?.schema;
    } catch {
      return schemaUnavailableResult();
    }
    if (!changeTermSchema) return schemaUnavailableResult();
  }

  let expectedCanonical: string;
  try {
    const complexityError = commercialTermsComplexityError(expectedCommercialTerms);
    if (complexityError) return invalidTermsResult('expected', '/commercial_terms', complexityError, schemaVersion);
    const expectedTerms = structuredClone(expectedCommercialTerms);
    expectedCanonical = canonicalProposalTerms(expectedTerms);
    if (Buffer.byteLength(expectedCanonical, 'utf8') > MAX_COMMERCIAL_TERMS_BYTES) {
      return invalidTermsResult(
        'expected',
        '/commercial_terms',
        'expected commercial terms exceed 256 KiB',
        schemaVersion
      );
    }
  } catch {
    return invalidTermsResult(
      'expected',
      '/commercial_terms',
      'expected commercial terms cannot be canonicalized',
      schemaVersion
    );
  }

  const actual = JSON.parse(actualCanonical) as unknown;
  const expected = JSON.parse(expectedCanonical) as unknown;
  if (!validator(actual)) {
    const error = validator.errors?.[0];
    return invalidTermsResult(
      'proposal',
      schemaValidationPointer(error),
      `proposal commercial terms do not satisfy AdCP ${schemaVersion}${error?.message ? `: ${error.message}` : ''}`,
      schemaVersion,
      error?.keyword
    );
  }
  if (!validator(expected)) {
    const error = validator.errors?.[0];
    return invalidTermsResult(
      'expected',
      schemaValidationPointer(error),
      `expected commercial terms do not satisfy AdCP ${schemaVersion}${error?.message ? `: ${error.message}` : ''}`,
      schemaVersion,
      error?.keyword
    );
  }

  if (!isRecord(actual) || !isRecord(expected)) {
    return invalidTermsResult('proposal', '/commercial_terms', 'commercial terms must be objects', schemaVersion);
  }

  const semanticSupportError = commercialTermsSemanticSupportError(document.schema, changeTermSchema);
  if (semanticSupportError) {
    return {
      ok: false,
      schemaVersion,
      mismatches: [
        {
          kind: 'unsupported_schema',
          path: '/commercial_terms',
          message: semanticSupportError,
        },
      ],
    };
  }
  const actualSemanticIssues = validateCommercialTermsSemantics(actual, document.schema, changeTermSchema);
  if (actualSemanticIssues.length > 0) {
    const truncated = actualSemanticIssues.length > MAX_COMMERCIAL_TERMS_MISMATCHES;
    return {
      ok: false,
      schemaVersion,
      ...(truncated && { truncated: true }),
      mismatches: actualSemanticIssues.slice(0, MAX_COMMERCIAL_TERMS_MISMATCHES).map(issue => ({
        kind: 'invalid_terms',
        subject: 'proposal',
        keyword: 'x-adcp-validation',
        ...issue,
      })),
    };
  }
  const expectedSemanticIssues = validateCommercialTermsSemantics(expected, document.schema, changeTermSchema);
  if (expectedSemanticIssues.length > 0) {
    const truncated = expectedSemanticIssues.length > MAX_COMMERCIAL_TERMS_MISMATCHES;
    return {
      ok: false,
      schemaVersion,
      ...(truncated && { truncated: true }),
      mismatches: expectedSemanticIssues.slice(0, MAX_COMMERCIAL_TERMS_MISMATCHES).map(issue => ({
        kind: 'invalid_terms',
        subject: 'expected',
        keyword: 'x-adcp-validation',
        ...issue,
      })),
    };
  }

  // Derive the exhaustive top-level comparison allowlist from the selected
  // schema. Nested values are recursively compared in full after AJV has
  // proved that both trees satisfy the same schema bundle.
  const comparisonFields = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  const mismatchState = { truncated: false, diagnosticBytes: 0 };
  for (const field of [...comparisonFields].sort()) {
    const actualHas = Object.hasOwn(actual, field);
    const expectedHas = Object.hasOwn(expected, field);
    diffCommercialTerm(
      actual[field],
      expected[field],
      `/commercial_terms/${escapeJsonPointer(field)}`,
      mismatches,
      mismatchState,
      { actualHas, expectedHas }
    );
    if (mismatchState.truncated) break;
  }

  return {
    ok: mismatches.length === 0 && !mismatchState.truncated,
    schemaVersion,
    ...(mismatchState.truncated && { truncated: true }),
    mismatches,
  };
}

export function assertProposalCommercialTerms(
  proposal: unknown,
  expectedCommercialTerms: unknown,
  options: VerifyProposalCommercialTermsOptions = {}
): void {
  const result = verifyProposalCommercialTerms(proposal, expectedCommercialTerms, options);
  if (!result.ok) throw new ProposalCommercialTermsVerificationError(result.mismatches, result.truncated);
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
  request: Pick<RefineProposalsRequest, 'refinements'>,
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
  request: Pick<RefineProposalsRequest, 'refinements'>,
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
  if (
    value.adcp_version !== undefined &&
    (typeof value.adcp_version !== 'string' || !ADCP_32_RELEASE.test(value.adcp_version))
  ) {
    valid = shape(
      issues,
      'adcp_version',
      `refine_proposals response adcp_version must be on the 3.2 release line; received ${describeReceived(
        value.adcp_version
      )}`
    );
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
  const validateCanonicalProposal = getSchemaValidatorByRef('core/canonical-proposal.json');
  if (!validateCanonicalProposal) return shape(issues, path, 'canonical-proposal schema is unavailable');
  if (!validateCanonicalProposal(value)) {
    const error = validateCanonicalProposal.errors?.[0];
    const errorPath = error?.instancePath ? `${path}${error.instancePath.replaceAll('/', '.')}` : path;
    return shape(
      issues,
      errorPath,
      `proposal must satisfy the AdCP 3.2 schema${error?.message ? `: ${error.message}` : ''}`
    );
  }
  const proposal = value as Record<string, any>;
  let valid = true;
  if (!boundedString(proposal.proposal_id, 1, 255))
    valid = shape(issues, `${path}.proposal_id`, 'proposal_id must be non-empty');
  if (!PROPOSAL_KINDS.has(proposal.proposal_kind as string))
    valid = shape(issues, `${path}.proposal_kind`, 'proposal_kind is not recognized');
  if (!nonempty(proposal.parent_proposal_id))
    valid = shape(issues, `${path}.parent_proposal_id`, 'parent_proposal_id is required');
  if (!PROPOSAL_STATUSES.has(proposal.proposal_status as string))
    valid = shape(issues, `${path}.proposal_status`, 'proposal_status is not recognized');
  if (!boundedString(proposal.name, 1, 500)) valid = shape(issues, `${path}.name`, 'name must be non-empty');
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(typeof proposal.terms_digest === 'string' ? proposal.terms_digest : '')) {
    valid = shape(issues, `${path}.terms_digest`, 'terms_digest must be a sha256 base64url digest');
  }
  for (const key of ['description', 'brief_alignment'] as const) {
    if (proposal[key] !== undefined && (typeof proposal[key] !== 'string' || proposal[key].length > 2000)) {
      valid = shape(issues, `${path}.${key}`, `${key} must be a string of at most 2000 characters`);
    }
  }
  for (const key of ['media_buy_id', 'opportunity_id'] as const) {
    if (proposal[key] !== undefined && !nonempty(proposal[key]))
      valid = shape(issues, `${path}.${key}`, `${key} must be non-empty`);
  }
  if (
    proposal.base_media_buy_revision !== undefined &&
    (!Number.isInteger(proposal.base_media_buy_revision) || proposal.base_media_buy_revision < 1)
  ) {
    valid = shape(issues, `${path}.base_media_buy_revision`, 'base_media_buy_revision must be a positive integer');
  }
  for (const key of ['accepted_at', 'expires_at'] as const) {
    if (proposal[key] !== undefined && !isStrictDateTime(proposal[key]))
      valid = shape(issues, `${path}.${key}`, `${key} must be an RFC 3339 date-time`);
  }
  if (proposal.insertion_order !== undefined && !isRecord(proposal.insertion_order))
    valid = shape(issues, `${path}.insertion_order`, 'insertion_order must be an object');

  if (
    (proposal.proposal_kind === 'media_buy_update' || proposal.proposal_kind === 'media_buy_cancellation') &&
    (!nonempty(proposal.media_buy_id) || !Number.isInteger(proposal.base_media_buy_revision))
  ) {
    valid = shape(issues, path, 'media-buy successor proposals require media_buy_id and base_media_buy_revision');
  }
  if (
    proposal.proposal_status === 'accepted' &&
    (!nonempty(proposal.media_buy_id) || !isStrictDateTime(proposal.accepted_at))
  ) {
    valid = shape(issues, path, 'accepted proposals require media_buy_id and accepted_at');
  }
  if (proposal.proposal_status === 'committed' && !isStrictDateTime(proposal.expires_at)) {
    valid = shape(issues, `${path}.expires_at`, 'committed proposals require expires_at');
  }
  if (!validateCommercialTerms(proposal.commercial_terms, `${path}.commercial_terms`, issues)) valid = false;
  return valid;
}

function validateCommercialTerms(value: unknown, path: string, issues: ProposalVerificationIssue[]): boolean {
  if (!isRecord(value)) return shape(issues, path, 'commercial_terms must be an object');
  let valid = true;
  if (!isRecord(value.brand)) valid = shape(issues, `${path}.brand`, 'brand must be an object');
  if (!Array.isArray(value.purchases) || value.purchases.length === 0) {
    valid = shape(issues, `${path}.purchases`, 'purchases must be a non-empty array');
  } else {
    value.purchases.forEach((purchase, index) => {
      if (!validatePurchase(purchase, `${path}.purchases[${index}]`, issues)) valid = false;
    });
  }
  const purchaseCurrencies = new Set<string>();
  if (Array.isArray(value.purchases)) {
    for (const purchase of value.purchases) {
      if (isRecord(purchase) && isRecord(purchase.pricing) && typeof purchase.pricing.currency === 'string') {
        purchaseCurrencies.add(purchase.pricing.currency);
      }
    }
  }
  if (purchaseCurrencies.size > 1) {
    valid = shape(issues, `${path}.purchases`, 'every purchase pricing currency must be identical');
  }
  const purchaseCurrency = purchaseCurrencies.size === 1 ? [...purchaseCurrencies][0] : undefined;
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
  if (
    purchaseCurrency !== undefined &&
    isRecord(value.total_budget) &&
    value.total_budget.currency !== purchaseCurrency
  ) {
    valid = shape(issues, `${path}.total_budget.currency`, 'total budget currency must equal purchase currency');
  }
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
  if (
    value.change_terms !== undefined &&
    !validateChangeTerms(value.change_terms, `${path}.change_terms`, issues, purchaseCurrency)
  )
    valid = false;
  return valid;
}

const CHANGE_TERM_ACTIONS_BY_CONSTRAINT = {
  budget: new Set([
    'increase_budget',
    'decrease_budget',
    'reallocate_budget',
    'update_budget_allocation',
    'update_spend_target',
  ]),
  flight: new Set(['extend_flight', 'shorten_flight', 'update_flight_dates']),
  package_count: new Set(['add_packages', 'remove_packages']),
  effective_timing: new Set(['pause', 'resume', 'cancel']),
} as const;

function validateChangeTerms(
  value: unknown,
  path: string,
  issues: ProposalVerificationIssue[],
  purchaseCurrency?: string
): boolean {
  if (!Array.isArray(value) || value.length === 0) return shape(issues, path, 'change_terms must be a non-empty array');
  const validateChangeTerm = getSchemaValidatorByRef('media-buy/change-term.json');
  if (!validateChangeTerm) return shape(issues, path, 'change-term schema is unavailable');
  let valid = true;
  const actions = new Set<string>();
  value.forEach((term, index) => {
    const termPath = `${path}[${index}]`;
    if (!validateChangeTerm(term)) {
      const error = validateChangeTerm.errors?.[0];
      const errorPath = error?.instancePath ? `${termPath}${error.instancePath.replaceAll('/', '.')}` : termPath;
      valid = shape(
        issues,
        errorPath,
        `change term must satisfy the AdCP 3.2 schema${error?.message ? `: ${error.message}` : ''}`
      );
      return;
    }
    const typedTerm = term as Record<string, any>;
    if (actions.has(typedTerm.action)) {
      valid = shape(issues, `${termPath}.action`, 'change term actions must be unique');
    }
    actions.add(typedTerm.action);
    if (isRecord(typedTerm.constraints)) {
      const kind = typedTerm.constraints.kind as keyof typeof CHANGE_TERM_ACTIONS_BY_CONSTRAINT;
      if (!CHANGE_TERM_ACTIONS_BY_CONSTRAINT[kind]?.has(typedTerm.action)) {
        valid = shape(
          issues,
          `${termPath}.constraints.kind`,
          `${kind} constraints are not compatible with action ${typedTerm.action}`
        );
      }
      if (!validateConstraintConsistency(typedTerm.constraints, termPath, issues, purchaseCurrency)) valid = false;
    }
  });
  return valid;
}

function validateConstraintConsistency(
  constraints: Record<string, any>,
  termPath: string,
  issues: ProposalVerificationIssue[],
  purchaseCurrency?: string
): boolean {
  const path = `${termPath}.constraints`;
  let valid = true;
  for (const key of ['max_delta_amount', 'min_result_amount', 'max_result_amount'] as const) {
    const money = constraints[key];
    if (isRecord(money) && purchaseCurrency !== undefined && money.currency !== purchaseCurrency) {
      valid = shape(issues, `${path}.${key}.currency`, `constraint currency must equal ${purchaseCurrency}`);
    }
  }
  const minimum = constraints.min_result_amount;
  const maximum = constraints.max_result_amount;
  if (isRecord(minimum) && isRecord(maximum) && minimum.amount > maximum.amount) {
    valid = shape(issues, path, 'minimum result amount must not exceed maximum result amount');
  }
  for (const [earliestKey, latestKey] of [
    ['earliest_result', 'latest_result'],
    ['earliest_effective_at', 'latest_effective_at'],
  ] as const) {
    if (
      typeof constraints[earliestKey] === 'string' &&
      typeof constraints[latestKey] === 'string' &&
      Date.parse(constraints[earliestKey]) > Date.parse(constraints[latestKey])
    ) {
      valid = shape(issues, path, `${earliestKey} must not be later than ${latestKey}`);
    }
  }
  return valid;
}

function validatePurchase(value: unknown, path: string, issues: ProposalVerificationIssue[]): boolean {
  if (!isRecord(value)) return shape(issues, path, 'purchase must be an object');
  let valid = true;
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
      terms = canonicalProposalTerms(proposal.commercial_terms);
      if (proposal.terms_digest !== digestCanonicalTerms(terms)) {
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

function invalidTermsResult(
  subject: 'proposal' | 'expected',
  path: string,
  message: string,
  schemaVersion?: string,
  keyword?: string
): ProposalCommercialTermsVerificationResult {
  if (Buffer.byteLength(path, 'utf8') + Buffer.byteLength(message, 'utf8') > MAX_COMMERCIAL_TERMS_DIAGNOSTIC_BYTES) {
    return {
      ok: false,
      ...(schemaVersion && { schemaVersion }),
      truncated: true,
      mismatches: [],
    };
  }
  return {
    ok: false,
    ...(schemaVersion && { schemaVersion }),
    mismatches: [
      {
        kind: 'invalid_terms',
        subject,
        path,
        ...(keyword && { keyword }),
        message,
      },
    ],
  };
}

function schemaUnavailableResult(): ProposalCommercialTermsVerificationResult {
  return {
    ok: false,
    mismatches: [
      {
        kind: 'schema_unavailable',
        path: '/commercial_terms',
        message: 'the selected AdCP commercial-terms schema is unavailable',
      },
    ],
  };
}

function commercialTermsComplexityError(value: unknown): string | undefined {
  const stack: Array<{ value: unknown; depth: number; leaving?: boolean }> = [{ value, depth: 0 }];
  const activeAncestors = new WeakSet<object>();
  let nodes = 0;
  let arraySlots = 0;
  let stringBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.leaving) {
      if (current.value !== null && typeof current.value === 'object') activeAncestors.delete(current.value);
      continue;
    }
    nodes++;
    if (nodes > MAX_COMMERCIAL_TERMS_NODES) return 'commercial terms exceed the 50,000-node complexity limit';
    if (current.depth > MAX_JSON_DEPTH) {
      return `commercial terms exceed the maximum JSON depth of ${MAX_JSON_DEPTH}`;
    }
    const valueType = typeof current.value;
    if (
      valueType === 'undefined' ||
      valueType === 'function' ||
      valueType === 'symbol' ||
      valueType === 'bigint' ||
      (valueType === 'number' && !Number.isFinite(current.value))
    ) {
      return 'commercial terms must contain JSON values only';
    }
    if (typeof current.value === 'string') {
      stringBytes += Buffer.byteLength(current.value, 'utf8');
      if (stringBytes > MAX_COMMERCIAL_TERMS_BYTES) return 'commercial terms exceed 256 KiB';
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    const prototype = Object.getPrototypeOf(current.value);
    if (!Array.isArray(current.value) && prototype !== null && prototype !== Object.prototype) {
      return 'commercial terms must contain JSON values only';
    }
    if (activeAncestors.has(current.value)) return 'commercial terms must not contain cyclic references';
    activeAncestors.add(current.value);
    stack.push({ value: current.value, depth: current.depth, leaving: true });
    if (Array.isArray(current.value)) {
      arraySlots += current.value.length;
      if (arraySlots > MAX_COMMERCIAL_TERMS_NODES) {
        return 'commercial terms exceed the 50,000-node complexity limit';
      }
    }

    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) return 'commercial terms must contain data properties only';
      stringBytes += Buffer.byteLength(key, 'utf8');
      if (stringBytes > MAX_COMMERCIAL_TERMS_BYTES) return 'commercial terms exceed 256 KiB';
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return undefined;
}

const PRICING_INTEGRITY_CONSTRAINTS = {
  pricing_option_ids: 'each_purchase.pricing_option_id_equals_pricing.pricing_option_id',
  purchase_currencies: 'all_purchase.pricing.currency_equal',
  total_budget_currency: 'when_total_budget_present_equals_purchase_pricing_currency',
  monetary_fields: 'purchase_budget_min_spend_and_bidding_use_purchase_pricing_currency',
  on_violation: 'reject_proposal_or_commitment',
} as const;

function commercialTermsSemanticSupportError(
  schema: Readonly<Record<string, unknown>>,
  changeTermSchema: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const validation = schema['x-adcp-validation'];
  if (validation !== undefined) {
    if (!isRecord(validation)) return 'commercial-terms x-adcp-validation metadata must be an object';
    const constraints = validation.verifier_constraints;
    if (constraints !== undefined) {
      if (!isRecord(constraints)) return 'commercial-terms verifier_constraints metadata must be an object';
      const constraintKeys = Object.keys(constraints);
      if (constraintKeys.some(key => key !== 'pricing_integrity')) {
        return 'commercial-terms schema declares verifier constraints this SDK does not understand';
      }
      if (constraints.pricing_integrity !== undefined) {
        if (!isRecord(constraints.pricing_integrity)) {
          return 'commercial-terms pricing_integrity metadata must be an object';
        }
        const actual = constraints.pricing_integrity;
        const expectedKeys = Object.keys(PRICING_INTEGRITY_CONSTRAINTS);
        if (
          Object.keys(actual).length !== expectedKeys.length ||
          expectedKeys.some(
            key => actual[key] !== PRICING_INTEGRITY_CONSTRAINTS[key as keyof typeof PRICING_INTEGRITY_CONSTRAINTS]
          )
        ) {
          return 'commercial-terms schema declares unsupported pricing_integrity constraints';
        }
      }
    }
  }

  const properties = schema.properties;
  if (!isRecord(properties)) return undefined;
  const changeTermsProperty = properties.change_terms;
  if (!isRecord(changeTermsProperty)) return undefined;
  const changeTermsValidation = changeTermsProperty['x-adcp-validation'];
  if (changeTermsValidation !== undefined) {
    if (
      !isRecord(changeTermsValidation) ||
      Object.keys(changeTermsValidation).length !== 1 ||
      changeTermsValidation.unique_by !== 'action'
    ) {
      return 'commercial-terms schema declares unsupported change_terms validation metadata';
    }
  }
  if (!changeTermSchema) return 'commercial-terms schema is missing its change-term schema';
  return changeTermSemanticSupportError(changeTermSchema);
}

function validateCommercialTermsSemantics(
  terms: Record<string, unknown>,
  schema: Readonly<Record<string, unknown>>,
  changeTermSchema: Readonly<Record<string, unknown>> | undefined
): Array<{ path: string; message: string }> {
  const validation = schema['x-adcp-validation'];
  const pricingIntegrityEnabled =
    isRecord(validation) &&
    isRecord(validation.verifier_constraints) &&
    isRecord(validation.verifier_constraints.pricing_integrity);

  const issues: Array<{ path: string; message: string }> = [];
  if (!Array.isArray(terms.purchases)) return issues;
  let purchaseCurrency: string | undefined;
  for (const [index, purchase] of terms.purchases.entries()) {
    if (!isRecord(purchase) || !isRecord(purchase.pricing)) continue;
    const pricing = purchase.pricing;
    if (pricingIntegrityEnabled && purchase.pricing_option_id !== pricing.pricing_option_id) {
      issues.push({
        path: `/commercial_terms/purchases/${index}/pricing/pricing_option_id`,
        message: 'pricing pricing_option_id must match the purchase pricing_option_id',
      });
      if (issues.length > MAX_COMMERCIAL_TERMS_MISMATCHES) return issues;
    }
    const currency = pricing.currency as string;
    purchaseCurrency ??= currency;
    if (pricingIntegrityEnabled && currency !== purchaseCurrency) {
      issues.push({
        path: `/commercial_terms/purchases/${index}/pricing/currency`,
        message: 'every purchase pricing currency must be identical',
      });
      if (issues.length > MAX_COMMERCIAL_TERMS_MISMATCHES) return issues;
    }
  }
  if (
    pricingIntegrityEnabled &&
    purchaseCurrency !== undefined &&
    isRecord(terms.total_budget) &&
    terms.total_budget.currency !== purchaseCurrency
  ) {
    issues.push({
      path: '/commercial_terms/total_budget/currency',
      message: 'total budget currency must equal purchase currency',
    });
  }
  if (changeTermSchema && Array.isArray(terms.change_terms)) {
    validateChangeTermSemantics(terms.change_terms, purchaseCurrency, issues);
  }
  return issues;
}

function changeTermSemanticSupportError(schema: Readonly<Record<string, unknown>>): string | undefined {
  const validation = schema['x-adcp-validation'];
  if (!isRecord(validation) || !isRecord(validation.verifier_constraints)) {
    return 'change-term schema is missing verifier constraint metadata';
  }
  const constraints = validation.verifier_constraints;
  const expectedKeys = new Set([
    'allowed_statuses',
    'constraint_action_compatibility',
    'constraint_currency',
    'constraint_consistency',
  ]);
  if (
    Object.keys(constraints).length !== expectedKeys.size ||
    Object.keys(constraints).some(key => !expectedKeys.has(key))
  ) {
    return 'change-term schema declares verifier constraints this SDK does not understand';
  }
  if (
    constraints.allowed_statuses !==
      'Every value is a non-terminal MediaBuy status. The current buy projection omits the action outside these statuses without extinguishing the negotiated right.' ||
    constraints.constraint_currency !==
      'Every monetary constraint currency equals the commercial terms purchase currency.' ||
    constraints.constraint_consistency !==
      'Minimum result does not exceed maximum result; earliest timestamp does not exceed latest timestamp.'
  ) {
    return 'change-term schema declares unsupported verifier constraint semantics';
  }
  const compatibility = constraints.constraint_action_compatibility;
  if (!isRecord(compatibility) || compatibility.on_violation !== 'reject_proposal') {
    return 'change-term schema declares unsupported action compatibility metadata';
  }
  for (const [kind, actions] of Object.entries(CHANGE_TERM_ACTIONS_BY_CONSTRAINT)) {
    const declared = compatibility[kind];
    if (
      !Array.isArray(declared) ||
      declared.length !== actions.size ||
      declared.some(action => typeof action !== 'string' || !actions.has(action))
    ) {
      return 'change-term schema declares unsupported action compatibility metadata';
    }
  }
  if (Object.keys(compatibility).some(key => key !== 'on_violation' && !(key in CHANGE_TERM_ACTIONS_BY_CONSTRAINT))) {
    return 'change-term schema declares unsupported action compatibility metadata';
  }
  return undefined;
}

function validateChangeTermSemantics(
  terms: unknown[],
  purchaseCurrency: string | undefined,
  issues: Array<{ path: string; message: string }>
): void {
  const actions = new Set<string>();
  for (const [index, value] of terms.entries()) {
    if (!isRecord(value)) continue;
    const path = `/commercial_terms/change_terms/${index}`;
    const action = value.action;
    if (typeof action === 'string') {
      if (actions.has(action)) {
        issues.push({ path: `${path}/action`, message: 'change term actions must be unique' });
      }
      actions.add(action);
    }
    if (!isRecord(value.constraints)) continue;
    const constraints = value.constraints;
    const kind = constraints.kind as keyof typeof CHANGE_TERM_ACTIONS_BY_CONSTRAINT;
    if (typeof action === 'string' && !CHANGE_TERM_ACTIONS_BY_CONSTRAINT[kind]?.has(action)) {
      issues.push({
        path: `${path}/constraints/kind`,
        message: `${String(kind)} constraints are not compatible with action ${action}`,
      });
    }
    for (const key of ['max_delta_amount', 'min_result_amount', 'max_result_amount'] as const) {
      const money = constraints[key];
      if (purchaseCurrency !== undefined && isRecord(money) && money.currency !== purchaseCurrency) {
        issues.push({
          path: `${path}/constraints/${key}/currency`,
          message: `constraint currency must equal ${purchaseCurrency}`,
        });
      }
    }
    const minimum = constraints.min_result_amount;
    const maximum = constraints.max_result_amount;
    if (isRecord(minimum) && isRecord(maximum) && minimum.amount > maximum.amount) {
      issues.push({
        path: `${path}/constraints`,
        message: 'minimum result amount must not exceed maximum result amount',
      });
    }
    for (const [earliestKey, latestKey] of [
      ['earliest_result', 'latest_result'],
      ['earliest_effective_at', 'latest_effective_at'],
    ] as const) {
      if (
        typeof constraints[earliestKey] === 'string' &&
        typeof constraints[latestKey] === 'string' &&
        Date.parse(constraints[earliestKey]) > Date.parse(constraints[latestKey])
      ) {
        issues.push({
          path: `${path}/constraints`,
          message: `${earliestKey} must not be later than ${latestKey}`,
        });
      }
    }
    if (issues.length > MAX_COMMERCIAL_TERMS_MISMATCHES) return;
  }
}

function diffCommercialTerm(
  actual: unknown,
  expected: unknown,
  path: string,
  mismatches: ProposalCommercialTermsMismatch[],
  state: { truncated: boolean; diagnosticBytes: number },
  presence: { actualHas: boolean; expectedHas: boolean } = { actualHas: true, expectedHas: true }
): void {
  if (state.truncated) return;
  if (!presence.actualHas) {
    pushCommercialTermsMismatch(mismatches, state, {
      kind: 'missing',
      path,
      message: 'proposal is missing a reviewed commercial term',
    });
    return;
  }
  if (!presence.expectedHas) {
    pushCommercialTermsMismatch(mismatches, state, {
      kind: 'unexpected',
      path,
      message: 'proposal contains an unreviewed commercial term',
    });
    return;
  }
  if (Object.is(actual, expected)) return;

  if (Array.isArray(actual) && Array.isArray(expected)) {
    const length = Math.max(actual.length, expected.length);
    for (let index = 0; index < length; index++) {
      diffCommercialTerm(actual[index], expected[index], `${path}/${index}`, mismatches, state, {
        actualHas: index < actual.length,
        expectedHas: index < expected.length,
      });
    }
    return;
  }

  if (isRecord(actual) && isRecord(expected)) {
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    for (const key of [...keys].sort()) {
      diffCommercialTerm(actual[key], expected[key], `${path}/${escapeJsonPointer(key)}`, mismatches, state, {
        actualHas: Object.hasOwn(actual, key),
        expectedHas: Object.hasOwn(expected, key),
      });
    }
    return;
  }

  pushCommercialTermsMismatch(mismatches, state, {
    kind: 'changed',
    path,
    message: 'proposal changed a reviewed commercial term',
  });
}

function pushCommercialTermsMismatch(
  mismatches: ProposalCommercialTermsMismatch[],
  state: { truncated: boolean; diagnosticBytes: number },
  mismatch: ProposalCommercialTermsMismatch
): void {
  const diagnosticBytes = Buffer.byteLength(mismatch.path, 'utf8') + Buffer.byteLength(mismatch.message, 'utf8');
  if (
    mismatches.length >= MAX_COMMERCIAL_TERMS_MISMATCHES ||
    state.diagnosticBytes + diagnosticBytes > MAX_COMMERCIAL_TERMS_DIAGNOSTIC_BYTES
  ) {
    state.truncated = true;
    return;
  }
  state.diagnosticBytes += diagnosticBytes;
  mismatches.push(mismatch);
}

function schemaValidationPointer(
  error:
    | {
        instancePath?: string;
        keyword?: string;
        params?: Record<string, unknown>;
      }
    | null
    | undefined
): string {
  let pointer = `/commercial_terms${error?.instancePath ?? ''}`;
  const field =
    error?.keyword === 'required'
      ? error.params?.missingProperty
      : error?.keyword === 'additionalProperties'
        ? error.params?.additionalProperty
        : undefined;
  if (typeof field === 'string') pointer += `/${escapeJsonPointer(field)}`;
  return pointer;
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Canonicalize once so validation and hashing observe the exact same bytes, including accessor-backed input. */
function canonicalProposalTerms(value: unknown): string {
  const canonical = canonicalize(value);
  assertIJsonString(canonical);
  return canonical;
}

function digestCanonicalTerms(canonical: string): string {
  // The negotiation protocol requires a SHA-256 digest of canonical proposal
  // terms. This is content integrity, not password storage or verification.
  // codeql[js/insufficient-password-hash]
  return `sha256:${createHash('sha256').update(canonical).digest('base64url')}`;
}

function assertIJsonString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        index++;
        continue;
      }
      throw new TypeError('JCS: lone Unicode surrogate is not valid I-JSON');
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('JCS: lone Unicode surrogate is not valid I-JSON');
    }
  }
}

function shape(issues: ProposalVerificationIssue[], path: string, message: string): false {
  push(issues, 'shape', path, message);
  return false;
}

function describeReceived(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return String(value);
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
