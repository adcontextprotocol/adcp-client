import type { MaybePromise } from '../server/create-adcp-server';
import { AdcpError } from '../server/decisioning/async-outcome';
import type { HandlerContext } from '../server/create-adcp-server';
import { ProposalRefinementValidationError, validateRefineProposalsRequest } from './buyer';
import { assertRefineProposalsResponse, isStrictDateTime, proposalTermsDigest } from './verification';
import type {
  CanonicalProposal,
  ProposalCommercialTerms,
  ProposalRefinement,
  ProposalRefinementCapabilities,
  ProposalRefinementReason,
  ProposalRefinementResult,
  RefineProposalsCompletedResponse,
  RefineProposalsRequest,
} from './types';

export interface ProposalFailureClassification {
  unsatisfied_constraints?: readonly string[];
  unsatisfied_product_changes?: Readonly<Record<string, 'include' | 'omit'>>;
  batch_aborted?: boolean;
  hold_unavailable?: boolean;
  source_unavailable?: boolean;
  alternatives_unavailable?: boolean;
  unsupported_dimension?: boolean;
  commercially_declined?: boolean;
}

/** Apply the protocol's deterministic reason-code precedence. */
export function classifyProposalRefinementFailure(failure: ProposalFailureClassification): ProposalRefinementReason {
  if (
    (failure.unsatisfied_constraints?.length ?? 0) > 0 ||
    Object.keys(failure.unsatisfied_product_changes ?? {}).length > 0
  ) {
    return 'constraint_unsatisfiable';
  }
  if (failure.batch_aborted) return 'batch_aborted';
  if (failure.hold_unavailable) return 'hold_unavailable';
  if (failure.source_unavailable) return 'source_unavailable';
  if (failure.alternatives_unavailable) return 'alternatives_unavailable';
  if (failure.unsupported_dimension) return 'unsupported_dimension';
  if (failure.commercially_declined) return 'commercially_declined';
  return 'uninterpreted';
}

export function defineProposalRefinementCapabilities(
  capabilities: ProposalRefinementCapabilities
): ProposalRefinementCapabilities {
  const dimensions = capabilities.supported_dimensions;
  if (dimensions && new Set(dimensions).size !== dimensions.length) {
    throw new TypeError('proposal_refinement.supported_dimensions must be unique');
  }
  if (
    capabilities.max_alternatives !== undefined &&
    (!Number.isInteger(capabilities.max_alternatives) ||
      capabilities.max_alternatives < 2 ||
      capabilities.max_alternatives > 10)
  ) {
    throw new TypeError('proposal_refinement.max_alternatives must be an integer from 2-10');
  }
  if (capabilities.max_alternatives !== undefined && !dimensions?.includes('alternatives')) {
    throw new TypeError('proposal_refinement.max_alternatives requires alternatives in supported_dimensions');
  }
  return Object.freeze({
    ...capabilities,
    ...(dimensions && { supported_dimensions: Object.freeze([...dimensions]) }),
  });
}

export interface ProposalRefinementTransaction<TProposal extends CanonicalProposal = CanonicalProposal> {
  /**
   * Stage immutable successors; implementations MUST NOT expose them before
   * commit and MUST insert them as new records (never upsert/overwrite).
   */
  stage(proposals: readonly TProposal[]): MaybePromise<void>;
  /**
   * Commit every staged successor atomically after comparing every source
   * version supplied to `begin`. A mismatch MUST abort the whole batch.
   *
   * For `finalize`, the store MUST also reject an existing unexpired active
   * hold and atomically record the staged committed successor as the source's
   * new `active_hold`. Merely incrementing the source version is insufficient:
   * a later request can read that new version and otherwise mint a second hold.
   * Source proposal contents remain immutable.
   */
  commit(): MaybePromise<void>;
  /** Restore the exact pre-batch state. Safe to call after any failed stage/commit. */
  rollback(): MaybePromise<void>;
}

