import { generateIdempotencyKey, isValidIdempotencyKey } from '../utils/idempotency';
import type { TaskResult } from '../core/ConversationTypes';
import { ADCP_VERSION, toReleasePrecisionVersion } from '../version';
import type {
  ProposalRefinement,
  ProposalRefinementCapabilities,
  ProposalRefinementDimension,
  ProposalRefinementSupport,
  RefineProposalsInput,
  RefineProposalsCompletedResponse,
  RefineProposalsRequest,
  RefineProposalsResponse,
} from './types';
import { PROPOSAL_REFINEMENT_DIMENSIONS } from './types';
import { assertRefineProposalsResponse, isStrictDateTime } from './verification';

export const MAX_PROPOSAL_REFINEMENTS = 25;
export const MAX_PROPOSAL_ALTERNATIVES = 10;
const ADCP_32_RELEASE = /^3\.2(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;

/**
 * Read AdCP 3.2 proposal discovery from a raw get_adcp_capabilities response,
 * a normalized `agent.getCapabilities()` value, or a completed TaskResult / MCP
 * result wrapper. Malformed explicit declarations fail closed instead of being
 * treated as absent support.
 */
export function extractProposalRefinementSupport(source: unknown): ProposalRefinementSupport {
  const payload = unwrapCapabilityPayload(source);
  if (!isRecord(payload)) fail('capabilities response must be an object', 'capabilities');

  const mediaBuy = payload.media_buy;
  if (mediaBuy === undefined) return Object.freeze({ supported: false });
  if (!isRecord(mediaBuy)) fail('media_buy capabilities must be an object', 'capabilities.media_buy');

  let supported = false;
  if (mediaBuy.lifecycle_tools !== undefined) {
    if (
      !Array.isArray(mediaBuy.lifecycle_tools) ||
      mediaBuy.lifecycle_tools.some(tool => typeof tool !== 'string' || tool.length === 0)
    ) {
      fail('media_buy.lifecycle_tools must contain non-empty strings', 'capabilities.media_buy.lifecycle_tools');
    }
    supported = mediaBuy.lifecycle_tools.includes('refine_proposals');
  }

  if (mediaBuy.proposal_refinement === undefined) return Object.freeze({ supported });
  validateCapabilities(mediaBuy.proposal_refinement as ProposalRefinementCapabilities);
  const raw = mediaBuy.proposal_refinement as ProposalRefinementCapabilities;
  const capabilities = Object.freeze({
    supported_dimensions: Object.freeze([...raw.supported_dimensions]),
    ...(raw.max_alternatives !== undefined && { max_alternatives: raw.max_alternatives }),
  });
  return Object.freeze({ supported, capabilities });
}

export class ProposalRefinementValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly code: 'VALIDATION_ERROR' | 'UNSUPPORTED_FEATURE' = 'VALIDATION_ERROR',
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ProposalRefinementValidationError';
  }
}

export class RefineProposalsTaskError extends Error {
  readonly result: TaskResult<RefineProposalsResponse>;

  constructor(result: TaskResult<RefineProposalsResponse>) {
    super(result.success ? `refine_proposals did not complete (status ${result.status})` : result.error);
    this.name = 'RefineProposalsTaskError';
    this.result = result;
  }
}

export function refinementDimensions(refinement: ProposalRefinement): ProposalRefinementDimension[] {
  if (refinement.action === 'finalize') return [];
  const dimensions: ProposalRefinementDimension[] = [];
  if (refinement.constraints) {
    if (refinement.constraints.total_budget) dimensions.push('total_budget');
    if (refinement.constraints.cpm) dimensions.push('cpm');
    if (refinement.constraints.impressions) dimensions.push('impressions');
    if (refinement.constraints.flight) dimensions.push('flight');
  }
  if (refinement.product_changes) dimensions.push('product_changes');
  if (refinement.alternatives) dimensions.push('alternatives');
  if (refinement.criteria) dimensions.push('criteria');
  return dimensions;
}

