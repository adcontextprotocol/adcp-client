const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner');
const { proposalTermsDigest } = require('../../dist/lib/negotiation/verification.js');

const baseStoryboard = {
  id: 'compact_context_regression',
  version: '1.0.0',
  title: 'Compact context regression',
  category: 'test',
  summary: '',
  narrative: '',
  agent: { interaction_model: '*', capabilities: [] },
  caller: { role: 'buyer_agent' },
};

function options(client, profile, context, contextProvenance) {
  return {
    protocol: 'mcp',
    allow_http: true,
    agentTools: profile.tools.map(tool => tool.name),
    _client: client,
    _profile: profile,
    ...(context && { context }),
    ...(contextProvenance && { context_provenance: contextProvenance }),
  };
}

describe('compact lifecycle convention context', () => {
  test('runner atomically replaces a product snapshot across stateless steps', async () => {
    const responses = [
      {
        outcome: 'listed',
        products: [
          {
            product_id: 'prod_a',
            name: 'Product A',
            pricing_options: [{ pricing_option_id: 'price_a', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }],
          },
        ],
        feed_version: 'feed_a',
        pricing_version: 'pricing_a',
        cache_scope: 'public',
      },
      {
        outcome: 'listed',
        products: [{ product_id: 'prod_b', name: 'Product B' }],
        feed_version: 'feed_b',
        cache_scope: 'public',
      },
      { outcome: 'unchanged', feed_version: 'feed_b', cache_scope: 'public' },
    ];
    const requests = [];
    const client = {
      getAgentInfo: async () => profile,
      listProducts: async request => {
        requests.push(request);
        return { success: true, data: responses.shift() };
      },
    };
    const profile = { name: 'stub', tools: [{ name: 'list_products' }] };
    const storyboard = {
      ...baseStoryboard,
      phases: [
        {
          id: 'products',
          title: 'Products',
          steps: [
            { id: 'list_a', title: 'List A', task: 'list_products', sample_request: {} },
            { id: 'list_b', title: 'List B', task: 'list_products', sample_request: {} },
            { id: 'unchanged', title: 'Unchanged', task: 'list_products', sample_request: {} },
          ],
        },
      ],
    };

    const first = await runStoryboardStep('https://stub.example/mcp', storyboard, 'list_a', options(client, profile));
    const second = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard,
      'list_b',
      options(client, profile, first.context, first.context_provenance)
    );
    const unchanged = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard,
      'unchanged',
      options(client, profile, second.context, second.context_provenance)
    );

    assert.equal(first.passed, true);
    assert.equal(second.passed, true);
    assert.deepStrictEqual(second.context, { product_id: 'prod_b', feed_version: 'feed_b' });
    assert.deepStrictEqual(unchanged.context, second.context, 'unchanged response preserves the selected snapshot');
    assert.equal(second.context_provenance.product_id.source_step_id, 'list_b');
    assert.equal(second.context_provenance.pricing_option_id, undefined);
    assert.equal(requests.length, 3, 'typed public listProducts wrapper executed for every step');
  });

  test('runner removes proposal aliases after a successful decline', async () => {
    const commercialTerms = {
      brand: { domain: 'example.com' },
      purchases: [
        {
          product_id: 'prod_1',
          pricing_option_id: 'price_1',
          pricing: { pricing_option_id: 'price_1', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 },
          start_time: '2026-09-01T00:00:00Z',
          end_time: '2026-10-01T00:00:00Z',
        },
      ],
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-10-01T00:00:00Z',
    };
    const proposal = {
      proposal_id: 'proposal_1',
      proposal_kind: 'new_media_buy',
      proposal_status: 'draft',
      expires_at: '2026-08-30T00:00:00Z',
      name: 'Draft campaign',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const declineResponses = [
      { results: [{ proposal_id: 'proposal_other', outcome: 'declined' }] },
      { results: [{ proposal_id: proposal.proposal_id, outcome: 'unable', reason: 'Already processing' }] },
      { results: [{ proposal_id: proposal.proposal_id, outcome: 'declined' }] },
    ];
    const client = {
      getAgentInfo: async () => profile,
      requestProposals: async () => ({
        success: true,
        data: {
          outcome: 'proposed',
          products: [{ product_id: 'prod_1', name: 'Homepage display' }],
          proposals: [proposal],
        },
      }),
      refineProposals: async () => ({
        success: true,
        data: {
          products: [{ product_id: 'prod_1', name: 'Homepage display' }],
          results: [
            {
              source_proposal_id: proposal.proposal_id,
              outcome: 'unable',
              reason_code: 'source_unavailable',
              reason: 'Budget cannot be reduced',
            },
          ],
        },
      }),
      declineProposals: async () => ({
        success: true,
        data: declineResponses.shift(),
      }),
    };
    const profile = {
      name: 'stub',
      tools: [{ name: 'request_proposals' }, { name: 'refine_proposals' }, { name: 'decline_proposals' }],
    };
    const storyboard = {
      ...baseStoryboard,
      phases: [
        {
          id: 'proposals',
          title: 'Proposals',
          steps: [
            {
              id: 'request',
              title: 'Request',
              task: 'request_proposals',
              sample_request: { idempotency_key: 'request-1', brief: 'Homepage campaign' },
            },
            {
              id: 'refine_unable',
              title: 'Unable to refine',
              task: 'refine_proposals',
              sample_request: {
                idempotency_key: 'refine-1',
                refinements: [{ proposal_id: '$context.proposal_id', action: 'revise', ask: 'Reduce the budget' }],
              },
            },
            {
              id: 'decline_other',
              title: 'Decline another proposal',
              task: 'decline_proposals',
              sample_request: {
                idempotency_key: 'decline-other',
                declines: [{ proposal_id: 'proposal_other', reason: 'other', detail: 'Campaign changed' }],
              },
            },
            {
              id: 'decline_unable',
              title: 'Unable to decline',
              task: 'decline_proposals',
              sample_request: {
                idempotency_key: 'decline-unable',
                declines: [{ proposal_id: '$context.proposal_id', reason: 'other', detail: 'Campaign changed' }],
              },
            },
            {
              id: 'decline',
              title: 'Decline',
              task: 'decline_proposals',
              sample_request: {
                idempotency_key: 'decline-1',
                declines: [{ proposal_id: '$context.proposal_id', reason: 'other', detail: 'Campaign changed' }],
              },
            },
          ],
        },
      ],
    };

    const first = await runStoryboardStep('https://stub.example/mcp', storyboard, 'request', options(client, profile));
    const second = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard,
      'refine_unable',
      options(client, profile, first.context, first.context_provenance)
    );
    const third = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard,
      'decline_other',
      options(client, profile, second.context, second.context_provenance)
    );
    const fourth = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard,
      'decline_unable',
      options(client, profile, third.context, third.context_provenance)
    );
    const fifth = await runStoryboardStep(
      'https://stub.example/mcp',
      storyboard,
      'decline',
      options(client, profile, fourth.context, fourth.context_provenance)
    );

    assert.equal(first.context.proposal_id, proposal.proposal_id);
    assert.deepStrictEqual(second.context, first.context, 'unable refinement preserves the source proposal');
    assert.deepStrictEqual(third.context, first.context, 'declining a different proposal preserves the selected one');
    assert.deepStrictEqual(fourth.context, first.context, 'unable decline preserves the selected proposal');
    assert.deepStrictEqual(fifth.context, {});
    assert.equal(fifth.context_provenance, undefined);
  });
});