/** Authenticated, server-derived namespace for proposal persistence. */
export interface ProposalRefinementScope {
  tenant_id: string;
  principal_id: string;
  account_id?: string;
}

/** Current committed successor that reserves inventory for this source draft. */
export interface ProposalActiveHold {
  proposal_id: string;
  expires_at: string;
}

/** Opaque store revision and active hold state used for compare-and-swap at commit. */
export interface ProposalSourceSnapshot<TProposal extends CanonicalProposal = CanonicalProposal> {
  proposal: TProposal;
  version: string;
  /**
   * Present only while the committed successor's hold is unexpired. Stores
   * MUST omit/clear expired holds and update this field atomically with the
   * successor insert and source-version advance.
   */
  active_hold?: ProposalActiveHold;
}

export interface ProposalSourceExpectation {
  proposal_id: string;
  action: ProposalRefinement['action'];
  /** `null` means the source was absent when the request was evaluated. */
  version: string | null;
}

export interface ProposalRefinementStore<TProposal extends CanonicalProposal = CanonicalProposal> {
  get(
    scope: Readonly<ProposalRefinementScope>,
    proposalId: string
  ): MaybePromise<ProposalSourceSnapshot<TProposal> | null>;
  begin(
    scope: Readonly<ProposalRefinementScope>,
    expectedSources: readonly ProposalSourceExpectation[]
  ): MaybePromise<ProposalRefinementTransaction<TProposal>>;
}

export interface ProposalEvaluationContext<
  TProposal extends CanonicalProposal = CanonicalProposal,
  TContext = unknown,
> {
  refinement: ProposalRefinement;
  source: TProposal | null;
  index: number;
  request: Readonly<RefineProposalsRequest>;
  context: TContext;
}

export type ProposalCommercialEvaluator<TProposal extends CanonicalProposal = CanonicalProposal, TContext = unknown> = (
  evaluation: ProposalEvaluationContext<TProposal, TContext>
) => MaybePromise<ProposalRefinementResult<TProposal>>;

export interface ProposalRefinementHandlerOptions<
  TProposal extends CanonicalProposal = CanonicalProposal,
  TProduct = Record<string, unknown>,
  TContext = unknown,
> {
  capabilities: ProposalRefinementCapabilities;
  store: ProposalRefinementStore<TProposal>;
  /**
   * Derive the persistence namespace from trusted handler context only. The
   * request is deliberately not provided, so buyer arguments cannot choose a
   * tenant or principal namespace.
   */
  scope: (context: TContext) => MaybePromise<ProposalRefinementScope>;
  /** Application-owned commercial policy. The SDK never chooses business terms. */
  evaluate: ProposalCommercialEvaluator<TProposal, TContext>;
  products?: (results: readonly ProposalRefinementResult<TProposal>[], context: TContext) => MaybePromise<TProduct[]>;
  now?: () => Date;
}

export type ProposalRefinementHandler<TProduct = Record<string, unknown>, TContext = unknown> = (
  request: RefineProposalsRequest,
  context: TContext
) => Promise<RefineProposalsCompletedResponse<CanonicalProposal, TProduct>>;

/**
 * Build a seller handler that preflights the entire batch, evaluates without
 * writes, verifies the complete response, and only then stages one atomic
 * transaction. A preflight/evaluation/verification failure performs no write.
 */
export function createProposalRefinementHandler<
  TProposal extends CanonicalProposal = CanonicalProposal,
  TProduct = Record<string, unknown>,
  TContext = unknown,