export function validateRefineProposalsRequest(
  request: unknown,
  capabilities?: ProposalRefinementCapabilities
): asserts request is RefineProposalsRequest {
  if (!isRecord(request)) fail('request must be an object');
  assertAllowedKeys(request, REQUEST_KEYS, 'request');
  if (typeof request.adcp_version !== 'string' || !ADCP_32_RELEASE.test(request.adcp_version)) {
    fail('refine_proposals requires an adcp_version on the 3.2 release line', 'adcp_version');
  }
  if (request.adcp_major_version !== 3) {
    fail('refine_proposals requires adcp_major_version 3', 'adcp_major_version');
  }
  if (request.context_id !== undefined && !isNonemptyString(request.context_id)) {
    fail('context_id must be a non-empty string', 'context_id');
  }
  if (
    request.governance_context !== undefined &&
    (!isNonemptyString(request.governance_context) || request.governance_context.length > 4096)
  ) {
    fail('governance_context must be a non-empty string of at most 4096 characters', 'governance_context');
  }
  if (request.context !== undefined && !isRecord(request.context)) fail('context must be an object', 'context');
  if (request.push_notification_config !== undefined && !isRecord(request.push_notification_config)) {
    fail('push_notification_config must be an object', 'push_notification_config');
  }
  if (!isValidIdempotencyKey(request.idempotency_key)) {
    throw new ProposalRefinementValidationError(
      'idempotency_key must be 16-255 characters from A-Z, a-z, 0-9, _, ., :, or -',
      'idempotency_key'
    );
  }
  if (!Array.isArray(request.refinements)) fail('refinements must be an array', 'refinements');
  if (request.refinements.length < 1 || request.refinements.length > MAX_PROPOSAL_REFINEMENTS) {
    throw new ProposalRefinementValidationError(
      `refinements must contain 1-${MAX_PROPOSAL_REFINEMENTS} entries`,
      'refinements'
    );
  }

  validateCapabilities(capabilities);

  const ids = new Set<string>();
  const hasFinalize = request.refinements.some(entry => isRecord(entry) && entry.action === 'finalize');
  for (const [index, refinement] of request.refinements.entries()) {
    const base = `refinements[${index}]`;
    if (!isRecord(refinement)) fail('refinement must be an object', base);
    if (!isNonemptyString(refinement.proposal_id)) {
      throw new ProposalRefinementValidationError('proposal_id must not be empty', `${base}.proposal_id`);
    }
    if (ids.has(refinement.proposal_id)) {
      throw new ProposalRefinementValidationError('proposal_id values must be unique', `${base}.proposal_id`);
    }
    ids.add(refinement.proposal_id);

    if (refinement.action !== 'revise' && refinement.action !== 'finalize') {
      fail('action must be revise or finalize', `${base}.action`);
    }
    if (refinement.action === 'finalize') {
      assertAllowedKeys(refinement, FINALIZE_KEYS, base);
    } else {
      assertAllowedKeys(refinement, REVISE_KEYS, base);
    }
    if (hasFinalize && refinement.action !== 'finalize') {
      throw new ProposalRefinementValidationError(
        'a batch containing finalize may contain only finalize entries',
        `${base}.action`
      );
    }
    if (refinement.action === 'revise') {
      if (
        refinement.change_kind !== undefined &&
        refinement.change_kind !== 'amendment' &&
        refinement.change_kind !== 'cancellation'
      ) {
        fail('change_kind must be amendment or cancellation', `${base}.change_kind`);
      }
      const hasRevision =
        refinement.change_kind === 'cancellation' ||
        refinement.constraints != null ||
        refinement.product_changes != null ||
        refinement.alternatives != null ||
        refinement.ask != null ||
        refinement.criteria != null;
      if (!hasRevision) {
        throw new ProposalRefinementValidationError(
          'revise requires a constraint, product change, alternative request, ask, criteria, or cancellation',
          base
        );
      }
      validateConstraints(refinement as Extract<ProposalRefinement, { action: 'revise' }>, base);
      const count = refinement.alternatives?.count;
      if (count !== undefined) {
        if (!Number.isInteger(count) || count < 2 || count > MAX_PROPOSAL_ALTERNATIVES) {
          throw new ProposalRefinementValidationError(
            `alternatives.count must be an integer from 2-${MAX_PROPOSAL_ALTERNATIVES}`,
            `${base}.alternatives.count`
          );
        }
        if (capabilities?.max_alternatives !== undefined && count > capabilities.max_alternatives) {
          throw new ProposalRefinementValidationError(
            `alternatives.count (${count}) exceeds seller max_alternatives (${capabilities.max_alternatives})`,
            `${base}.alternatives.count`
          );
        }
      }

      if (capabilities !== undefined) {
        const supported = new Set(capabilities.supported_dimensions);
        const unsupported = refinementDimensions(refinement as ProposalRefinement).find(
          dimension => !supported.has(dimension)
        );
        if (unsupported) {
          throw new ProposalRefinementValidationError(
            `seller does not advertise proposal refinement dimension ${unsupported}`,
            base,
            'UNSUPPORTED_FEATURE',
            {
              unsupported_dimension: unsupported,
              supported_dimensions: [...capabilities.supported_dimensions],
            }
          );
        }
      }
    }
  }
}

