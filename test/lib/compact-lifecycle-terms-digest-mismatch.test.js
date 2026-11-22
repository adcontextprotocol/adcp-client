const { test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const { serve } = require('../../dist/lib/index.js');
const { adcpError } = require('../../dist/lib/server/index.js');
const { proposalTermsDigest } = require('../../dist/lib/negotiation/verification.js');
const { ADCP_CAPABILITIES, getSdkServer } = require('../../dist/lib/server/adcp-server.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { TOOL_INPUT_SHAPE, toMcpResponse } = require('../../dist/lib/server/test-controller.js');
const { getComplianceStoryboardById } = require('../../dist/lib/testing/storyboard/index.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

const ADCP_VERSION = '3.3.0-rc.3';
const WIRE_VERSION = '3.3-rc.3';
const STORYBOARD_ID = 'media_buy_seller/compact_product_lifecycle';
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
  assert.equal(request.adcp_version, WIRE_VERSION);
  assert.equal(request.adcp_major_version, 3);
}

function commercialTerms(productId, pricingOptionId) {
  return {
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

async function createLifecycleServer({ staleDigestRefusal }) {
  const calls = [];
  const state = {
    revision: 0,
    mediaBuyId: undefined,
    packageId: undefined,
    acceptedProposal: undefined,
    dailyBudgetCap: undefined,
    totalBudget: 1000,
    mediaBuyStatus: 'pending_creatives',
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
      return {
        outcome: 'listed',
        products: [
          {
            product_id: request.criteria.product_ids[0],
            name: 'Compact proposal video',
            pricing_options: [PRICING],
            allowed_actions: PROPOSAL_ALLOWED_ACTIONS,
          },
        ],
        feed_version: 'proposal-feed-v1',
        cache_scope: 'account',
      };
    },

    async requestProposals(request) {
      record('requestProposals', request);
      assertBeta3Envelope(request);
      const terms = commercialTerms(request.criteria.product_ids[0], 'compact_video_cpm');
      return {
        outcome: 'proposed',
        status: 'completed',
        proposals: [proposal({ id: 'proposal-draft', status: 'draft', terms })],
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
      if (request.proposal_terms_digest !== accepted.terms_digest) {
        return staleDigestRefusal === 'canonical'
          ? adcpError('PROPOSAL_TERMS_CHANGED', {
              message: 'proposal_terms_digest does not match the proposal terms',
              recovery: 'correctable',
              field: 'proposal_terms_digest',
            })
          : adcpError('INVALID_REQUEST', {
              message: 'proposal_terms_digest does not match the proposal terms',
              recovery: 'correctable',
            });
      }
      return commitment('proposal-media-buy', accepted);
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
    resolveAccount: ref => (ref ? { account_id: ref.account_id ?? JSON.stringify(ref), status: 'active' } : undefined),
    name: 'Compact lifecycle wire seller',
    version: '1.0.0',
    adcpVersion: WIRE_VERSION,
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
    scenarios: ['compact_product_lifecycle_probe'],
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

async function runStaleDigest(staleDigestRefusal) {
  const storyboard = getComplianceStoryboardById(STORYBOARD_ID, { version: ADCP_VERSION });
  assert.ok(storyboard, `missing ${STORYBOARD_ID}`);
  const { calls, server, url } = await createLifecycleServer({ staleDigestRefusal });
  try {
    const result = await runStoryboard(url, storyboard, {
      protocol: 'mcp',
      adcpVersion: WIRE_VERSION,
      allow_http: true,
      skip_controller_seeding: true,
      agentTools: [
        'comply_test_controller',
        'list_products',
        'request_proposals',
        'refine_proposals',
        'accept_proposal',
        'control_media_buy',
        'get_media_buys',
      ],
    });
    const step = result.phases
      .flatMap(phase => phase.steps)
      .find(candidate => candidate.step_id === 'accept_with_stale_digest');
    assert.ok(step, 'stale-digest step missing from the run result');
    const phase = result.phases.find(candidate => candidate.steps.includes(step));
    assert.equal(phase.phase_id, 'terms_digest_mismatch');
    return { result, step, calls };
  } finally {
    await closeServer(server);
  }
}

const advisoryFailures = step => step.validations.filter(v => v.severity === 'advisory' && !v.passed);

function assertRealAcceptanceSucceeded(result, calls) {
  assert.equal(result.overall_passed, true, JSON.stringify(result, null, 2));
  assert.equal(result.failed_count, 0, JSON.stringify(result, null, 2));
  const accepts = calls.filter(call => call.method === 'acceptProposal');
  assert.equal(accepts.length, 2, 'accept handler runs for the stale digest and again for the real one');
  assert.notEqual(accepts[0].request.proposal_terms_digest, accepts[1].request.proposal_terms_digest);
  assert.equal(accepts[0].request.proposal_id, accepts[1].request.proposal_id);
  const acceptStep = result.phases
    .flatMap(phase => phase.steps)
    .find(candidate => candidate.step_id === 'accept_product_proposal');
  assert.ok(acceptStep?.passed, 'real acceptance step passed');
}

test('rc.3 stale-digest phase: PROPOSAL_TERMS_CHANGED refusal passes with no advisory findings', async () => {
  const { result, step, calls } = await runStaleDigest('canonical');
  assert.equal(step.passed, true, JSON.stringify(step, null, 2));
  assert.deepEqual(advisoryFailures(step), []);
  const errorCode = step.validations.find(v => v.check === 'error_code');
  assert.ok(errorCode && errorCode.passed && errorCode.severity === 'advisory');
  assert.equal(step.validations.filter(v => v.severity === 'advisory').length, 5);
  assertRealAcceptanceSucceeded(result, calls);
});

test('rc.3 stale-digest phase: a different refusal code still passes the step but fails the error_code advisory', async () => {
  const { result, step, calls } = await runStaleDigest('other');
  assert.equal(step.passed, true, JSON.stringify(step, null, 2));
  const failed = advisoryFailures(step);
  assert.deepEqual(
    failed.map(v => v.check),
    ['error_code']
  );
  assert.equal(failed[0].severity, 'advisory');
  assert.ok((result.validations_advisory_failed ?? 0) >= 1);
  // correctable recovery is present and right; absent field is not reported.
  const fieldChecks = step.validations.filter(v => v.check === 'field_value_or_absent');
  assert.equal(fieldChecks.length, 4);
  assert.ok(fieldChecks.every(v => v.passed));
  assertRealAcceptanceSucceeded(result, calls);
});