>(options: ProposalRefinementHandlerOptions<TProposal, TProduct, TContext>) {
  const capabilities = defineProposalRefinementCapabilities(options.capabilities);
  return async (
    request: RefineProposalsRequest,
    context: TContext
  ): Promise<RefineProposalsCompletedResponse<TProposal, TProduct>> => {
    try {
      validateRefineProposalsRequest(request, capabilities);
    } catch (error) {
      if (error instanceof ProposalRefinementValidationError) {
        throw new ProposalSellerPreflightError(error.code, error.field ?? 'refinements', error.message, error.details);
      }
      throw error;
    }

    // Application callbacks never receive the caller-owned object graph.
    // A deep immutable snapshot keeps concurrent evaluators and exact retry
    // semantics stable even if the transport or caller retains references.
    const requestSnapshot = deepFreeze(structuredClone(request));

    const scope = freezeScope(await options.scope(context));
    const loadedSnapshots = await Promise.all(
      requestSnapshot.refinements.map(entry => options.store.get(scope, entry.proposal_id))
    );
    const snapshots = loadedSnapshots.map(snapshot => (snapshot ? deepFreeze(structuredClone(snapshot)) : null));
    const sources = snapshots.map(snapshot => (snapshot ? deepFreeze(structuredClone(snapshot.proposal)) : null));
    const now = options.now?.() ?? new Date();
    preflightSourceStates(requestSnapshot.refinements, snapshots, safeDateTime(now));

    const evaluatedResults = await Promise.all(
      requestSnapshot.refinements.map((refinement, index) =>
        options.evaluate({ refinement, source: sources[index]!, index, request: requestSnapshot, context })
      )
    );
    const evaluatedProducts = options.products ? await options.products(evaluatedResults, context) : [];
    // Snapshot and freeze the canonical response before verification. The
    // transaction receives a separate frozen snapshot below, so a hostile or
    // mutation-prone storage adapter cannot alter the verified return value.
    const response = deepFreeze(
      structuredClone({
        status: 'completed' as const,
        results: evaluatedResults,
        products: evaluatedProducts,
      })
    ) as RefineProposalsCompletedResponse<TProposal, TProduct>;
    assertRefineProposalsResponse(requestSnapshot, response, { now });
    verifyFinalizePreservesSources(requestSnapshot.refinements, sources, response.results);

    const successors = response.results.flatMap(result => {
      if (result.outcome === 'revised' || result.outcome === 'partial') return result.proposals;
      if (result.outcome === 'finalized') return [result.proposal];
      return [];
    });
    if (successors.length === 0) return response;

    const expectedSources = requestSnapshot.refinements.map((refinement, index) => ({
      proposal_id: refinement.proposal_id,
      action: refinement.action,
      version: snapshots[index]?.version ?? null,
    }));
    const stagedSuccessors = deepFreeze(structuredClone(successors)) as readonly TProposal[];
    const transaction = await options.store.begin(scope, expectedSources);
    try {
      await transaction.stage(stagedSuccessors);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    return response;
  };
}

/**
 * Standard trusted-scope adapter for handlers registered with
 * `createAdcpServer`. It refuses anonymous or unscoped calls instead of
 * allowing buyer payload fields to select a persistence namespace.
 */
export function proposalRefinementScopeFromContext<TAccount>(
  context: HandlerContext<TAccount>
): ProposalRefinementScope {
  const scope = context.proposalRefinementScope;
  if (!scope) {
    throw new AdcpError('SERVICE_UNAVAILABLE', {
      message: 'Proposal refinement requires proposalNegotiation.resolveScope',
    });
  }
  return freezeScope(scope);
}

function freezeScope(scope: ProposalRefinementScope): Readonly<ProposalRefinementScope> {
  if (!scope?.tenant_id || !scope.principal_id) {
    throw new AdcpError('SERVICE_UNAVAILABLE', {
      message: 'Proposal refinement scope must include tenant_id and principal_id',
    });
  }
  return Object.freeze({ ...scope });
}

function verifyFinalizePreservesSources<TProposal extends CanonicalProposal>(
  refinements: readonly ProposalRefinement[],
  sources: readonly (TProposal | null)[],
  results: readonly ProposalRefinementResult<TProposal>[]
): void {
  for (const [index, refinement] of refinements.entries()) {
    if (refinement.action !== 'finalize') continue;
    const source = sources[index];
    const result = results[index];
    if (!source || result?.outcome !== 'finalized') continue;
    const successor = result.proposal;
    if (
      source.terms_digest !== proposalTermsDigest(source.commercial_terms) ||
      successor.terms_digest !== source.terms_digest ||
      proposalTermsDigest(successor.commercial_terms) !== source.terms_digest
    ) {
      throw new ProposalSellerPreflightError(
        'INVALID_STATE',
        `results[${index}].proposal.commercial_terms`,
        'finalize must preserve the source commercial terms and terms_digest'
      );
    }
  }
}

function preflightSourceStates<TProposal extends CanonicalProposal>(
  refinements: readonly ProposalRefinement[],
  snapshots: readonly (Readonly<ProposalSourceSnapshot<TProposal>> | null)[],
  nowMs: number
): void {
  for (const [index, refinement] of refinements.entries()) {
    const snapshot = snapshots[index];
    const source = snapshot?.proposal;
    if (!source) continue; // evaluator classifies this as source_unavailable
    if (refinement.action === 'finalize' && source.proposal_status !== 'draft') {
      throw new ProposalSellerPreflightError(
        'INVALID_STATE',
        `refinements[${index}].proposal_id`,
        'finalize must target a draft proposal'
      );
    }
    if (refinement.action === 'finalize' && snapshot.active_hold !== undefined) {
      const activeHold = snapshot.active_hold;
      const expiresAt = isStrictDateTime(activeHold.expires_at) ? Date.parse(activeHold.expires_at) : Number.NaN;
      if (!activeHold.proposal_id || !Number.isFinite(expiresAt)) {
        throw new ProposalSellerPreflightError(
          'INVALID_STATE',
          `refinements[${index}].proposal_id`,
          'source proposal has invalid active hold state'
        );
      }
      if (!Number.isFinite(nowMs)) {
        throw new ProposalSellerPreflightError(
          'INVALID_STATE',
          `refinements[${index}].proposal_id`,
          'source proposal hold cannot be checked because the current time is invalid'
        );
      }
      if (expiresAt > nowMs) {
        throw new ProposalSellerPreflightError(
          'INVALID_STATE',
          `refinements[${index}].proposal_id`,
          'source proposal already has an unexpired committed hold',
          { active_proposal_id: activeHold.proposal_id, expires_at: activeHold.expires_at }
        );
      }
    }
    if (
      refinement.action === 'revise' &&
      refinement.change_kind === 'cancellation' &&
      source.proposal_status !== 'accepted'
    ) {
      throw new ProposalSellerPreflightError(
        'INVALID_STATE',
        `refinements[${index}].change_kind`,
        'cancellation must fork an accepted proposal'
      );
    }
  }
}

function safeDateTime(value: unknown): number {
  try {
    return value instanceof Date ? value.getTime() : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

export class ProposalSellerPreflightError extends AdcpError {
  constructor(
    code: 'INVALID_STATE' | 'UNSUPPORTED_FEATURE' | 'VALIDATION_ERROR',
    field: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(code, { message, field, details });
  }
}

export type ProposalSuccessorInput<TTerms extends ProposalCommercialTerms = ProposalCommercialTerms> = Omit<
  CanonicalProposal<TTerms>,
  'parent_proposal_id' | 'terms_digest'
>;

/** Create an immutable, correctly linked successor without choosing its terms. */
export function createProposalSuccessor<TTerms extends ProposalCommercialTerms>(
  source: CanonicalProposal,
  successor: ProposalSuccessorInput<TTerms>
): CanonicalProposal<TTerms> {
  const result = structuredClone({
    ...successor,
    parent_proposal_id: source.proposal_id,
    terms_digest: proposalTermsDigest(successor.commercial_terms),
  }) as CanonicalProposal<TTerms>;
  return deepFreeze(result);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
