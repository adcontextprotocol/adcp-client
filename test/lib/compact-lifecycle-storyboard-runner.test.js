const { test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const { AgentClient, serve } = require('../../dist/lib/index.js');
const { proposalTermsDigest } = require('../../dist/lib/negotiation/verification.js');
const { ADCP_CAPABILITIES, getSdkServer } = require('../../dist/lib/server/adcp-server.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { TOOL_INPUT_SHAPE, toMcpResponse } = require('../../dist/lib/server/test-controller.js');
const { getComplianceStoryboardById } = require('../../dist/lib/testing/storyboard/index.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

const ADCP_VERSION = '3.2.0-beta.11';
const ACCOUNT = {
  brand: { domain: 'acmeoutdoor.example' },
  operator: 'pinnacle-agency.example',
  sandbox: true,
};
const AVAILABLE_ACTIONS = [
  {
    task: 'control_media_buy',
    action: 'decrease_budget',
    mode: 'self_serve',
    change_term_id: 'change_decrease_budget',
  },
];
const PROPOSAL_ALLOWED_ACTIONS = [
  {
    action: 'increase_budget',
    modes: ['seller_managed'],
    allowed_statuses: ['active'],
    constraints: { kind: 'budget', max_delta_percent: 20 },
  },
];
const PRICING = {
  pricing_option_id: 'compact_video_cpm',
  pricing_model: 'cpm',
  currency: 'USD',
  fixed_price: 18,
};
const DIRECT_PRICING_VERSION = 'direct-pricing-v1';

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

function assertBeta3Envelope(request) {
  assert.equal(request.adcp_version, '3.2-beta.11');
  assert.equal(request.adcp_major_version, 3);
}

function commercialTerms(productId, pricingOptionId, sourceFeedVersion, sourcePricingVersion) {
  return {
    ...(sourceFeedVersion && { source_feed_version: sourceFeedVersion }),
    ...(sourcePricingVersion && { source_pricing_version: sourcePricingVersion }),
    brand: ACCOUNT.brand,
    purchases: [
      {
        product_id: productId,
        pricing_option_id: pricingOptionId,
        pricing: { ...PRICING, pricing_option_id: pricingOptionId },
        budget: 1000,
        start_time: '2099-09-01T00:00:00Z',
        end_time: '2099-09-30T23:59:59Z',
      },
    ],
    start_time: '2099-09-01T00:00:00Z',
    end_time: '2099-09-30T23:59:59Z',
    total_budget: { amount: 1000, currency: 'USD' },
    change_terms: [
      {
        term_id: 'change_decrease_budget',
        action: 'decrease_budget',
        service_mode: 'self_serve',
        constraints: { kind: 'budget', max_delta_percent: 50 },
      },
      {
        term_id: 'change_increase_budget',
        action: 'increase_budget',
        service_mode: 'seller_managed',
        allowed_statuses: ['active'],
        processing_sla: { response_max: 'PT30M', completion_max: 'PT24H' },
        constraints: { kind: 'budget', max_delta_percent: 20 },
        terms_ref: 'https://seller.example/terms/budget-increase',
      },
      {
        term_id: 'change_extend_flight',
        action: 'extend_flight',
        service_mode: 'seller_managed',
        constraints: { kind: 'flight', max_change: { interval: 7, unit: 'days' } },
      },
      {
        term_id: 'change_resume',
        action: 'resume',
        service_mode: 'self_serve',
        allowed_statuses: ['paused'],
      },
    ],
  };
}

function proposal({ id, status, terms, parentProposalId, mediaBuyId }) {
  return {
    proposal_id: id,
    proposal_kind: 'new_media_buy',
    proposal_status: status,
    name: `Compact lifecycle ${status} proposal`,
    commercial_terms: terms,
    terms_digest: proposalTermsDigest(terms),
    expires_at: '2099-08-31T23:59:59Z',
    ...(parentProposalId && { parent_proposal_id: parentProposalId }),
    ...(mediaBuyId && {
      media_buy_id: mediaBuyId,
      accepted_at: '2026-08-19T05:00:00Z',
    }),
  };
}

async function createLifecycleServer() {
  const calls = [];
  const state = {
    revision: 0,
    mediaBuyId: undefined,
    packageId: undefined,
    acceptedProposal: undefined,
    dailyBudgetCap: undefined,
    totalBudget: 1000,
    mediaBuyStatus: 'pending_creatives',
    proposalSequence: 0,
  };

  function record(method, request) {
    calls.push({ method, request: structuredClone(request) });
  }

  function commitment(mediaBuyId, acceptedProposal) {
    state.mediaBuyId = mediaBuyId;
    state.packageId = `${mediaBuyId}-package`;
    state.acceptedProposal = acceptedProposal;
    state.revision = 1;
    state.mediaBuyStatus = 'pending_creatives';
    return {
      status: 'completed',
      media_buy_id: mediaBuyId,
      revision: state.revision,
      media_buy_status: 'pending_creatives',
      accepted_proposal: acceptedProposal,
      purchase_bindings: [
        {
          purchase_index: 0,
          product_id: acceptedProposal.commercial_terms.purchases[0].product_id,
          package_id: state.packageId,
        },
      ],
      available_actions: AVAILABLE_ACTIONS,
    };
  }

  const mediaBuy = {
    async listProducts(request) {
      record('listProducts', request);
      assertBeta3Envelope(request);
      const productId = request.criteria.product_ids[0];
      const direct = productId === 'compact_direct_buy_video';
      const pricingOptionId = direct ? 'compact_direct_video_cpm' : 'compact_video_cpm';
      return {
        outcome: 'listed',
        products: [
          {
            product_id: productId,
            name: direct ? 'Compact direct-buy video' : 'Compact proposal video',
            pricing_options: [{ ...PRICING, pricing_option_id: pricingOptionId }],
            allowed_actions: direct ? [{ action: 'decrease_budget', modes: ['self_serve'] }] : PROPOSAL_ALLOWED_ACTIONS,
          },
        ],
        feed_version: direct ? 'direct-feed-v1' : 'proposal-feed-v1',
        ...(direct && { pricing_version: DIRECT_PRICING_VERSION }),
        cache_scope: 'account',
      };
    },

    async requestProposals(request) {
      record('requestProposals', request);
      assertBeta3Envelope(request);
      const terms = commercialTerms(request.criteria.product_ids[0], 'compact_video_cpm');
      state.proposalSequence += 1;
      const proposalId = state.proposalSequence === 1 ? 'proposal-draft' : `proposal-draft-${state.proposalSequence}`;
      return {
        outcome: 'proposed',
        status: 'completed',
        proposals: [proposal({ id: proposalId, status: 'draft', terms })],
        products: [
          {
            product_id: 'compact_lifecycle_video',
            name: 'Compact proposal video',
            pricing_options: [PRICING],
          },
        ],
      };
    },

    async refineProposals(request) {
      record('refineProposals', request);
      assertBeta3Envelope(request);
      const terms = commercialTerms('compact_lifecycle_video', 'compact_video_cpm');
      return {
        status: 'completed',
        products: [
          {
            product_id: 'compact_lifecycle_video',
            name: 'Compact proposal video',
            pricing_options: [PRICING],
          },
        ],
        results: [
          {
            source_proposal_id: request.refinements[0].proposal_id,
            outcome: 'finalized',
            proposal: proposal({
              id: 'proposal-committed',
              status: 'committed',
              terms,
              parentProposalId: request.refinements[0].proposal_id,
            }),
          },
        ],
      };
    },

    async acceptProposal(request) {
      record('acceptProposal', request);
      assertBeta3Envelope(request);
      const terms = commercialTerms('compact_lifecycle_video', 'compact_video_cpm');
      const accepted = proposal({
        id: request.proposal_id,
        status: 'accepted',
        terms,
        parentProposalId: 'proposal-draft',
        mediaBuyId: 'proposal-media-buy',
      });
      assert.equal(request.proposal_terms_digest, accepted.terms_digest);
      return commitment('proposal-media-buy', accepted);
    },

    async declineProposals(request) {
      record('declineProposals', request);
      assertBeta3Envelope(request);
      return {
        results: request.declines.map(decline => ({ proposal_id: decline.proposal_id, outcome: 'declined' })),
      };
    },

    async buyProducts(request) {
      record('buyProducts', request);
      assertBeta3Envelope(request);
      assert.equal(request.feed_version, 'direct-feed-v1');
      assert.equal(request.pricing_version, DIRECT_PRICING_VERSION);
      const purchase = request.purchases[0];
      const terms = commercialTerms(
        purchase.product_id,
        purchase.pricing_option_id,
        request.feed_version,
        request.pricing_version
      );
      const accepted = proposal({
        id: 'direct-purchase-snapshot',
        status: 'accepted',
        terms,
        mediaBuyId: 'direct-media-buy',
      });
      return commitment('direct-media-buy', accepted);
    },

    async controlMediaBuy(request) {
      record('controlMediaBuy', request);
      assertBeta3Envelope(request);
      assert.equal(request.media_buy_id, state.mediaBuyId);
      assert.equal(request.revision, state.revision);
      state.revision += 1;
      if (request.daily_budget_cap !== undefined) state.dailyBudgetCap = request.daily_budget_cap;
      if (request.total_budget !== undefined) state.totalBudget = request.total_budget.amount;
      state.mediaBuyStatus =
        request.canceled === true
          ? 'canceled'
          : request.paused === true
            ? 'paused'
            : request.paused === false
              ? 'active'
              : state.mediaBuyStatus;
      return {
        status: 'completed',
        media_buy_id: state.mediaBuyId,
        revision: state.revision,
        media_buy_status: state.mediaBuyStatus,
        available_actions: AVAILABLE_ACTIONS,
      };
    },

    async getMediaBuys(request) {
      record('getMediaBuys', request);
      assertBeta3Envelope(request);
      assert.deepEqual(request.media_buy_ids, [state.mediaBuyId]);
      return {
        media_buys: [
          {
            media_buy_id: state.mediaBuyId,
            accepted_proposal_id: state.acceptedProposal.proposal_id,
            accepted_proposal_terms_digest: state.acceptedProposal.terms_digest,
            accepted_proposal: state.acceptedProposal,
            status: state.mediaBuyStatus,
            available_actions: AVAILABLE_ACTIONS,
            currency: 'USD',
            total_budget: state.totalBudget,
            daily_budget_cap: state.dailyBudgetCap,
            confirmed_at: '2026-08-19T05:00:00Z',
            revision: state.revision,
            packages: [
              {
                package_id: state.packageId,
                product_id: state.acceptedProposal.commercial_terms.purchases[0].product_id,
                budget: 1000,
              },
            ],
            history: [
              { revision: state.revision, timestamp: '2026-08-19T05:01:00Z', action: 'updated_budget' },
              { revision: 1, timestamp: '2026-08-19T05:00:00Z', action: 'created' },
            ],
          },
        ],
      };
    },
  };

  const adcpServer = createAdcpServer({
    name: 'Compact lifecycle wire seller',
    version: '1.0.0',
    adcpVersion: ADCP_VERSION,
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
    resolveIdempotencyPrincipal: () => 'compact-lifecycle-wire-buyer',
    stateStore: new InMemoryStateStore(),
    validation: { requests: 'strict', responses: 'strict' },
    mediaBuy,
    proposalNegotiation: {
      capabilities: { supported_dimensions: [] },
      resolveScope: () => ({ tenant_id: 'compact-lifecycle-seller', principal_id: 'compact-lifecycle-wire-buyer' }),
      refineProposals: mediaBuy.refineProposals,
    },
  });
  adcpServer[ADCP_CAPABILITIES].compliance_testing = {
    scenarios: ['compact_product_lifecycle_probe', 'compact_direct_buy_lifecycle_probe'],
  };
  const sdkServer = getSdkServer(adcpServer);
  assert.ok(sdkServer);
  sdkServer.registerTool(
    'comply_test_controller',
    {
      description: 'Deterministic compact lifecycle preparation for this wire regression.',
      inputSchema: {
        ...TOOL_INPUT_SHAPE,
        account: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async request => {
      record('complyTestController', request);
      return toMcpResponse({
        status: 'completed',
        success: true,
        simulated: { prepared: true, product_id: request.params.product_id },
      });
    }
  );

  const server = serve(() => adcpServer, {
    port: 0,
    authenticate: () => ({ principal: 'compact-lifecycle-wire-buyer' }),
    onListening: () => {},
  });
  await waitForListening(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { calls, server, url: `http://127.0.0.1:${address.port}/mcp` };
}

async function runLifecycle(id) {
  const storyboard = getComplianceStoryboardById(id);
  assert.ok(storyboard, `missing ${id}`);
  const { calls, server, url } = await createLifecycleServer();
  try {
    const result = await runStoryboard(url, storyboard, {
      protocol: 'mcp',
      allow_http: true,
      skip_controller_seeding: true,
      agentTools: [
        'comply_test_controller',
        'list_products',
        'request_proposals',
        'refine_proposals',
        'decline_proposals',
        'accept_proposal',
        'buy_products',
        'control_media_buy',
        'get_media_buys',
      ],
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result, null, 2));
    assert.equal(result.failed_count, 0, JSON.stringify(result, null, 2));
    assert.equal(result.skipped_count, 0, JSON.stringify(result, null, 2));
    return calls.map(call => call.method);
  } finally {
    await closeServer(server);
  }
}

test('public storyboard runner executes the complete compact proposal lifecycle over validated beta.3 MCP', async () => {
  assert.deepEqual(await runLifecycle('media_buy_seller/compact_product_lifecycle'), [
    'complyTestController',
    'listProducts',
    'requestProposals',
    'refineProposals',
    'acceptProposal',
    'controlMediaBuy',
    'getMediaBuys',
  ]);
});

test('public storyboard runner executes the complete compact direct-buy lifecycle over validated beta.3 MCP', async () => {
  assert.deepEqual(await runLifecycle('media_buy_seller/compact_direct_buy_lifecycle'), [
    'complyTestController',
    'listProducts',
    'buyProducts',
    'controlMediaBuy',
    'getMediaBuys',
  ]);
});

test('compact-first coordinator executes proposal outcomes and the full control matrix over validated beta.3 MCP', async () => {
  const { calls, server, url } = await createLifecycleServer();
  try {
    const buyer = new AgentClient(
      {
        id: 'compact-wire-release-gate',
        name: 'Compact wire release gate',
        agent_uri: url,
        protocol: 'mcp',
      },
      { adcpVersion: ADCP_VERSION, validation: { requests: 'strict', responses: 'strict' } }
    );
    const lifecycle = await buyer.negotiateMediaBuyLifecycle({ principalScope: 'compact-lifecycle-wire-buyer' });
    assert.equal(lifecycle.lifecycle, 'compact');

    const listed = await lifecycle.listProducts({
      account: ACCOUNT,
      criteria: { product_ids: ['compact_lifecycle_video'] },
    });
    assert.equal(listed.data.products[0].product_id, 'compact_lifecycle_video');

    const requestedForDecline = await lifecycle.requestProposals({
      idempotency_key: 'compact-wire-request-decline-0001',
      account: ACCOUNT,
      brief: 'Proposal to decline',
      criteria: { product_ids: ['compact_lifecycle_video'] },
    });
    assert.equal(requestedForDecline.success, true, JSON.stringify(requestedForDecline));
    assert.equal(requestedForDecline.status, 'completed', JSON.stringify(requestedForDecline));
    assert.equal(requestedForDecline.data.operation, 'request');
    assert.equal(requestedForDecline.data.outcome, 'proposed');
    const declined = await lifecycle.declineProposals({
      idempotency_key: 'compact-wire-decline-0001',
      declines: [{ proposal_id: requestedForDecline.data.proposals[0].proposal_id, reason: 'budget_changed' }],
    });
    assert.equal(declined.success, true, JSON.stringify(declined));
    assert.equal(declined.status, 'completed', JSON.stringify(declined));
    assert.equal(declined.data.operation, 'decline');
    assert.equal(declined.data.outcome, 'native_results');
    assert.equal(declined.data.results[0].outcome, 'declined');

    const requested = await lifecycle.requestProposals({
      idempotency_key: 'compact-wire-request-accept-0001',
      account: ACCOUNT,
      brief: 'Proposal to accept',
      criteria: { product_ids: ['compact_lifecycle_video'] },
    });
    assert.equal(requested.success, true, JSON.stringify(requested));
    assert.equal(requested.status, 'completed', JSON.stringify(requested));
    const finalized = await lifecycle.refineProposals({
      idempotency_key: 'compact-wire-finalize-0001',
      refinements: [{ proposal_id: requested.data.proposals[0].proposal_id, action: 'finalize' }],
    });
    assert.equal(finalized.success, true, JSON.stringify(finalized));
    assert.equal(finalized.status, 'completed', JSON.stringify(finalized));
    assert.equal(finalized.data.operation, 'refine');
    assert.equal(finalized.data.outcome, 'native_results');
    assert.equal(finalized.data.results[0].outcome, 'finalized');
    assert.equal(finalized.data.results[0].proposal.proposal_id, 'proposal-committed');

    const accepted = await lifecycle.acceptProposal({
      idempotency_key: 'compact-wire-accept-0001',
      account: ACCOUNT,
      proposal_id: finalized.data.results[0].proposal.proposal_id,
      proposal_terms_digest: finalized.data.results[0].proposal.terms_digest,
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted));

    const controls = [
      { idempotency_key: 'compact-wire-pause-0001', revision: 1, paused: true },
      { idempotency_key: 'compact-wire-resume-0001', revision: 2, paused: false },
      { idempotency_key: 'compact-wire-budget-0001', revision: 3, daily_budget_cap: 100 },
      {
        idempotency_key: 'compact-wire-cancel-0001',
        revision: 4,
        canceled: true,
        cancellation_reason: 'buyer_request',
      },
    ];
    for (const control of controls) {
      const result = await lifecycle.controlMediaBuy({
        account: ACCOUNT,
        media_buy_id: 'proposal-media-buy',
        ...control,
      });
      assert.equal(result.success, true, JSON.stringify(result));
    }
    const readback = await lifecycle.getMediaBuys({
      account: ACCOUNT,
      media_buy_ids: ['proposal-media-buy'],
    });
    assert.equal(readback.data.media_buys[0].revision, 5);
    assert.equal(readback.data.media_buys[0].status, 'canceled');
    assert.equal(readback.data.media_buys[0].daily_budget_cap, 100);

    assert.ok(calls.some(call => call.method === 'declineProposals'));
    assert.equal(calls.filter(call => call.method === 'controlMediaBuy').length, 4);
  } finally {
    await closeServer(server);
  }
});