function validateConstraints(refinement: Extract<ProposalRefinement, { action: 'revise' }>, base: string): void {
  if (refinement.ask !== undefined && !isNonemptyString(refinement.ask)) {
    throw new ProposalRefinementValidationError('ask must not be empty', `${base}.ask`);
  }
  if (refinement.criteria !== undefined && !isRecord(refinement.criteria)) {
    fail('criteria must be an object', `${base}.criteria`);
  }
  if (refinement.criteria) {
    assertAllowedKeys(refinement.criteria, CRITERIA_KEYS, `${base}.criteria`);
    if (Object.keys(refinement.criteria).length === 0) fail('criteria must not be empty', `${base}.criteria`);
    validateNonemptyUniqueStrings(refinement.criteria.product_ids, `${base}.criteria.product_ids`);
    validateNonemptyUniqueStrings(refinement.criteria.policy_ids, `${base}.criteria.policy_ids`);
    for (const key of ['offer_filters', 'targeting_overlay', 'required_overlay_support', 'ext'] as const) {
      if (refinement.criteria[key] !== undefined && !isRecord(refinement.criteria[key])) {
        fail(`${key} must be an object`, `${base}.criteria.${key}`);
      }
    }
    if (refinement.criteria.catalog !== undefined) {
      if (!isRecord(refinement.criteria.catalog)) fail('catalog must be an object', `${base}.criteria.catalog`);
      assertAllowedKeys(refinement.criteria.catalog, CATALOG_KEYS, `${base}.criteria.catalog`);
      if (!isNonemptyString(refinement.criteria.catalog.catalog_id)) {
        fail('catalog.catalog_id must be a non-empty string', `${base}.criteria.catalog.catalog_id`);
      }
      if (refinement.criteria.catalog.type !== undefined && !CATALOG_TYPES.has(refinement.criteria.catalog.type)) {
        fail('catalog.type must be a recognized catalog type', `${base}.criteria.catalog.type`);
      }
      validateNonemptyUniqueStrings(refinement.criteria.catalog.ids, `${base}.criteria.catalog.ids`);
      validateNonemptyUniqueStrings(refinement.criteria.catalog.tags, `${base}.criteria.catalog.tags`);
      validateNonemptyUniqueStrings(refinement.criteria.catalog.gtins, `${base}.criteria.catalog.gtins`);
      if (
        Array.isArray(refinement.criteria.catalog.gtins) &&
        refinement.criteria.catalog.gtins.some(gtin => !/^[0-9]{8,14}$/.test(gtin))
      ) {
        fail('catalog.gtins must contain 8-14 digit identifiers', `${base}.criteria.catalog.gtins`);
      }
      for (const key of ['category', 'query'] as const) {
        if (refinement.criteria.catalog[key] !== undefined && !isNonemptyString(refinement.criteria.catalog[key])) {
          fail(`catalog.${key} must be a non-empty string`, `${base}.criteria.catalog.${key}`);
        }
      }
    }
  }
  if (refinement.constraints !== undefined && !isRecord(refinement.constraints)) {
    fail('constraints must be an object', `${base}.constraints`);
  }
  if (refinement.constraints) {
    assertAllowedKeys(refinement.constraints, CONSTRAINT_KEYS, `${base}.constraints`);
  }
  if (refinement.constraints && Object.keys(refinement.constraints).length === 0) {
    throw new ProposalRefinementValidationError('constraints must not be empty', `${base}.constraints`);
  }
  const budget = refinement.constraints?.total_budget;
  if (budget) {
    if (!isRecord(budget)) fail('total_budget must be an object', `${base}.constraints.total_budget`);
    assertAllowedKeys(budget, BUDGET_KEYS, `${base}.constraints.total_budget`);
    if (budget.min === undefined && budget.max === undefined) {
      throw new ProposalRefinementValidationError(
        'total_budget requires min or max',
        `${base}.constraints.total_budget`
      );
    }
    if (budget.min !== undefined && budget.max !== undefined && budget.min > budget.max) {
      throw new ProposalRefinementValidationError(
        'total_budget.min must be less than or equal to max',
        `${base}.constraints.total_budget`
      );
    }
    if (
      typeof budget.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(budget.currency) ||
      (budget.min !== undefined && (!isFiniteNumber(budget.min) || budget.min < 0)) ||
      (budget.max !== undefined && (!isFiniteNumber(budget.max) || budget.max < 0))
    ) {
      throw new ProposalRefinementValidationError(
        'total_budget requires an uppercase ISO currency and non-negative bounds',
        `${base}.constraints.total_budget`
      );
    }
  }
  const cpm = refinement.constraints?.cpm;
  if (cpm) {
    if (!isRecord(cpm)) fail('cpm must be an object', `${base}.constraints.cpm`);
    assertAllowedKeys(cpm, CPM_KEYS, `${base}.constraints.cpm`);
  }
  if (cpm && (!isFiniteNumber(cpm.max) || cpm.max <= 0 || !/^[A-Z]{3}$/.test(cpm.currency))) {
    throw new ProposalRefinementValidationError(
      'cpm requires max > 0 and an uppercase ISO currency',
      `${base}.constraints.cpm`
    );
  }
  const impressions = refinement.constraints?.impressions;
  if (impressions) {
    if (!isRecord(impressions)) fail('impressions must be an object', `${base}.constraints.impressions`);
    assertAllowedKeys(impressions, IMPRESSIONS_KEYS, `${base}.constraints.impressions`);
  }
  if (impressions && (!isFiniteNumber(impressions.min) || impressions.min <= 0)) {
    throw new ProposalRefinementValidationError(
      'impressions.min must be greater than zero',
      `${base}.constraints.impressions.min`
    );
  }
  const flight = refinement.constraints?.flight;
  if (flight) {
    if (!isRecord(flight)) fail('flight must be an object', `${base}.constraints.flight`);
    assertAllowedKeys(flight, FLIGHT_KEYS, `${base}.constraints.flight`);
  }
  if (flight && flight.start_no_later_than === undefined && flight.end_no_earlier_than === undefined) {
    throw new ProposalRefinementValidationError(
      'flight requires start_no_later_than or end_no_earlier_than',
      `${base}.constraints.flight`
    );
  }
  if (
    flight &&
    ((flight.start_no_later_than !== undefined && !isStrictDateTime(flight.start_no_later_than)) ||
      (flight.end_no_earlier_than !== undefined && !isStrictDateTime(flight.end_no_earlier_than)))
  ) {
    throw new ProposalRefinementValidationError('flight bounds must be ISO date-times', `${base}.constraints.flight`);
  }
  if (refinement.product_changes !== undefined && !isRecord(refinement.product_changes)) {
    fail('product_changes must be an object', `${base}.product_changes`);
  }
  if (refinement.product_changes) {
    const changes = Object.entries(refinement.product_changes);
    if (
      changes.length === 0 ||
      changes.some(([productId, action]) => !productId || !['include', 'omit'].includes(action))
    ) {
      throw new ProposalRefinementValidationError(
        'product_changes requires non-empty product IDs mapped to include or omit',
        `${base}.product_changes`
      );
    }
  }
  if (refinement.alternatives !== undefined) {
    if (!isRecord(refinement.alternatives)) fail('alternatives must be an object', `${base}.alternatives`);
    assertAllowedKeys(refinement.alternatives, ALTERNATIVES_KEYS, `${base}.alternatives`);
    if (!Object.hasOwn(refinement.alternatives, 'count')) {
      fail('alternatives.count is required', `${base}.alternatives.count`);
    }
  }
}

