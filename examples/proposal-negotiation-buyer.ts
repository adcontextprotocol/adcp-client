#!/usr/bin/env tsx
/**
 * Run against an AdCP 3.2 seller/training-agent profile:
 *
 * ADCP_AGENT_URL=https://seller.example/mcp/ ADCP_AUTH_TOKEN=... \
 * ADCP_PROPOSAL_ID=proposal_123 npx tsx examples/proposal-negotiation-buyer.ts
 */
import {
  ADCPMultiAgentClient,
  ProposalNegotiator,
  extractProposalRefinementSupport,
  type CanonicalProposal,
} from '@adcp/sdk';

const agentUrl = process.env['ADCP_AGENT_URL'];
const sourceProposalId = process.env['ADCP_PROPOSAL_ID'];
if (!agentUrl || !sourceProposalId) {
  throw new Error('ADCP_AGENT_URL and ADCP_PROPOSAL_ID are required');
}

const client = ADCPMultiAgentClient.simple(agentUrl, {
  authToken: process.env['ADCP_AUTH_TOKEN'],
  protocol: 'mcp',
});
const agent = client.agent('default-agent');
const proposalSupport = extractProposalRefinementSupport(await agent.getCapabilities());
if (!proposalSupport.supported) {
  throw new Error('Seller does not advertise refine_proposals; use the documented get_products fallback');
}
if (!proposalSupport.capabilities) {
  throw new Error('Seller advertises refine_proposals without proposal_refinement capability details');
}

const negotiator = new ProposalNegotiator(
  request =>
    agent.refineProposals(request, undefined, {
      disableWebhook: true,
      proposalRefinementCapabilities: proposalSupport.capabilities,
    }),
  { capabilities: proposalSupport.capabilities, transportRetries: 1 }
);

const revised = await negotiator.execute({
  refinements: [
    {
      proposal_id: sourceProposalId,
      action: 'revise',
      constraints: { total_budget: { currency: 'USD', max: 50_000 } },
      alternatives: { count: 2 },
      ask: 'Prefer the strongest forecast while preserving the hard budget ceiling.',
    },
  ],
});

const selected = negotiator.selectCounteroffer(revised.response, proposals =>
  proposals.reduce((best, candidate) =>
    (candidate.commercial_terms.total_budget?.amount ?? Infinity) <
    (best.commercial_terms.total_budget?.amount ?? Infinity)
      ? candidate
      : best
  )
);
const held = await negotiator.finalize(selected.proposal_id);

const accepted = await negotiator.accept(held, async (proposal: CanonicalProposal) => {
  // accept_proposal is a 3.2 split-lifecycle tool. The cast disappears when
  // the generated SDK pin moves to the published 3.2 schema bundle.
  return agent.executeTask('accept_proposal' as never, { proposal_id: proposal.proposal_id } as never);
});

console.log(JSON.stringify({ selected: selected.proposal_id, held_until: held.expires_at, accepted }, null, 2));
