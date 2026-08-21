import type {
  CompatibleDeclineProposalsResponse,
  CompatibleProductsResponse,
  CompatibleRefineProposalsResponse,
  CompatibleRequestProposalsResponse,
  EstablishedProductsWireResponse,
  MediaBuyLifecycleCoordinator,
} from '../lib';

declare const products: CompatibleProductsResponse;
const productId: string | undefined = products.products?.[0]?.product_id;
const proposalFromDiscovery: string | undefined = products.proposals?.[0]?.proposal_id;
void productId;
void proposalFromDiscovery;
void products.raw.context;

declare const establishedProductsSource: EstablishedProductsWireResponse;
void establishedProductsSource.projection.diagnostics;

declare const requested: CompatibleRequestProposalsResponse;
const requestOutcome: 'proposed' | 'products_available' | 'rejected' | 'legacy_unavailable' = requested.outcome;
const requestedProposalId: string | undefined = requested.proposals?.[0]?.proposal_id;
void requestOutcome;
void requestedProposalId;
void requested.raw.context;

declare const refined: CompatibleRefineProposalsResponse;
for (const result of refined.results ?? []) {
  switch (result.outcome) {
    case 'revised':
    case 'partial': {
      const proposalId: string | undefined = result.proposals[0]?.proposal_id;
      const termsDigest: string | undefined = result.proposals[0]?.terms_digest;
      const parentProposalId: string | undefined = result.proposals[0]?.parent_proposal_id;
      void proposalId;
      void termsDigest;
      void parentProposalId;
      break;
    }
    case 'finalized': {
      const proposalId: string = result.proposal.proposal_id;
      const termsDigest: string = result.proposal.terms_digest;
      const parentProposalId: string = result.proposal.parent_proposal_id;
      void proposalId;
      void termsDigest;
      void parentProposalId;
      break;
    }
    case 'unable':
      void result.reason;
      break;
    default: {
      const exhaustive: never = result;
      void exhaustive;
    }
  }
}

declare const declined: CompatibleDeclineProposalsResponse;
for (const result of declined.results) {
  const proposalId: string = result.proposal_id;
  const outcome: 'declined' | 'unable' | 'unconfirmed' = result.outcome;
  void proposalId;
  void outcome;
  if (result.outcome === 'unable') {
    const reason: string = result.reason;
    void reason;
  }
}

declare const requestTask: Awaited<ReturnType<MediaBuyLifecycleCoordinator['requestProposals']>>;
if (requestTask.status === 'completed') {
  const operation: 'request' = requestTask.data.operation;
  const outcome: 'proposed' | 'products_available' | 'rejected' | 'legacy_unavailable' = requestTask.data.outcome;
  void operation;
  void outcome;
} else if (requestTask.data !== undefined) {
  // Intermediate and failure data is the honest seller wire payload, not a
  // completed compatibility projection with invented operation/outcome fields.
  void requestTask.data.status;
  // @ts-expect-error completed-only projection fields are unavailable here
  void requestTask.data.operation;
}

async function assertCompatibilityContinuations(
  task: Awaited<ReturnType<MediaBuyLifecycleCoordinator['requestProposals']>>
): Promise<void> {
  if (task.submitted) {
    const completed = await task.submitted.waitForCompletion();
    const compatibility = completed.compatibility.lifecycle;
    void compatibility;
    if (completed.status === 'completed') {
      const outcome: 'proposed' | 'products_available' | 'rejected' | 'legacy_unavailable' = completed.data.outcome;
      void outcome;
    }
  }
  if (task.deferred) {
    const completed = await task.deferred.resume({ approved: true });
    const compatibility = completed.compatibility.lifecycle;
    void compatibility;
    if (completed.status === 'completed') {
      const operation: 'request' = completed.data.operation;
      void operation;
    }
  }
}
void assertCompatibilityContinuations;