/** Build and preflight a request before any transport call. */
export function buildRefineProposalsRequest(
  input: RefineProposalsInput,
  capabilities?: ProposalRefinementCapabilities,
  defaultAdcpVersion = ADCP_VERSION
): RefineProposalsRequest {
  if (!isRecord(input)) fail('request input must be an object');
  if (input.adcp_version !== undefined && !ADCP_32_RELEASE.test(input.adcp_version)) {
    fail('refine_proposals requires an adcp_version on the 3.2 release line', 'adcp_version');
  }
  if (input.adcp_major_version !== undefined && input.adcp_major_version !== 3) {
    fail('refine_proposals requires adcp_major_version 3', 'adcp_major_version');
  }
  const snapshot = structuredClone(input) as RefineProposalsInput;
  const request: RefineProposalsRequest = {
    ...snapshot,
    adcp_version: (snapshot.adcp_version ??
      toReleasePrecisionVersion(defaultAdcpVersion)) as RefineProposalsRequest['adcp_version'],
    adcp_major_version: 3,
    idempotency_key: snapshot.idempotency_key ?? generateIdempotencyKey(),
  };
  validateRefineProposalsRequest(request, capabilities);
  return deepFreeze(request);
}

const REQUEST_KEYS = new Set([
  'adcp_version',
  'adcp_major_version',
  'context_id',
  'context',
  'governance_context',
  'push_notification_config',
  'idempotency_key',
  'refinements',
]);
const FINALIZE_KEYS = new Set(['proposal_id', 'action']);
const REVISE_KEYS = new Set([
  'proposal_id',
  'action',
  'change_kind',
  'constraints',
  'product_changes',
  'alternatives',
  'ask',
  'criteria',
]);
const CONSTRAINT_KEYS = new Set(['total_budget', 'cpm', 'impressions', 'flight']);
const BUDGET_KEYS = new Set(['min', 'max', 'currency']);
const CPM_KEYS = new Set(['max', 'currency']);
const IMPRESSIONS_KEYS = new Set(['min']);
const FLIGHT_KEYS = new Set(['start_no_later_than', 'end_no_earlier_than']);
const ALTERNATIVES_KEYS = new Set(['count']);
const CRITERIA_KEYS = new Set([
  'product_ids',
  'offer_filters',
  'targeting_overlay',
  'required_overlay_support',
  'catalog',
  'policy_ids',
  'ext',
]);
const CATALOG_KEYS = new Set(['catalog_id', 'type', 'ids', 'gtins', 'category', 'tags', 'query']);
const CATALOG_TYPES = new Set([
  'offering',
  'product',
  'inventory',
  'store',
  'promotion',
  'hotel',
  'flight',
  'job',
  'vehicle',
  'real_estate',
  'education',
  'destination',
  'app',
]);

