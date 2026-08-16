import type { TaskResult } from '../core/ConversationTypes';
import { buildRefineProposalsRequest, unwrapVerifiedRefineProposals } from './buyer';
import { isStrictDateTime } from './verification';
import type {
  CanonicalProposal,
  ProposalRefinement,
  ProposalRefinementCapabilities,
  RefineProposalsCompletedResponse,
  RefineProposalsInput,
  RefineProposalsRequest,
  RefineProposalsResponse,
} from './types';

export type RefineProposalsTransport = (
  request: RefineProposalsRequest
) => Promise<TaskResult<RefineProposalsResponse>>;

export interface ProposalNegotiatorOptions {
  capabilities?: ProposalRefinementCapabilities;
  transportRetries?: number;
  now?: () => Date;
}

/** Buyer orchestration for retry, counteroffer selection, hold, and acceptance. */
export class ProposalNegotiator {
  private readonly capabilities?: ProposalRefinementCapabilities;
  private readonly transportRetries: number;
  private readonly now: () => Date;

  constructor(
    private readonly transport: RefineProposalsTransport,
    options: ProposalNegotiatorOptions = {}
  ) {
    this.capabilities = options.capabilities;
    this.transportRetries = options.transportRetries ?? 1;
    this.now = options.now ?? (() => new Date());
  }

  /** A transport retry reuses the exact request object and idempotency key. */
  async execute(input: RefineProposalsInput): Promise<{
    request: RefineProposalsRequest;
    response: RefineProposalsCompletedResponse;
    task: TaskResult<RefineProposalsResponse>;
  }> {
    const request = buildRefineProposalsRequest(input, this.capabilities);
    let task: TaskResult<RefineProposalsResponse> | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.transportRetries; attempt++) {
      try {
        task = await this.transport(request);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!task) throw lastError;
    return { request, response: unwrapVerifiedRefineProposals(task, request), task };
  }

  /** A changed commercial intent always receives a fresh idempotency key. */
  changedRequest(previous: RefineProposalsRequest, refinements: ProposalRefinement[]): RefineProposalsRequest {
    const { idempotency_key: _oldKey, refinements: _oldRefinements, ...envelope } = previous;
    return buildRefineProposalsRequest({ ...envelope, refinements }, this.capabilities);
  }

  selectCounteroffer(
    response: RefineProposalsCompletedResponse,
    select: (proposals: readonly CanonicalProposal[]) => CanonicalProposal
  ): CanonicalProposal {
    const proposals = response.results.flatMap(result =>
      result.outcome === 'revised' || result.outcome === 'partial' ? result.proposals : []
    );
    if (proposals.length === 0) throw new Error('refine_proposals returned no selectable counteroffer');
    const selected = select(proposals);
    const canonical = selected && proposals.find(proposal => proposal.proposal_id === selected.proposal_id);
    if (!canonical) {
      throw new Error('counteroffer selector returned a proposal outside the verified response');
    }
    // Return the verified object, never a selector-authored clone that merely
    // copied a valid proposal_id and changed the commercial terms.
    return canonical;
  }

  async finalize(proposalId: string): Promise<CanonicalProposal> {
    const { response } = await this.execute({ refinements: [{ proposal_id: proposalId, action: 'finalize' }] });
    const finalized = response.results[0];
    if (!finalized || finalized.outcome !== 'finalized') {
      const reason = finalized && finalized.outcome === 'unable' ? `: ${finalized.reason_code}` : '';
      throw new Error(`seller could not finalize proposal${reason}`);
    }
    this.assertLiveHold(finalized.proposal);
    return finalized.proposal;
  }

  async accept<T>(proposal: CanonicalProposal, accept: (proposal: CanonicalProposal) => Promise<T>): Promise<T> {
    this.assertLiveHold(proposal);
    return accept(proposal);
  }

  private assertLiveHold(proposal: CanonicalProposal): void {
    if (proposal.proposal_status !== 'committed') throw new Error('only a committed proposal can be accepted');
    const expiry = isStrictDateTime(proposal.expires_at) ? Date.parse(proposal.expires_at) : Number.NaN;
    let nowMs = Number.NaN;
    try {
      const now = this.now();
      nowMs = now instanceof Date ? now.getTime() : Number.NaN;
    } catch {
      // A broken clock dependency cannot authorize consumption of a hold.
    }
    if (!Number.isFinite(nowMs)) {
      throw new Error('proposal inventory hold cannot be verified because the current time is invalid');
    }
    if (!Number.isFinite(expiry) || expiry <= nowMs) {
      throw new Error('proposal inventory hold has expired; revise/finalize again before acceptance');
    }
  }
}