function validateCapabilities(capabilities: ProposalRefinementCapabilities | undefined): void {
  if (capabilities === undefined) return;
  if (!isRecord(capabilities) || !Array.isArray(capabilities.supported_dimensions)) {
    fail('proposal_refinement capabilities require supported_dimensions', 'capabilities.supported_dimensions');
  }
  const dimensions = capabilities.supported_dimensions;
  if (
    new Set(dimensions).size !== dimensions.length ||
    dimensions.some(value => !(PROPOSAL_REFINEMENT_DIMENSIONS as readonly unknown[]).includes(value))
  ) {
    fail('supported_dimensions must contain unique recognized dimensions', 'capabilities.supported_dimensions');
  }
  if (
    capabilities.max_alternatives !== undefined &&
    (!Number.isInteger(capabilities.max_alternatives) ||
      capabilities.max_alternatives < 2 ||
      capabilities.max_alternatives > MAX_PROPOSAL_ALTERNATIVES)
  ) {
    fail('max_alternatives must be an integer from 2-10', 'capabilities.max_alternatives');
  }
  if (capabilities.max_alternatives !== undefined && !dimensions.includes('alternatives')) {
    fail('max_alternatives requires alternatives in supported_dimensions', 'capabilities.max_alternatives');
  }
}

function unwrapCapabilityPayload(source: unknown): unknown {
  if (!isRecord(source)) return source;
  if (source.success === false) fail('cannot extract capabilities from a failed task result', 'capabilities');
  if (source._raw !== undefined) return source._raw;
  if (source.structuredContent !== undefined) return source.structuredContent;
  if (source.data !== undefined && (source.success === true || source.status !== undefined)) return source.data;
  return source;
}

function validateNonemptyUniqueStrings(value: unknown, path: string): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(item => !isNonemptyString(item)) ||
    new Set(value).size !== value.length
  ) {
    fail(`${path.split('.').at(-1)} must contain unique non-empty strings`, path);
  }
}

function assertAllowedKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.has(key));
  if (unexpected) fail(`${unexpected} is not allowed`, `${path}.${unexpected}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fail(message: string, field?: string): never {
  throw new ProposalRefinementValidationError(message, field);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Narrow a task result only after surfacing task-level failures and verifying
 * the completed payload against its source request.
 */
export function unwrapVerifiedRefineProposals(
  result: TaskResult<RefineProposalsResponse>,
  request: RefineProposalsRequest
): RefineProposalsCompletedResponse {
  if (!result.success || result.status !== 'completed') {
    throw new RefineProposalsTaskError(result);
  }
  assertRefineProposalsResponse(request, result.data);
  return result.data;
}
