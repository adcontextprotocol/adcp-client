const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  AgentClient,
  MediaBuyLifecycleCompatibilityError,
  createInMemoryLegacyPurchaseContinuationStore,
  proposalTermsDigest,
} = require('../../dist/lib/index.js');
const { normalizeGetProductsResponse } = require('../../dist/lib/utils/pricing-adapter.js');

const PRODUCTS_ONLY_BRIEF_VECTORS = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      '../../compliance/cache/3.2.0-beta.4/test-vectors/products-only-brief-compatibility/vectors.json'
    ),
    'utf8'
  )
);

const AGENT = {
  id: 'compat-seller',
  name: 'Compatibility seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

function capabilities({ version = '3.2.0-beta.4', tools, discoveredTools, replayTtlSeconds = 3600 } = {}) {
  if (version === '2.5') {
    return {
      version: 'v2',
      majorVersions: [2],
      protocols: ['media_buy'],
      features: {},
      extensions: [],
      _synthetic: true,
    };
  }
  return {
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [version],
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    idempotency: { replayTtlSeconds },
    mediaBuyLifecycleTools: tools,
    discoveredTools,
    _synthetic: false,
  };
}

function completed(taskName, data) {
  return {
    success: true,
    status: 'completed',
    data,
    metadata: {
      taskId: `${taskName}-task`,
      taskName,
      agent: { id: AGENT.id, name: AGENT.name, protocol: AGENT.protocol },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'completed',
    },
  };
}

function legacyListedProduct(product_id, name, extra = {}) {
  return {
    product_id,
    name,
    pricing_options: [
      {
        pricing_option_id: 'fixed-cpm',
        pricing_model: 'cpm',
        currency: 'USD',
        fixed_price: 10,
      },
    ],
    ...extra,
  };
}

function working(taskName) {
  return {
    success: true,
    status: 'working',
    data: { task_id: `${taskName}-task` },
    metadata: {
      taskId: `${taskName}-task`,
      taskName,
      agent: { id: AGENT.id, name: AGENT.name, protocol: AGENT.protocol },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'working',
    },
  };
}

function failed(taskName) {
  return {
    success: false,
    status: 'failed',
    error: { code: 'seller_failed', message: 'Seller rejected the request' },
    metadata: {
      taskId: `${taskName}-task`,
      taskName,
      agent: { id: AGENT.id, name: AGENT.name, protocol: AGENT.protocol },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'failed',
    },
  };
}

function submitted(taskName, terminal) {
  return {
    success: true,
    status: 'submitted',
    metadata: {
      taskId: `${taskName}-task`,
      taskName,
      agent: { id: AGENT.id, name: AGENT.name, protocol: AGENT.protocol },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'submitted',
    },
    submitted: {
      taskId: `${taskName}-task`,
      track: async () => ({
        taskId: `${taskName}-task`,
        status: terminal.status,
        taskType: taskName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: terminal.data,
      }),
      waitForCompletion: async () => terminal,
    },
  };
}

function deferred(taskName, resume) {
  return {
    success: true,
    status: 'deferred',
    metadata: {
      taskId: `${taskName}-task`,
      taskName,
      agent: { id: AGENT.id, name: AGENT.name, protocol: AGENT.protocol },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'deferred',
    },
    deferred: { resume },
  };
}

function clientWithCaps(caps, adcpVersion) {
  const agent = new AgentClient(AGENT, { validateFeatures: false, ...(adcpVersion && { adcpVersion }) });
  agent.getCapabilities = async () => caps;
  agent.createMediaBuyLegacyWithPreDispatch = async (params, beforeDispatch, inputHandler, options) => {
    const decision = await beforeDispatch(params, { governanceAdjusted: false });
    return decision.action === 'return' ? decision.result : agent.createMediaBuyLegacy(params, inputHandler, options);
  };
  return agent;
}

const COMPACT_TOOLS = [
  'list_products',
  'request_proposals',
  'refine_proposals',
  'decline_proposals',
  'buy_products',
  'accept_proposal',
  'control_media_buy',
];

function proposalMutationRequest(operation, proposalId, idempotencyKey, suffix = '') {
  return operation === 'refinement'
    ? {
        idempotency_key: idempotencyKey,
        refinements: [{ proposal_id: proposalId, action: 'revise', ask: `Keep terms${suffix}` }],
      }
    : {
        idempotency_key: idempotencyKey,
        declines: [{ proposal_id: proposalId, reason: 'other', detail: `No longer needed${suffix}` }],
      };
}

function completedProposalMutation(operation, proposalId) {
  const tool = operation === 'refinement' ? 'refine_proposals' : 'decline_proposals';
  return operation === 'refinement'
    ? completed(tool, {
        products: [],
        results: [
          {
            source_proposal_id: proposalId,
            outcome: 'unable',
            reason_code: 'commercially_declined',
            reason: 'The original proposal remains available.',
          },
        ],
      })
    : completed(tool, { results: [{ proposal_id: proposalId, outcome: 'declined' }] });
}

function seedProposalSnapshot(coordinator, proposal, account = { account_id: 'account-1' }) {
  coordinator.rememberProposals({ proposals: [proposal] }, coordinator.accountScope(account));
}

describe('MediaBuyLifecycleCoordinator negotiation matrix', () => {
  for (const lane of [
    { name: 'v2.5 legacy', caps: capabilities({ version: '2.5' }), expected: 'established' },
    { name: '3.0 legacy', caps: capabilities({ version: '3.0' }), expected: 'established' },
    { name: '3.1 legacy', caps: capabilities({ version: '3.1' }), expected: 'established' },
    {
      name: '3.2 legacy-only',
      caps: capabilities({ discoveredTools: ['get_products'] }),
      expected: 'established',
    },
    {
      name: '3.2 dual-surface',
      caps: capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products'] }),
      expected: 'compact',
    },
    { name: '3.2 compact-only', caps: capabilities({ tools: COMPACT_TOOLS }), expected: 'compact' },
  ]) {
    test(`${lane.name} selects ${lane.expected} product discovery`, async () => {
      const agent = clientWithCaps(lane.caps);
      const calls = [];
      agent.listProducts = async request => {
        calls.push(['list_products', request]);
        return completed('list_products', { products: [{ product_id: 'p1' }], feed_version: 'feed-compact' });
      };
      agent.getProducts = async request => {
        calls.push(['get_products', request]);
        return completed('get_products', {
          products: [{ product_id: 'p1' }],
          wholesale_feed_version: 'feed-established',
          cache_scope: 'public',
        });
      };

      const coordinator = await agent.negotiateMediaBuyLifecycle();
      const isV25 = lane.name === 'v2.5 legacy';
      const result = await coordinator.listProducts(isV25 ? {} : { max_results: 5 });

      assert.equal(coordinator.lifecycle, lane.expected);
      assert.equal(result.compatibility.lifecycle, lane.expected);
      assert.deepEqual(result.compatibility.tools_used, [
        lane.expected === 'compact' ? 'list_products' : 'get_products',
      ]);
      assert.equal(result.data.feed_version, lane.expected === 'compact' ? 'feed-compact' : 'feed-established');
      assert.equal(calls.length, 1);
      if (lane.expected === 'established') {
        assert.equal(calls[0][1].buying_mode, 'wholesale');
        assert.deepEqual(calls[0][1].pagination, isV25 ? undefined : { max_results: 5 });
      }
    });
  }

  test('out-of-range seller replay declarations fail negotiation with a defined error', async () => {
    for (const replayTtlSeconds of [3599, 604801, 3600.5]) {
      const agent = clientWithCaps(capabilities({ version: '3.1', replayTtlSeconds }));
      await assert.rejects(
        agent.negotiateMediaBuyLifecycle(),
        error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'adcp.idempotency.replay_ttl_seconds'
      );
    }
  });

  test('partial compact 3.2 surfaces never fall through to unadvertised established tools', async () => {
    const noDiscovery = clientWithCaps(capabilities({ tools: ['buy_products'] }));
    await assert.rejects(noDiscovery.negotiateMediaBuyLifecycle(), error => {
      assert.ok(error instanceof MediaBuyLifecycleCompatibilityError);
      assert.equal(error.feature, 'lifecycle_tool_not_advertised');
      assert.equal(error.operation, 'list_products');
      return true;
    });

    const agent = clientWithCaps(capabilities({ tools: ['list_products'] }));
    let dispatches = 0;
    for (const method of [
      'getProducts',
      'createMediaBuy',
      'updateMediaBuy',
      'requestProposals',
      'refineProposals',
      'declineProposals',
      'buyProducts',
      'acceptProposal',
      'controlMediaBuy',
      'getMediaBuys',
      'getMediaBuyDelivery',
    ]) {
      agent[method] = async () => {
        dispatches += 1;
        return completed(method, {});
      };
    }
    agent.listProducts = async () => completed('list_products', { outcome: 'listed', products: [] });
    const coordinator = await agent.negotiateMediaBuyLifecycle();
    const operations = [
      ['request_proposals', () => coordinator.requestProposals({ brief: 'test' })],
      [
        'refine_proposals',
        () => coordinator.refineProposals({ refinements: [{ proposal_id: 'proposal-1', action: 'finalize' }] }),
      ],
      [
        'decline_proposals',
        () => coordinator.declineProposals({ declines: [{ proposal_id: 'proposal-1', reason: 'other' }] }),
      ],
      ['buy_products', () => coordinator.buyProducts({})],
      [
        'accept_proposal',
        () =>
          coordinator.acceptProposal({
            account: { account_id: 'account-1' },
            proposal_id: 'proposal-1',
            proposal_terms_digest: `sha256:${'A'.repeat(43)}`,
          }),
      ],
      [
        'control_media_buy',
        () =>
          coordinator.controlMediaBuy({
            account: { account_id: 'account-1' },
            media_buy_id: 'media-buy-1',
            revision: 1,
            paused: true,
          }),
      ],
      ['get_media_buys', () => coordinator.getMediaBuys({ account: { account_id: 'account-1' } })],
      [
        'get_media_buy_delivery',
        () =>
          coordinator.getMediaBuyDelivery({
            account: { account_id: 'account-1' },
            media_buy_ids: ['media-buy-1'],
            start_date: '2027-01-01',
            end_date: '2027-01-02',
          }),
      ],
    ];
    for (const [operation, invoke] of operations) {
      await assert.rejects(invoke(), error => {
        assert.ok(error instanceof MediaBuyLifecycleCompatibilityError);
        assert.equal(error.feature, 'lifecycle_tool_not_advertised');
        assert.equal(error.operation, operation);
        return true;
      });
    }
    assert.equal(dispatches, 0);
  });

  test('established list projection preserves seller pagination defaults and explicit limits', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const requests = [];
    agent.getProducts = async value => {
      requests.push(value);
      return completed('get_products', { products: [] });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    await coordinator.listProducts({});
    await coordinator.listProducts({ max_results: 25 });

    assert.equal(requests[0].pagination, undefined);
    assert.deepEqual(requests[1].pagination, { max_results: 25 });
  });

  test('malformed native proposal completions fail instead of fabricating a legacy outcome', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    agent.requestProposals = async () => completed('request_proposals', { proposals: [], products: [] });
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    await assert.rejects(
      coordinator.requestProposals({ brief: 'Reach readers' }),
      /request_proposals returned a malformed compact completion/
    );
  });

  const proposalPricing = {
    pricing_option_id: 'proposal-validation-price',
    pricing_model: 'cpm',
    currency: 'USD',
    fixed_price: 10,
  };
  const proposalValidationTerms = {
    brand: { domain: 'example.com' },
    start_time: '2027-01-01T00:00:00Z',
    end_time: '2027-02-01T00:00:00Z',
    purchases: [
      {
        product_id: 'proposal-validation-product',
        pricing_option_id: proposalPricing.pricing_option_id,
        pricing: proposalPricing,
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    ],
  };
  const validDraftProposal = {
    proposal_id: 'proposal-validation-draft',
    proposal_kind: 'new_media_buy',
    proposal_status: 'draft',
    name: 'Proposal validation draft',
    expires_at: '2099-12-31T23:59:59Z',
    commercial_terms: proposalValidationTerms,
    terms_digest: proposalTermsDigest(proposalValidationTerms),
  };
  const validProposalProduct = {
    product_id: 'proposal-validation-product',
    name: 'Proposal validation product',
    pricing_options: [proposalPricing],
  };

  test('compact proposal validation strips only the SDK-synthesized message annotation', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    let response = {
      outcome: 'proposed',
      proposals: [validDraftProposal],
      products: [validProposalProduct],
      _message: 'SDK text-part summary',
    };
    agent.requestProposals = async () => completed('request_proposals', response);
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    const accepted = await coordinator.requestProposals({ brief: 'Reach readers' });
    assert.equal(accepted.data.outcome, 'proposed');
    assert.equal(Object.hasOwn(accepted.data.raw, '_message'), false);

    response = { ...response, _seller_annotation: 'must remain seller-controlled' };
    await assert.rejects(
      coordinator.requestProposals({ brief: 'Reach readers' }),
      /undeclared fields _seller_annotation/
    );
  });

  for (const [name, response] of [
    ['proposed without proposals', { outcome: 'proposed', products: [validProposalProduct] }],
    ['proposed without products', { outcome: 'proposed', proposals: [validDraftProposal] }],
    [
      'proposed with rejection fields',
      {
        outcome: 'proposed',
        proposals: [validDraftProposal],
        products: [validProposalProduct],
        reason: 'wrong branch',
      },
    ],
    [
      'proposed with rejection suggestions',
      {
        outcome: 'proposed',
        proposals: [validDraftProposal],
        products: [validProposalProduct],
        suggestions: ['wrong branch'],
      },
    ],
    ['rejected without reason', { outcome: 'rejected' }],
    ['rejected with proposals', { outcome: 'rejected', reason: 'No match', proposals: [validDraftProposal] }],
    ['rejected with products', { outcome: 'rejected', reason: 'No match', products: [validProposalProduct] }],
    ['rejected with a submitted task ID', { outcome: 'rejected', reason: 'No match', task_id: 'task-1' }],
    ['a submitted arm inside a completed SDK result', { status: 'submitted', task_id: 'task-1' }],
  ]) {
    test(`compact proposal completion rejects ${name} even when client response validation is disabled`, async () => {
      const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
      agent.requestProposals = async () => completed('request_proposals', response);
      const coordinator = await agent.negotiateMediaBuyLifecycle();

      await assert.rejects(
        coordinator.requestProposals({ brief: 'Reach readers' }),
        /request_proposals returned a malformed compact completion/
      );
    });
  }

  for (const operation of ['refine', 'decline']) {
    test(`compact ${operation} validates the response root before following proposal containers`, async () => {
      const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
      const response =
        operation === 'refine'
          ? {
              products: [],
              results: [
                {
                  source_proposal_id: 'root-validation-proposal',
                  outcome: 'unable',
                  reason_code: 'commercially_declined',
                  reason: 'No change was applied.',
                },
              ],
            }
          : { results: [{ proposal_id: 'root-validation-proposal', outcome: 'declined' }] };
      response.proposals = {};
      let cursor = response.proposals;
      for (let index = 0; index < 4100; index += 1) {
        cursor.proposals = {};
        cursor = cursor.proposals;
      }
      if (operation === 'refine') agent.refineProposals = async () => completed('refine_proposals', response);
      else agent.declineProposals = async () => completed('decline_proposals', response);
      const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: `root-first-${operation}` });

      const invocation =
        operation === 'refine'
          ? coordinator.refineProposals({
              refinements: [{ proposal_id: 'root-validation-proposal', action: 'revise', ask: 'Change it' }],
            })
          : coordinator.declineProposals({
              declines: [{ proposal_id: 'root-validation-proposal', reason: 'other' }],
            });
      await assert.rejects(invocation, error => {
        assert.doesNotMatch(error.message, /bounded traversal limit/);
        return true;
      });
      coordinator.dispose();
    });
  }

  test('legacy proposal traversal is cycle-safe and bounded', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const cyclic = {};
    cyclic.proposals = [cyclic];
    let response = cyclic;
    agent.getProducts = async () => completed('get_products', response);
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    const projected = await coordinator.requestProposals({ brief: 'Cycle-safe traversal' });
    assert.equal(projected.data.outcome, 'legacy_unavailable');

    response = {};
    let cursor = response;
    for (let index = 0; index < 4100; index += 1) {
      cursor.proposals = {};
      cursor = cursor.proposals;
    }
    await assert.rejects(
      coordinator.requestProposals({ brief: 'Bounded traversal' }),
      /proposal response exceeded the bounded traversal limit/
    );
    coordinator.dispose();
  });

  for (const delivery of ['immediate', 'task-update']) {
    test(`${delivery} malformed same-ID compact proposal evidence revokes an older executable snapshot`, async () => {
      const proposalId = `malformed-replacement-${delivery}`;
      const committedProposal = {
        ...validDraftProposal,
        proposal_id: proposalId,
        proposal_status: 'committed',
      };
      const listeners = new Set();
      const agent = clientWithCaps(
        capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
      );
      agent.onTaskUpdate = listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      agent.getProducts = async () => completed('get_products', { proposals: [committedProposal] });
      const malformed = {
        outcome: 'proposed',
        proposals: [{ proposal_id: proposalId }],
        products: [validProposalProduct],
      };
      agent.requestProposals = async () =>
        delivery === 'immediate' ? completed('request_proposals', malformed) : working('request_proposals');
      let mutations = 0;
      agent.createMediaBuy = async () => {
        mutations += 1;
        return completed('create_media_buy', { media_buy_id: 'must-not-be-created' });
      };
      const principalScope = `malformed-replacement-${delivery}`;
      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      await established.requestProposals({ brief: 'Valid source', account: { account_id: 'account-1' } });
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });

      if (delivery === 'immediate') {
        await assert.rejects(
          compact.requestProposals({ brief: 'Malformed replacement', account: { account_id: 'account-1' } }),
          /malformed compact completion/
        );
      } else {
        await compact.requestProposals({ brief: 'Malformed replacement', account: { account_id: 'account-1' } });
        for (const listener of [...listeners]) {
          listener({
            taskId: 'request_proposals-task',
            taskType: 'request_proposals',
            status: 'completed',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            result: malformed,
          });
        }
      }

      await assert.rejects(
        established.acceptProposal({
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: committedProposal.terms_digest,
        }),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
      );
      assert.equal(mutations, 0);
      compact.dispose();
      established.dispose();
    });
  }

  test('current 3.2 prerelease preserves native compact BrandRef countries', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    let request;
    agent.listProducts = async value => {
      request = value;
      return completed('list_products', { products: [] });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    await coordinator.listProducts({ brand: { domain: 'example.com', countries: ['US'] } });

    assert.deepEqual(request.brand, { domain: 'example.com', countries: ['US'] });
  });

  test('compact and established product pages expose the same cursor and unchanged view', async () => {
    const compactAgent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    compactAgent.listProducts = async () =>
      completed('list_products', { next_cursor: 'cursor-2', outcome: 'unchanged' });
    const establishedAgent = clientWithCaps(capabilities({ version: '3.1' }));
    establishedAgent.getProducts = async () =>
      completed('get_products', { pagination: { cursor: 'cursor-2', has_more: true }, unchanged: true });

    const compact = await (await compactAgent.negotiateMediaBuyLifecycle()).listProducts({});
    const established = await (await establishedAgent.negotiateMediaBuyLifecycle()).listProducts({});

    for (const result of [compact, established]) {
      assert.equal(result.data.next_cursor, 'cursor-2');
      assert.equal(result.data.unchanged, true);
    }
  });

  test('projection preserves absent product and proposal collections instead of inventing empty arrays', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async request =>
      completed(
        'get_products',
        request.buying_mode === 'wholesale'
          ? { unchanged: true, cache_scope: 'public' }
          : { context: { correlation_id: 'no-proposals' } }
      );
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-1' });

    const products = await coordinator.listProducts({});
    const proposals = await coordinator.requestProposals({
      idempotency_key: 'proposal-request-key-no-results',
      brief: 'No matching inventory',
    });

    assert.equal(Object.hasOwn(products.data, 'products'), false);
    assert.equal(products.data.unchanged, true);
    assert.equal(Object.hasOwn(proposals.data, 'proposals'), false);
    assert.equal(proposals.data.operation, 'request');
    assert.equal(proposals.data.outcome, 'legacy_unavailable');
    assert.deepEqual(proposals.data.context, { correlation_id: 'no-proposals' });
  });

  test('proposal compatibility responses preserve native and projected outcome discriminants', async () => {
    const canonicalChild = overrides => ({
      proposal_id: 'proposal-child',
      proposal_kind: 'new_media_buy',
      parent_proposal_id: 'proposal-1',
      proposal_status: 'draft',
      name: 'Revised proposal',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        purchases: [
          {
            product_id: 'product-1',
            pricing_option_id: 'pricing-1',
            start_time: '2027-01-01T00:00:00Z',
            end_time: '2027-02-01T00:00:00Z',
            pricing: {
              pricing_option_id: 'pricing-1',
              pricing_model: 'cpm',
              currency: 'USD',
              fixed_price: 5,
            },
          },
        ],
      },
      terms_digest: `sha256:${'A'.repeat(43)}`,
      ...overrides,
    });
    const compactAgent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    compactAgent.refineProposals = async () =>
      completed('refine_proposals', {
        status: 'completed',
        products: [],
        results: [
          {
            source_proposal_id: 'proposal-1',
            outcome: 'unable',
            reason_code: 'commercially_declined',
            reason: 'Inventory cannot satisfy the requested constraint.',
          },
        ],
      });
    compactAgent.declineProposals = async () =>
      completed('decline_proposals', { results: [{ proposal_id: 'proposal-2', outcome: 'declined' }] });
    const compact = await compactAgent.negotiateMediaBuyLifecycle();

    const refined = await compact.refineProposals({
      refinements: [{ proposal_id: 'proposal-1', action: 'revise', ask: 'lower price' }],
    });
    assert.equal(refined.data.operation, 'refine');
    assert.equal(refined.data.outcome, 'native_results');
    assert.equal(refined.data.results[0].outcome, 'unable');
    assert.equal(refined.data.results[0].reason_code, 'commercially_declined');
    assert.equal(refined.data.results[0].reason, 'Inventory cannot satisfy the requested constraint.');

    compactAgent.refineProposals = async () =>
      completed('refine_proposals', {
        products: [],
        results: [
          {
            source_proposal_id: 'proposal-20',
            outcome: 'unable',
            reason_code: 'commercially_declined',
            reason: 'second',
          },
          {
            source_proposal_id: 'proposal-10',
            outcome: 'unable',
            reason_code: 'commercially_declined',
            reason: 'first',
          },
        ],
      });
    await assert.rejects(
      compact.refineProposals({
        refinements: [
          { proposal_id: 'proposal-10', action: 'revise', ask: 'first' },
          { proposal_id: 'proposal-20', action: 'revise', ask: 'second' },
        ],
      }),
      error => /results must preserve source request order/.test(error.message)
    );

    compactAgent.refineProposals = async () =>
      completed('refine_proposals', {
        products: [],
        results: [
          {
            source_proposal_id: 'proposal-3',
            outcome: 'revised',
            proposals: [canonicalChild({ parent_proposal_id: 'different-parent' })],
          },
        ],
      });
    await assert.rejects(
      compact.refineProposals({ refinements: [{ proposal_id: 'proposal-3', action: 'revise', ask: 'first' }] }),
      error => /parent_proposal_id/.test(error.message)
    );

    compactAgent.refineProposals = async () =>
      completed('refine_proposals', {
        products: [],
        results: [
          {
            source_proposal_id: 'proposal-4',
            outcome: 'revised',
            proposals: [{ proposal_id: 'proposal-child', parent_proposal_id: 'proposal-4' }],
          },
        ],
      });
    await assert.rejects(
      compact.refineProposals({ refinements: [{ proposal_id: 'proposal-4', action: 'revise', ask: 'first' }] }),
      error => /refine_proposals response failed verification/.test(error.message)
    );

    compactAgent.refineProposals = async () =>
      completed('refine_proposals', {
        products: [],
        results: [
          {
            source_proposal_id: 'proposal-5',
            outcome: 'revised',
            proposals: [
              canonicalChild({
                parent_proposal_id: 'proposal-5',
                proposal_status: 'committed',
                expires_at: '2099-12-31T23:59:59Z',
              }),
            ],
          },
        ],
      });
    await assert.rejects(
      compact.refineProposals({ refinements: [{ proposal_id: 'proposal-5', action: 'revise', ask: 'first' }] }),
      error => /proposal_status/.test(error.message)
    );

    const declined = await compact.declineProposals({
      declines: [{ proposal_id: 'proposal-2', reason: 'other' }],
    });
    assert.equal(declined.data.operation, 'decline');
    assert.equal(declined.data.outcome, 'native_results');
    assert.deepEqual(declined.data.results, [{ proposal_id: 'proposal-2', outcome: 'declined' }]);

    compactAgent.declineProposals = async () => completed('decline_proposals', { results: [{ outcome: 'declined' }] });
    await assert.rejects(
      compact.declineProposals({ declines: [{ proposal_id: 'proposal-2', reason: 'other' }] }),
      /malformed compact completion/
    );

    compactAgent.declineProposals = async () =>
      completed('decline_proposals', { results: [{ proposal_id: 0, outcome: 'unable', reason: 'Invalid ID' }] });
    await assert.rejects(
      compact.declineProposals({ declines: [{ proposal_id: 'proposal-40', reason: 'other' }] }),
      error => error instanceof TypeError && /malformed compact completion/.test(error.message)
    );

    compactAgent.declineProposals = async () =>
      completed('decline_proposals', {
        results: [
          { proposal_id: 'proposal-60', outcome: 'declined' },
          { proposal_id: 'proposal-50', outcome: 'declined' },
        ],
      });
    await assert.rejects(
      compact.declineProposals({
        declines: [
          { proposal_id: 'proposal-50', reason: 'other' },
          { proposal_id: 'proposal-60', reason: 'other' },
        ],
      }),
      error => error instanceof TypeError && /different proposal/.test(error.message)
    );

    compactAgent.declineProposals = async () =>
      completed('decline_proposals', {
        results: [
          { proposal_id: 'proposal-70', outcome: 'declined' },
          { proposal_id: 'proposal-80', outcome: 'declined' },
        ],
      });
    await assert.rejects(
      compact.declineProposals({ declines: [{ proposal_id: 'proposal-70', reason: 'other' }] }),
      error => error instanceof TypeError && /different result count/.test(error.message)
    );

    const legacyAgent = clientWithCaps(capabilities({ version: '3.1' }));
    legacyAgent.getProducts = async () => completed('get_products', { proposals: [] });
    const legacy = await legacyAgent.negotiateMediaBuyLifecycle({
      allowedLosses: ['proposal_decline_not_terminal', 'proposal_decline_reason_not_forwarded'],
    });
    const projectedDecline = await legacy.declineProposals({
      declines: [{ proposal_id: 'legacy-proposal-1', reason: 'budget_changed' }],
    });
    assert.equal(projectedDecline.data.operation, 'decline');
    assert.equal(projectedDecline.data.outcome, 'legacy_unconfirmed');
    assert.deepEqual(projectedDecline.data.results, [{ proposal_id: 'legacy-proposal-1', outcome: 'unconfirmed' }]);
  });

  test('decline outcomes revoke only locally terminal proposal snapshots across lifecycle lanes', async () => {
    for (const scenario of [
      { name: 'compact confirmed decline', lifecycle: 'compact', outcome: 'declined', accepts: false },
      { name: 'compact unable decline', lifecycle: 'compact', outcome: 'unable', accepts: true },
      { name: 'established unconfirmed omit', lifecycle: 'established', outcome: 'unconfirmed', accepts: false },
    ]) {
      const proposalId = `cross-lane-${scenario.lifecycle}-${scenario.outcome}`;
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const agent = clientWithCaps(
        capabilities({
          tools: COMPACT_TOOLS,
          discoveredTools: ['get_products', 'create_media_buy', 'update_media_buy'],
        })
      );
      agent.requestProposals = async () =>
        completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
      agent.declineProposals = async () =>
        completed('decline_proposals', {
          results: [
            {
              proposal_id: proposalId,
              outcome: scenario.outcome,
              ...(scenario.outcome === 'unable' && { reason: 'Seller could not apply the decline.' }),
            },
          ],
        });
      let refinementDispatches = 0;
      agent.refineProposals = async () => {
        refinementDispatches += 1;
        return completed('refine_proposals', { products: [], results: [] });
      };
      agent.getProducts = async request => {
        if (request.buying_mode === 'refine') refinementDispatches += 1;
        return completed('get_products', { products: [], proposals: [] });
      };
      let mutations = 0;
      agent.createMediaBuy = async () => {
        mutations += 1;
        return completed('create_media_buy', { media_buy_id: 'cross-lane-media-buy', revision: 1 });
      };
      const principalScope = `buyer-${scenario.lifecycle}-${scenario.outcome}`;
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
      seedProposalSnapshot(compact, proposal);
      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: [
          'proposal_terms_digest_not_enforced',
          'proposal_decline_not_terminal',
          'proposal_decline_reason_not_forwarded',
        ],
      });
      if (scenario.lifecycle === 'compact') {
        await compact.declineProposals({
          idempotency_key: `decline-${scenario.lifecycle}-${scenario.outcome}-0001`,
          declines: [{ proposal_id: proposalId, reason: 'other' }],
        });
      } else {
        await established.declineProposals({
          idempotency_key: `decline-${scenario.lifecycle}-${scenario.outcome}-0001`,
          declines: [{ proposal_id: proposalId, reason: 'other' }],
        });
      }
      const refinementDispatchesAfterDecline = refinementDispatches;
      const accept = () =>
        established.acceptProposal({
          idempotency_key: `accept-${scenario.lifecycle}-${scenario.outcome}-0001`,
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: proposal.terms_digest,
        });
      if (scenario.accepts) {
        const accepted = await accept();
        assert.equal(accepted.success, true, scenario.name);
      } else {
        await assert.rejects(
          accept(),
          error =>
            error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
        );
        for (const refine of [
          () =>
            compact.refineProposals({
              idempotency_key: `compact-refine-terminal-${scenario.lifecycle}-${scenario.outcome}-0001`,
              refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Already terminal' }],
            }),
          () =>
            established.refineProposals({
              idempotency_key: `established-refine-terminal-${scenario.lifecycle}-${scenario.outcome}-0001`,
              refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Already terminal' }],
            }),
        ]) {
          await assert.rejects(
            refine(),
            error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_terminal'
          );
        }
      }
      assert.equal(mutations, scenario.accepts ? 1 : 0, scenario.name);
      assert.equal(refinementDispatches, refinementDispatchesAfterDecline, scenario.name);
    }
  });

  test('unscoped native terminal fences and task updates remain fail-closed', async () => {
    const immediateId = 'unscoped-terminal-immediate';
    const asyncId = 'unscoped-terminal-task-update';
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    const listeners = new Set();
    agent.onTaskUpdate = listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    let declineMode = 'immediate';
    agent.declineProposals = async () =>
      declineMode === 'immediate'
        ? completed('decline_proposals', { results: [{ proposal_id: immediateId, outcome: 'declined' }] })
        : working('decline_proposals');
    let competingDispatches = 0;
    agent.acceptProposal = agent.refineProposals = async () => {
      competingDispatches += 1;
      return completed('unexpected_competing_mutation', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    await coordinator.declineProposals({
      idempotency_key: 'unscoped-terminal-decline-immediate-0001',
      declines: [{ proposal_id: immediateId, reason: 'other' }],
    });
    declineMode = 'working';
    assert.equal(
      (
        await coordinator.declineProposals({
          idempotency_key: 'unscoped-terminal-decline-update-0001',
          declines: [{ proposal_id: asyncId, reason: 'other' }],
        })
      ).status,
      'working'
    );
    assert.equal(listeners.size > 0, true);
    for (const listener of [...listeners]) {
      listener({
        taskId: 'decline_proposals-task',
        taskType: 'decline_proposals',
        status: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: { results: [{ proposal_id: asyncId, outcome: 'declined' }] },
      });
    }
    assert.equal(coordinator.proposalSnapshotStore.pendingDeclines.size, 0);

    for (const proposalId of [immediateId, asyncId]) {
      await assert.rejects(
        coordinator.acceptProposal({
          idempotency_key: `unscoped-terminal-accept-${proposalId}-0001`,
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: proposalTermsDigest({}),
        }),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_terminal'
      );
      await assert.rejects(
        coordinator.refineProposals({
          idempotency_key: `unscoped-terminal-refine-${proposalId}-0001`,
          refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Already declined' }],
        }),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_terminal'
      );
    }
    assert.equal(competingDispatches, 0);
    coordinator.dispose();
  });

  test('established acceptance waits for a shared pending decline and remains possible after unable', async () => {
    const proposalId = 'pending-decline-acceptance-proposal';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
    };
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const agent = clientWithCaps(
      capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
    );
    agent.requestProposals = async () => completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
    agent.declineProposals = async () =>
      submitted(
        'decline_proposals',
        completed('decline_proposals', {
          results: [{ proposal_id: proposalId, outcome: 'unable', reason: 'Proposal remains available.' }],
        })
      );
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: 'accepted-after-unable', revision: 1 });
    };

    const principalScope = 'buyer-pending-decline-acceptance';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    seedProposalSnapshot(compact, proposal);
    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    const decline = await compact.declineProposals({
      idempotency_key: 'pending-decline-decline-0001',
      declines: [{ proposal_id: proposalId, reason: 'other' }],
    });
    const accept = () =>
      established.acceptProposal({
        idempotency_key: 'pending-decline-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      });

    await assert.rejects(
      accept(),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_decline_pending'
    );
    assert.equal(mutations, 0, 'acceptance must fail before seller dispatch while decline is unresolved');

    const completedDecline = await decline.submitted.waitForCompletion();
    assert.deepEqual(completedDecline.data.results, [
      { proposal_id: proposalId, outcome: 'unable', reason: 'Proposal remains available.' },
    ]);
    const accepted = await accept();
    assert.equal(accepted.success, true);
    assert.equal(mutations, 1, 'an unable decline must not permanently revoke the proposal');
    compact.dispose();
    established.dispose();
  });

  test('decline cannot race a shared in-flight established acceptance', async () => {
    const proposalId = 'pending-acceptance-decline-proposal';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
    };
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const agent = clientWithCaps(
      capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
    );
    agent.requestProposals = async () => completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
    let resolveAcceptance;
    let markAcceptanceStarted;
    const acceptanceGate = new Promise(resolve => {
      resolveAcceptance = resolve;
    });
    const acceptanceStarted = new Promise(resolve => {
      markAcceptanceStarted = resolve;
    });
    let acceptanceDispatches = 0;
    agent.createMediaBuy = async () => {
      acceptanceDispatches += 1;
      markAcceptanceStarted();
      await acceptanceGate;
      return completed('create_media_buy', { media_buy_id: 'accepted-without-decline-race', revision: 1 });
    };
    let declineDispatches = 0;
    agent.declineProposals = async () => {
      declineDispatches += 1;
      return completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] });
    };

    const principalScope = 'buyer-pending-acceptance-decline';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    seedProposalSnapshot(compact, proposal);

    const acceptance = established.acceptProposal({
      idempotency_key: 'pending-acceptance-accept-0001',
      account: { account_id: 'account-1' },
      proposal_id: proposalId,
      proposal_terms_digest: proposal.terms_digest,
    });
    await acceptanceStarted;
    await assert.rejects(
      compact.declineProposals({
        idempotency_key: 'pending-acceptance-decline-0001',
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_pending'
    );
    assert.equal(acceptanceDispatches, 1);
    assert.equal(declineDispatches, 0, 'decline must fail before seller dispatch while acceptance is unresolved');

    resolveAcceptance();
    assert.equal((await acceptance).success, true);
    compact.dispose();
    established.dispose();
  });

  test('commit-uncertain acceptance blocks decline while preserving the exact idempotent retry', async () => {
    const proposalId = 'commit-uncertain-decline-proposal';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
    };
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const agent = clientWithCaps(
      capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
    );
    agent.requestProposals = async () => completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
    let acceptanceDispatches = 0;
    agent.createMediaBuy = async () => {
      acceptanceDispatches += 1;
      if (acceptanceDispatches === 1) throw new Error('transport outcome unknown');
      return completed('create_media_buy', { media_buy_id: 'idempotent-retry-buy', revision: 1 });
    };
    let declineDispatches = 0;
    agent.declineProposals = async () => {
      declineDispatches += 1;
      return completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] });
    };

    const principalScope = 'buyer-commit-uncertain-decline';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    seedProposalSnapshot(compact, proposal);
    const acceptance = {
      idempotency_key: 'commit-uncertain-accept-0001',
      account: { account_id: 'account-1' },
      proposal_id: proposalId,
      proposal_terms_digest: proposal.terms_digest,
    };

    await assert.rejects(established.acceptProposal(acceptance), /transport outcome unknown/);
    await assert.rejects(
      compact.declineProposals({
        idempotency_key: 'commit-uncertain-decline-0001',
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_commit_uncertain'
    );
    assert.equal(declineDispatches, 0, 'a different mutation must not follow an unknown create outcome');

    assert.equal((await established.acceptProposal(acceptance)).success, true);
    assert.equal(acceptanceDispatches, 2, 'only the exact idempotent create retry may reconcile the ambiguity');
    compact.dispose();
    established.dispose();
  });

  test('expired commit uncertainty still blocks decline until external reconciliation', async () => {
    const proposalId = 'expired-commit-uncertain-proposal';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
    };
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const agent = clientWithCaps(
      capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
    );
    agent.requestProposals = async () => completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
    agent.createMediaBuy = async () => {
      throw new Error('transport outcome remains unknown');
    };
    let declineDispatches = 0;
    agent.declineProposals = async () => {
      declineDispatches += 1;
      return completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] });
    };

    const principalScope = 'buyer-expired-commit-uncertain';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    established.idempotencyReplayTtlMs = 10;
    seedProposalSnapshot(compact, proposal);
    const acceptance = {
      idempotency_key: 'expired-uncertain-accept-0001',
      account: { account_id: 'account-1' },
      proposal_id: proposalId,
      proposal_terms_digest: proposal.terms_digest,
    };

    await assert.rejects(established.acceptProposal(acceptance), /transport outcome remains unknown/);
    const reservation = established.proposalSnapshotStore.proposalAcceptances.get(proposalId).reservation;
    const expiryTimer = established.acceptanceRetryExpiryTimers.get(reservation);
    clearTimeout(expiryTimer);
    established.acceptanceRetryExpiryTimers.delete(reservation);
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(
      established.acceptProposal(acceptance),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry_window'
    );
    await assert.rejects(
      compact.declineProposals({
        idempotency_key: 'expired-uncertain-decline-0001',
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_commit_uncertain'
    );
    assert.equal(declineDispatches, 0);
    compact.dispose();
    established.dispose();
  });

  test('transport ambiguity without replay support permanently fences competing proposal mutations', async () => {
    const proposalId = 'no-replay-commit-uncertain-proposal';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
    };
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const caps = capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] });
    delete caps.idempotency;
    const agent = clientWithCaps(caps);
    agent.requestProposals = async () => completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
    agent.createMediaBuy = async () => {
      throw new Error('unknown create outcome without replay support');
    };
    let competingDispatches = 0;
    agent.declineProposals =
      agent.refineProposals =
      agent.acceptProposal =
        async () => {
          competingDispatches += 1;
          return completed('unexpected_competing_mutation', {});
        };

    const principalScope = 'buyer-no-replay-commit-uncertain';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    seedProposalSnapshot(compact, proposal);
    await assert.rejects(
      established.acceptProposal({
        idempotency_key: 'no-replay-uncertain-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      }),
      /unknown create outcome without replay support/
    );

    const assertCommitUncertain = promise =>
      assert.rejects(
        promise,
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          error.feature === 'proposal_acceptance_commit_uncertain'
      );
    await assertCommitUncertain(
      compact.declineProposals({
        idempotency_key: 'no-replay-uncertain-decline-0001',
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      })
    );
    await assertCommitUncertain(
      compact.refineProposals({
        idempotency_key: 'no-replay-uncertain-refine-0001',
        refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Do not dispatch' }],
      })
    );
    await assertCommitUncertain(
      compact.acceptProposal({
        idempotency_key: 'no-replay-uncertain-compact-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      })
    );
    assert.equal(competingDispatches, 0);
    compact.dispose();
    established.dispose();
  });

  test('disposing an exactly retryable transport ambiguity preserves the fence for a fresh coordinator', async () => {
    const proposalId = 'retryable-transport-dispose-proposal';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
    };
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const agent = clientWithCaps(
      capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
    );
    agent.requestProposals = async () => completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
    let acceptanceDispatches = 0;
    agent.createMediaBuy = async () => {
      acceptanceDispatches += 1;
      if (acceptanceDispatches === 1) throw new Error('retryable transport outcome unknown');
      return completed('create_media_buy', { media_buy_id: 'retryable-dispose-reconciled', revision: 1 });
    };
    let competingDispatches = 0;
    agent.declineProposals =
      agent.refineProposals =
      agent.acceptProposal =
        async () => {
          competingDispatches += 1;
          return completed('unexpected_competing_mutation', {});
        };

    const principalScope = 'buyer-retryable-transport-dispose';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    seedProposalSnapshot(compact, proposal);
    await assert.rejects(
      established.acceptProposal({
        idempotency_key: 'retryable-dispose-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      }),
      /retryable transport outcome unknown/
    );
    compact.dispose();
    established.dispose();

    const fresh = await agent.negotiateMediaBuyLifecycle({ principalScope });
    const assertCommitUncertain = promise =>
      assert.rejects(
        promise,
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          error.feature === 'proposal_acceptance_commit_uncertain'
      );
    await assertCommitUncertain(
      fresh.declineProposals({
        idempotency_key: 'retryable-dispose-decline-0001',
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      })
    );
    await assertCommitUncertain(
      fresh.refineProposals({
        idempotency_key: 'retryable-dispose-refine-0001',
        refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Do not dispatch' }],
      })
    );
    await assertCommitUncertain(
      fresh.acceptProposal({
        idempotency_key: 'retryable-dispose-compact-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      })
    );
    assert.equal(competingDispatches, 0);
    const retry = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    assert.equal(
      (
        await retry.acceptProposal({
          idempotency_key: 'retryable-dispose-accept-0001',
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: proposal.terms_digest,
        })
      ).success,
      true
    );
    assert.equal(acceptanceDispatches, 2);
    fresh.dispose();
    retry.dispose();
  });

  for (const retirement of ['no-replay', 'replay-expiry', 'dispose']) {
    test(`paused acceptance ${retirement} permits terminal decline but fences compact accept and refine`, async () => {
      const proposalId = `paused-terminal-${retirement}-proposal`;
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const caps = capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] });
      if (retirement === 'no-replay') delete caps.idempotency;
      const agent = clientWithCaps(caps);
      agent.requestProposals = async () =>
        completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
      agent.createMediaBuy = async () => ({ ...working('create_media_buy'), status: 'input-required' });
      let compactAcceptDispatches = 0;
      let refineDispatches = 0;
      let declineDispatches = 0;
      agent.acceptProposal = async () => {
        compactAcceptDispatches += 1;
        return completed('accept_proposal', { proposal_id: proposalId, outcome: 'accepted' });
      };
      agent.refineProposals = async () => {
        refineDispatches += 1;
        return completed('refine_proposals', { outcome: 'refined', proposals: [] });
      };
      agent.declineProposals = async () => {
        declineDispatches += 1;
        return completed('decline_proposals', {
          results: [{ proposal_id: proposalId, outcome: 'declined' }],
        });
      };

      const principalScope = `buyer-paused-terminal-${retirement}`;
      const discovery = await agent.negotiateMediaBuyLifecycle({ principalScope });
      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      if (retirement === 'replay-expiry') established.idempotencyReplayTtlMs = 10;
      seedProposalSnapshot(discovery, proposal);
      assert.equal(
        (
          await established.acceptProposal({
            idempotency_key: `paused-terminal-${retirement}-accept-0001`,
            account: { account_id: 'account-1' },
            proposal_id: proposalId,
            proposal_terms_digest: proposal.terms_digest,
          })
        ).status,
        'input-required'
      );

      if (retirement === 'replay-expiry') {
        await new Promise(resolve => setTimeout(resolve, 30));
      } else if (retirement === 'dispose') {
        established.dispose();
      }
      discovery.dispose();

      const fresh = await agent.negotiateMediaBuyLifecycle({ principalScope });
      const assertTerminal = promise =>
        assert.rejects(
          promise,
          error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_terminal'
        );
      await assertTerminal(
        fresh.refineProposals({
          idempotency_key: `paused-terminal-${retirement}-refine-0001`,
          refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Do not dispatch' }],
        })
      );
      await assertTerminal(
        fresh.acceptProposal({
          idempotency_key: `paused-terminal-${retirement}-compact-accept-0001`,
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: proposal.terms_digest,
        })
      );
      assert.equal(
        (
          await fresh.declineProposals({
            idempotency_key: `paused-terminal-${retirement}-decline-0001`,
            declines: [{ proposal_id: proposalId, reason: 'other' }],
          })
        ).success,
        true
      );
      assert.equal(refineDispatches, 0);
      assert.equal(compactAcceptDispatches, 0);
      assert.equal(declineDispatches, 1);
      fresh.dispose();
      established.dispose();
    });
  }

  for (const retirement of ['watcher-expiry', 'dispose']) {
    test(`unresolved working acceptance ${retirement} preserves a cross-lifecycle commit-uncertain fence`, async () => {
      const proposalId = `working-acceptance-${retirement}-proposal`;
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const agent = clientWithCaps(
        capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
      );
      agent.requestProposals = async () =>
        completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
      let acceptanceDispatches = 0;
      agent.createMediaBuy = async () => {
        acceptanceDispatches += 1;
        return acceptanceDispatches === 1
          ? working('create_media_buy')
          : completed('create_media_buy', { media_buy_id: `mb-working-${retirement}-retry` });
      };
      let competingDispatches = 0;
      agent.declineProposals =
        agent.refineProposals =
        agent.acceptProposal =
          async () => {
            competingDispatches += 1;
            return completed('unexpected_competing_mutation', {});
          };

      const principalScope = `buyer-working-acceptance-${retirement}`;
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      const coordinatorClass = established.constructor;
      const originalTtl = coordinatorClass.PROPOSAL_TASK_WATCH_TTL_MS;
      if (retirement === 'watcher-expiry') coordinatorClass.PROPOSAL_TASK_WATCH_TTL_MS = 10;

      try {
        seedProposalSnapshot(compact, proposal);
        assert.equal(
          (
            await established.acceptProposal({
              idempotency_key: `working-${retirement}-accept-0001`,
              account: { account_id: 'account-1' },
              proposal_id: proposalId,
              proposal_terms_digest: proposal.terms_digest,
            })
          ).status,
          'working'
        );
        const firstReservation = established.proposalSnapshotStore.proposalAcceptances.get(proposalId).reservation;
        const replayDeadline = firstReservation.retryDeadlineMs;
        assert.equal(Object.getOwnPropertyDescriptor(firstReservation, 'retryDeadlineMs').writable, false);
        assert.equal(Reflect.set(firstReservation, 'retryDeadlineMs', replayDeadline + 60_000), false);
        if (retirement === 'watcher-expiry') {
          await new Promise(resolve => setTimeout(resolve, 30));
        } else {
          established.dispose();
        }

        const assertCommitUncertain = promise =>
          assert.rejects(
            promise,
            error =>
              error instanceof MediaBuyLifecycleCompatibilityError &&
              error.feature === 'proposal_acceptance_commit_uncertain'
          );
        await assertCommitUncertain(
          compact.declineProposals({
            idempotency_key: `working-${retirement}-decline-0001`,
            declines: [{ proposal_id: proposalId, reason: 'other' }],
          })
        );
        await assertCommitUncertain(
          compact.refineProposals({
            idempotency_key: `working-${retirement}-refine-0001`,
            refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Do not dispatch' }],
          })
        );
        await assertCommitUncertain(
          compact.acceptProposal({
            idempotency_key: `working-${retirement}-compact-accept-0001`,
            account: { account_id: 'account-1' },
            proposal_id: proposalId,
            proposal_terms_digest: proposal.terms_digest,
          })
        );
        assert.equal(competingDispatches, 0);
        const retry = await agent.negotiateMediaBuyLifecycle({
          principalScope,
          preferredLifecycle: 'established',
          allowedLosses: ['proposal_terms_digest_not_enforced'],
        });
        assert.equal(
          (
            await retry.acceptProposal({
              idempotency_key: `working-${retirement}-accept-0001`,
              account: { account_id: 'account-1' },
              proposal_id: proposalId,
              proposal_terms_digest: proposal.terms_digest,
            })
          ).status,
          'completed'
        );
        assert.equal(acceptanceDispatches, 2);
        retry.dispose();
      } finally {
        coordinatorClass.PROPOSAL_TASK_WATCH_TTL_MS = originalTtl;
        compact.dispose();
        established.dispose();
      }
    });
  }

  test('submitted refine completions enforce request semantics before caching executable proposals', async () => {
    const sourceProposalId = 'async-refine-source';
    const childProposalId = 'async-refine-invalid-finalized-child';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      purchases: [
        {
          product_id: 'product-1',
          pricing_option_id: 'pricing-1',
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
          budget: 1000,
          pricing: {
            pricing_option_id: 'pricing-1',
            pricing_model: 'cpm',
            currency: 'USD',
            fixed_price: 5,
          },
        },
      ],
    };
    const sourceProposal = {
      proposal_id: sourceProposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'draft',
      name: 'Source proposal',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const invalidFinalizedChild = {
      ...sourceProposal,
      proposal_id: childProposalId,
      parent_proposal_id: sourceProposalId,
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      name: 'Invalid finalize response to revise',
    };
    const agent = clientWithCaps(
      capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
    );
    agent.requestProposals = async () =>
      completed('request_proposals', { outcome: 'proposed', proposals: [sourceProposal] });
    agent.refineProposals = async () =>
      submitted(
        'refine_proposals',
        completed('refine_proposals', {
          products: [],
          results: [
            {
              source_proposal_id: sourceProposalId,
              outcome: 'finalized',
              proposal: invalidFinalizedChild,
            },
          ],
        })
      );
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: 'must-not-be-created', revision: 1 });
    };
    const principalScope = 'buyer-async-refine-semantic-gate';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    seedProposalSnapshot(compact, sourceProposal);
    const pending = await compact.refineProposals({
      idempotency_key: 'async-refine-semantic-refine-0001',
      refinements: [{ proposal_id: sourceProposalId, action: 'revise', ask: 'Change the plan' }],
    });
    await assert.rejects(pending.submitted.waitForCompletion(), /revise must not return finalized/);

    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await assert.rejects(
      established.acceptProposal({
        idempotency_key: 'async-refine-semantic-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: childProposalId,
        proposal_terms_digest: invalidFinalizedChild.terms_digest,
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    await assert.rejects(
      established.acceptProposal({
        idempotency_key: 'async-refine-semantic-source-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: sourceProposalId,
        proposal_terms_digest: sourceProposal.terms_digest,
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_refinement_pending'
    );
    assert.equal(mutations, 0);
    compact.dispose();
    established.dispose();
  });

  for (const completionMode of ['immediate', 'submitted']) {
    test(`an unable compact refinement preserves the immutable source proposal after ${completionMode} completion`, async () => {
      const proposalId = 'unable-refine-source-remains-executable';
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const agent = clientWithCaps(
        capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
      );
      agent.requestProposals = async () =>
        completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
      agent.refineProposals = async () => {
        const terminal = completed('refine_proposals', {
          products: [],
          results: [
            {
              source_proposal_id: proposalId,
              outcome: 'unable',
              reason_code: 'commercially_declined',
              reason: 'The requested change is unavailable.',
            },
          ],
        });
        return completionMode === 'submitted' ? submitted('refine_proposals', terminal) : terminal;
      };
      let mutations = 0;
      agent.createMediaBuy = async () => {
        mutations += 1;
        return completed('create_media_buy', { media_buy_id: 'source-proposal-buy', revision: 1 });
      };
      const principalScope = `buyer-unable-refine-source-${completionMode}`;
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
      seedProposalSnapshot(compact, proposal);
      const refinement = await compact.refineProposals({
        idempotency_key: `unable-refine-source-refine-${completionMode}-0001`,
        refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Unavailable change' }],
      });
      if (refinement.submitted) await refinement.submitted.waitForCompletion();

      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      const accepted = await established.acceptProposal({
        idempotency_key: `unable-refine-source-accept-${completionMode}-0001`,
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      });
      assert.equal(accepted.success, true);
      assert.equal(mutations, 1);
      compact.dispose();
      established.dispose();
    });
  }

  for (const path of ['immediate', 'tracked', 'polled', 'task-update']) {
    for (const terminalStatus of ['failed', 'governance-denied']) {
      test(`${path} authoritative ${terminalStatus} refinement restores the still-valid source proposal`, async () => {
        const proposalId = `authoritative-refine-${path}-${terminalStatus}`;
        const commercialTerms = {
          brand: { domain: 'example.com' },
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
          total_budget: { amount: 1000, currency: 'USD' },
        };
        const proposal = {
          proposal_id: proposalId,
          proposal_kind: 'new_media_buy',
          proposal_status: 'committed',
          expires_at: '2099-12-31T23:59:59Z',
          commercial_terms: commercialTerms,
          terms_digest: proposalTermsDigest(commercialTerms),
        };
        const listeners = new Set();
        const agent = clientWithCaps(
          capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
        );
        agent.onTaskUpdate = listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
        const terminal = {
          ...failed('refine_proposals'),
          status: terminalStatus,
          data: { proposal_id: proposalId },
          metadata: { ...failed('refine_proposals').metadata, status: terminalStatus },
        };
        agent.refineProposals = async () => {
          if (path === 'immediate') return terminal;
          if (path === 'task-update') return working('refine_proposals');
          return submitted('refine_proposals', terminal);
        };
        let mutations = 0;
        agent.createMediaBuy = async () => {
          mutations += 1;
          return completed('create_media_buy', { media_buy_id: `accepted-after-${terminalStatus}` });
        };
        const principalScope = `authoritative-refine-${path}-${terminalStatus}`;
        const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
        seedProposalSnapshot(compact, proposal);
        const refinement = await compact.refineProposals({
          idempotency_key: `authoritative-${path}-${terminalStatus}-refine-0001`,
          refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Change the plan' }],
        });
        if (path === 'tracked') await refinement.submitted.track();
        if (path === 'polled') await refinement.submitted.waitForCompletion();
        if (path === 'task-update') {
          for (const listener of [...listeners]) {
            listener({
              taskId: 'refine_proposals-task',
              taskType: 'refine_proposals',
              status: terminalStatus,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              result: { proposal_id: proposalId },
            });
          }
        }

        const established = await agent.negotiateMediaBuyLifecycle({
          principalScope,
          preferredLifecycle: 'established',
          allowedLosses: ['proposal_terms_digest_not_enforced'],
        });
        const accepted = await established.acceptProposal({
          idempotency_key: `authoritative-${path}-${terminalStatus}-accept-0001`,
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: proposal.terms_digest,
        });
        assert.equal(accepted.success, true);
        assert.equal(mutations, 1);
        compact.dispose();
        established.dispose();
      });
    }
  }

  test('an uncorrelated failed refinement continuation remains fail-closed', async () => {
    const proposalId = 'unknown-failed-refinement-proposal';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
    };
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const agent = clientWithCaps(
      capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
    );
    agent.refineProposals = async () => failed('unknown');
    let acceptDispatches = 0;
    agent.createMediaBuy = async () => {
      acceptDispatches += 1;
      return completed('create_media_buy', { media_buy_id: 'must-not-dispatch' });
    };
    const principalScope = 'unknown-failed-refinement';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    seedProposalSnapshot(compact, proposal);
    assert.equal(
      (
        await compact.refineProposals({
          idempotency_key: 'unknown-failed-refinement-key-0001',
          refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Ambiguous local failure' }],
        })
      ).status,
      'failed'
    );
    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await assert.rejects(
      established.acceptProposal({
        idempotency_key: 'unknown-failed-refinement-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_refinement_pending'
    );
    assert.equal(acceptDispatches, 0);
    compact.dispose();
    established.dispose();
  });

  for (const scenario of ['in-flight', 'initial-transport-throw', 'continuation-throw']) {
    test(`shared refinement fencing prevents established acceptance during ${scenario}`, async () => {
      const proposalId = `refinement-fence-${scenario}`;
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const agent = clientWithCaps(
        capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
      );
      agent.requestProposals = async () =>
        completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
      agent.refineProposals = async () => {
        if (scenario === 'initial-transport-throw') throw new Error('ambiguous refine transport failure');
        if (scenario === 'in-flight') return working('refine_proposals');
        const pending = submitted(
          'refine_proposals',
          completed('refine_proposals', {
            products: [],
            results: [
              {
                source_proposal_id: proposalId,
                outcome: 'unable',
                reason_code: 'commercially_declined',
                reason: 'Would have preserved the source if delivery were trustworthy.',
              },
            ],
          })
        );
        pending.submitted.waitForCompletion = async () => {
          throw new Error('ambiguous refine continuation failure');
        };
        return pending;
      };
      let mutations = 0;
      agent.createMediaBuy = async () => {
        mutations += 1;
        return completed('create_media_buy', { media_buy_id: 'must-not-be-created', revision: 1 });
      };
      const principalScope = `buyer-refinement-fence-${scenario}`;
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      seedProposalSnapshot(compact, proposal);
      const refine = () =>
        compact.refineProposals({
          idempotency_key: `refinement-fence-refine-${scenario}-0001`,
          refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Ambiguous change' }],
        });
      if (scenario === 'initial-transport-throw') {
        await assert.rejects(refine(), /ambiguous refine transport failure/);
      } else {
        const result = await refine();
        if (scenario === 'continuation-throw') {
          await assert.rejects(result.submitted.waitForCompletion(), /ambiguous refine continuation failure/);
        }
      }

      await assert.rejects(
        established.acceptProposal({
          idempotency_key: `refinement-fence-accept-${scenario}-0001`,
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: proposal.terms_digest,
        }),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_refinement_pending'
      );
      assert.equal(mutations, 0);
      compact.dispose();
      established.dispose();
    });
  }

  test('native compact acceptance owns the shared fence and retires the proposal on success', async () => {
    const proposalId = 'native-acceptance-shared-fence-proposal';
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products'] }));
    let finishAcceptance;
    let acceptanceDispatches = 0;
    let competingDispatches = 0;
    agent.acceptProposal = async () => {
      acceptanceDispatches += 1;
      return new Promise(resolve => {
        finishAcceptance = () =>
          resolve(completed('accept_proposal', { proposal_id: proposalId, outcome: 'accepted', media_buy_id: 'mb-1' }));
      });
    };
    agent.declineProposals = agent.refineProposals = async () => {
      competingDispatches += 1;
      return completed('unexpected_competing_mutation', {});
    };
    agent.getProducts = async () => {
      competingDispatches += 1;
      return completed('get_products', { products: [] });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'native-acceptance-shared-fence' });
    const acceptance = coordinator.acceptProposal({
      idempotency_key: 'native-acceptance-shared-fence-key-0001',
      account: { account_id: 'account-1' },
      proposal_id: proposalId,
      proposal_terms_digest: proposalTermsDigest({}),
    });
    await new Promise(resolve => setImmediate(resolve));

    for (const mutation of [
      () =>
        coordinator.declineProposals({
          idempotency_key: 'native-acceptance-fenced-decline-0001',
          declines: [{ proposal_id: proposalId, reason: 'other' }],
        }),
      () =>
        coordinator.refineProposals({
          idempotency_key: 'native-acceptance-fenced-refine-0001',
          refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Do not race acceptance' }],
        }),
    ]) {
      await assert.rejects(
        mutation(),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_pending'
      );
    }
    finishAcceptance();
    assert.equal((await acceptance).status, 'completed');

    await assert.rejects(
      coordinator.declineProposals({
        idempotency_key: 'native-acceptance-terminal-decline-0001',
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_terminal'
    );
    await assert.rejects(
      coordinator.refineProposals({
        idempotency_key: 'native-acceptance-terminal-refine-0001',
        refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Already accepted' }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_terminal'
    );
    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'native-acceptance-shared-fence',
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await assert.rejects(
      established.refineProposals({
        idempotency_key: 'native-acceptance-established-refine-0001',
        refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Already accepted' }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_terminal'
    );
    assert.equal(acceptanceDispatches, 1);
    assert.equal(competingDispatches, 0);
    coordinator.dispose();
    established.dispose();
  });

  test('a deferred native acceptance continuation cannot dispatch after an exact retry', async () => {
    const proposalId = 'native-acceptance-deferred-epoch-proposal';
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    let dispatches = 0;
    let continuationDispatches = 0;
    agent.acceptProposal = async () => {
      dispatches += 1;
      if (dispatches > 1) {
        return completed('accept_proposal', { proposal_id: proposalId, outcome: 'accepted', media_buy_id: 'mb-2' });
      }
      return deferred('accept_proposal', async () => {
        continuationDispatches += 1;
        return completed('accept_proposal', { proposal_id: proposalId, outcome: 'accepted', media_buy_id: 'mb-2' });
      });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'native-acceptance-deferred-epoch' });
    const request = {
      idempotency_key: 'native-acceptance-deferred-key-0001',
      account: { account_id: 'account-1' },
      proposal_id: proposalId,
      proposal_terms_digest: proposalTermsDigest({}),
    };
    const first = await coordinator.acceptProposal(request);
    assert.equal(first.status, 'deferred');
    const reservation = coordinator.proposalSnapshotStore.proposalAcceptances.get(proposalId).reservation;
    const replayDeadline = reservation.retryDeadlineMs;
    assert.equal(Object.getOwnPropertyDescriptor(reservation, 'retryDeadlineMs').writable, false);
    assert.equal(Reflect.set(reservation, 'retryDeadlineMs', replayDeadline + 60_000), false);
    assert.equal((await coordinator.acceptProposal(request)).status, 'completed');
    await assert.rejects(
      first.deferred.resume({ approved: true }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.feature === 'proposal_acceptance_continuation_stale'
    );
    assert.equal(dispatches, 2);
    assert.equal(continuationDispatches, 0);
    coordinator.dispose();
  });

  test('a deferred acceptance continuation waits for an unresolved decline and resumes after unable', async () => {
    const proposalId = 'native-acceptance-deferred-decline-proposal';
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    let continuationDispatches = 0;
    agent.acceptProposal = async () =>
      deferred('accept_proposal', async () => {
        continuationDispatches += 1;
        return completed('accept_proposal', {
          proposal_id: proposalId,
          outcome: 'accepted',
          media_buy_id: 'mb-after-unable-decline',
        });
      });
    agent.declineProposals = async () =>
      submitted(
        'decline_proposals',
        completed('decline_proposals', {
          results: [{ proposal_id: proposalId, outcome: 'unable', reason: 'Seller could not decline.' }],
        })
      );
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'native-acceptance-deferred-decline',
    });
    const acceptance = await coordinator.acceptProposal({
      idempotency_key: 'native-acceptance-deferred-decline-accept-0001',
      account: { account_id: 'account-1' },
      proposal_id: proposalId,
      proposal_terms_digest: proposalTermsDigest({}),
    });
    const decline = await coordinator.declineProposals({
      idempotency_key: 'native-acceptance-deferred-decline-0001',
      declines: [{ proposal_id: proposalId, reason: 'other' }],
    });

    await assert.rejects(
      acceptance.deferred.resume({ approved: true }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_decline_pending'
    );
    assert.equal(continuationDispatches, 0);
    assert.equal((await decline.submitted.waitForCompletion()).status, 'completed');
    assert.equal((await acceptance.deferred.resume({ approved: true })).status, 'completed');
    assert.equal(continuationDispatches, 1);
    coordinator.dispose();
  });

  for (const eventTiming of ['raced', 'watched']) {
    test(`${eventTiming} event-only unable decline releases its shared fence without retiring the source`, async () => {
      const proposalId = `event-only-unable-decline-source-${eventTiming}`;
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const agent = clientWithCaps(
        capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
      );
      const taskListeners = new Set();
      agent.onTaskUpdate = listener => {
        taskListeners.add(listener);
        return () => taskListeners.delete(listener);
      };
      agent.requestProposals = async () =>
        completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
      const unableUpdate = {
        taskId: 'decline_proposals-task',
        status: 'completed',
        taskType: 'decline_proposals',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: {
          results: [{ proposal_id: proposalId, outcome: 'unable', reason: 'The proposal remains available.' }],
        },
      };
      agent.declineProposals = async () => {
        if (eventTiming === 'raced') {
          for (const listener of [...taskListeners]) listener(unableUpdate);
        }
        return working('decline_proposals');
      };
      let mutations = 0;
      agent.createMediaBuy = async () => {
        mutations += 1;
        return completed('create_media_buy', { media_buy_id: 'accepted-after-event-unable', revision: 1 });
      };
      const principalScope = `buyer-event-only-unable-decline-${eventTiming}`;
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      seedProposalSnapshot(compact, proposal);
      await compact.declineProposals({
        idempotency_key: `event-only-unable-decline-decline-${eventTiming}-0001`,
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      });
      assert.equal(taskListeners.size, eventTiming === 'watched' ? 1 : 0);
      if (eventTiming === 'watched') {
        for (const listener of [...taskListeners]) listener(unableUpdate);
      }
      assert.equal(taskListeners.size, 0);
      const accepted = await established.acceptProposal({
        idempotency_key: `event-only-unable-decline-accept-${eventTiming}-0001`,
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      });
      assert.equal(accepted.success, true);
      assert.equal(mutations, 1);
      compact.dispose();
      established.dispose();
    });
  }

  for (const operation of ['refinement', 'decline']) {
    test(`an unrelated terminal task cannot release an in-flight ${operation} fence`, async () => {
      const proposalId = `uncorrelated-${operation}-source`;
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const agent = clientWithCaps(
        capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
      );
      const taskListeners = new Set();
      agent.onTaskUpdate = listener => {
        taskListeners.add(listener);
        return () => taskListeners.delete(listener);
      };
      agent.requestProposals = async () =>
        completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
      let resolveDispatch;
      const heldDispatch = () =>
        new Promise(resolve => {
          resolveDispatch = resolve;
        });
      if (operation === 'refinement') agent.refineProposals = heldDispatch;
      else agent.declineProposals = heldDispatch;
      let mutations = 0;
      agent.createMediaBuy = async () => {
        mutations += 1;
        return completed('create_media_buy', { media_buy_id: 'must-not-be-created', revision: 1 });
      };
      const principalScope = `buyer-uncorrelated-${operation}`;
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      seedProposalSnapshot(compact, proposal);
      const pending =
        operation === 'refinement'
          ? compact.refineProposals({
              idempotency_key: 'uncorrelated-refinement-0001',
              refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Held change' }],
            })
          : compact.declineProposals({
              idempotency_key: 'uncorrelated-decline-0001',
              declines: [{ proposal_id: proposalId, reason: 'other' }],
            });
      assert.equal(taskListeners.size, 1);
      const taskType = operation === 'refinement' ? 'refine_proposals' : 'decline_proposals';
      for (const listener of [...taskListeners]) {
        listener({
          taskId: `unrelated-${taskType}-task`,
          status: 'completed',
          taskType,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result:
            operation === 'refinement'
              ? {
                  products: [],
                  results: [
                    {
                      source_proposal_id: proposalId,
                      outcome: 'unable',
                      reason_code: 'commercially_declined',
                      reason: 'Unrelated task result',
                    },
                  ],
                }
              : { results: [{ outcome: 'unable', reason: 'Unrelated task result' }] },
        });
      }
      await assert.rejects(
        established.acceptProposal({
          idempotency_key: `uncorrelated-${operation}-accept-0001`,
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: proposal.terms_digest,
        }),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          error.feature === (operation === 'refinement' ? 'proposal_refinement_pending' : 'proposal_decline_pending')
      );
      resolveDispatch(working(taskType));
      const result = await pending;
      assert.equal(result.status, 'working');
      assert.equal(mutations, 0);
      compact.dispose();
      established.dispose();
    });
  }

  test('ambiguous and paused declines cannot fail open into established acceptance', async () => {
    for (const scenario of [
      { name: 'transport rejection', result: 'throw', feature: 'proposal_decline_pending' },
      { name: 'input-required pause', result: 'pause', feature: 'proposal_decline_pending' },
      { name: 'malformed async completion', result: 'malformed', feature: 'proposal_decline_pending' },
    ]) {
      const proposalId = `decline-fail-closed-${scenario.result}`;
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const agent = clientWithCaps(
        capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_products', 'create_media_buy'] })
      );
      agent.requestProposals = async () =>
        completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
      agent.declineProposals = async () => {
        if (scenario.result === 'throw') throw new Error('ambiguous transport failure');
        if (scenario.result === 'malformed') {
          return submitted('decline_proposals', completed('decline_proposals', { results: [{}] }));
        }
        return { ...working('decline_proposals'), status: 'input-required' };
      };
      let mutations = 0;
      agent.createMediaBuy = async () => {
        mutations += 1;
        return completed('create_media_buy', { media_buy_id: 'must-not-be-created', revision: 1 });
      };
      const principalScope = `buyer-${scenario.result}-decline`;
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
      seedProposalSnapshot(compact, proposal);
      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      const decline = compact.declineProposals({
        idempotency_key: `decline-${scenario.result}-mutation-0001`,
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      });
      if (scenario.result === 'throw') await assert.rejects(decline, /ambiguous transport failure/);
      else if (scenario.result === 'malformed') {
        const pending = await decline;
        await assert.rejects(pending.submitted.waitForCompletion(), /malformed compact completion/);
      } else assert.equal((await decline).status, 'input-required');

      await assert.rejects(
        established.acceptProposal({
          idempotency_key: `decline-${scenario.result}-accept-0001`,
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: proposal.terms_digest,
        }),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === scenario.feature,
        scenario.name
      );
      assert.equal(mutations, 0, scenario.name);
      compact.dispose();
      established.dispose();
    }
  });

  test('dispose preserves the fence for a decline that was already dispatched', async () => {
    const proposalId = 'decline-dispose-race-proposal';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
    };
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const agent = clientWithCaps(
      capabilities({
        tools: COMPACT_TOOLS,
        discoveredTools: ['get_products', 'create_media_buy'],
      })
    );
    agent.requestProposals = async () => completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
    let resolveDecline;
    agent.declineProposals = () =>
      new Promise(resolve => {
        resolveDecline = resolve;
      });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: 'must-not-be-created', revision: 1 });
    };
    const principalScope = 'buyer-decline-dispose-race';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    seedProposalSnapshot(compact, proposal);

    const pendingDecline = compact.declineProposals({
      idempotency_key: 'decline-dispose-decline-0001',
      declines: [{ proposal_id: proposalId, reason: 'other' }],
    });
    compact.dispose();
    resolveDecline(completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] }));
    await assert.rejects(
      pendingDecline,
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'mediaBuy.lifecycleCoordinator'
    );

    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await assert.rejects(
      established.acceptProposal({
        idempotency_key: 'decline-dispose-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_decline_pending'
    );
    assert.equal(mutations, 0);
    established.dispose();
  });

  test('dispose preserves the fence for a decline continuation that was already polling', async () => {
    const proposalId = 'decline-continuation-dispose-race';
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
      terms_digest: proposalTermsDigest(commercialTerms),
    };
    const agent = clientWithCaps(
      capabilities({
        tools: COMPACT_TOOLS,
        discoveredTools: ['get_products', 'create_media_buy'],
      })
    );
    agent.requestProposals = async () => completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
    let resolveCompletion;
    agent.declineProposals = async () => {
      const result = submitted(
        'decline_proposals',
        completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] })
      );
      result.submitted.waitForCompletion = () =>
        new Promise(resolve => {
          resolveCompletion = resolve;
        });
      return result;
    };
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: 'must-not-be-created', revision: 1 });
    };
    const principalScope = 'buyer-decline-continuation-dispose-race';
    const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
    seedProposalSnapshot(compact, proposal);
    const submittedDecline = await compact.declineProposals({
      idempotency_key: 'decline-continuation-decline-0001',
      declines: [{ proposal_id: proposalId, reason: 'other' }],
    });
    const completion = submittedDecline.submitted.waitForCompletion();
    compact.dispose();
    resolveCompletion(completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] }));
    await assert.rejects(
      completion,
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'mediaBuy.lifecycleCoordinator'
    );

    const established = await agent.negotiateMediaBuyLifecycle({
      principalScope,
      preferredLifecycle: 'established',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await assert.rejects(
      established.acceptProposal({
        idempotency_key: 'decline-continuation-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_decline_pending'
    );
    assert.equal(mutations, 0);
    established.dispose();
  });

  for (const operation of ['refinement', 'decline']) {
    for (const pauseStatus of ['input-required', 'auth-required']) {
      for (const pausePath of ['direct', 'tracked', 'polled']) {
        test(`an exact ${operation} retry reuses its lease after a ${pausePath} ${pauseStatus} pause`, async () => {
          const proposalId = `paused-${operation}-${pauseStatus}-${pausePath}-proposal`;
          const tool = operation === 'refinement' ? 'refine_proposals' : 'decline_proposals';
          const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
          const requests = [];
          let dispatches = 0;
          const completedMutation = () =>
            operation === 'refinement'
              ? completed(tool, {
                  products: [],
                  results: [
                    {
                      source_proposal_id: proposalId,
                      outcome: 'unable',
                      reason_code: 'commercially_declined',
                      reason: 'The original proposal remains available.',
                    },
                  ],
                })
              : completed(tool, { results: [{ proposal_id: proposalId, outcome: 'declined' }] });
          const dispatch = async request => {
            requests.push(structuredClone(request));
            dispatches += 1;
            if (dispatches > 1) return completedMutation();
            const pause = { ...working(tool), status: pauseStatus };
            return pausePath === 'direct' ? pause : submitted(tool, pause);
          };
          if (operation === 'refinement') agent.refineProposals = dispatch;
          else agent.declineProposals = dispatch;
          const coordinator = await agent.negotiateMediaBuyLifecycle({
            principalScope: `buyer-paused-${operation}-${pauseStatus}-${pausePath}`,
          });
          const request =
            operation === 'refinement'
              ? {
                  ...(pausePath !== 'polled' && {
                    idempotency_key: `paused-refinement-${pauseStatus}-${pausePath}-0001`,
                  }),
                  refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Keep the exact request' }],
                }
              : {
                  ...(pausePath !== 'polled' && {
                    idempotency_key: `paused-decline-${pauseStatus}-${pausePath}-0001`,
                  }),
                  declines: [{ proposal_id: proposalId, reason: 'other', detail: 'Keep the exact request' }],
                };
          const invoke = value =>
            operation === 'refinement' ? coordinator.refineProposals(value) : coordinator.declineProposals(value);

          const first = await invoke(request);
          if (pausePath === 'direct') assert.equal(first.status, pauseStatus);
          else if (pausePath === 'tracked') assert.equal((await first.submitted.track()).status, pauseStatus);
          else assert.equal((await first.submitted.waitForCompletion()).status, pauseStatus);

          const leases =
            operation === 'refinement'
              ? coordinator.proposalSnapshotStore.pendingRefinements
              : coordinator.proposalSnapshotStore.pendingDeclines;
          assert.equal(leases.size, 1);
          assert.equal([...leases][0].state, 'paused');
          const divergent = structuredClone(request);
          if (operation === 'refinement') divergent.refinements[0].ask = 'A different request';
          else divergent.declines[0].detail = 'A different request';
          await assert.rejects(
            invoke(divergent),
            error =>
              error instanceof MediaBuyLifecycleCompatibilityError &&
              error.feature === (operation === 'refinement' ? 'proposal_refinement_retry' : 'proposal_decline_retry')
          );
          assert.equal(dispatches, 1, 'a divergent retry must fail before seller dispatch');
          assert.equal(leases.size, 1, 'a divergent retry must not allocate another lease');

          const retried = await invoke(request);
          assert.equal(retried.status, 'completed');
          assert.equal(dispatches, 2);
          assert.deepEqual(requests[1], requests[0], 'the retry must preserve the exact outbound request');
          assert.match(requests[0].idempotency_key, /^[A-Za-z0-9_-]{16,255}$/);
          assert.equal(leases.size, 0);
          coordinator.dispose();
        });
      }
    }
  }

  for (const operation of ['refinement', 'decline']) {
    const tool = operation === 'refinement' ? 'refine_proposals' : 'decline_proposals';
    const invoke = (coordinator, request) =>
      operation === 'refinement' ? coordinator.refineProposals(request) : coordinator.declineProposals(request);
    const reservations = coordinator =>
      operation === 'refinement'
        ? coordinator.proposalSnapshotStore.pendingRefinements
        : coordinator.proposalSnapshotStore.pendingDeclines;

    test(`${operation} ambiguity without an advertised replay TTL leaves a cross-coordinator tombstone`, async () => {
      const proposalId = `no-ttl-${operation}-proposal`;
      const caps = capabilities({ tools: COMPACT_TOOLS });
      delete caps.idempotency;
      const agent = clientWithCaps(caps);
      let dispatches = 0;
      agent[operation === 'refinement' ? 'refineProposals' : 'declineProposals'] = async () => {
        dispatches += 1;
        throw new Error('transport outcome is unknown');
      };
      const principalScope = `buyer-no-ttl-${operation}`;
      const first = await agent.negotiateMediaBuyLifecycle({ principalScope });
      const request = proposalMutationRequest(operation, proposalId, `no-ttl-${operation}-key-0001`);

      await assert.rejects(invoke(first, request), /transport outcome is unknown/);
      assert.equal(reservations(first).size, 0);
      const fresh = await agent.negotiateMediaBuyLifecycle({ principalScope });
      await assert.rejects(
        invoke(fresh, request),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_mutation_commit_uncertain'
      );
      assert.equal(dispatches, 1);
      first.dispose();
      fresh.dispose();
    });

    test(`${operation} transport ambiguity permits only the exact immutable-deadline replay`, async () => {
      const proposalId = `transport-${operation}-proposal`;
      const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
      let dispatches = 0;
      agent[operation === 'refinement' ? 'refineProposals' : 'declineProposals'] = async () => {
        dispatches += 1;
        if (dispatches === 1) throw new Error('transport failed after dispatch');
        return completedProposalMutation(operation, proposalId);
      };
      const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: `buyer-transport-${operation}` });
      const request = proposalMutationRequest(operation, proposalId, `transport-${operation}-key-0001`);

      await assert.rejects(invoke(coordinator, request), /transport failed after dispatch/);
      const reservation = [...reservations(coordinator)][0];
      assert.equal(reservation.state, 'commit-uncertain');
      assert.equal(Object.getOwnPropertyDescriptor(reservation, 'retryDeadlineMs').writable, false);
      await assert.rejects(
        invoke(coordinator, { ...request, idempotency_key: `transport-${operation}-key-0002` }),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          error.feature === (operation === 'refinement' ? 'proposal_refinement_retry' : 'proposal_decline_retry')
      );
      assert.equal(dispatches, 1);
      assert.equal((await invoke(coordinator, request)).status, 'completed');
      assert.equal(dispatches, 2);
      coordinator.dispose();
    });

    test(`${operation} replay expiry retires the reservation and blocks a fresh coordinator`, async () => {
      const proposalId = `expired-${operation}-proposal`;
      const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
      let dispatches = 0;
      agent[operation === 'refinement' ? 'refineProposals' : 'declineProposals'] = async () => {
        dispatches += 1;
        return { ...working(tool), status: 'input-required' };
      };
      const principalScope = `buyer-expired-${operation}`;
      const first = await agent.negotiateMediaBuyLifecycle({ principalScope });
      first.idempotencyReplayTtlMs = 15;
      const request = proposalMutationRequest(operation, proposalId, `expired-${operation}-key-0001`);
      assert.equal((await invoke(first, request)).status, 'input-required');
      const reservation = [...reservations(first)][0];
      const deadline = reservation.retryDeadlineMs;
      assert.equal(reservation.state, 'paused');
      assert.equal(Object.getOwnPropertyDescriptor(reservation, 'retryDeadlineMs').writable, false);
      assert.equal(Reflect.set(reservation, 'retryDeadlineMs', deadline + 60_000), false);
      await new Promise(resolve => setTimeout(resolve, 30));

      await assert.rejects(
        invoke(first, request),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          [
            'proposal_mutation_commit_uncertain',
            `proposal_${operation === 'refinement' ? 'refinement' : 'decline'}_retry_window`,
          ].includes(error.feature)
      );
      const fresh = await agent.negotiateMediaBuyLifecycle({ principalScope });
      await assert.rejects(
        invoke(fresh, request),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_mutation_commit_uncertain'
      );
      assert.equal(dispatches, 1);
      first.dispose();
      fresh.dispose();
    });

    test(`${operation} abort, stale continuation, and stale timer cannot mutate a newer retry epoch`, async () => {
      const proposalId = `epoch-${operation}-proposal`;
      const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
      let dispatches = 0;
      let resolveTrack;
      agent[operation === 'refinement' ? 'refineProposals' : 'declineProposals'] = async () => {
        dispatches += 1;
        if (dispatches > 1) return completedProposalMutation(operation, proposalId);
        const result = submitted(tool, completedProposalMutation(operation, proposalId));
        result.submitted.track = () =>
          new Promise(resolve => {
            resolveTrack = resolve;
          });
        result.submitted.waitForCompletion = async (_pollInterval, signal) => {
          if (signal?.aborted) {
            const error = new Error('local wait aborted');
            error.name = 'AbortError';
            throw error;
          }
          return completedProposalMutation(operation, proposalId);
        };
        return result;
      };
      const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: `buyer-epoch-${operation}` });
      const request = proposalMutationRequest(operation, proposalId, `epoch-${operation}-key-0001`);
      const first = await invoke(coordinator, request);
      const staleTrack = first.submitted.track();
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(first.submitted.waitForCompletion(undefined, abort.signal), /local wait aborted/);
      const reservation = [...reservations(coordinator)][0];
      const staleTimer = reservation.timer;
      assert.equal(reservation.state, 'commit-uncertain');
      assert.equal((await invoke(coordinator, request)).status, 'completed');
      assert.equal(reservations(coordinator).size, 0);

      resolveTrack({
        taskId: `${tool}-task`,
        taskType: tool,
        status: 'failed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      assert.equal((await staleTrack).status, 'failed');
      staleTimer?._onTimeout?.();
      const newRequest = proposalMutationRequest(operation, proposalId, `epoch-${operation}-key-0002`, '-new');
      assert.equal((await invoke(coordinator, newRequest)).status, 'completed');
      assert.equal(dispatches, 3);
      coordinator.dispose();
    });

    test(`${operation} deferred continuation cannot dispatch after an exact retry takes ownership`, async () => {
      const proposalId = `deferred-epoch-${operation}-proposal`;
      const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
      let dispatches = 0;
      let continuationDispatches = 0;
      agent[operation === 'refinement' ? 'refineProposals' : 'declineProposals'] = async () => {
        dispatches += 1;
        if (dispatches > 1) return completedProposalMutation(operation, proposalId);
        return deferred(tool, async () => {
          continuationDispatches += 1;
          return completedProposalMutation(operation, proposalId);
        });
      };
      const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: `buyer-deferred-${operation}` });
      const request = proposalMutationRequest(operation, proposalId, `deferred-${operation}-key-0001`);
      const first = await invoke(coordinator, request);
      assert.equal([...reservations(coordinator)][0].state, 'paused');

      assert.equal((await invoke(coordinator, request)).status, 'completed');
      await assert.rejects(
        first.deferred.resume({ approved: true }),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          error.feature === 'proposal_mutation_continuation_stale'
      );
      assert.equal(dispatches, 2);
      assert.equal(continuationDispatches, 0);
      coordinator.dispose();
    });

    test(`${operation} dispose preserves an exact retry for a fresh coordinator`, async () => {
      const proposalId = `dispose-${operation}-proposal`;
      const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
      let dispatches = 0;
      agent[operation === 'refinement' ? 'refineProposals' : 'declineProposals'] = async () => {
        dispatches += 1;
        return dispatches === 1 ? working(tool) : completedProposalMutation(operation, proposalId);
      };
      const principalScope = `buyer-dispose-${operation}`;
      const first = await agent.negotiateMediaBuyLifecycle({ principalScope });
      const request = proposalMutationRequest(operation, proposalId, `dispose-${operation}-key-0001`);
      assert.equal((await invoke(first, request)).status, 'working');
      first.dispose();
      assert.equal([...reservations(first)][0].state, 'commit-uncertain');

      const fresh = await agent.negotiateMediaBuyLifecycle({ principalScope });
      await assert.rejects(
        invoke(fresh, { ...request, idempotency_key: `dispose-${operation}-key-0002` }),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          error.feature === (operation === 'refinement' ? 'proposal_refinement_retry' : 'proposal_decline_retry')
      );
      assert.equal((await invoke(fresh, request)).status, 'completed');
      assert.equal(dispatches, 2);
      fresh.dispose();
    });
  }

  test('an in-flight decline cannot allocate a duplicate lease', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    let dispatches = 0;
    agent.declineProposals = async () => {
      dispatches += 1;
      return working('decline_proposals');
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-duplicate-decline-lease' });
    const request = {
      idempotency_key: 'duplicate-decline-lease-0001',
      declines: [{ proposal_id: 'duplicate-decline-proposal', reason: 'other' }],
    };
    assert.equal((await coordinator.declineProposals(request)).status, 'working');
    await assert.rejects(
      coordinator.declineProposals(request),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_decline_pending'
    );
    assert.equal(dispatches, 1);
    assert.equal(coordinator.proposalSnapshotStore.pendingDeclines.size, 1);
    assert.equal(coordinator.proposalSnapshotStore.pendingDeclineProposalIdCount, 1);
    coordinator.dispose();
  });

  for (const operation of ['refinement', 'decline']) {
    test(`an established ${operation} pause permits only the exact projected retry`, async () => {
      const proposalId = `established-paused-${operation}-proposal`;
      const agent = clientWithCaps(capabilities({ version: '3.1' }));
      const requests = [];
      agent.getProducts = async request => {
        requests.push(structuredClone(request));
        if (requests.length === 1) return { ...working('get_products'), status: 'auth-required' };
        return completed('get_products', { products: [], proposals: [] });
      };
      const coordinator = await agent.negotiateMediaBuyLifecycle({
        principalScope: `buyer-established-paused-${operation}`,
        ...(operation === 'decline' && {
          allowedLosses: ['proposal_decline_not_terminal', 'proposal_decline_reason_not_forwarded'],
        }),
      });
      const request =
        operation === 'refinement'
          ? {
              idempotency_key: 'established-paused-refinement-0001',
              refinements: [{ proposal_id: proposalId, action: 'revise', ask: 'Keep this exact request' }],
            }
          : {
              idempotency_key: 'established-paused-decline-0001',
              declines: [{ proposal_id: proposalId, reason: 'other' }],
            };
      const invoke = value =>
        operation === 'refinement' ? coordinator.refineProposals(value) : coordinator.declineProposals(value);

      assert.equal((await invoke(request)).status, 'auth-required');
      await assert.rejects(
        invoke({ ...request, idempotency_key: `${request.idempotency_key}-different` }),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          error.feature === (operation === 'refinement' ? 'proposal_refinement_retry' : 'proposal_decline_retry')
      );
      assert.equal(requests.length, 1);
      assert.equal((await invoke(request)).status, 'completed');
      assert.deepEqual(requests[1], requests[0]);
      coordinator.dispose();
    });
  }

  test('pending decline leases are bounded per principal and released by owner', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    let dispatches = 0;
    agent.declineProposals = async () => {
      dispatches += 1;
      return submitted(
        'decline_proposals',
        completed('decline_proposals', { results: [{ proposal_id: 'unused', outcome: 'declined' }] })
      );
    };
    const first = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-pending-decline-limit' });
    const second = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-pending-decline-limit' });
    assert.equal(first.proposalSnapshotStore, second.proposalSnapshotStore);

    for (let index = 0; index < 255; index += 1) {
      const result = await first.declineProposals({
        idempotency_key: `pending-decline-${String(index).padStart(4, '0')}`,
        declines: [{ proposal_id: `pending-proposal-${index}`, reason: 'other' }],
      });
      assert.equal(result.status, 'submitted');
    }
    const secondOwned = await second.declineProposals({
      idempotency_key: 'pending-decline-second-owner',
      declines: [{ proposal_id: 'pending-proposal-second-owner', reason: 'other' }],
    });
    assert.equal(secondOwned.status, 'submitted');
    assert.equal(first.proposalSnapshotStore.pendingDeclines.size, 256);
    assert.equal(first.proposalSnapshotStore.pendingDeclineProposalIdCount, 256);
    await assert.rejects(
      second.declineProposals({
        idempotency_key: 'pending-decline-overflow',
        declines: [{ proposal_id: 'pending-proposal-overflow', reason: 'other' }],
      }),
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'mediaBuy.pendingDeclines'
    );
    assert.equal(dispatches, 256, 'the over-limit decline must fail before seller dispatch');

    first.dispose();
    assert.equal(second.proposalSnapshotStore.pendingDeclines.size, 256);
    assert.equal(second.proposalSnapshotStore.pendingDeclineProposalIdCount, 256);
    assert.equal(
      [...second.proposalSnapshotStore.pendingDeclines].filter(lease => lease.state === 'commit-uncertain').length,
      255
    );
    assert.equal(second.proposalSnapshotStore.registry.retiredAcceptanceSegments, undefined);
    second.dispose();
    assert.equal(second.proposalSnapshotStore.pendingDeclines.size, 256);
    assert.equal(second.proposalSnapshotStore.pendingDeclineProposalIdCount, 256);
  });

  test('pending refinement leases are bounded per principal and released by owner', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    let dispatches = 0;
    agent.refineProposals = async () => {
      dispatches += 1;
      return submitted(
        'refine_proposals',
        completed('refine_proposals', {
          products: [],
          results: [
            {
              source_proposal_id: 'unused',
              outcome: 'unable',
              reason_code: 'commercially_declined',
              reason: 'Unused terminal fixture',
            },
          ],
        })
      );
    };
    const first = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-pending-refinement-limit' });
    const second = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-pending-refinement-limit' });
    assert.equal(first.proposalSnapshotStore, second.proposalSnapshotStore);

    for (let index = 0; index < 255; index += 1) {
      const result = await first.refineProposals({
        idempotency_key: `pending-refinement-${String(index).padStart(4, '0')}`,
        refinements: [{ proposal_id: `pending-refinement-source-${index}`, action: 'revise', ask: 'test' }],
      });
      assert.equal(result.status, 'submitted');
    }
    const secondOwned = await second.refineProposals({
      idempotency_key: 'pending-refinement-second-owner',
      refinements: [{ proposal_id: 'pending-refinement-second-owner', action: 'revise', ask: 'test' }],
    });
    assert.equal(secondOwned.status, 'submitted');
    assert.equal(first.proposalSnapshotStore.pendingRefinements.size, 256);
    assert.equal(first.proposalSnapshotStore.pendingRefinementProposalIdCount, 256);
    await assert.rejects(
      second.refineProposals({
        idempotency_key: 'pending-refinement-overflow',
        refinements: [{ proposal_id: 'pending-refinement-overflow', action: 'revise', ask: 'test' }],
      }),
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'mediaBuy.pendingRefinements'
    );
    assert.equal(dispatches, 256, 'the over-limit refinement must fail before seller dispatch');

    first.dispose();
    assert.equal(second.proposalSnapshotStore.pendingRefinements.size, 256);
    assert.equal(second.proposalSnapshotStore.pendingRefinementProposalIdCount, 256);
    assert.equal(
      [...second.proposalSnapshotStore.pendingRefinements].filter(lease => lease.state === 'commit-uncertain').length,
      255
    );
    second.dispose();
    assert.equal(second.proposalSnapshotStore.pendingRefinements.size, 256);
    assert.equal(second.proposalSnapshotStore.pendingRefinementProposalIdCount, 256);
  });

  test('terminal decline retires paused acceptance retries across coordinators', async () => {
    for (const pausedStatus of ['input-required', 'auth-required']) {
      const proposalId = `paused-then-declined-${pausedStatus}`;
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const agent = clientWithCaps(
        capabilities({
          tools: COMPACT_TOOLS,
          discoveredTools: ['get_products', 'create_media_buy', 'update_media_buy'],
        })
      );
      agent.requestProposals = async () =>
        completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
      agent.declineProposals = async () =>
        completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] });
      let mutations = 0;
      agent.createMediaBuy = async () => {
        mutations += 1;
        return { ...working('create_media_buy'), status: pausedStatus };
      };
      const principalScope = `buyer-paused-then-declined-${pausedStatus}`;
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });
      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      seedProposalSnapshot(compact, proposal);
      const acceptance = {
        idempotency_key: `accept-paused-then-declined-${pausedStatus}-0001`,
        account: { account_id: 'account-1' },
        proposal_id: proposalId,
        proposal_terms_digest: proposal.terms_digest,
      };
      assert.equal((await established.acceptProposal(acceptance)).status, pausedStatus);
      assert.equal(mutations, 1);

      const decliningCoordinator = await agent.negotiateMediaBuyLifecycle({ principalScope });
      await decliningCoordinator.declineProposals({
        idempotency_key: `decline-paused-then-declined-${pausedStatus}-0001`,
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      });

      await assert.rejects(
        established.acceptProposal(acceptance),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
      );
      assert.equal(mutations, 1, 'terminal decline must prevent any additional create mutation');
    }
  });

  test('terminal decline tombstone blocks late proposal observations from restoring acceptance', async () => {
    for (const observation of ['completion', 'track']) {
      const proposalId = `late-proposal-after-decline-${observation}`;
      const commercialTerms = {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      };
      const proposal = {
        proposal_id: proposalId,
        proposal_kind: 'new_media_buy',
        proposal_status: 'committed',
        expires_at: '2099-12-31T23:59:59Z',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      const agent = clientWithCaps(
        capabilities({
          tools: COMPACT_TOOLS,
          discoveredTools: ['get_products', 'create_media_buy', 'update_media_buy'],
        })
      );
      agent.declineProposals = async () =>
        completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] });
      let mutations = 0;
      agent.createMediaBuy = async () => {
        mutations += 1;
        return completed('create_media_buy', { media_buy_id: `should-not-run-${observation}` });
      };
      const principalScope = `buyer-late-proposal-after-decline-${observation}`;
      const compact = await agent.negotiateMediaBuyLifecycle({ principalScope });

      const decliningCoordinator = await agent.negotiateMediaBuyLifecycle({ principalScope });
      await decliningCoordinator.declineProposals({
        idempotency_key: `decline-late-proposal-${observation}-0001`,
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      });
      seedProposalSnapshot(compact, proposal);

      const established = await agent.negotiateMediaBuyLifecycle({
        principalScope,
        preferredLifecycle: 'established',
        allowedLosses: ['proposal_terms_digest_not_enforced'],
      });
      await assert.rejects(
        established.acceptProposal({
          idempotency_key: `accept-late-proposal-${observation}-0001`,
          account: { account_id: 'account-1' },
          proposal_id: proposalId,
          proposal_terms_digest: proposal.terms_digest,
        }),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
      );
      assert.equal(mutations, 0, 'late proposal observation must not restore a terminally declined proposal');
    }
  });

  test('principal scope is non-empty and coordinator-local', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    await assert.rejects(
      agent.negotiateMediaBuyLifecycle({ principalScope: '   ' }),
      error => error instanceof TypeError && /principalScope/.test(error.message)
    );
    await assert.rejects(
      agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer\nadmin' }),
      error => error instanceof TypeError && /control characters/.test(error.message)
    );
    await assert.rejects(
      agent.negotiateMediaBuyLifecycle({ principalScope: 'x'.repeat(257) }),
      error => error instanceof TypeError && /256 UTF-8 bytes/.test(error.message)
    );
    const first = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-1' });
    const second = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-2' });
    assert.notEqual(first, second);
    assert.equal(first.proposalSnapshotStore.registry.retiredAcceptanceSegments, undefined);

    agent.getProducts = async () =>
      completed('get_products', { proposals: [{ proposal_id: 'proposal-without-scope' }] });
    const unscoped = await agent.negotiateMediaBuyLifecycle();
    await unscoped.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });
    await assert.rejects(
      unscoped.acceptProposal({ account: { account_id: 'account-1' }, proposal_id: 'proposal-without-scope' }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'principal_scope'
    );
  });

  test('principal snapshot partitions are bounded without evicting live tombstones', async () => {
    const proposalId = 'bounded-principal-terminal-proposal';
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    agent.declineProposals = async () =>
      completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] });
    agent.requestProposals = async () =>
      completed('request_proposals', {
        outcome: 'proposed',
        proposals: [
          {
            proposal_id: proposalId,
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
      });
    const protectedCoordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'bounded-principal-0' });
    await protectedCoordinator.declineProposals({
      idempotency_key: 'bounded-principal-decline-0001',
      declines: [{ proposal_id: proposalId, reason: 'other' }],
    });
    const fillers = [];
    for (let index = 1; index < 256; index += 1) {
      fillers.push(await agent.negotiateMediaBuyLifecycle({ principalScope: `bounded-principal-${index}` }));
    }
    assert.equal(protectedCoordinator.proposalSnapshotStore.registry.stores.size, 256);
    await assert.rejects(
      agent.negotiateMediaBuyLifecycle({ principalScope: 'bounded-principal-overflow' }),
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'mediaBuy.principalScope'
    );

    seedProposalSnapshot(protectedCoordinator, { proposal_id: proposalId });
    assert.equal(protectedCoordinator.proposalSnapshotStore.entries.size, 0);

    fillers.forEach(coordinator => coordinator.dispose());
    const reclaimed = await agent.negotiateMediaBuyLifecycle({ principalScope: 'bounded-principal-reclaimed' });
    assert.equal(protectedCoordinator.proposalSnapshotStore.registry.stores.size, 256);
    reclaimed.dispose();
    protectedCoordinator.dispose();
  });

  test('retired proposals survive reclamation of more than 256 disposed principal stores', async () => {
    const proposalId = 'registry-level-retired-proposal';
    const proposal = {
      proposal_id: proposalId,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    };
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    agent.declineProposals = async () =>
      completed('decline_proposals', { results: [{ proposal_id: proposalId, outcome: 'declined' }] });
    agent.requestProposals = async () => completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });

    let registry;
    for (let index = 0; index < 257; index += 1) {
      const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: `retired-principal-${index}` });
      registry ??= coordinator.proposalSnapshotStore.registry;
      await coordinator.declineProposals({
        idempotency_key: `registry-retire-${index}-0001`,
        declines: [{ proposal_id: proposalId, reason: 'other' }],
      });
      coordinator.dispose();
    }

    assert.equal(registry.stores.size, 256);
    assert.ok(registry.retiredAcceptanceSegments.size > 0);
    assert.ok(registry.retiredAcceptanceSegments.size <= 256);
    for (const segment of registry.retiredAcceptanceSegments.values()) {
      assert.equal(segment.byteLength, 256 * 1024);
    }

    const recreated = await agent.negotiateMediaBuyLifecycle({ principalScope: 'retired-principal-0' });
    seedProposalSnapshot(recreated, proposal);
    assert.equal(recreated.proposalSnapshotStore.entries.size, 0);
    recreated.dispose();
  });

  test('disposed coordinators cannot repopulate a reclaimed principal partition', async () => {
    const proposal = {
      proposal_id: 'disposed-race-proposal',
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    };
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    const taskListeners = new Set();
    agent.onTaskUpdate = listener => {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    };
    let resolveDispatch;
    agent.requestProposals = () =>
      new Promise(resolve => {
        resolveDispatch = resolve;
      });

    const original = await agent.negotiateMediaBuyLifecycle({ principalScope: 'disposed-race-original' });
    const detachedOriginalStore = original.proposalSnapshotStore;
    const pending = original.requestProposals({
      idempotency_key: 'disposed-race-request-0001',
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
      brief: 'Response resolves after disposal and partition reclamation',
    });
    assert.equal(taskListeners.size, 1);

    const fillers = [];
    for (let index = 1; index < 256; index += 1) {
      fillers.push(await agent.negotiateMediaBuyLifecycle({ principalScope: `disposed-race-filler-${index}` }));
    }
    original.dispose();
    assert.equal(taskListeners.size, 0);
    const continuationCoordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'disposed-race-continuation',
    });
    assert.equal(detachedOriginalStore.registry.stores.has('principal:disposed-race-original'), false);

    resolveDispatch(
      completed('request_proposals', {
        outcome: 'proposed',
        proposals: [proposal],
      })
    );
    await assert.rejects(
      pending,
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'mediaBuy.lifecycleCoordinator'
    );
    assert.equal(detachedOriginalStore.entries.size, 0);
    assert.equal(taskListeners.size, 0);

    const terminal = completed('request_proposals', { outcome: 'proposed', proposals: [proposal] });
    agent.requestProposals = async () => submitted('request_proposals', terminal);
    const savedContinuation = await continuationCoordinator.requestProposals({
      idempotency_key: 'disposed-race-request-0002',
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
      brief: 'Continuation is retained across disposal',
    });
    const detachedContinuationStore = continuationCoordinator.proposalSnapshotStore;
    assert.equal(taskListeners.size, 1);
    continuationCoordinator.dispose();
    assert.equal(taskListeners.size, 0);
    const replacement = await agent.negotiateMediaBuyLifecycle({ principalScope: 'disposed-race-replacement' });
    assert.equal(detachedContinuationStore.registry.stores.has('principal:disposed-race-continuation'), false);

    await assert.rejects(
      savedContinuation.submitted.track(),
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'mediaBuy.lifecycleCoordinator'
    );
    await assert.rejects(
      savedContinuation.submitted.waitForCompletion(),
      error => error.code === 'CONFIGURATION_ERROR' && error.configField === 'mediaBuy.lifecycleCoordinator'
    );
    assert.equal(detachedContinuationStore.entries.size, 0);
    assert.equal(taskListeners.size, 0);

    fillers.forEach(coordinator => coordinator.dispose());
    replacement.dispose();
  });

  test('dual-surface seller supports a separately forced established lane', async () => {
    const agent = clientWithCaps(capabilities({ tools: [...COMPACT_TOOLS, 'get_products'] }));
    const calls = [];
    agent.listProducts = async () => {
      calls.push('list_products');
      return completed('list_products', { products: [], feed_version: 'compact' });
    };
    agent.getProducts = async () => {
      calls.push('get_products');
      return completed('get_products', { products: [], wholesale_feed_version: 'legacy', cache_scope: 'public' });
    };

    const coordinator = await agent.negotiateMediaBuyLifecycle({ preferredLifecycle: 'established' });
    const result = await coordinator.listProducts({});

    assert.deepEqual(calls, ['get_products']);
    assert.equal(result.compatibility.compatibility, 'lossless_projection');
  });

  test('forced established lane fails closed when a compact-only seller advertises no legacy tool', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));

    await assert.rejects(
      agent.negotiateMediaBuyLifecycle({ preferredLifecycle: 'established' }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.feature === 'established_lifecycle_not_advertised' &&
        error.lifecycle === 'compact'
    );
  });

  test('a 3.1-pinned buyer does not select compact from a dual-surface 3.2 seller', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    caps.supportedVersions = ['3.0', '3.1', '3.2.0-beta.4'];
    const agent = clientWithCaps(caps, '3.1.18');
    const calls = [];
    agent.listProducts = async () => {
      calls.push('list_products');
      return completed('list_products', {});
    };
    agent.getProducts = async () => {
      calls.push('get_products');
      return completed('get_products', { products: [], cache_scope: 'public' });
    };

    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-1' });
    const result = await coordinator.listProducts({});

    assert.equal(coordinator.negotiated_version, '3.1');
    assert.deepEqual(calls, ['get_products']);
    assert.equal(result.compatibility.lifecycle, 'established');
  });

  test('authoritative served release wins over the seller support window', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    caps.supportedVersions = ['3.0', '3.1', '3.2.0-beta.4'];
    caps.servedVersion = '3.1';
    const agent = clientWithCaps(caps);
    const calls = [];
    agent.listProducts = async () => {
      calls.push('list_products');
      return completed('list_products', {});
    };
    agent.getProducts = async () => {
      calls.push('get_products');
      return completed('get_products', { products: [], cache_scope: 'public' });
    };

    const coordinator = await agent.negotiateMediaBuyLifecycle();
    const result = await coordinator.listProducts({});

    assert.equal(coordinator.negotiated_version, '3.1');
    assert.deepEqual(calls, ['get_products']);
    assert.equal(result.compatibility.lifecycle, 'established');
  });

  test('a metadata-free v3 capability response is reported as the 3.0 lane', async () => {
    const caps = capabilities({ version: '3.0' });
    delete caps.supportedVersions;
    const agent = clientWithCaps(caps);
    agent.getProducts = async () => completed('get_products', { products: [], cache_scope: 'public' });

    const coordinator = await agent.negotiateMediaBuyLifecycle();
    const result = await coordinator.listProducts({});

    assert.equal(coordinator.negotiated_version, '3.0');
    assert.equal(result.compatibility.negotiated_version, '3.0');
  });

  test('does not select a newer prerelease than the compact buyer pin', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    caps.supportedVersions = ['3.1', '3.2.0-beta.5'];
    const agent = clientWithCaps(caps, '3.2.0-beta.4');
    const calls = [];
    agent.getProducts = async () => {
      calls.push('get_products');
      return completed('get_products', { products: [], cache_scope: 'public' });
    };

    const coordinator = await agent.negotiateMediaBuyLifecycle();
    await coordinator.listProducts({});

    assert.equal(coordinator.negotiated_version, '3.1');
    assert.deepEqual(calls, ['get_products']);
  });

  test('fails closed when every valid advertised version is newer than the buyer pin', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    caps.supportedVersions = ['3.2.0-beta.5'];
    const agent = clientWithCaps(caps, '3.2.0-beta.4');

    await assert.rejects(
      agent.negotiateMediaBuyLifecycle(),
      /advertises only AdCP versions newer than the client pin 3\.2\.0-beta\.4/
    );
  });

  test('authoritative compact tool discovery survives synthetic capability fallback', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    delete caps.supportedVersions;
    caps._synthetic = true;
    const agent = clientWithCaps(caps, '3.2.0-beta.4');
    const calls = [];
    agent.listProducts = async () => {
      calls.push('list_products');
      return completed('list_products', { products: [], feed_version: 'feed-1' });
    };
    agent.getProducts = async () => assert.fail('compact discovery must not fall back to an absent alias');

    const coordinator = await agent.negotiateMediaBuyLifecycle();
    await coordinator.listProducts({});

    assert.equal(coordinator.negotiated_version, '3.2.0-beta.4');
    assert.deepEqual(calls, ['list_products']);
  });

  test('fails closed when a future seller serves a release newer than the buyer pin', async () => {
    const caps = capabilities({ version: '3.3', tools: COMPACT_TOOLS });
    caps.servedVersion = '3.3';
    const agent = clientWithCaps(caps);

    await assert.rejects(
      agent.negotiateMediaBuyLifecycle(),
      /served AdCP 3\.3, which is newer than the client pin 3\.2\.0-beta\.4/
    );
  });

  test('fails closed when an exact newer prerelease is served despite an older advertised fallback', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    caps.servedVersion = '3.2.0-beta.5';
    caps.supportedVersions = ['3.2.0-beta.4', '3.2.0-beta.5'];
    const agent = clientWithCaps(caps, '3.2.0-beta.4');

    await assert.rejects(
      agent.negotiateMediaBuyLifecycle(),
      /served AdCP 3\.2\.0-beta\.5, which is newer than the client pin 3\.2\.0-beta\.4/
    );
  });

  test('fails closed when a newer patch release is served on the same minor line', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    caps.servedVersion = '3.1.18';
    caps.supportedVersions = ['3.1', '3.1.18'];
    const agent = clientWithCaps(caps, '3.1');

    await assert.rejects(
      agent.negotiateMediaBuyLifecycle(),
      /served AdCP 3\.1\.18, which is newer than the client pin 3\.1/
    );
  });

  test('accepts an authoritative served release at or below the buyer pin', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    caps.servedVersion = '3.2.0-beta.2';
    caps.supportedVersions = ['3.2.0-beta.4'];
    const agent = clientWithCaps(caps, '3.2.0-beta.4');
    agent.listProducts = async () => completed('list_products', { products: [], feed_version: 'feed-1' });

    const coordinator = await agent.negotiateMediaBuyLifecycle();
    const listed = await coordinator.listProducts({});

    assert.equal(coordinator.negotiated_version, '3.2.0-beta.2');
    assert.equal(listed.success, true);
  });

  test('advisory build metadata cannot select a compact wire lifecycle', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    delete caps.supportedVersions;
    caps.buildVersion = '3.2.0-beta.4+sha.abc123';
    const agent = clientWithCaps(caps, '3.2.0-beta.4');
    agent.getProducts = async () => completed('get_products', { products: [] });
    agent.listProducts = async () => assert.fail('build metadata must not enable compact wire tools');

    const coordinator = await agent.negotiateMediaBuyLifecycle();
    await coordinator.listProducts({});

    assert.equal(coordinator.negotiated_version, '3.0');
    assert.equal(coordinator.lifecycle, 'established');
  });

  test('malformed capability version strings fail closed to the established 3.0 lane', async () => {
    const caps = capabilities({ tools: COMPACT_TOOLS });
    caps.servedVersion = 'not-a-version';
    caps.supportedVersions = ['also-invalid'];
    caps.buildVersion = 'still-invalid';
    const agent = clientWithCaps(caps);
    agent.getProducts = async () => completed('get_products', { products: [] });
    agent.listProducts = async () => assert.fail('malformed version evidence must not enable compact tools');

    const coordinator = await agent.negotiateMediaBuyLifecycle();
    await coordinator.listProducts({});

    assert.equal(coordinator.negotiated_version, '3.0');
    assert.equal(coordinator.lifecycle, 'established');
  });
});

describe('legacy products-only purchase continuations', () => {
  function validLegacyCreateResponse(sourceVersion, request, productId) {
    return {
      media_buy_id: `buy-${productId}`,
      packages: [],
      ...(sourceVersion.startsWith('2.5') && { buyer_ref: request.buyer_ref }),
      ...(sourceVersion.startsWith('3.1') && { confirmed_at: '2099-01-01T00:00:00Z', revision: 1 }),
    };
  }

  test('keeps unsafe products-only discovery readable without issuing a purchase continuation', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }), '3.1');
    let products = [legacyListedProduct('p-readable-only', 'Readable only')];
    agent.getProducts = async () => completed('get_products', { products });

    const withoutPrincipal = await agent.negotiateMediaBuyLifecycle();
    const principalResult = await withoutPrincipal.requestProposals({
      idempotency_key: 'request-proposals-readable-principal-0001',
      account: { account_id: 'account-readable' },
      brand: { domain: 'example.com' },
      brief: 'Readable discovery',
    });
    assert.equal(principalResult.data.outcome, 'legacy_unavailable');
    assert.equal(principalResult.data.purchase_continuation, undefined);
    assert.equal(principalResult.data.products[0].product_id, 'p-readable-only');

    const withoutAccount = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-readable' });
    const accountResult = await withoutAccount.requestProposals({
      idempotency_key: 'request-proposals-readable-account-0001',
      brand: { domain: 'example.com' },
      brief: 'Readable discovery',
    });
    assert.equal(accountResult.data.outcome, 'legacy_unavailable');
    assert.equal(accountResult.data.purchase_continuation, undefined);

    products = [{ product_id: 'p-no-pricing', name: 'No pricing' }];
    const missingPricing = await withoutAccount.requestProposals({
      idempotency_key: 'request-proposals-readable-pricing-0001',
      account: { account_id: 'account-readable' },
      brand: { domain: 'example.com' },
      brief: 'Readable discovery',
    });
    assert.equal(missingPricing.data.outcome, 'legacy_unavailable');
    assert.equal(missingPricing.data.purchase_continuation, undefined);
  });

  test('runs deterministic create preflight before atomically claiming the continuation', async () => {
    const store = createInMemoryLegacyPurchaseContinuationStore();
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-preflight-claim', 'Preflight claim')] });
    agent.createMediaBuyLegacyWithPreDispatch = async () => {
      throw new Error('deterministic local preflight failed');
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-preflight-claim',
      legacyPurchaseContinuationStore: store,
    });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-preflight-claim-0001',
      account: { account_id: 'account-preflight-claim' },
      brand: { domain: 'example.com' },
      brief: 'Preflight before claim',
    });
    const token = discovery.data.purchase_continuation.continuation_token;
    await assert.rejects(
      coordinator.continueLegacyPurchase({
        idempotency_key: '16a32ab9-9d5b-4578-91eb-c9e8ef810a09',
        continuation_token: token,
        account: { account_id: 'account-preflight-claim' },
        selected_product_ids: ['p-preflight-claim'],
        accepted_losses: discovery.data.purchase_continuation.losses,
        legacy_create_request: {
          idempotency_key: 'legacy-preflight-claim-create-0001',
          account: { account_id: 'account-preflight-claim' },
          brand: { domain: 'example.com' },
          packages: [{ product_id: 'p-preflight-claim', budget: 10, pricing_option_id: 'fixed-cpm' }],
          start_time: '2099-01-01T00:00:00Z',
          end_time: '2099-02-01T00:00:00Z',
        },
      }),
      /deterministic local preflight failed/
    );
    assert.equal((await store.get(token)).operation.state, 'available');
  });

  test('rejects governance rewrites and final pricing drift before claiming the continuation', async () => {
    const issueContinuation = async suffix => {
      const store = createInMemoryLegacyPurchaseContinuationStore();
      const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
      agent.getProducts = async () =>
        completed('get_products', { products: [legacyListedProduct(`p-${suffix}`, 'Bound product')] });
      const coordinator = await agent.negotiateMediaBuyLifecycle({
        principalScope: `buyer-${suffix}`,
        legacyPurchaseContinuationStore: store,
      });
      const discovery = await coordinator.requestProposals({
        idempotency_key: `request-proposals-${suffix}`,
        account: { account_id: `account-${suffix}` },
        brand: { domain: 'example.com' },
        brief: 'Bind the final seller payload',
      });
      const input = {
        idempotency_key:
          suffix === 'governance-rewrite'
            ? 'bd71379f-1c36-41a5-8ed0-0a33a629f91f'
            : '3aa4d66a-d542-434f-8f57-bf2ed17fd717',
        continuation_token: discovery.data.purchase_continuation.continuation_token,
        account: { account_id: `account-${suffix}` },
        selected_product_ids: [`p-${suffix}`],
        accepted_losses: discovery.data.purchase_continuation.losses,
        legacy_create_request: {
          idempotency_key: `create-${suffix}`,
          account: { account_id: `account-${suffix}` },
          brand: { domain: 'example.com' },
          packages: [{ product_id: `p-${suffix}`, budget: 10, pricing_option_id: 'fixed-cpm' }],
          start_time: '2099-01-01T00:00:00Z',
          end_time: '2099-02-01T00:00:00Z',
        },
      };
      return { agent, coordinator, input, store, token: input.continuation_token };
    };

    const governance = await issueContinuation('governance-rewrite');
    governance.agent.createMediaBuyLegacyWithPreDispatch = async (params, beforeDispatch) => {
      const decision = await beforeDispatch(params, { governanceAdjusted: true });
      assert.fail(`unexpected dispatch decision: ${decision.action}`);
    };
    await assert.rejects(governance.coordinator.continueLegacyPurchase(governance.input), /cannot rewrite/i);
    assert.equal((await governance.store.get(governance.token)).operation.state, 'available');

    const pricing = await issueContinuation('pricing-drift');
    pricing.agent.createMediaBuyLegacyWithPreDispatch = async (params, beforeDispatch) => {
      const altered = {
        ...params,
        packages: params.packages.map(pkg => ({ ...pkg, pricing_option_id: 'unobserved-price' })),
      };
      const decision = await beforeDispatch(altered, { governanceAdjusted: false });
      assert.fail(`unexpected dispatch decision: ${decision.action}`);
    };
    await assert.rejects(pricing.coordinator.continueLegacyPurchase(pricing.input), /pricing options must match/i);
    assert.equal((await pricing.store.get(pricing.token)).operation.state, 'available');
  });

  for (const vector of PRODUCTS_ONLY_BRIEF_VECTORS.cases) {
    const version = vector.source_version.startsWith('2.5')
      ? '2.5'
      : vector.source_version.startsWith('3.0')
        ? '3.0'
        : '3.1';
    const productId = vector.continuation_input.selected_product_ids[0];
    test(`projects and redeems signed ${vector.source_version} products-only vector`, async () => {
      const agent = clientWithCaps(capabilities({ version }), version === '2.5' ? undefined : vector.source_version);
      const creates = [];
      agent.getProducts = async () =>
        completed(
          'get_products',
          version === '2.5' ? normalizeGetProductsResponse(vector.legacy_response) : vector.legacy_response
        );
      agent.createMediaBuyLegacy = async request => {
        creates.push(request);
        return completed('create_media_buy', validLegacyCreateResponse(vector.source_version, request, productId));
      };
      const coordinator = await agent.negotiateMediaBuyLifecycle({
        principalScope: 'buyer-acme',
        ...(version === '2.5' && { legacyPurchaseSellerSessionScope: 'seller-session-acme' }),
      });
      const projected = await coordinator.requestProposals({
        idempotency_key: 'request-proposals-vector-0001',
        account: { account_id: 'account-acme' },
        brand: { domain: 'acme.example' },
        brief: 'A premium display campaign for Acme.',
      });

      assert.equal(projected.data.outcome, 'products_available');
      assert.deepEqual(
        projected.data.products.map(({ product_id, name, description, pricing_options }) => ({
          product_id,
          name,
          description,
          pricing_options,
        })),
        vector.compact_projection.products
      );
      assert.equal(
        projected.data.purchase_continuation.source_adcp_version,
        vector.compact_projection.purchase_continuation.source_adcp_version
      );
      assert.deepEqual(
        projected.data.purchase_continuation.product_ids,
        vector.compact_projection.purchase_continuation.product_ids
      );
      assert.deepEqual(
        projected.data.purchase_continuation.losses,
        vector.compact_projection.purchase_continuation.losses
      );
      assert.equal('feed_version' in projected.data, false);
      assert.equal('proposals' in projected.data, false);

      const continuationInput = {
        ...vector.continuation_input,
        continuation_token: projected.data.purchase_continuation.continuation_token,
      };
      const purchased = await coordinator.continueLegacyPurchase(continuationInput);
      const replayed = await coordinator.continueLegacyPurchase(continuationInput);

      assert.equal(purchased.data.media_buy_id, `buy-${productId}`);
      assert.equal(replayed.data.media_buy_id, purchased.data.media_buy_id);
      assert.equal(creates.length, 1);
      assert.deepEqual(creates[0], vector.continuation_input.legacy_create_request);
    });
  }

  test('binds a v2.5 continuation to the authenticated seller session at the same endpoint', async () => {
    const vector = PRODUCTS_ONLY_BRIEF_VECTORS.cases[0];
    const store = createInMemoryLegacyPurchaseContinuationStore();
    const firstAgent = clientWithCaps(capabilities({ version: '2.5' }));
    firstAgent.getProducts = async () =>
      completed('get_products', normalizeGetProductsResponse(vector.legacy_response));
    firstAgent.createMediaBuyLegacy = async request =>
      completed(
        'create_media_buy',
        validLegacyCreateResponse(vector.source_version, request, vector.continuation_input.selected_product_ids[0])
      );
    const first = await firstAgent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-session-bound',
      legacyPurchaseSellerSessionScope: 'authenticated-session-one',
      legacyPurchaseContinuationStore: store,
    });
    const discovery = await first.requestProposals({
      account: vector.continuation_input.account,
      brand: { domain: 'acme.example' },
      brief: 'A premium display campaign for Acme.',
    });
    const input = {
      ...vector.continuation_input,
      continuation_token: discovery.data.purchase_continuation.continuation_token,
    };

    const secondAgent = clientWithCaps(capabilities({ version: '2.5' }));
    secondAgent.createMediaBuyLegacy = async () => assert.fail('session binding must fail before mutation');
    const second = await secondAgent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-session-bound',
      legacyPurchaseSellerSessionScope: 'authenticated-session-two',
      legacyPurchaseContinuationStore: store,
    });
    await assert.rejects(second.continueLegacyPurchase(input), error => error.code === 'binding_mismatch');
    assert.equal((await first.continueLegacyPurchase(input)).success, true);
  });

  test('atomically rejects a concurrent second claim and fails closed after ambiguity', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }), '3.1');
    let releaseCreate;
    const createStarted = new Promise(resolve => {
      agent.createMediaBuyLegacy = async () => {
        await new Promise(release => {
          releaseCreate = release;
          resolve();
        });
        return completed('create_media_buy', {
          media_buy_id: 'buy-concurrent',
          packages: [],
          confirmed_at: '2099-01-01T00:00:00Z',
          revision: 1,
        });
      };
    });
    agent.getProducts = async () =>
      completed('get_products', {
        products: [legacyListedProduct('p-concurrent', 'Concurrent', { description: 'Test' })],
      });
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-concurrent' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-concurrent-0001',
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
      brief: 'Test concurrent claims',
    });
    const input = {
      idempotency_key: '754d5421-52a6-4e93-8e32-917bb107fd24',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-1' },
      selected_product_ids: ['p-concurrent'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-concurrent-create-0001',
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-concurrent', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    const first = coordinator.continueLegacyPurchase(input);
    await createStarted;
    await assert.rejects(coordinator.continueLegacyPurchase(input), error => error.code === 'in_flight');
    releaseCreate();
    await first;

    const failedDiscovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-ambiguous-0001',
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
      brief: 'Test ambiguous claim',
    });
    agent.createMediaBuyLegacy = async () => {
      throw new Error('connection reset');
    };
    const ambiguousInput = {
      ...input,
      idempotency_key: '60888384-bdb4-4388-a9ce-c08597492c0c',
      continuation_token: failedDiscovery.data.purchase_continuation.continuation_token,
    };
    await assert.rejects(
      coordinator.continueLegacyPurchase(ambiguousInput),
      error => error.code === 'ambiguous' && /reconcileLegacyPurchase/.test(error.recovery)
    );
    await assert.rejects(coordinator.continueLegacyPurchase(ambiguousInput), error => error.code === 'ambiguous');
  });

  test('replays a completed operation after issuance expiry but rejects an unclaimed expired token', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    let creates = 0;
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-expiry', 'Expiry')] });
    agent.createMediaBuyLegacy = async () => {
      creates += 1;
      return completed('create_media_buy', { media_buy_id: 'buy-expiry', packages: [] });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-expiry',
      legacyPurchaseContinuationTtlMs: 10,
      legacyPurchaseOperationTtlMs: 1000,
    });
    const discover = idempotency_key =>
      coordinator.requestProposals({
        idempotency_key,
        account: { account_id: 'account-expiry' },
        brand: { domain: 'example.com' },
        brief: 'Expiry test',
      });
    const first = await discover('request-proposals-expiry-0001');
    const input = {
      idempotency_key: '26701544-60b7-4b52-8124-6ef4669ea26b',
      continuation_token: first.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-expiry' },
      selected_product_ids: ['p-expiry'],
      accepted_losses: first.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-expiry-create-0001',
        account: { account_id: 'account-expiry' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-expiry', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    await coordinator.continueLegacyPurchase(input);
    const unused = await discover('request-proposals-expiry-0002');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal((await coordinator.continueLegacyPurchase(input)).data.media_buy_id, 'buy-expiry');
    await assert.rejects(
      coordinator.continueLegacyPurchase({
        ...input,
        idempotency_key: '781a6d21-9e2b-4f3b-94b1-54d2891835b9',
        continuation_token: unused.data.purchase_continuation.continuation_token,
      }),
      error => error.code === 'expired'
    );
    assert.equal(creates, 1);
  });

  test('enforces seller binding and operation-wide idempotency across continuation tokens', async () => {
    const store = createInMemoryLegacyPurchaseContinuationStore();
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    let creates = 0;
    agent.getProducts = async () => completed('get_products', { products: [legacyListedProduct('p-bound', 'Bound')] });
    agent.createMediaBuyLegacy = async () => {
      creates += 1;
      return completed('create_media_buy', { media_buy_id: 'buy-bound', packages: [] });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-bound',
      legacyPurchaseContinuationStore: store,
    });
    const discover = idempotency_key =>
      coordinator.requestProposals({
        idempotency_key,
        account: { account_id: 'account-bound' },
        brand: { domain: 'example.com' },
        brief: 'Binding test',
      });
    const [first, second] = await Promise.all([
      discover('request-proposals-bound-0001'),
      discover('request-proposals-bound-0002'),
    ]);
    const base = {
      idempotency_key: '17cb18b0-2857-49a1-8073-9f4618f2094d',
      account: { account_id: 'account-bound' },
      selected_product_ids: ['p-bound'],
      accepted_losses: first.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-bound-create-0001',
        account: { account_id: 'account-bound' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-bound', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    await coordinator.continueLegacyPurchase({
      ...base,
      continuation_token: first.data.purchase_continuation.continuation_token,
    });
    await assert.rejects(
      coordinator.continueLegacyPurchase({
        ...base,
        continuation_token: second.data.purchase_continuation.continuation_token,
      }),
      error => error.code === 'conflict'
    );

    const otherSeller = new AgentClient(
      { ...AGENT, id: 'other-seller', agent_uri: 'https://other-seller.example/mcp' },
      { validateFeatures: false, adcpVersion: '3.0' }
    );
    otherSeller.getCapabilities = async () => capabilities({ version: '3.0' });
    otherSeller.createMediaBuyLegacy = async () => assert.fail('seller binding must fail before mutation');
    const otherCoordinator = await otherSeller.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-bound',
      legacyPurchaseContinuationStore: store,
    });
    const third = await discover('request-proposals-bound-0003');
    await assert.rejects(
      otherCoordinator.continueLegacyPurchase({
        ...base,
        idempotency_key: '6de32b73-469d-44c7-8135-387b1fe5c14d',
        continuation_token: third.data.purchase_continuation.continuation_token,
      }),
      error => error.code === 'binding_mismatch'
    );
    assert.equal(creates, 1);
  });

  test('rejects shared-vector substitution, incomplete consent, account drift, and unknown fields before mutation', async () => {
    const vector = PRODUCTS_ONLY_BRIEF_VECTORS.cases[1];
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    let creates = 0;
    agent.getProducts = async () => completed('get_products', { products: vector.compact_projection.products });
    agent.createMediaBuyLegacy = async () => {
      creates += 1;
      return completed('create_media_buy', { media_buy_id: 'must-not-run', packages: [] });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-negative' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-negative-0001',
      account: vector.continuation_input.account,
      brand: { domain: 'acme.example' },
      brief: vector.legacy_request.brief,
    });
    const valid = {
      ...vector.continuation_input,
      continuation_token: discovery.data.purchase_continuation.continuation_token,
    };
    for (const [candidate, code] of [
      [{ ...valid, selected_product_ids: ['substituted-product'] }, 'selection_mismatch'],
      [
        {
          ...valid,
          legacy_create_request: {
            ...valid.legacy_create_request,
            packages: valid.legacy_create_request.packages.map(pkg => ({
              ...pkg,
              pricing_option_id: 'substituted-pricing-option',
            })),
          },
        },
        'selection_mismatch',
      ],
      [{ ...valid, accepted_losses: ['feed_version_not_atomic'] }, 'loss_mismatch'],
      [{ ...valid, account: { account_id: 'other-account' } }, 'binding_mismatch'],
      [{ ...valid, unexpected: true }, 'request_invalid'],
    ]) {
      await assert.rejects(coordinator.continueLegacyPurchase(candidate), error => error.code === code);
    }
    assert.equal(creates, 0);
  });

  test('re-observing one async discovery returns one token and native 3.2 never emits the projection arm', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }), '3.1');
    const terminal = completed('get_products', { products: [legacyListedProduct('p-async', 'Async')] });
    agent.getProducts = async () => submitted('get_products', terminal);
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-async' });
    const pending = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-async-0001',
      account: { account_id: 'account-async' },
      brand: { domain: 'example.com' },
      brief: 'Async products',
    });
    const [first, second] = await Promise.all([
      pending.submitted.waitForCompletion(),
      pending.submitted.waitForCompletion(),
    ]);
    assert.equal(
      first.data.purchase_continuation.continuation_token,
      second.data.purchase_continuation.continuation_token
    );

    const native = clientWithCaps(
      capabilities({
        version: '3.2.0-beta.4',
        tools: COMPACT_TOOLS,
        discoveredTools: ['get_products', ...COMPACT_TOOLS],
      }),
      '3.2.0-beta.4'
    );
    native.getProducts = async () =>
      completed('get_products', { products: [{ product_id: 'p-native', name: 'Native' }] });
    const forced = await native.negotiateMediaBuyLifecycle({
      preferredLifecycle: 'established',
      principalScope: 'buyer-native',
    });
    const nativeResult = await forced.requestProposals({
      idempotency_key: 'request-proposals-native-0001',
      account: { account_id: 'account-native' },
      brand: { domain: 'example.com' },
      brief: 'Native products',
    });
    assert.equal(nativeResult.data.outcome, 'legacy_unavailable');
    assert.equal(nativeResult.data.purchase_continuation, undefined);
  });

  test('executes the signed account-fenced listed_purchase vector through native buy_products', async () => {
    const vector = PRODUCTS_ONLY_BRIEF_VECTORS.listed_purchase_cases[0];
    const agent = clientWithCaps(capabilities({ version: '3.2.0-beta.4', tools: COMPACT_TOOLS }), '3.2.0-beta.4');
    const calls = [];
    agent.buyProducts = async request => {
      calls.push(request);
      return completed('buy_products', { media_buy_id: 'buy-listed', revision: 1 });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-listed' });
    const result = await coordinator.buyProducts(vector.buy_products_request);
    assert.equal(result.data.media_buy_id, 'buy-listed');
    assert.deepEqual(calls, [vector.buy_products_request]);
    assert.equal(calls[0].feed_version, vector.compact_projection.purchase_continuation.feed_version);
    assert.equal(calls[0].pricing_version, vector.compact_projection.purchase_continuation.pricing_version);
  });

  test('reconciles an ambiguous claim from its durable natural key and rejects malformed completion', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-reconcile', 'Reconcile')] });
    let mutationMode = 'throw';
    agent.createMediaBuyLegacy = async () => {
      if (mutationMode === 'throw') throw new Error('connection lost');
      return completed('create_media_buy', undefined);
    };
    let reconciliationCalls = 0;
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-reconcile',
      reconcileLegacyPurchase: async (record, exactInput) => {
        reconciliationCalls += 1;
        assert.equal(record.operation.sourceMutationKey, 'legacy-reconcile-create-0001');
        assert.deepEqual(record.operation.selectedProductIds, ['p-reconcile']);
        assert.equal(exactInput.legacy_create_request.idempotency_key, record.operation.sourceMutationKey);
        return {
          outcome: 'completed',
          result: completed('create_media_buy', { media_buy_id: 'buy-reconciled', packages: [] }),
        };
      },
    });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-reconcile-0001',
      account: { account_id: 'account-reconcile' },
      brand: { domain: 'example.com' },
      brief: 'Reconcile products',
    });
    const input = {
      idempotency_key: '117b3ee1-8034-4195-bf64-365eaac08cb0',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-reconcile' },
      selected_product_ids: ['p-reconcile'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-reconcile-create-0001',
        account: { account_id: 'account-reconcile' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-reconcile', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    await assert.rejects(coordinator.continueLegacyPurchase(input), error => error.code === 'ambiguous');
    assert.equal((await coordinator.continueLegacyPurchase(input)).data.media_buy_id, 'buy-reconciled');
    assert.equal(reconciliationCalls, 1);

    const malformedDiscovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-malformed-0001',
      account: { account_id: 'account-reconcile' },
      brand: { domain: 'example.com' },
      brief: 'Malformed completion',
    });
    mutationMode = 'malformed';
    await assert.rejects(
      coordinator.continueLegacyPurchase({
        ...input,
        idempotency_key: 'f3aad00b-24a8-42c8-b948-3269f488032e',
        continuation_token: malformedDiscovery.data.purchase_continuation.continuation_token,
        legacy_create_request: {
          ...input.legacy_create_request,
          idempotency_key: 'legacy-malformed-create-0001',
        },
      }),
      error => error.code === 'ambiguous'
    );
  });

  test('background-observes submitted legacy purchase completion for deterministic replay', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-submitted', 'Submitted')] });
    agent.createMediaBuyLegacy = async () =>
      submitted('create_media_buy', completed('create_media_buy', { media_buy_id: 'buy-submitted', packages: [] }));
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-submitted' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-submitted-0001',
      account: { account_id: 'account-submitted' },
      brand: { domain: 'example.com' },
      brief: 'Submitted purchase',
    });
    const input = {
      idempotency_key: 'e52cf054-a288-4781-8018-c48cb8da0451',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-submitted' },
      selected_product_ids: ['p-submitted'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-submitted-create-0001',
        account: { account_id: 'account-submitted' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-submitted', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    assert.equal((await coordinator.continueLegacyPurchase(input)).status, 'submitted');
    await new Promise(resolve => setTimeout(resolve, 5));
    const replay = await coordinator.continueLegacyPurchase(input);
    assert.equal(replay.status, 'completed');
    assert.equal(replay.data.media_buy_id, 'buy-submitted');
  });

  test('shares one seller polling loop between the background observer and callers', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-shared-poll', 'Shared poll')] });
    let polls = 0;
    let finished = false;
    let originalWaits = 0;
    agent.createMediaBuyLegacy = async () => {
      const result = submitted(
        'create_media_buy',
        completed('create_media_buy', { media_buy_id: 'buy-shared-poll', packages: [] })
      );
      result.submitted.waitForCompletion = async () => {
        originalWaits += 1;
        return new Promise(() => {});
      };
      result.submitted.track = async () => {
        polls += 1;
        return {
          taskId: 'create_media_buy-task',
          status: finished ? 'completed' : 'working',
          taskType: 'create_media_buy',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(finished && { result: { media_buy_id: 'buy-shared-poll', packages: [] } }),
        };
      };
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-shared-poll' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-shared-poll-0001',
      account: { account_id: 'account-shared-poll' },
      brand: { domain: 'example.com' },
      brief: 'Shared polling',
    });
    const input = {
      idempotency_key: 'cc7f3687-3b44-4c66-9578-7580b03c6a60',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-shared-poll' },
      selected_product_ids: ['p-shared-poll'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-shared-poll-create-0001',
        account: { account_id: 'account-shared-poll' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-shared-poll', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    const pending = await coordinator.continueLegacyPurchase(input);
    const first = pending.submitted.waitForCompletion(1);
    const second = pending.submitted.waitForCompletion(1);
    assert.equal(polls, 1);
    finished = true;
    const results = await Promise.all([first, second]);
    assert.deepEqual(
      results.map(value => value.data.media_buy_id),
      ['buy-shared-poll', 'buy-shared-poll']
    );
    assert.equal(polls, 2);
    assert.equal(originalWaits, 0, 'SDK observer deadlines must never enter the remote-cancel polling path');
  });

  test('starts a fresh polling epoch after a shared input-required pause', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-shared-pause', 'Shared pause')] });
    let status = 'input-required';
    let polls = 0;
    agent.createMediaBuyLegacy = async () => {
      const result = submitted('create_media_buy', completed('create_media_buy', {}));
      result.submitted.track = async () => {
        polls += 1;
        return {
          taskId: 'create_media_buy-task',
          status,
          taskType: 'create_media_buy',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result:
            status === 'completed'
              ? { media_buy_id: 'buy-shared-pause', packages: [] }
              : { question: 'Approval required' },
        };
      };
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-shared-pause' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-shared-pause-0001',
      account: { account_id: 'account-shared-pause' },
      brand: { domain: 'example.com' },
      brief: 'Shared pause',
    });
    const pending = await coordinator.continueLegacyPurchase({
      idempotency_key: 'cb584864-ac5e-4c69-a8b0-d1d12ebf43a3',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-shared-pause' },
      selected_product_ids: ['p-shared-pause'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-shared-pause-create-0001',
        account: { account_id: 'account-shared-pause' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-shared-pause', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    });
    assert.equal((await pending.submitted.waitForCompletion(1)).status, 'input-required');
    status = 'completed';
    const completion = await pending.submitted.waitForCompletion(1);
    assert.equal(completion.status, 'completed');
    assert.equal(completion.data.media_buy_id, 'buy-shared-pause');
    assert.ok(polls >= 2);
  });

  test('rejects invalid shared polling intervals', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-poll-interval', 'Poll interval')] });
    agent.createMediaBuyLegacy = async () => submitted('create_media_buy', completed('create_media_buy', {}));
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-poll-interval' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-poll-interval-0001',
      account: { account_id: 'account-poll-interval' },
      brand: { domain: 'example.com' },
      brief: 'Poll interval validation',
    });
    const pending = await coordinator.continueLegacyPurchase({
      idempotency_key: '7e0df2b7-ebda-43a9-ace9-c0e0313a73a7',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-poll-interval' },
      selected_product_ids: ['p-poll-interval'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-poll-interval-create-0001',
        account: { account_id: 'account-poll-interval' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-poll-interval', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    });
    await assert.rejects(pending.submitted.waitForCompletion(Number.NaN), RangeError);
    await assert.rejects(pending.submitted.waitForCompletion(-1), RangeError);
    await assert.rejects(pending.submitted.waitForCompletion(2_147_483_648), RangeError);
  });

  test('treats a seller tracking RangeError as durable mutation uncertainty', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-track-range', 'Track range')] });
    agent.createMediaBuyLegacy = async () => {
      const result = submitted('create_media_buy', completed('create_media_buy', {}));
      result.submitted.track = async () => {
        throw new RangeError('protocol response exceeded parser bounds');
      };
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-track-range' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-track-range-0001',
      account: { account_id: 'account-track-range' },
      brand: { domain: 'example.com' },
      brief: 'Track RangeError',
    });
    const input = {
      idempotency_key: '0c4ff6ce-d295-485e-bb69-a1badb0badf3',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-track-range' },
      selected_product_ids: ['p-track-range'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-track-range-create-0001',
        account: { account_id: 'account-track-range' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-track-range', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    const pending = await coordinator.continueLegacyPurchase(input);
    await assert.rejects(pending.submitted.waitForCompletion(1), error => error.code === 'ambiguous');
    await assert.rejects(coordinator.continueLegacyPurchase(input), error => error.code === 'ambiguous');
  });

  test('keeps shared observation authoritative when one caller aborts', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-abort-poll', 'Abort poll')] });
    let finished = false;
    let polls = 0;
    let originalWaits = 0;
    agent.createMediaBuyLegacy = async () => {
      const result = submitted(
        'create_media_buy',
        completed('create_media_buy', { media_buy_id: 'buy-abort-poll', packages: [] })
      );
      result.submitted.waitForCompletion = async () => {
        originalWaits += 1;
        return new Promise(() => {});
      };
      result.submitted.track = async () => {
        polls += 1;
        return {
          taskId: 'create_media_buy-task',
          status: finished ? 'completed' : 'working',
          taskType: 'create_media_buy',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(finished && { result: { media_buy_id: 'buy-abort-poll', packages: [] } }),
        };
      };
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-abort-poll' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-abort-poll-0001',
      account: { account_id: 'account-abort-poll' },
      brand: { domain: 'example.com' },
      brief: 'Abort polling',
    });
    const input = {
      idempotency_key: '898176bd-d07f-45cd-9267-6b8d87cc028d',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-abort-poll' },
      selected_product_ids: ['p-abort-poll'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-abort-poll-create-0001',
        account: { account_id: 'account-abort-poll' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-abort-poll', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    const pending = await coordinator.continueLegacyPurchase(input);
    await new Promise(resolve => setTimeout(resolve, 5));
    const backgroundPolls = polls;
    const abort = new AbortController();
    const stopped = pending.submitted.waitForCompletion(1, abort.signal);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(polls > backgroundPolls, 'caller cadence should accelerate the shared observer');
    abort.abort('caller stopped waiting');
    await assert.rejects(stopped, error => error.name === 'AbortError');
    const pollsAfterAbort = polls;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(polls <= pollsAfterAbort + 1, 'background observer must not retain the departed caller cadence');

    finished = true;
    const completion = await pending.submitted.waitForCompletion(1);
    assert.equal(completion.status, 'completed');
    assert.equal(completion.data.media_buy_id, 'buy-abort-poll');
    assert.equal(originalWaits, 0);
  });

  test('does not let the background observation deadline shorten an active caller wait', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-deadline-poll', 'Deadline poll')] });
    let finished = false;
    let originalWaits = 0;
    agent.createMediaBuyLegacy = async () => {
      const result = submitted(
        'create_media_buy',
        completed('create_media_buy', { media_buy_id: 'buy-deadline-poll', packages: [] })
      );
      result.submitted.waitForCompletion = async () => {
        originalWaits += 1;
        return new Promise(() => {});
      };
      result.submitted.track = async () => ({
        taskId: 'create_media_buy-task',
        status: finished ? 'completed' : 'working',
        taskType: 'create_media_buy',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(finished && { result: { media_buy_id: 'buy-deadline-poll', packages: [] } }),
      });
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-deadline-poll',
      legacyPurchaseOperationTtlMs: 15,
    });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-deadline-poll-0001',
      account: { account_id: 'account-deadline-poll' },
      brand: { domain: 'example.com' },
      brief: 'Deadline polling',
    });
    const input = {
      idempotency_key: 'd987f636-37c2-4bd5-9098-f0b962ab19a1',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-deadline-poll' },
      selected_product_ids: ['p-deadline-poll'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-deadline-poll-create-0001',
        account: { account_id: 'account-deadline-poll' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-deadline-poll', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    const pending = await coordinator.continueLegacyPurchase(input);
    await new Promise(resolve => setTimeout(resolve, 5));
    const completion = pending.submitted.waitForCompletion(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    finished = true;
    const terminal = await completion;
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.data.media_buy_id, 'buy-deadline-poll');
    assert.equal(originalWaits, 0);
  });

  test('does not mark a claim ambiguous when an abandoned background poll rejects late', async () => {
    const store = createInMemoryLegacyPurchaseContinuationStore();
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-late-rejection', 'Late rejection')] });
    let rejectTrack;
    let markTrackStarted;
    const trackStarted = new Promise(resolve => {
      markTrackStarted = resolve;
    });
    agent.createMediaBuyLegacy = async () => {
      const result = submitted('create_media_buy', completed('create_media_buy', {}));
      result.submitted.track = async () =>
        new Promise((_, reject) => {
          rejectTrack = reject;
          markTrackStarted();
        });
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-late-rejection',
      legacyPurchaseContinuationStore: store,
      legacyPurchaseOperationTtlMs: 15,
    });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-late-rejection-0001',
      account: { account_id: 'account-late-rejection' },
      brand: { domain: 'example.com' },
      brief: 'Late poll rejection',
    });
    const token = discovery.data.purchase_continuation.continuation_token;
    const input = {
      idempotency_key: '31b9774c-7d27-4587-aefd-2ff93ee89535',
      continuation_token: token,
      account: { account_id: 'account-late-rejection' },
      selected_product_ids: ['p-late-rejection'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-late-rejection-create-0001',
        account: { account_id: 'account-late-rejection' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-late-rejection', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    assert.equal((await coordinator.continueLegacyPurchase(input)).status, 'submitted');
    await trackStarted;
    await new Promise(resolve => setTimeout(resolve, 25));
    rejectTrack(new Error('late tasks/get rejection'));
    await new Promise(resolve => setImmediate(resolve));

    const record = await store.get(token);
    assert.equal(record.operation.state, 'claimed');
  });

  test('persists a completed transport task with an AdCP error payload as a failed replay', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-operation-error', 'Operation error')] });
    const operationError = {
      adcp_error: { code: 'BUDGET_INVALID', message: 'Budget rejected' },
      context: { correlation_id: 'correlation-operation-error' },
    };
    agent.createMediaBuyLegacy = async () => {
      const result = submitted('create_media_buy', completed('create_media_buy', operationError));
      result.submitted.track = async () => ({
        taskId: 'create_media_buy-task',
        status: 'completed',
        taskType: 'create_media_buy',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: operationError,
      });
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-operation-error' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-operation-error-0001',
      account: { account_id: 'account-operation-error' },
      brand: { domain: 'example.com' },
      brief: 'Operation error replay',
    });
    const input = {
      idempotency_key: 'e5fc47d0-f308-439c-be46-213b3bf550f2',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-operation-error' },
      selected_product_ids: ['p-operation-error'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-operation-error-create-0001',
        account: { account_id: 'account-operation-error' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-operation-error', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    const pending = await coordinator.continueLegacyPurchase(input);
    const failure = await pending.submitted.waitForCompletion(1);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.error, 'Budget rejected');
    assert.equal(failure.adcpError.code, 'BUDGET_INVALID');
    assert.equal(failure.correlationId, 'correlation-operation-error');
    assert.deepEqual(failure.data, operationError);

    const replay = await coordinator.continueLegacyPurchase(input);
    assert.equal(replay.status, 'failed');
    assert.equal(replay.error, 'Budget rejected');
    assert.equal(replay.adcpError.code, 'BUDGET_INVALID');
    assert.equal(replay.correlationId, 'correlation-operation-error');
    assert.deepEqual(replay.data, operationError);
  });

  test('fences an immediate unstructured failure as ambiguous instead of replaying it', async () => {
    const store = createInMemoryLegacyPurchaseContinuationStore();
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-malformed-completion', 'Malformed')] });
    agent.createMediaBuyLegacy = async () => ({
      ...completed('create_media_buy', { media_buy_id: 'possibly-created' }),
      success: false,
      status: 'failed',
      error: 'Schema validation failed: packages is required',
      metadata: {
        ...completed('create_media_buy', {}).metadata,
        status: 'failed',
      },
    });
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-malformed-completion',
      legacyPurchaseContinuationStore: store,
    });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-malformed-completion-0001',
      account: { account_id: 'account-malformed-completion' },
      brand: { domain: 'example.com' },
      brief: 'Malformed completion',
    });
    const token = discovery.data.purchase_continuation.continuation_token;
    const input = {
      idempotency_key: '6919bb43-64f3-4a70-b264-8df0f023fce1',
      continuation_token: token,
      account: { account_id: 'account-malformed-completion' },
      selected_product_ids: ['p-malformed-completion'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-malformed-completion-create-0001',
        account: { account_id: 'account-malformed-completion' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-malformed-completion', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };

    await assert.rejects(
      coordinator.continueLegacyPurchase(input),
      error => error.code === 'ambiguous' && /not an authoritative structured AdCP error/.test(error.message)
    );
    assert.equal((await store.get(token)).operation.state, 'ambiguous');
    await assert.rejects(coordinator.continueLegacyPurchase(input), error => error.code === 'ambiguous');
  });

  test('keeps an unrecognizable tracked task fail-closed as ambiguous', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () =>
      completed('get_products', { products: [legacyListedProduct('p-unknown-task', 'Unknown task')] });
    agent.createMediaBuyLegacy = async () => {
      const result = submitted('create_media_buy', completed('create_media_buy', {}));
      result.submitted.track = async () => ({
        taskId: 'create_media_buy-task',
        status: 'unknown',
        taskType: 'unknown',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-unknown-task' });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-unknown-task-0001',
      account: { account_id: 'account-unknown-task' },
      brand: { domain: 'example.com' },
      brief: 'Unknown tracked task',
    });
    const input = {
      idempotency_key: 'd73411da-982c-4448-ab18-49c5b1c53450',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-unknown-task' },
      selected_product_ids: ['p-unknown-task'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-unknown-task-create-0001',
        account: { account_id: 'account-unknown-task' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-unknown-task', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    const pending = await coordinator.continueLegacyPurchase(input);
    await assert.rejects(pending.submitted.waitForCompletion(1), error => error.code === 'ambiguous');
    await assert.rejects(coordinator.continueLegacyPurchase(input), error => error.code === 'ambiguous');
  });

  test('returns the persisted terminal winner when submitted observers race', async () => {
    const baseStore = createInMemoryLegacyPurchaseContinuationStore();
    const winner = completed('create_media_buy', { media_buy_id: 'buy-persisted-winner', packages: [] });
    const store = {
      create: record => baseStore.create(record),
      get: token => baseStore.get(token),
      claim: (token, request) => baseStore.claim(token, request),
      complete: (token, claim) => baseStore.complete(token, claim, winner),
      recordSubmittedTask: (token, claim, taskId) => baseStore.recordSubmittedTask(token, claim, taskId),
      markAmbiguous: (token, claim, reason) => baseStore.markAmbiguous(token, claim, reason),
    };
    const agent = clientWithCaps(capabilities({ version: '3.0' }), '3.0');
    agent.getProducts = async () => completed('get_products', { products: [legacyListedProduct('p-race', 'Race')] });
    agent.createMediaBuyLegacy = async () => {
      const result = submitted(
        'create_media_buy',
        completed('create_media_buy', { media_buy_id: 'buy-losing-observer', packages: [] })
      );
      result.submitted.waitForCompletion = async () => new Promise(() => {});
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-race',
      legacyPurchaseContinuationStore: store,
    });
    const discovery = await coordinator.requestProposals({
      idempotency_key: 'request-proposals-race-0001',
      account: { account_id: 'account-race' },
      brand: { domain: 'example.com' },
      brief: 'Race purchase observers',
    });
    const input = {
      idempotency_key: '54ec2250-c4d0-4f03-a669-e77821fb3c7e',
      continuation_token: discovery.data.purchase_continuation.continuation_token,
      account: { account_id: 'account-race' },
      selected_product_ids: ['p-race'],
      accepted_losses: discovery.data.purchase_continuation.losses,
      legacy_create_request: {
        idempotency_key: 'legacy-race-create-0001',
        account: { account_id: 'account-race' },
        brand: { domain: 'example.com' },
        packages: [{ product_id: 'p-race', budget: 10, pricing_option_id: 'fixed-cpm' }],
        start_time: '2099-01-01T00:00:00Z',
        end_time: '2099-02-01T00:00:00Z',
      },
    };
    const pending = await coordinator.continueLegacyPurchase(input);
    const tracked = await pending.submitted.track();
    assert.equal(tracked.result.media_buy_id, 'buy-persisted-winner');
    assert.equal((await coordinator.continueLegacyPurchase(input)).data.media_buy_id, 'buy-persisted-winner');
  });

  test('preserves the original durable claim descriptor through submitted, ambiguous, and completed states', async () => {
    const store = createInMemoryLegacyPurchaseContinuationStore();
    const claim = {
      idempotencyKey: 'claim-key',
      inputFingerprint: 'input-fingerprint',
      operationKey: 'operation-key',
      claimedAt: '2027-01-01T00:00:00Z',
      replayExpiresAt: '2099-01-01T00:00:00Z',
      selectedProductIds: ['p-store'],
      sourceMutationKey: 'source-key',
    };
    const binding = {
      principalScope: 'principal',
      accountScope: 'account',
      sellerScope: 'seller',
      clientSessionScope: 'session',
      sourceAdcpVersion: '3.0',
    };
    const created = await store.create({
      ...binding,
      token: 'store-preservation-token',
      expiresAt: '2099-01-01T00:00:00Z',
      issuanceFingerprint: 'issuance',
      discoveryRequestFingerprint: 'discovery',
      observedResponse: { products: [{ product_id: 'p-store' }] },
      productIds: ['p-store'],
      losses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
      operation: { state: 'available' },
    });
    assert.equal(created.outcome, 'created');
    assert.equal((await store.claim('store-preservation-token', { claim, expected: binding })).outcome, 'claimed');
    assert.equal(await store.recordSubmittedTask('store-preservation-token', claim, 'seller-task-1'), true);
    assert.equal(await store.markAmbiguous('store-preservation-token', claim, 'transport'), true);
    const ambiguous = await store.get('store-preservation-token');
    assert.equal(ambiguous.operation.claimedAt, claim.claimedAt);
    assert.equal(ambiguous.operation.replayExpiresAt, claim.replayExpiresAt);
    assert.equal(ambiguous.operation.sellerTaskId, 'seller-task-1');
    await store.complete('store-preservation-token', claim, winnerForStore());
    const completedRecord = await store.get('store-preservation-token');
    assert.equal(completedRecord.operation.claimedAt, claim.claimedAt);
    assert.equal(completedRecord.operation.replayExpiresAt, claim.replayExpiresAt);
    assert.equal(completedRecord.operation.sellerTaskId, 'seller-task-1');

    function winnerForStore() {
      return completed('create_media_buy', { media_buy_id: 'buy-store', packages: [] });
    }
  });
});

describe('MediaBuyLifecycleCoordinator mutation boundaries', () => {
  const directIntent = {
    idempotency_key: 'direct-compat-key-0001',
    account: { account_id: 'account-1' },
    brand: { domain: 'example.com' },
    feed_version: 'feed-1',
    pricing_version: 'price-1',
    purchases: [{ product_id: 'product-1', pricing_option_id: 'option-1', budget: 100 }],
    start_time: '2027-01-01T00:00:00Z',
    end_time: '2027-02-01T00:00:00Z',
  };

  test('legacy direct buy rejects named snapshot losses before mutation by default', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    await assert.rejects(coordinator.buyProducts(directIntent), error => {
      assert.ok(error instanceof MediaBuyLifecycleCompatibilityError);
      assert.equal(error.code, 'UNSUPPORTED_FEATURE');
      assert.deepEqual(error.losses, ['feed_version_not_atomic', 'pricing_version_not_atomic']);
      return true;
    });
    assert.equal(mutations, 0);
  });

  test('explicitly accepted direct-buy losses are reported and preserve the retry key', async () => {
    const agent = clientWithCaps(capabilities({ version: '2.5' }));
    const calls = [];
    agent.createMediaBuy = async request => {
      calls.push(request);
      return completed('create_media_buy', { media_buy_id: 'mb-1', revision: 1 });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
    });

    const result = await coordinator.buyProducts(directIntent);

    assert.equal(result.success, true);
    assert.equal(result.compatibility.compatibility, 'lossy_projection');
    assert.deepEqual(result.compatibility.tools_used, ['create_media_buy']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].idempotency_key, directIntent.idempotency_key);
    assert.equal(calls[0].packages[0].product_id, 'product-1');
    assert.equal(calls[0].feed_version, undefined);
  });

  test('3.0/3.1 projections reject compact-only request fields before dispatch', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let proposalReads = 0;
    let mutations = 0;
    agent.getProducts = async () => {
      proposalReads += 1;
      return completed('get_products', { proposals: [] });
    };
    agent.createMediaBuy = agent.updateMediaBuy = async () => {
      mutations += 1;
      return completed('mutation', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
    });

    await assert.rejects(
      coordinator.requestProposals({ brief: 'test', criteria: { targeting_overlay: {} } }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'targeting_overlay'
    );
    await assert.rejects(
      coordinator.buyProducts({ ...directIntent, budget_allocation: { mode: 'fixed' } }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'budget_allocation'
    );
    await assert.rejects(
      coordinator.buyProducts({ ...directIntent, total_budget: { amount: 100, currency: 'USD' } }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'total_budget'
    );
    for (const field of ['measurement_terms', 'optimization_goals', 'performance_standards']) {
      await assert.rejects(
        coordinator.buyProducts({
          ...directIntent,
          purchases: [{ ...directIntent.purchases[0], [field]: {} }],
        }),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === `purchases[0].${field}`
      );
    }
    await assert.rejects(
      coordinator.listProducts({ brand: { domain: 'example.com', countries: ['US'] } }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'brand.countries'
    );
    await assert.rejects(
      coordinator.buyProducts({
        ...directIntent,
        account: {
          brand: { domain: 'example.com' },
          operator: 'example.com',
          currency: 'USD',
        },
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'account.currency'
    );
    await assert.rejects(
      coordinator.requestProposals({
        brief: 'test',
        criteria: { offer_filters: { is_fixed_price: false } },
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.feature === 'criteria.offer_filters.is_fixed_price'
    );
    await assert.rejects(
      coordinator.requestProposals({
        brief: 'test',
        criteria: {
          offer_filters: {
            required_performance_standards: [
              {
                metric: 'viewability',
                threshold: 0.7,
                vendor: { domain: 'measurement.example', countries: ['US'] },
              },
            ],
          },
        },
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.feature === 'criteria.offer_filters.required_performance_standards[0].vendor.countries'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        total_budget: { amount: 200, currency: 'USD' },
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'total_budget'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        packages: [{ package_id: 'package-1', bidding: { automatic: true } }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'bidding'
    );

    assert.equal(proposalReads, 0);
    assert.equal(mutations, 0);
  });

  test('compatibility diagnostics escape and cap buyer-controlled field names', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const coordinator = await agent.negotiateMediaBuyLifecycle();
    const hostileField = `future\n\u001b[31m\u061c\u202e${'x'.repeat(3000)}`;

    await assert.rejects(coordinator.listProducts({ [hostileField]: true }), error => {
      assert.ok(error instanceof MediaBuyLifecycleCompatibilityError);
      assert.doesNotMatch(error.feature, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      assert.match(error.feature, /\\u000a\\u001b\[31m\\u061c\\u202e/);
      assert.ok(error.feature.length < 550);
      assert.ok(error.message.length < 2100);
      return true;
    });
  });

  test('auto-negotiated established validation errors identify the established lifecycle', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
    });

    await assert.rejects(coordinator.buyProducts({ ...directIntent, brand: 'not-an-object' }), error => {
      assert.ok(error instanceof MediaBuyLifecycleCompatibilityError);
      assert.equal(error.feature, 'compact_request_validation');
      assert.equal(error.lifecycle, 'established');
      return true;
    });
    assert.equal(mutations, 0);
  });

  test('v2.5 products-only proposal reads are supported while proposal mutations remain unsupported', async () => {
    const agent = clientWithCaps(capabilities({ version: '2.5' }));
    let reads = 0;
    const updates = [];
    agent.getProducts = async () => {
      reads += 1;
      return completed('get_products', {});
    };
    agent.updateMediaBuy = async request => {
      updates.push(request);
      return completed('update_media_buy', { media_buy_id: request.media_buy_id });
    };
    const strict = await agent.negotiateMediaBuyLifecycle();
    const requested = await strict.requestProposals({ brief: 'test' });
    assert.equal(requested.data.outcome, 'legacy_unavailable');
    for (const operation of [
      () => strict.refineProposals({ refinements: [{ proposal_id: 'p1', action: 'revise', ask: 'test' }] }),
      () => strict.declineProposals({ declines: [{ proposal_id: 'p1', reason: 'other' }] }),
      () => strict.acceptProposal({ account: { account_id: 'account-1' }, proposal_id: 'p1' }),
    ]) {
      await assert.rejects(
        operation(),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_lifecycle'
      );
    }
    await assert.rejects(
      strict.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        paused: true,
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.losses.includes('revision_not_atomic')
    );
    const optedIn = await agent.negotiateMediaBuyLifecycle({ allowedLosses: ['revision_not_atomic'] });
    await assert.rejects(
      optedIn.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        packages: [{ package_id: 'package-1', canceled: true }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'packages[0].canceled'
    );

    const result = await optedIn.controlMediaBuy({
      account: { account_id: 'account-1' },
      media_buy_id: 'mb-1',
      revision: 1,
      paused: true,
    });
    assert.equal(reads, 1);
    assert.equal(updates.length, 1);
    assert.deepEqual(result.compatibility.losses, ['revision_not_atomic']);
  });

  test('v2.5 rejects unsupported create and update fields instead of relying on permissive schemas', async () => {
    const agent = clientWithCaps(capabilities({ version: '2.5' }));
    let mutations = 0;
    agent.createMediaBuy = agent.updateMediaBuy = async () => {
      mutations += 1;
      return completed('mutation', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic', 'revision_not_atomic'],
    });

    for (const field of [
      'context',
      'start_time',
      'end_time',
      'measurement_terms',
      'performance_standards',
      'agency_estimate_number',
    ]) {
      await assert.rejects(
        coordinator.buyProducts({
          ...directIntent,
          purchases: [
            {
              ...directIntent.purchases[0],
              [field]: field === 'context' ? { buyer_ref: 'line-1' } : directIntent.start_time,
            },
          ],
        }),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === `purchases[0].${field}`
      );
    }
    for (const field of [
      'advertiser_industry',
      'agency_estimate_number',
      'invoice_recipient',
      'push_notification_config',
    ]) {
      await assert.rejects(
        coordinator.buyProducts({
          ...directIntent,
          [field]: ['invoice_recipient', 'push_notification_config'].includes(field) ? {} : 'unsupported',
        }),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === field
      );
    }
    await assert.rejects(
      coordinator.buyProducts({
        ...directIntent,
        purchases: [
          {
            ...directIntent.purchases[0],
            targeting_overlay: { geo_countries: ['US'] },
          },
        ],
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'purchases[0].targeting_overlay'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        reporting_webhook: { url: 'https://example.com/report' },
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'reporting_webhook'
    );
    await assert.rejects(
      coordinator.buyProducts({
        ...directIntent,
        reporting_webhook: { requested_metrics: ['roas'] },
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'reporting_webhook.requested_metrics'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        push_notification_config: { url: 'https://example.com/tasks' },
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.feature === 'push_notification_config.authentication'
    );
    assert.equal(mutations, 0);
  });

  test('forced established 3.2 lane retains fields that the 3.2 established schemas support', async () => {
    const agent = clientWithCaps(
      capabilities({ tools: [...COMPACT_TOOLS, 'get_products', 'create_media_buy', 'update_media_buy'] })
    );
    const calls = [];
    agent.createMediaBuy = async request => {
      calls.push(request);
      return completed('create_media_buy', { media_buy_id: 'mb-1' });
    };
    agent.updateMediaBuy = async request => {
      calls.push(request);
      return completed('update_media_buy', { media_buy_id: 'mb-1', revision: 2 });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      preferredLifecycle: 'established',
      allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
    });

    await coordinator.buyProducts({
      ...directIntent,
      purchases: [
        {
          ...directIntent.purchases[0],
          context: { buyer_ref: 'line-1' },
          daily_budget_cap: 25,
          impressions: 1000,
          pacing: 'even',
        },
      ],
      daily_budget_cap: 50,
      budget_cap_timezone: 'UTC',
      pacing: 'even',
      bidding: { automatic: true },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].daily_budget_cap, 50);
    assert.deepEqual(calls[0].bidding, { automatic: true });
    assert.deepEqual(calls[0].packages[0].context, { buyer_ref: 'line-1' });
    assert.equal(calls[0].packages[0].daily_budget_cap, 25);
    assert.equal(calls[0].packages[0].impressions, 1000);
    assert.equal(calls[0].packages[0].pacing, 'even');

    await coordinator.controlMediaBuy({
      account: { account_id: 'account-1' },
      media_buy_id: 'mb-1',
      revision: 1,
      packages: [{ package_id: 'package-1', bidding: { automatic: true }, daily_budget_cap: 10 }],
    });
    assert.deepEqual(calls[1].packages[0].bidding, { automatic: true });
    assert.equal(calls[1].packages[0].daily_budget_cap, 10);

    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 2,
        packages: [{ package_id: 'package-1', catalog_ids: ['catalog-1'] }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'packages[0].catalog_ids'
    );
  });

  test('compact direct buy dispatches only buy_products', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    const calls = [];
    agent.buyProducts = async request => {
      calls.push(['buy_products', request]);
      return completed('buy_products', { media_buy_id: 'mb-compact', revision: 1 });
    };
    agent.createMediaBuy = async request => {
      calls.push(['create_media_buy', request]);
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    const result = await coordinator.buyProducts(directIntent);

    assert.deepEqual(
      calls.map(call => call[0]),
      ['buy_products']
    );
    assert.equal(result.compatibility.compatibility, 'native');
  });

  test('compact lane dispatches every lifecycle operation without established aliases', async () => {
    const agent = clientWithCaps(
      capabilities({ tools: COMPACT_TOOLS, discoveredTools: ['get_media_buys', 'get_media_buy_delivery'] })
    );
    const calls = [];
    for (const [method, tool, data] of [
      ['listProducts', 'list_products', { products: [], feed_version: 'feed-1' }],
      ['requestProposals', 'request_proposals', { outcome: 'rejected', reason: 'no match' }],
      [
        'refineProposals',
        'refine_proposals',
        {
          products: [],
          results: [
            {
              source_proposal_id: 'proposal-1',
              outcome: 'unable',
              reason_code: 'commercially_declined',
              reason: 'no match',
            },
          ],
        },
      ],
      ['declineProposals', 'decline_proposals', { results: [{ proposal_id: 'proposal-2', outcome: 'declined' }] }],
      ['buyProducts', 'buy_products', { media_buy_id: 'mb-1' }],
      ['acceptProposal', 'accept_proposal', { media_buy_id: 'mb-2' }],
      ['controlMediaBuy', 'control_media_buy', { media_buy_id: 'mb-1', revision: 2 }],
      ['getMediaBuys', 'get_media_buys', { media_buys: [] }],
      ['getMediaBuyDelivery', 'get_media_buy_delivery', { media_buy_deliveries: [] }],
    ]) {
      agent[method] = async () => {
        calls.push(tool);
        return completed(tool, data);
      };
    }
    agent.getProducts = async () => assert.fail('compact lane must not call get_products');
    agent.createMediaBuy = async () => assert.fail('compact lane must not call create_media_buy');
    agent.updateMediaBuy = async () => assert.fail('compact lane must not call update_media_buy');

    const coordinator = await agent.negotiateMediaBuyLifecycle();
    await coordinator.listProducts({});
    await coordinator.requestProposals({ brand: { domain: 'example.com' }, brief: 'proposal request' });
    await coordinator.refineProposals({ refinements: [{ proposal_id: 'proposal-1', action: 'finalize' }] });
    await coordinator.declineProposals({ declines: [{ proposal_id: 'proposal-2', reason: 'budget_changed' }] });
    await coordinator.buyProducts(directIntent);
    await coordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-1',
      proposal_terms_digest: `sha256:${'A'.repeat(43)}`,
    });
    await coordinator.controlMediaBuy({
      account: { account_id: 'account-1' },
      media_buy_id: 'mb-1',
      revision: 1,
    });
    await coordinator.getMediaBuys({ account: { account_id: 'account-1' } });
    await coordinator.getMediaBuyDelivery({ account: { account_id: 'account-1' } });

    assert.deepEqual(calls, [
      'list_products',
      'request_proposals',
      'refine_proposals',
      'decline_proposals',
      'buy_products',
      'accept_proposal',
      'control_media_buy',
      'get_media_buys',
      'get_media_buy_delivery',
    ]);
  });

  test('compact proposal advisory errors preserve successful safe proposal snapshots', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    const pricing = {
      pricing_option_id: 'compact-advisory-price',
      pricing_model: 'cpm',
      currency: 'USD',
      fixed_price: 10,
    };
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      purchases: [
        {
          product_id: 'compact-advisory-product',
          pricing_option_id: pricing.pricing_option_id,
          pricing,
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
        },
      ],
    };
    agent.requestProposals = async () =>
      completed('request_proposals', {
        outcome: 'proposed',
        status: 'completed',
        proposals: [
          {
            proposal_id: 'compact-advisory-proposal',
            proposal_kind: 'new_media_buy',
            proposal_status: 'draft',
            name: 'Compact advisory proposal',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: commercialTerms,
            terms_digest: proposalTermsDigest(commercialTerms),
          },
        ],
        products: [
          {
            product_id: 'compact-advisory-product',
            name: 'Compact advisory product',
            pricing_options: [pricing],
          },
        ],
        errors: [{ code: 'PARTIAL_AVAILABILITY', message: 'One alternative was unavailable' }],
      });
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-compact-advisory',
    });

    const result = await coordinator.requestProposals({
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
      brief: 'proposal with advisory',
    });

    assert.equal(result.data.proposals[0].proposal_id, 'compact-advisory-proposal');
    assert.equal(coordinator.proposalSnapshotStore.entries.size, 1);
    assert.equal([...coordinator.proposalSnapshotStore.entries.values()][0].proposal.proposal_status, 'draft');
  });

  test('compact validation failures report the compact lifecycle before dispatch', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    let calls = 0;
    agent.requestProposals = async () => {
      calls += 1;
      return completed('request_proposals', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    await assert.rejects(coordinator.requestProposals({ brief: '' }), error => {
      assert.ok(error instanceof MediaBuyLifecycleCompatibilityError);
      assert.equal(error.feature, 'compact_request_validation');
      assert.equal(error.lifecycle, 'compact');
      return true;
    });
    assert.equal(calls, 0);
  });

  test('async task states keep compatibility provenance without fabricating completed data', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () => working('get_products');
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    const result = await coordinator.requestProposals({ brief: 'async proposal request' });

    assert.equal(result.status, 'working');
    assert.deepEqual(result.data, { task_id: 'get_products-task' });
    assert.deepEqual(result.compatibility.tools_used, ['get_products']);
    assert.equal(result.compatibility.lifecycle, 'established');
  });

  test('working and webhook completion is ingested through AgentClient task updates', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const taskListeners = new Set();
    agent.onTaskUpdate = listener => {
      taskListeners.add(listener);
      return () => {
        taskListeners.delete(listener);
      };
    };
    agent.getProducts = async () => working('get_products');
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: 'mb-working', revision: 1 });
    };
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const digest = proposalTermsDigest(commercialTerms);
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await coordinator.requestProposals({ brief: 'working proposal', account: { account_id: 'account-1' } });
    assert.equal(taskListeners.size, 1);
    const taskUpdate = Object.freeze({
      taskId: 'get_products-task',
      status: 'completed',
      taskType: 'get_products',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: {
        proposals: [
          {
            proposal_id: 'working-proposal-1',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            terms_digest: digest,
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: commercialTerms,
          },
        ],
      },
    });
    for (const listener of [...taskListeners]) listener(taskUpdate);

    await coordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: 'working-proposal-1',
      proposal_terms_digest: digest,
    });
    assert.equal(mutations, 1);
  });

  test('a proposal completion racing dispatch return is captured before the long-lived listener', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const taskListeners = new Set();
    agent.onTaskUpdate = listener => {
      taskListeners.add(listener);
      return () => {
        taskListeners.delete(listener);
      };
    };
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const digest = proposalTermsDigest(commercialTerms);
    agent.getProducts = async () => {
      const update = {
        taskId: 'get_products-task',
        status: 'completed',
        taskType: 'get_products',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: {
          proposals: [
            {
              proposal_id: 'raced-proposal-1',
              proposal_kind: 'new_media_buy',
              proposal_status: 'committed',
              terms_digest: digest,
              expires_at: '2099-12-31T23:59:59Z',
              commercial_terms: commercialTerms,
            },
          ],
        },
      };
      for (const listener of [...taskListeners]) listener(update);
      return working('get_products');
    };
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: 'mb-raced', revision: 1 });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });

    await coordinator.requestProposals({ brief: 'raced proposal', account: { account_id: 'account-1' } });
    assert.equal(taskListeners.size, 0);
    await coordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: 'raced-proposal-1',
      proposal_terms_digest: digest,
    });

    assert.equal(mutations, 1);
  });

  for (const terminalStatus of ['input-required', 'auth-required', 'deferred', 'governance-denied', 'aborted']) {
    test(`${terminalStatus} proposal task update releases its listener`, async () => {
      const agent = clientWithCaps(capabilities({ version: '3.1' }));
      const taskListeners = new Set();
      agent.onTaskUpdate = listener => {
        taskListeners.add(listener);
        return () => {
          taskListeners.delete(listener);
        };
      };
      agent.getProducts = async () => working('get_products');
      const update = {
        taskId: 'get_products-task',
        status: terminalStatus,
        taskType: 'get_products',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-1' });

      await coordinator.requestProposals({ brief: 'paused proposal request' });
      assert.equal(taskListeners.size, 1);
      for (const listener of [...taskListeners]) listener(update);

      assert.equal(taskListeners.size, 0);
    });
  }

  test('terminal proposal failures do not leave a task-update listener attached', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const taskListeners = new Set();
    agent.onTaskUpdate = listener => {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    };
    agent.getProducts = async () => failed('get_products');
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-1' });

    const result = await coordinator.requestProposals({ brief: 'failed proposal request' });

    assert.equal(result.status, 'failed');
    assert.equal(taskListeners.size, 0);
  });

  test('dispose releases a permanently working proposal listener', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const taskListeners = new Set();
    agent.onTaskUpdate = listener => {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    };
    agent.getProducts = async () => working('get_products');
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-1' });

    await coordinator.requestProposals({ brief: 'working forever' });
    assert.equal(taskListeners.size, 1);
    coordinator.dispose();

    assert.equal(taskListeners.size, 0);
  });

  test('submitted proposal completion is projected and retained before established acceptance', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const digest = proposalTermsDigest(commercialTerms);
    const terminal = completed('get_products', {
      proposals: [
        {
          proposal_id: 'async-proposal-1',
          proposal_kind: 'new_media_buy',
          proposal_status: 'committed',
          terms_digest: digest,
          expires_at: '2099-12-31T23:59:59Z',
          commercial_terms: commercialTerms,
        },
      ],
    });
    agent.getProducts = async () => submitted('get_products', terminal);
    const mutations = [];
    agent.createMediaBuy = async request => {
      mutations.push(request);
      return completed('create_media_buy', { media_buy_id: 'mb-async', revision: 1 });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });

    const pending = await coordinator.requestProposals({
      brief: 'async proposal request',
      account: { account_id: 'account-1' },
    });
    const tracked = await pending.submitted.track();
    assert.equal(tracked.result.proposals[0].proposal_id, 'async-proposal-1');
    const finished = await pending.submitted.waitForCompletion();
    assert.equal(finished.data.proposals[0].proposal_id, 'async-proposal-1');
    assert.deepEqual(finished.compatibility.tools_used, ['get_products']);

    await coordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: 'async-proposal-1',
      proposal_terms_digest: digest,
    });
    assert.equal(mutations.length, 1);
  });

  test('operation-error proposal completions invalidate only their correlated stale snapshots', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const proposal = proposal_id => ({
      proposal_id,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    });
    const ids = {
      direct: 'proposal-stale-direct-error',
      event: 'proposal-stale-event-error',
      track: 'proposal-stale-track-error',
      unrelated: 'proposal-unrelated-race-error',
      raced: 'proposal-stale-race-error',
      taskFailedRaced: 'proposal-stale-task-failed-race',
      pausedRaced: 'proposal-stale-paused-race',
      unsafeRacedSuccess: 'proposal-stale-unsafe-race-success',
      safeRacedSuccess: 'proposal-safe-race-success',
      duplicateRacedSuccess: 'proposal-stale-duplicate-race-success',
      digestRacedSuccess: 'proposal-digest-race-success',
      oversizedRacedSuccess: 'proposal-stale-oversized-race-success',
      overflowRacedSuccess: 'proposal-stale-overflow-race-success',
      rejectedOverflowSuccess: 'proposal-stale-rejected-overflow-success',
    };
    const taskListeners = new Set();
    agent.onTaskUpdate = listener => {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    };
    agent.getProducts = async () =>
      completed('get_products', { proposals: Object.values(ids).map(proposal), cache_scope: 'account' });
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-proposal-operation-error',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const account = { account_id: 'account-1' };
    await coordinator.requestProposals({ brief: 'seed stale proposals', account });
    const operationError = proposalId => ({
      success: false,
      error: 'seller proposal operation failed',
      proposals: [proposal(proposalId)],
    });
    const assertUnavailable = proposalId =>
      assert.rejects(
        coordinator.acceptProposal({ account, proposal_id: proposalId }),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
      );

    agent.getProducts = async () => completed('get_products', operationError(ids.direct));
    await coordinator.requestProposals({ brief: 'direct operation error', account });
    await assertUnavailable(ids.direct);

    agent.getProducts = async () => working('get_products');
    await coordinator.requestProposals({ brief: 'event operation error', account });
    for (const listener of [...taskListeners]) {
      listener({
        taskId: 'get_products-task',
        status: 'completed',
        taskType: 'get_products',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: operationError(ids.event),
      });
    }
    await assertUnavailable(ids.event);

    agent.getProducts = async () => submitted('get_products', completed('get_products', operationError(ids.track)));
    const pending = await coordinator.requestProposals({ brief: 'track operation error', account });
    assert.equal((await pending.submitted.track()).status, 'completed');
    await assertUnavailable(ids.track);

    agent.getProducts = async () => {
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'unrelated-task',
          status: 'completed',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: operationError(ids.unrelated),
        });
      }
      return working('get_products');
    };
    await coordinator.requestProposals({ brief: 'unrelated raced error', account });
    assert.equal(taskListeners.size, 1);
    for (const listener of [...taskListeners]) {
      listener({
        taskId: 'get_products-task',
        status: 'failed',
        taskType: 'get_products',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    assert.equal(taskListeners.size, 0);

    agent.getProducts = async () => {
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'get_products-task',
          status: 'completed',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: operationError(ids.raced),
        });
      }
      return working('get_products');
    };
    await coordinator.requestProposals({ brief: 'matched raced error', account });
    assert.equal(taskListeners.size, 0, 'matched terminal race must not leave a long-lived watcher');
    await assertUnavailable(ids.raced);

    agent.getProducts = async () => {
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'get_products-task',
          status: 'failed',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: operationError(ids.taskFailedRaced),
        });
      }
      return working('get_products');
    };
    await coordinator.requestProposals({ brief: 'matched raced task failure', account });
    assert.equal(taskListeners.size, 0, 'raced task failure must not leave a long-lived watcher');
    await assertUnavailable(ids.taskFailedRaced);

    agent.getProducts = async () => {
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'get_products-task',
          status: 'input-required',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: operationError(ids.pausedRaced),
        });
      }
      return working('get_products');
    };
    await coordinator.requestProposals({ brief: 'matched raced paused task', account });
    assert.equal(taskListeners.size, 0, 'raced paused task must not leave a long-lived watcher');
    await assertUnavailable(ids.pausedRaced);

    agent.getProducts = async () => {
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'get_products-task',
          status: 'completed',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: {
            proposals: [
              ...Array.from({ length: 256 }, (_, index) => ({
                proposal_id: `uncached-padding-${index}`,
                commercial_terms: { accessToken: 'unsafe-padding' },
              })),
              {
                proposal_id: ids.unsafeRacedSuccess,
                commercial_terms: { accessToken: 'must-not-be-retained' },
              },
              proposal(ids.safeRacedSuccess),
            ],
          },
        });
      }
      return working('get_products');
    };
    await coordinator.requestProposals({ brief: 'matched raced mixed success', account });
    assert.equal(taskListeners.size, 0, 'matched terminal race must not leave a long-lived watcher');
    await assertUnavailable(ids.unsafeRacedSuccess);
    await assertUnavailable(ids.safeRacedSuccess);

    agent.getProducts = async () => {
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'get_products-task',
          status: 'completed',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: {
            proposals: [
              proposal(ids.duplicateRacedSuccess),
              {
                proposal_id: ids.duplicateRacedSuccess,
                commercial_terms: { accessToken: 'later-duplicate-must-revoke' },
              },
            ],
          },
        });
      }
      return working('get_products');
    };
    await coordinator.requestProposals({ brief: 'matched raced duplicate success', account });
    assert.equal(taskListeners.size, 0, 'duplicate terminal race must not leave a long-lived watcher');
    await assertUnavailable(ids.duplicateRacedSuccess);

    const digestCommercialTerms = {
      ...proposal(ids.digestRacedSuccess).commercial_terms,
      seller_planning_note: 'benign term retained in the seller digest but not the legacy create request',
    };
    const racedTermsDigest = proposalTermsDigest(digestCommercialTerms);
    agent.getProducts = async () => {
      const unsubscribeMutator = agent.onTaskUpdate(task => {
        if (task.taskId !== 'get_products-task' || task.status !== 'completed') return;
        task.result.proposals[0].commercial_terms.brand.accessToken = 'injected-after-safety-check';
      });
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'get_products-task',
          status: 'completed',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: {
            proposals: [
              {
                ...proposal(ids.digestRacedSuccess),
                name: 'Digest-bound raced proposal',
                allocations: [{ product_id: 'product-1', allocation_percentage: 100 }],
                commercial_terms: digestCommercialTerms,
                terms_digest: racedTermsDigest,
              },
            ],
            products: [],
            cache_scope: 'account',
          },
        });
      }
      unsubscribeMutator();
      return working('get_products');
    };
    await coordinator.requestProposals({ brief: 'matched raced full-terms digest', account });
    assert.equal(taskListeners.size, 0, 'digest-bound terminal race must not leave a long-lived watcher');
    assert.doesNotMatch(
      JSON.stringify([...coordinator.proposalSnapshotStore.entries.values()]),
      /injected-after-safety-check/
    );

    const oversizedSafeProposals = Array.from({ length: 16 }, (_, index) => {
      const candidate = proposal(`oversized-safe-${String(index).padStart(2, '0')}`);
      candidate.commercial_terms.purchase_order_ref = 'x'.repeat(261_860);
      return candidate;
    });
    agent.getProducts = async () => {
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'get_products-task',
          status: 'completed',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: {
            proposals: [
              ...oversizedSafeProposals,
              {
                proposal_id: ids.oversizedRacedSuccess,
                commercial_terms: { accessToken: 'must-not-survive-capture-pressure' },
              },
            ],
          },
        });
      }
      return working('get_products');
    };
    await coordinator.requestProposals({ brief: 'matched oversized raced success', account });
    assert.equal(taskListeners.size, 0, 'oversized terminal race must not leave a long-lived watcher');
    await assertUnavailable(ids.oversizedRacedSuccess);

    let mutations = 0;
    const mutationRequests = [];
    agent.createMediaBuy = async request => {
      mutations += 1;
      mutationRequests.push(request);
      return completed('create_media_buy', { media_buy_id: 'mb-unrelated-race' });
    };
    assert.equal((await coordinator.acceptProposal({ account, proposal_id: ids.unrelated })).status, 'completed');
    assert.equal(
      (
        await coordinator.acceptProposal({
          account,
          proposal_id: ids.digestRacedSuccess,
          proposal_terms_digest: racedTermsDigest,
        })
      ).status,
      'completed'
    );
    assert.deepEqual(mutationRequests[1].brand, { domain: 'example.com' });
    assert.equal(mutations, 2, 'raced results must preserve unrelated and full-terms-bound snapshots');

    agent.getProducts = async () => {
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'get_products-task',
          status: 'completed',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: {
            proposals: [
              {
                proposal_id: ids.overflowRacedSuccess,
                commercial_terms: { accessToken: 'must-not-survive-correlation-overflow' },
              },
            ],
          },
        });
      }
      for (let index = 0; index < 33; index += 1) {
        for (const listener of [...taskListeners]) {
          listener({
            taskId: `unrelated-terminal-${index}`,
            status: 'completed',
            taskType: 'get_products',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            result: { proposals: [] },
          });
        }
      }
      return working('get_products');
    };
    await coordinator.requestProposals({ brief: 'matched raced success under correlation pressure', account });
    assert.equal(taskListeners.size, 0, 'overflow fallback must suppress an ambiguous long-lived watcher');
    await assertUnavailable(ids.overflowRacedSuccess);
    assert.equal(mutations, 2, 'capture pressure must never authorize an additional mutation');

    agent.getProducts = async () => completed('get_products', { proposals: [proposal(ids.rejectedOverflowSuccess)] });
    await coordinator.requestProposals({ brief: 'seed transport rejection race', account });
    agent.getProducts = async () => {
      for (const listener of [...taskListeners]) {
        listener({
          taskId: 'get_products-task',
          status: 'completed',
          taskType: 'get_products',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: {
            proposals: [
              {
                proposal_id: ids.rejectedOverflowSuccess,
                commercial_terms: { accessToken: 'must-not-survive-transport-rejection' },
              },
            ],
          },
        });
      }
      for (let index = 0; index < 33; index += 1) {
        for (const listener of [...taskListeners]) {
          listener({
            taskId: `rejected-unrelated-terminal-${index}`,
            status: 'completed',
            taskType: 'get_products',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            result: { proposals: [] },
          });
        }
      }
      throw new Error('transport failed after terminal event');
    };
    await assert.rejects(
      coordinator.requestProposals({ brief: 'transport rejection after terminal race', account }),
      /transport failed after terminal event/
    );
    assert.equal(taskListeners.size, 0, 'transport rejection must release the pre-dispatch listener');
    await assertUnavailable(ids.rejectedOverflowSuccess);
    assert.equal(mutations, 2, 'transport rejection after a terminal race must fail closed');
  });

  test('submitted compact mutations retain compatibility on completion', async () => {
    const agent = clientWithCaps(capabilities({ tools: COMPACT_TOOLS }));
    agent.buyProducts = async () =>
      submitted('buy_products', completed('buy_products', { media_buy_id: 'mb-submitted', revision: 1 }));
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    const pending = await coordinator.buyProducts(directIntent);
    assert.equal(pending.compatibility.lifecycle, 'compact');
    const finished = await pending.submitted.waitForCompletion();
    assert.equal(finished.data.media_buy_id, 'mb-submitted');
    assert.equal(finished.compatibility.lifecycle, 'compact');
    assert.deepEqual(finished.compatibility.tools_used, ['buy_products']);
  });

  test('readback fields are gated by the exact established schema version', async () => {
    for (const version of ['3.0', '3.1', '3.2.0-beta.4']) {
      const tools = version.startsWith('3.2')
        ? [...COMPACT_TOOLS, 'get_media_buys', 'get_media_buy_delivery']
        : undefined;
      const agent = clientWithCaps(capabilities({ version, tools }));
      let readbacks = 0;
      agent.getMediaBuys = async () => {
        readbacks += 1;
        return completed('get_media_buys', { media_buys: [] });
      };
      agent.getMediaBuyDelivery = async () => {
        readbacks += 1;
        return completed('get_media_buy_delivery', { media_buy_deliveries: [] });
      };
      const coordinator = await agent.negotiateMediaBuyLifecycle();

      if (version === '3.0') {
        await assert.rejects(
          coordinator.getMediaBuys({ include_webhook_activity: true }),
          error =>
            error instanceof MediaBuyLifecycleCompatibilityError && /include_webhook_activity/.test(error.feature)
        );
        await assert.rejects(
          coordinator.getMediaBuyDelivery({ include_window_breakdown: true }),
          error =>
            error instanceof MediaBuyLifecycleCompatibilityError && /include_window_breakdown/.test(error.feature)
        );
      } else {
        await coordinator.getMediaBuys({ include_webhook_activity: true, webhook_activity_limit: 5 });
        await coordinator.getMediaBuyDelivery({ include_window_breakdown: true, time_granularity: 'daily' });
        if (version === '3.1') {
          await assert.rejects(
            coordinator.getMediaBuyDelivery({ time_granularity: 'weekly' }),
            error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'time_granularity'
          );
        }
      }

      if (version === '3.0' || version === '3.1') {
        await assert.rejects(
          coordinator.getMediaBuys({ indicator_types: ['delivery'] }),
          error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'indicator_types'
        );
        await assert.rejects(
          coordinator.getMediaBuyDelivery({ reporting_dimensions: { demographic: {} } }),
          error =>
            error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'reporting_dimensions.demographic'
        );
        if (version === '3.0') {
          await assert.rejects(
            coordinator.getMediaBuyDelivery({
              reporting_dimensions: { geo: { geo_level: 'postal_area', country: 'US', system: 'zip' } },
            }),
            error =>
              error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'reporting_dimensions.geo'
          );
          for (const geo_level of ['metro', 'postal_area']) {
            await assert.rejects(
              coordinator.getMediaBuyDelivery({ reporting_dimensions: { geo: { geo_level } } }),
              error =>
                error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'reporting_dimensions.geo'
            );
          }
        }
      } else {
        await coordinator.getMediaBuys({ indicator_types: ['delivery'] });
        await coordinator.getMediaBuyDelivery({ time_granularity: 'weekly' });
      }
      assert.equal(readbacks, version === '3.0' ? 0 : version === '3.1' ? 2 : 4);
    }
  });

  test('product field selection is gated by the exact established enum', async () => {
    for (const [version, field] of [
      ['3.0', 'format_options'],
      ['3.1', 'measurement_terms'],
    ]) {
      const agent = clientWithCaps(capabilities({ version }));
      let calls = 0;
      agent.getProducts = async () => {
        calls += 1;
        return completed('get_products', { products: [] });
      };
      const coordinator = await agent.negotiateMediaBuyLifecycle();

      await assert.rejects(
        coordinator.listProducts({ fields: [field] }),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'fields'
      );
      assert.equal(calls, 0);
    }
  });

  test('hard proposal constraints fail before legacy get_products', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let calls = 0;
    agent.getProducts = async () => {
      calls += 1;
      return completed('get_products', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    await assert.rejects(
      coordinator.refineProposals({
        refinements: [
          {
            proposal_id: 'proposal-1',
            action: 'revise',
            constraints: { total_budget: { currency: 'USD', max: 1000 } },
          },
        ],
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'structured proposal refinement'
    );
    assert.equal(calls, 0);
  });

  test('compact-only proposal filters fail before legacy get_products', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let calls = 0;
    agent.getProducts = async () => {
      calls += 1;
      return completed('get_products', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    await assert.rejects(
      coordinator.requestProposals({
        brief: 'test',
        criteria: { product_ids: ['product-1'] },
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'criteria.product_ids'
    );
    await assert.rejects(
      coordinator.requestProposals({
        brief: 'test',
        criteria: { offer_filters: { required_features: { property_filtering: true } } },
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'required_features'
    );
    assert.equal(calls, 0);
  });

  test('nested 3.2 constraints fail before a legacy seller can ignore or reject them', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let calls = 0;
    agent.getProducts =
      agent.createMediaBuy =
      agent.updateMediaBuy =
        async () => {
          calls += 1;
          return completed('unexpected', {});
        };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
    });

    for (const targeting of [
      { browser: ['chrome'] },
      { demographics: { age_ranges: ['25-34'] } },
      { language: ['en-US'] },
    ]) {
      await assert.rejects(
        coordinator.buyProducts({
          ...directIntent,
          purchases: [{ ...directIntent.purchases[0], targeting_overlay: targeting }],
        }),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          error.feature.startsWith('purchases[0].targeting_overlay.')
      );
    }
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        packages: [
          {
            package_id: 'package-1',
            optimization_goals: [
              {
                kind: 'vendor_metric',
                vendor: { domain: 'measurement.example' },
                metric_id: 'attention_units',
              },
            ],
          },
        ],
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'packages[0].optimization_goals'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        packages: [{ package_id: 'package-1', budget: null }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'packages[0].budget'
    );
    await assert.rejects(
      coordinator.requestProposals({
        brief: 'metric drift',
        criteria: { offer_filters: { required_metrics: ['commissionable_value'] } },
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.feature === 'criteria.offer_filters.required_metrics'
    );
    await assert.rejects(
      coordinator.buyProducts({
        ...directIntent,
        reporting_webhook: { requested_metrics: ['commissionable_value'] },
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'reporting_webhook.requested_metrics'
    );
    await assert.rejects(
      coordinator.requestProposals({
        brief: 'catalog drift',
        criteria: { catalog: { catalog_id: 'catalog-1' } },
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'criteria.catalog'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        packages: [
          {
            package_id: 'package-1',
            keyword_targets_remove: [{ keyword: 'sports', match_type: 'broad', bid_price: 1 }],
          },
        ],
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.feature === 'packages[0].keyword_targets_remove[0].bid_price'
    );

    assert.equal(calls, 0);
  });

  test('3.0 postal targeting rejects the newer country-local shape before dispatch', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }));
    let calls = 0;
    agent.createMediaBuy = agent.updateMediaBuy = async () => {
      calls += 1;
      return completed('unexpected', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
    });

    await assert.rejects(
      coordinator.buyProducts({
        ...directIntent,
        purchases: [
          {
            ...directIntent.purchases[0],
            targeting_overlay: {
              geo_postal_areas: [{ country: 'US', system: 'zip', values: ['10001'] }],
            },
          },
        ],
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.feature === 'purchases[0].targeting_overlay.geo_postal_areas[0]'
    );
    for (const call of [
      () =>
        coordinator.buyProducts({
          ...directIntent,
          push_notification_config: { url: 'https://example.com/tasks', operation_id: 'operation-1' },
        }),
      () =>
        coordinator.controlMediaBuy({
          account: { account_id: 'account-1' },
          media_buy_id: 'mb-1',
          revision: 1,
          push_notification_config: { url: 'https://example.com/tasks', operation_id: 'operation-1' },
        }),
    ]) {
      await assert.rejects(
        call(),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError &&
          error.feature === 'push_notification_config.operation_id'
      );
    }
    assert.equal(calls, 0);
  });

  test('legacy finalize rejects every extra refinement field before dispatch', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let calls = 0;
    agent.getProducts = async () => {
      calls += 1;
      return completed('get_products', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    for (const extra of [
      { constraints: { total_budget: { currency: 'USD', max: 1000 } } },
      { product_changes: { 'product-2': 'include' } },
      { ask: 'finalize only if the rate holds' },
    ]) {
      await assert.rejects(
        coordinator.refineProposals({
          refinements: [{ proposal_id: 'proposal-1', action: 'finalize', ...extra }],
        }),
        error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature.startsWith('finalize.')
      );
    }
    assert.equal(calls, 0);
  });

  test('legacy proposal mutations receive SDK-generated retry keys when omitted', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const calls = [];
    agent.getProducts = async request => {
      calls.push(request);
      return completed('get_products', { proposals: [], cache_scope: 'account' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      allowedLosses: ['proposal_decline_not_terminal', 'proposal_decline_reason_not_forwarded'],
    });

    await coordinator.requestProposals({ brief: 'proposal request' });
    await coordinator.refineProposals({
      refinements: [{ proposal_id: 'proposal-1', action: 'revise', ask: 'lower price' }],
    });
    await coordinator.declineProposals({ declines: [{ proposal_id: 'proposal-2', reason: 'budget_changed' }] });

    assert.equal(calls.length, 3);
    for (const call of calls) assert.match(call.idempotency_key, /^[A-Za-z0-9_.:-]{16,255}$/);
    assert.equal(new Set(calls.map(call => call.idempotency_key)).size, 3);
  });

  test('compliance omission mode keeps legacy proposal retry keys absent', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const calls = [];
    agent.getProducts = async request => {
      calls.push(request);
      return completed('get_products', { proposals: [], cache_scope: 'account' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      allowedLosses: ['proposal_decline_not_terminal', 'proposal_decline_reason_not_forwarded'],
    });
    const options = { skipIdempotencyAutoInject: true };

    await coordinator.requestProposals({ brief: 'proposal request' }, undefined, options);
    await coordinator.refineProposals(
      { refinements: [{ proposal_id: 'proposal-1', action: 'revise', ask: 'lower price' }] },
      undefined,
      options
    );
    await coordinator.declineProposals(
      { declines: [{ proposal_id: 'proposal-2', reason: 'budget_changed' }] },
      undefined,
      options
    );

    assert.equal(calls.length, 3);
    for (const call of calls) assert.equal(call.idempotency_key, undefined);
  });

  test('malformed legacy proposal refinements fail as structured compatibility errors', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let calls = 0;
    agent.getProducts = async () => {
      calls += 1;
      return completed('get_products', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    await assert.rejects(
      coordinator.refineProposals({}),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'compact_request_validation'
    );
    assert.equal(calls, 0);
  });

  test('required compact mutation fences fail before any established mutation', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    agent.createMediaBuy = agent.updateMediaBuy = async () => {
      mutations += 1;
      return completed('mutation', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: [
        'feed_version_not_atomic',
        'pricing_version_not_atomic',
        'proposal_terms_digest_not_enforced',
        'proposal_decline_not_terminal',
        'proposal_decline_reason_not_forwarded',
      ],
    });

    await assert.rejects(
      coordinator.buyProducts({ ...directIntent, feed_version: '' }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'feed_version'
    );
    await assert.rejects(
      coordinator.acceptProposal({ account: { account_id: 'account-1' }, proposal_id: 'proposal-1' }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({ account: { account_id: 'account-1' }, media_buy_id: 'mb-1' }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'account/media_buy_id/revision'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 0,
        paused: true,
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'account/media_buy_id/revision'
    );
    await assert.rejects(
      coordinator.buyProducts({
        ...directIntent,
        purchases: [{ ...directIntent.purchases[0], buyer_ref: 'unsupported-package-ref' }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'purchases[0].buyer_ref'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        packages: [{ package_id: 'package-1', catalog_ids: ['catalog-1'] }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'packages[0].catalog_ids'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        canceled: true,
        paused: true,
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'canceled'
    );
    await assert.rejects(
      coordinator.controlMediaBuy({
        account: { account_id: 'account-1' },
        media_buy_id: 'mb-1',
        revision: 1,
        packages: [
          {
            package_id: 'package-1',
            targeting_overlay: {},
            keyword_targets_add: [{ keyword: 'sports' }],
          },
        ],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'packages[0].targeting_overlay'
    );
    await assert.rejects(
      coordinator.buyProducts({ ...directIntent, future_purchase_mode: 'unsafe' }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'future_purchase_mode'
    );
    await assert.rejects(
      coordinator.declineProposals({
        declines: [{ proposal_id: 'proposal-1', reason: 'budget_changed', future_feedback: true }],
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'future_feedback'
    );
    assert.equal(mutations, 0);
  });

  test('legacy proposal request and supported refinement use the established proposal flow', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const calls = [];
    const proposal = {
      proposal_id: 'proposal-1',
      proposal_status: 'draft',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    };
    agent.getProducts = async request => {
      calls.push(request);
      return completed('get_products', { proposals: [proposal], cache_scope: 'account' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-1' });

    const requested = await coordinator.requestProposals({
      idempotency_key: 'proposal-request-key-0001',
      brief: 'Premium outdoor inventory',
      criteria: { offer_filters: { channels: ['display'] }, policy_ids: ['policy-1'] },
    });
    const refined = await coordinator.refineProposals({
      idempotency_key: 'proposal-refine-key-0001',
      refinements: [
        {
          proposal_id: 'proposal-1',
          action: 'revise',
          ask: 'Reduce the price',
          product_changes: { 'product-2': 'include', 'product-3': 'omit' },
        },
      ],
    });

    assert.equal(requested.data.proposals.length, 1);
    assert.equal(requested.data.proposals[0].terms_digest, undefined, 'the coordinator must not invent a digest');
    assert.deepEqual(calls[0].filters, { channels: ['display'] });
    assert.deepEqual(calls[0].required_policies, ['policy-1']);
    assert.equal(calls[0].idempotency_key, 'proposal-request-key-0001');
    assert.deepEqual(calls[1].refine, [
      { scope: 'proposal', proposal_id: 'proposal-1', ask: 'Reduce the price' },
      { scope: 'product', product_id: 'product-2', action: 'include' },
      { scope: 'product', product_id: 'product-3', action: 'omit' },
    ]);
    assert.equal(calls[1].idempotency_key, 'proposal-refine-key-0001');
    assert.deepEqual(refined.compatibility.tools_used, ['get_products']);
  });

  test('legacy decline is fail-closed unless terminal-state loss is explicitly accepted', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }));
    const calls = [];
    agent.getProducts = async request => {
      calls.push(request);
      return completed('get_products', { proposals: [], cache_scope: 'account' });
    };
    const intent = {
      idempotency_key: 'proposal-decline-key-0001',
      declines: [{ proposal_id: 'proposal-1', reason: 'budget_changed' }],
    };
    const strict = await agent.negotiateMediaBuyLifecycle();
    await assert.rejects(
      strict.declineProposals(intent),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.losses.includes('proposal_decline_not_terminal')
    );
    assert.equal(calls.length, 0);

    const optedIn = await agent.negotiateMediaBuyLifecycle({
      allowedLosses: ['proposal_decline_not_terminal', 'proposal_decline_reason_not_forwarded'],
    });
    const result = await optedIn.declineProposals(intent);
    assert.deepEqual(calls[0].refine, [{ scope: 'proposal', proposal_id: 'proposal-1', action: 'omit' }]);
    assert.deepEqual(result.compatibility.losses, [
      'proposal_decline_not_terminal',
      'proposal_decline_reason_not_forwarded',
    ]);
  });

  test('legacy proposal acceptance requires opt-in when a digest guarantee was requested', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const digest = proposalTermsDigest(commercialTerms);
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-1',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            terms_digest: digest,
            commercial_terms: commercialTerms,
          },
        ],
        cache_scope: 'account',
      });
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: 'mb-1' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-1' });
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });

    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-1',
        proposal_terms_digest: digest,
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.losses.includes('proposal_terms_digest_not_enforced')
    );
    assert.equal(mutations, 0);
  });

  test('accepted proposal digest loss is explicit and dispatches one established mutation', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const calls = [];
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
    };
    const digest = proposalTermsDigest(commercialTerms);
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-1',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            terms_digest: digest,
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: commercialTerms,
          },
        ],
        cache_scope: 'account',
      });
    agent.createMediaBuy = async request => {
      calls.push(request);
      return completed('create_media_buy', { media_buy_id: 'mb-1', revision: 1 });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });

    const overlongKey = `oversized-${'x'.repeat(10_000)}`;
    await assert.rejects(
      coordinator.acceptProposal({
        idempotency_key: overlongKey,
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-1',
        proposal_terms_digest: digest,
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'idempotency_key'
    );
    assert.doesNotMatch(JSON.stringify([...coordinator.proposalSnapshotStore.entries.values()]), /oversized-/);

    const result = await coordinator.acceptProposal({
      idempotency_key: 'accept-proposal-key-0001',
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-1',
      proposal_terms_digest: digest,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].proposal_id, 'proposal-1');
    assert.equal(calls[0].idempotency_key, 'accept-proposal-key-0001');
    assert.equal(calls[0].proposal_terms_digest, undefined);
    assert.deepEqual(result.compatibility.losses, ['proposal_terms_digest_not_enforced']);
    await assert.rejects(
      coordinator.acceptProposal({
        idempotency_key: 'accept-proposal-fresh-key-0002',
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-1',
        proposal_terms_digest: digest,
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(calls.length, 1, 'an accepted legacy proposal snapshot must be one-shot');
  });

  test('cache pressure cannot erase an accepted-proposal tombstone or lock out later proposals', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const proposal = proposal_id => ({
      proposal_id,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    });
    let proposals = [proposal('proposal-retired-under-pressure')];
    agent.getProducts = async () => completed('get_products', { proposals, cache_scope: 'account' });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: `mb-pressure-${mutations}` });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-pressure',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const account = { account_id: 'account-1' };
    await coordinator.requestProposals({ brief: 'seed accepted proposal', account });
    await coordinator.acceptProposal({ account, proposal_id: 'proposal-retired-under-pressure' });

    proposals = [
      proposal('proposal-retired-under-pressure'),
      ...Array.from({ length: 300 }, (_, index) => proposal(`proposal-pressure-${index}`)),
    ];
    await coordinator.requestProposals({ brief: 'fill snapshot cache', account });
    await assert.rejects(
      coordinator.acceptProposal({ account, proposal_id: 'proposal-retired-under-pressure' }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    await coordinator.acceptProposal({ account, proposal_id: 'proposal-pressure-299' });
    assert.equal(mutations, 2);
  });

  test('cache pressure retires abandoned pauses without locking out later proposals', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const proposal = proposal_id => ({
      proposal_id,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    });
    let proposals = Array.from({ length: 256 }, (_, index) => proposal(`proposal-abandoned-${index}`));
    agent.getProducts = async () => completed('get_products', { proposals, cache_scope: 'account' });
    let completeMutations = false;
    agent.createMediaBuy = async () =>
      completeMutations
        ? completed('create_media_buy', { media_buy_id: 'mb-after-abandoned-pauses' })
        : { ...working('create_media_buy'), status: 'input-required' };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-abandoned-pauses',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const account = { account_id: 'account-1' };
    await coordinator.requestProposals({ brief: 'fill with paused acceptances', account });
    for (let index = 0; index < 256; index += 1) {
      assert.equal(
        (await coordinator.acceptProposal({ account, proposal_id: `proposal-abandoned-${index}` })).status,
        'input-required'
      );
    }

    proposals = [proposal('proposal-after-abandoned-pauses')];
    await coordinator.requestProposals({ brief: 'proposal after paused pressure', account });
    await assert.rejects(
      coordinator.acceptProposal({
        account,
        proposal_id: 'proposal-abandoned-0',
        idempotency_key: 'abandoned-pause-fresh-key',
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    completeMutations = true;
    assert.equal(
      (await coordinator.acceptProposal({ account, proposal_id: 'proposal-after-abandoned-pauses' })).status,
      'completed'
    );
    coordinator.dispose();
  });

  test('cache pressure from another principal cannot release a paused reservation owner', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const proposal = proposal_id => ({
      proposal_id,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    });
    let proposals = [proposal('proposal-owned-by-first-coordinator')];
    agent.getProducts = async () => completed('get_products', { proposals, cache_scope: 'account' });
    agent.createMediaBuy = async () => ({ ...working('create_media_buy'), status: 'input-required' });
    const losses = [
      'proposal_terms_digest_not_enforced',
      'proposal_terms_digest_unavailable',
      'proposal_snapshot_not_immutable',
    ];
    const first = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-pressure-owner-a',
      allowedLosses: losses,
    });
    const second = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-pressure-owner-b',
      allowedLosses: losses,
    });
    const account = { account_id: 'account-1' };
    await first.requestProposals({ brief: 'first coordinator proposal', account });
    assert.equal(
      (await first.acceptProposal({ account, proposal_id: 'proposal-owned-by-first-coordinator' })).status,
      'input-required'
    );
    assert.equal(first.ownedAcceptanceReservations.size, 1);
    assert.equal(first.pendingAcceptanceTasks.size, 1);

    proposals = Array.from({ length: 255 }, (_, index) => proposal(`proposal-second-coordinator-${index}`));
    await second.requestProposals({ brief: 'fill shared cache', account });
    proposals = [proposal('proposal-trigger-cross-coordinator-pressure')];
    await second.requestProposals({ brief: 'trigger shared pressure', account });

    assert.equal(first.ownedAcceptanceReservations.size, 1);
    assert.equal(first.pendingAcceptanceTasks.size, 1);
    await assert.rejects(
      first.acceptProposal({
        account,
        proposal_id: 'proposal-owned-by-first-coordinator',
        idempotency_key: 'cross-coordinator-fresh-key',
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry'
    );
    first.dispose();
    assert.equal(first.ownedAcceptanceReservations.size, 0);
    assert.equal(first.pendingAcceptanceTasks.size, 0);
    second.dispose();
  });

  test('cross-coordinator paused retries transfer bounded reservation ownership', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-cross-coordinator-retry',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    const mutationKeys = [];
    let completeMutation = false;
    agent.createMediaBuy = async request => {
      mutationKeys.push(request.idempotency_key);
      return completeMutation
        ? completed('create_media_buy', { media_buy_id: 'mb-cross-coordinator-retry' })
        : { ...working('create_media_buy'), status: 'input-required' };
    };
    const options = {
      principalScope: 'buyer-tenant-cross-coordinator-retry',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    };
    const first = await agent.negotiateMediaBuyLifecycle(options);
    const second = await agent.negotiateMediaBuyLifecycle(options);
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-cross-coordinator-retry',
    };
    await first.requestProposals({ brief: 'cross-coordinator retries', account: acceptance.account });

    for (let index = 0; index < 32; index += 1) {
      const coordinator = index % 2 === 0 ? first : second;
      assert.equal((await coordinator.acceptProposal(acceptance)).status, 'input-required');
      assert.equal(first.ownedAcceptanceReservations.size + second.ownedAcceptanceReservations.size, 1);
      assert.equal(first.pendingAcceptanceTasks.size + second.pendingAcceptanceTasks.size, 1);
    }
    completeMutation = true;
    assert.equal((await first.acceptProposal(acceptance)).status, 'completed');
    assert.equal(first.ownedAcceptanceReservations.size + second.ownedAcceptanceReservations.size, 0);
    assert.equal(first.pendingAcceptanceTasks.size + second.pendingAcceptanceTasks.size, 0);
    assert.equal(new Set(mutationKeys).size, 1);
    first.dispose();
    second.dispose();
  });

  test('legacy proposal acceptance retires the snapshot before an in-flight mutation completes', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-concurrent',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: commercialTerms,
          },
        ],
        cache_scope: 'account',
      });
    let releaseMutation;
    const mutationGate = new Promise(resolve => {
      releaseMutation = resolve;
    });
    let signalStarted;
    const mutationStarted = new Promise(resolve => {
      signalStarted = resolve;
    });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      signalStarted();
      await mutationGate;
      return completed('create_media_buy', { media_buy_id: 'mb-concurrent' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-concurrent',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    await coordinator.requestProposals({ brief: 'concurrent accept', account: { account_id: 'account-1' } });

    const firstAcceptance = coordinator.acceptProposal({
      idempotency_key: 'concurrent-accept-key-0001',
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-concurrent',
    });
    await mutationStarted;
    await coordinator.requestProposals({ brief: 'rediscover in flight', account: { account_id: 'account-1' } });
    await assert.rejects(
      coordinator.acceptProposal({
        idempotency_key: 'concurrent-accept-key-0002',
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-concurrent',
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_pending'
    );
    assert.equal(mutations, 1);
    releaseMutation();
    await firstAcceptance;
    await coordinator.requestProposals({ brief: 'rediscover retired', account: { account_id: 'account-1' } });
    await assert.rejects(
      coordinator.acceptProposal({
        idempotency_key: 'concurrent-accept-key-0003',
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-concurrent',
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 1);
  });

  test('legacy acceptance is one-shot across concurrent and sequential account representations', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-variant-account',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    let releaseMutation;
    const mutationGate = new Promise(resolve => {
      releaseMutation = resolve;
    });
    let signalStarted;
    const mutationStarted = new Promise(resolve => {
      signalStarted = resolve;
    });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      signalStarted();
      await mutationGate;
      return completed('create_media_buy', { media_buy_id: 'mb-variant-account' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-variant-account',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const firstAccount = { account_id: 'account-1', brand: { domain: 'one.example' } };
    const secondAccount = { account_id: 'account-1', brand: { domain: 'two.example' } };
    await coordinator.requestProposals({ brief: 'first representation', account: firstAccount });
    await coordinator.requestProposals({ brief: 'second representation', account: secondAccount });

    const firstAcceptance = coordinator.acceptProposal({
      account: firstAccount,
      proposal_id: 'proposal-variant-account',
    });
    await mutationStarted;
    await assert.rejects(
      coordinator.acceptProposal({ account: secondAccount, proposal_id: 'proposal-variant-account' }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_pending'
    );
    assert.equal(mutations, 1, 'the account alias must not dispatch while acceptance is in flight');

    releaseMutation();
    await firstAcceptance;
    await assert.rejects(
      coordinator.acceptProposal({ account: secondAccount, proposal_id: 'proposal-variant-account' }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 1, 'the account alias must remain retired after terminal success');
  });

  test('ambiguous legacy acceptance permits only the exact pinned-key retry', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-ambiguous',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    const requests = [];
    let failTransport = true;
    agent.createMediaBuy = async request => {
      requests.push(request);
      if (failTransport) throw new Error('ambiguous transport failure');
      return completed('create_media_buy', { media_buy_id: 'mb-ambiguous-retry' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-ambiguous',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    await coordinator.requestProposals({ brief: 'ambiguous accept', account: { account_id: 'account-1' } });

    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-ambiguous',
      }),
      /ambiguous transport failure/
    );
    await assert.rejects(
      coordinator.acceptProposal({
        idempotency_key: 'ambiguous-fresh-key-0002',
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-ambiguous',
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry'
    );
    failTransport = false;
    assert.equal(
      (
        await coordinator.acceptProposal({
          account: { account_id: 'account-1' },
          proposal_id: 'proposal-ambiguous',
        })
      ).status,
      'completed'
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0].idempotency_key, requests[1].idempotency_key);
  });

  test('executor-wrapped transport failure permits only the exact pinned-key retry', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-transport-failed',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    const requests = [];
    let wrapFailure = true;
    agent.createMediaBuy = async request => {
      requests.push(request);
      if (!wrapFailure) return completed('create_media_buy', { media_buy_id: 'mb-wrapped-retry' });
      const result = failed('create_media_buy');
      result.metadata.taskName = 'unknown';
      return result;
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-transport-failed',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    await coordinator.requestProposals({ brief: 'transport failure', account: { account_id: 'account-1' } });

    const first = await coordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-transport-failed',
    });
    assert.equal(first.success, false);
    await assert.rejects(
      coordinator.acceptProposal({
        idempotency_key: 'transport-failure-fresh-key-0002',
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-transport-failed',
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry'
    );
    wrapFailure = false;
    assert.equal(
      (
        await coordinator.acceptProposal({
          account: { account_id: 'account-1' },
          proposal_id: 'proposal-transport-failed',
        })
      ).status,
      'completed'
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0].idempotency_key, requests[1].idempotency_key);
  });

  test('paused legacy acceptance restores the proposal for the required retry', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const pausedExpiresAt = new Date(Date.now() + 100).toISOString();
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-paused',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: pausedExpiresAt,
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    const mutationKeys = [];
    agent.createMediaBuy = async request => {
      mutationKeys.push(request.idempotency_key);
      const mutations = mutationKeys.length;
      if (mutations <= 2) {
        return { ...working('create_media_buy'), status: mutations === 1 ? 'input-required' : 'auth-required' };
      }
      return completed('create_media_buy', { media_buy_id: 'mb-paused-retry' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-paused',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    await coordinator.requestProposals({ brief: 'paused accept', account: { account_id: 'account-1' } });
    const pausedCredential = 'paused-secret-must-not-be-retained';
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-paused',
      push_notification_config: {
        url: 'https://example.com/tasks',
        authentication: { schemes: ['HMAC-SHA256'], credentials: pausedCredential },
      },
    };

    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'input-required');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.doesNotMatch(
      JSON.stringify([...coordinator.proposalSnapshotStore.entries.values()]),
      new RegExp(pausedCredential),
      'acceptance reservations must retain only a request digest, never credentials'
    );
    await assert.rejects(
      coordinator.acceptProposal({ ...acceptance, idempotency_key: 'paused-fresh-key-0002' }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry'
    );
    await assert.rejects(
      coordinator.acceptProposal({
        ...acceptance,
        push_notification_config: {
          ...acceptance.push_notification_config,
          authentication: { schemes: ['HMAC-SHA256'], credentials: 'changed-secret' },
        },
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry'
    );
    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'auth-required');
    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'completed');
    await assert.rejects(
      coordinator.acceptProposal(acceptance),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutationKeys.length, 3);
    assert.equal(new Set(mutationKeys).size, 1, 'paused retries must reuse the coordinator-pinned idempotency key');
  });

  test('paused acceptance remains exactly retryable after its task watcher expires', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-long-pause',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return mutations === 1
        ? { ...working('create_media_buy'), status: 'input-required' }
        : completed('create_media_buy', { media_buy_id: 'mb-after-long-pause' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-long-pause',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const coordinatorClass = coordinator.constructor;
    const originalTtl = coordinatorClass.PROPOSAL_TASK_WATCH_TTL_MS;
    coordinatorClass.PROPOSAL_TASK_WATCH_TTL_MS = 10;
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-long-pause',
    };

    try {
      await coordinator.requestProposals({ brief: 'long pause', account: acceptance.account });
      assert.equal((await coordinator.acceptProposal(acceptance)).status, 'input-required');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal((await coordinator.acceptProposal(acceptance)).status, 'completed');
      assert.equal(mutations, 2);
    } finally {
      coordinatorClass.PROPOSAL_TASK_WATCH_TTL_MS = originalTtl;
      coordinator.dispose();
    }
  });

  test('paused acceptance retires at the seller idempotency replay deadline', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-replay-deadline',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return { ...working('create_media_buy'), status: 'input-required' };
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-replay-deadline',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    coordinator.idempotencyReplayTtlMs = 20;
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-replay-deadline',
    };
    await coordinator.requestProposals({ brief: 'replay deadline', account: acceptance.account });
    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'input-required');
    await new Promise(resolve => setTimeout(resolve, 40));
    await assert.rejects(
      coordinator.acceptProposal(acceptance),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 1);
  });

  test('paused retry rechecks the replay deadline immediately before dispatch', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-replay-deadline-race',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return mutations === 1
        ? { ...working('create_media_buy'), status: 'input-required' }
        : completed('create_media_buy', { media_buy_id: 'must-not-dispatch' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-replay-deadline-race',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-replay-deadline-race',
    };
    await coordinator.requestProposals({ brief: 'replay deadline race', account: acceptance.account });
    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'input-required');
    const reservation = [...coordinator.ownedAcceptanceReservations.keys()][0];
    const deadline = reservation.retryDeadlineMs;
    const realNow = Date.now;
    let clockReads = 0;
    Date.now = () => (clockReads++ === 0 ? deadline - 1 : deadline);
    try {
      await assert.rejects(
        coordinator.acceptProposal(acceptance),
        error =>
          error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry_window'
      );
    } finally {
      Date.now = realNow;
    }
    assert.equal(mutations, 1);
    assert.equal(coordinator.ownedAcceptanceReservations.size, 0);
  });

  test('paused acceptance without an advertised replay guarantee fails closed', async () => {
    const caps = capabilities({ version: '3.1' });
    delete caps.idempotency;
    const agent = clientWithCaps(caps);
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-missing-replay-guarantee',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return { ...working('create_media_buy'), status: 'auth-required' };
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-missing-replay-guarantee',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-missing-replay-guarantee',
    };
    await coordinator.requestProposals({ brief: 'missing replay guarantee', account: acceptance.account });
    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'auth-required');
    assert.equal(coordinator.ownedAcceptanceReservations.size, 0);
    assert.equal(coordinator.pendingAcceptanceTasks.size, 0);
    assert.equal(coordinator.acceptanceRetryExpiryTimers.size, 0);
    await assert.rejects(
      coordinator.acceptProposal(acceptance),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 1);
  });

  test('paused acceptance without an idempotency key fails closed', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-no-retry-key',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    const requests = [];
    agent.createMediaBuy = async request => {
      requests.push(request);
      return { ...working('create_media_buy'), status: 'input-required' };
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-no-retry-key',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-no-retry-key',
    };
    const options = { skipIdempotencyAutoInject: true };
    await coordinator.requestProposals({ brief: 'no retry key', account: acceptance.account });

    assert.equal((await coordinator.acceptProposal(acceptance, undefined, options)).status, 'input-required');
    assert.equal(requests[0].idempotency_key, undefined);
    await assert.rejects(
      coordinator.acceptProposal(acceptance, undefined, options),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(requests.length, 1);
  });

  test('completed task envelopes with operation errors restore submitted acceptance', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-completed-error',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      if (mutations === 1) {
        return submitted(
          'create_media_buy',
          completed('create_media_buy', { success: false, error: 'seller rejected the operation' })
        );
      }
      return completed('create_media_buy', { media_buy_id: 'mb-after-operation-error' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-completed-error',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-completed-error',
    };
    await coordinator.requestProposals({ brief: 'completed operation error', account: acceptance.account });

    const pending = await coordinator.acceptProposal(acceptance);
    assert.equal((await pending.submitted.track()).status, 'completed');
    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'completed');
    assert.equal(mutations, 2);
  });

  test('submitted legacy acceptance applies terminal failure and pause transitions', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const proposal = proposal_id => ({
      proposal_id,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    });
    let proposals = [proposal('proposal-submitted-failed')];
    agent.getProducts = async () => completed('get_products', { proposals, cache_scope: 'account' });
    const requests = [];
    let terminal = failed('create_media_buy');
    agent.createMediaBuy = async request => {
      requests.push(request);
      return submitted('create_media_buy', terminal);
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-submitted',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const account = { account_id: 'account-1' };
    await coordinator.requestProposals({ brief: 'submitted failure', account });

    const failedPending = await coordinator.acceptProposal({
      account,
      proposal_id: 'proposal-submitted-failed',
    });
    assert.equal((await failedPending.submitted.waitForCompletion()).status, 'failed');
    terminal = completed('create_media_buy', { media_buy_id: 'mb-after-submitted-failure' });
    assert.equal(
      (await coordinator.acceptProposal({ account, proposal_id: 'proposal-submitted-failed' })).status,
      'submitted'
    );

    proposals = [proposal('proposal-submitted-paused')];
    await coordinator.requestProposals({ brief: 'submitted pause', account });
    terminal = { ...working('create_media_buy'), status: 'input-required' };
    const pausedPending = await coordinator.acceptProposal({ account, proposal_id: 'proposal-submitted-paused' });
    assert.equal((await pausedPending.submitted.waitForCompletion()).status, 'input-required');
    const pausedKey = requests.at(-1).idempotency_key;
    await assert.rejects(
      coordinator.acceptProposal({
        account,
        proposal_id: 'proposal-submitted-paused',
        idempotency_key: 'submitted-paused-fresh-key',
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry'
    );
    terminal = completed('create_media_buy', { media_buy_id: 'mb-after-submitted-pause' });
    await coordinator.acceptProposal({ account, proposal_id: 'proposal-submitted-paused' });
    assert.equal(requests.at(-1).idempotency_key, pausedKey);
  });

  test('stale submitted continuation cannot mutate a newer completed retry', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const proposal = {
      proposal_id: 'proposal-stale-continuation',
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    };
    agent.getProducts = async () => completed('get_products', { proposals: [proposal], cache_scope: 'account' });
    let firstAttempt = true;
    agent.createMediaBuy = async () => {
      if (firstAttempt) {
        firstAttempt = false;
        return submitted('create_media_buy', { ...working('create_media_buy'), status: 'input-required' });
      }
      return completed('create_media_buy', { media_buy_id: 'mb-stale-retry' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-stale-continuation',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: proposal.proposal_id,
    };
    await coordinator.requestProposals({ brief: 'stale continuation', account: acceptance.account });

    const oldAttempt = await coordinator.acceptProposal(acceptance);
    assert.equal((await oldAttempt.submitted.track()).status, 'input-required');
    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'completed');
    assert.equal((await oldAttempt.submitted.waitForCompletion()).status, 'input-required');
    await coordinator.requestProposals({ brief: 'rediscover after stale continuation', account: acceptance.account });
    await assert.rejects(
      coordinator.acceptProposal({ ...acceptance, idempotency_key: 'stale-fresh-key-0003' }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
  });

  test('unknown track and deferred-to-aborted updates allow only pinned-key retries', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const proposal = proposal_id => ({
      proposal_id,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    });
    let proposals = [proposal('proposal-unknown-track')];
    agent.getProducts = async () => completed('get_products', { proposals, cache_scope: 'account' });
    const taskListeners = new Set();
    agent.onTaskUpdate = listener => {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    };
    let mode = 'unknown-track';
    agent.createMediaBuy = async () => {
      if (mode === 'unknown-track') return submitted('create_media_buy', { status: 'unknown' });
      if (mode === 'working') return working('create_media_buy');
      return completed('create_media_buy', { media_buy_id: 'mb-status-retry' });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-ambiguous-status',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const account = { account_id: 'account-1' };
    await coordinator.requestProposals({ brief: 'unknown track', account });
    const unknown = await coordinator.acceptProposal({ account, proposal_id: 'proposal-unknown-track' });
    assert.equal((await unknown.submitted.track()).status, 'unknown');
    await assert.rejects(
      coordinator.acceptProposal({
        account,
        proposal_id: 'proposal-unknown-track',
        idempotency_key: 'unknown-track-fresh-key',
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry'
    );
    mode = 'completed';
    assert.equal(
      (await coordinator.acceptProposal({ account, proposal_id: 'proposal-unknown-track' })).status,
      'completed'
    );

    proposals = [proposal('proposal-deferred-aborted')];
    await coordinator.requestProposals({ brief: 'deferred then aborted', account });
    mode = 'working';
    assert.equal(
      (await coordinator.acceptProposal({ account, proposal_id: 'proposal-deferred-aborted' })).status,
      'working'
    );
    const update = status => ({
      taskId: 'create_media_buy-task',
      status,
      taskType: 'create_media_buy',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    for (const listener of [...taskListeners]) listener(update('deferred'));
    await assert.rejects(
      coordinator.acceptProposal({
        account,
        proposal_id: 'proposal-deferred-aborted',
        idempotency_key: 'deferred-fresh-key-0001',
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry'
    );
    for (const listener of [...taskListeners]) listener(update('aborted'));
    await assert.rejects(
      coordinator.acceptProposal({
        account,
        proposal_id: 'proposal-deferred-aborted',
        idempotency_key: 'aborted-fresh-key-0002',
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_acceptance_retry'
    );
    mode = 'completed';
    assert.equal(
      (await coordinator.acceptProposal({ account, proposal_id: 'proposal-deferred-aborted' })).status,
      'completed'
    );
  });

  test('working legacy acceptance restores after an explicit failed task update', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const taskListeners = new Set();
    agent.onTaskUpdate = listener => {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    };
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-working-failed',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
        cache_scope: 'account',
      });
    let complete = false;
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return complete
        ? completed('create_media_buy', { media_buy_id: 'mb-working-retry' })
        : working('create_media_buy');
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-working-failed',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    const acceptance = {
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-working-failed',
    };
    await coordinator.requestProposals({ brief: 'working failure', account: acceptance.account });
    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'working');
    assert.equal(taskListeners.size, 1);
    for (const listener of [...taskListeners]) {
      listener({
        taskId: 'create_media_buy-task',
        status: 'failed',
        taskType: 'create_media_buy',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    assert.equal(taskListeners.size, 0);
    complete = true;
    assert.equal((await coordinator.acceptProposal(acceptance)).status, 'completed');
    assert.equal(mutations, 2);
  });

  test('failed acceptance restore remains bounded during a concurrent proposal refill', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const proposal = index => ({
      proposal_id: `bounded-proposal-${index}`,
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
    });
    let nextProposals = Array.from({ length: 256 }, (_, index) => proposal(index));
    agent.getProducts = async () => completed('get_products', { proposals: nextProposals, cache_scope: 'account' });
    let coordinator;
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      if (mutations === 1) {
        nextProposals = [proposal(256)];
        await coordinator.requestProposals({ brief: 'concurrent refill', account: { account_id: 'account-1' } });
        return failed('create_media_buy');
      }
      return completed('create_media_buy', { media_buy_id: 'mb-restored' });
    };
    coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-bounded-restore',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    await coordinator.requestProposals({ brief: 'seed cache', account: { account_id: 'account-1' } });

    const failedAcceptance = await coordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: 'bounded-proposal-0',
    });
    assert.equal(failedAcceptance.success, false);
    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'bounded-proposal-1',
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    await coordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: 'bounded-proposal-0',
    });
    assert.equal(mutations, 2, 'the failed snapshot is restored without exceeding the shared cache ceiling');
  });

  test('digest-bound proposal terms cannot be overridden during established acceptance', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
      total_budget: { amount: 1000, currency: 'USD' },
      daily_budget_cap: 100,
      purchase_order_ref: 'PO-SELLER',
    };
    const digest = proposalTermsDigest(commercialTerms);
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-1',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            terms_digest: digest,
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: commercialTerms,
          },
        ],
      });
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });

    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-1',
        proposal_terms_digest: digest,
        total_budget: { amount: 1, currency: 'USD' },
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.code === 'PROPOSAL_DIGEST_MISMATCH'
    );
    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-1',
        proposal_terms_digest: digest,
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError &&
        error.feature === 'commercial_terms.daily_budget_cap,budget_cap_timezone'
    );
    assert.equal(mutations, 0);
  });

  test('oversized seller proposals are not retained as executable acceptance snapshots', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'oversized',
            commercial_terms: {
              brand: { domain: 'example.com', padding: 'x'.repeat(300 * 1024) },
            },
          },
        ],
      });
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
        'proposal_hold_not_verifiable',
      ],
    });
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });

    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'oversized',
        established_fallback: {
          brand: { domain: 'example.com' },
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
        },
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 0);
  });

  test('seller proposals containing camelCase credential-shaped keys are never cached', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'credential-bearing-proposal',
            commercial_terms: { accessToken: 'must-not-enter-snapshot-cache' },
          },
        ],
      });
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
        'proposal_hold_not_verifiable',
      ],
    });
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });

    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'credential-bearing-proposal',
        established_fallback: {
          brand: { domain: 'example.com' },
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
        },
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 0);
  });

  test('credential-bearing or schema-invalid proposal metadata is never cached', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'invalid-metadata-proposal',
            terms_digest: { accessToken: 'must-not-enter-snapshot-cache' },
            commercial_terms: {
              brand: { domain: 'example.com' },
              start_time: '2027-01-01T00:00:00Z',
              end_time: '2027-02-01T00:00:00Z',
            },
          },
        ],
      });
    const coordinator = await agent.negotiateMediaBuyLifecycle({ principalScope: 'buyer-tenant-1' });
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });

    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'invalid-metadata-proposal',
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
  });

  test('seller proposals containing presigned URLs are never cached', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'presigned-url-proposal',
            commercial_terms: {
              brand: {
                domain: 'example.com',
                logo_url: 'https://assets.example/logo?X-Amz-Signature=must-not-enter-snapshot-cache',
              },
            },
          },
        ],
      });
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
        'proposal_hold_not_verifiable',
      ],
    });
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });

    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'presigned-url-proposal',
        established_fallback: {
          brand: { domain: 'example.com' },
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
        },
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 0);
  });

  test('an unsafe or non-terminal same-ID response invalidates an older executable snapshot', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const digest = proposalTermsDigest(commercialTerms);
    let response = completed('get_products', {
      proposals: [
        {
          proposal_id: 'replace-me',
          proposal_kind: 'new_media_buy',
          proposal_status: 'committed',
          terms_digest: digest,
          expires_at: '2099-12-31T23:59:59Z',
          commercial_terms: commercialTerms,
        },
      ],
    });
    agent.getProducts = async () => response;
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    const request = { brief: 'test', account: { account_id: 'account-1' } };
    const accept = () =>
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'replace-me',
        proposal_terms_digest: digest,
      });

    await coordinator.requestProposals(request);
    response = completed('get_products', {
      proposals: [{ proposal_id: 'replace-me', commercial_terms: { accessToken: 'unsafe' } }],
    });
    await coordinator.requestProposals(request);
    await assert.rejects(
      accept(),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );

    response = completed('get_products', {
      proposals: [
        {
          proposal_id: 'replace-me',
          proposal_kind: 'new_media_buy',
          proposal_status: 'committed',
          terms_digest: digest,
          expires_at: '2099-12-31T23:59:59Z',
          commercial_terms: commercialTerms,
        },
      ],
    });
    await coordinator.requestProposals(request);
    response = { ...working('get_products'), data: { proposals: [{ proposal_id: 'replace-me' }] } };
    await coordinator.requestProposals(request);
    await assert.rejects(
      accept(),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 0);
  });

  test('proposal account scope cannot be borrowed across authenticated principals', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const proposal = {
      proposal_id: 'shared-principal-proposal',
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    };
    proposal.terms_digest = proposalTermsDigest(proposal.commercial_terms);
    agent.getProducts = async () => completed('get_products', { proposals: [proposal] });
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const options = principalScope => ({
      principalScope,
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    const first = await agent.negotiateMediaBuyLifecycle(options('buyer-tenant-1'));
    await first.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });

    const second = await agent.negotiateMediaBuyLifecycle(options('buyer-tenant-2'));
    await second.refineProposals({
      refinements: [{ proposal_id: proposal.proposal_id, action: 'revise', ask: 'same terms' }],
    });
    await assert.rejects(
      second.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: proposal.proposal_id,
        proposal_terms_digest: proposal.terms_digest,
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 0);
  });

  test('same-key refinement replay cannot resurrect a source retired by an ambiguous failure', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const proposal = {
      proposal_id: 'refine-retry-proposal',
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    };
    proposal.terms_digest = proposalTermsDigest(proposal.commercial_terms);
    let calls = 0;
    agent.getProducts = async () => {
      calls += 1;
      if (calls === 2) throw new Error('transport closed after seller committed refinement');
      return completed('get_products', { proposals: [proposal] });
    };
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: 'mb-refined', revision: 1 });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });
    const refinement = {
      idempotency_key: 'same-refinement-retry-key-0001',
      refinements: [{ proposal_id: proposal.proposal_id, action: 'revise', ask: 'same terms' }],
    };

    await assert.rejects(coordinator.refineProposals(refinement), /transport closed/);
    await coordinator.refineProposals(refinement);
    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: proposal.proposal_id,
        proposal_terms_digest: proposal.terms_digest,
      }),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    assert.equal(mutations, 0);
  });

  test('proposal snapshot ceiling is shared by coordinators for the same authenticated AgentClient', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const digest = proposalTermsDigest(commercialTerms);
    const calls = [];
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'shared-agent-snapshot',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            terms_digest: digest,
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: commercialTerms,
          },
        ],
      });
    agent.createMediaBuy = async request => {
      calls.push(request);
      return completed('create_media_buy', { media_buy_id: 'mb-shared', revision: 1 });
    };
    const options = {
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    };
    const discoveryCoordinator = await agent.negotiateMediaBuyLifecycle(options);
    await discoveryCoordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });

    const acceptanceCoordinator = await agent.negotiateMediaBuyLifecycle(options);
    await acceptanceCoordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: 'shared-agent-snapshot',
      proposal_terms_digest: digest,
    });

    assert.equal(calls.length, 1);
  });

  test('proposal snapshot quotas and tombstones are isolated by authenticated principal', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const digest = proposalTermsDigest(commercialTerms);
    const protectedProposal = {
      proposal_id: 'principal-isolated-proposal',
      proposal_kind: 'new_media_buy',
      proposal_status: 'committed',
      terms_digest: digest,
      expires_at: '2099-12-31T23:59:59Z',
      commercial_terms: commercialTerms,
    };
    let response;
    agent.getProducts = async () => completed('get_products', response);
    let mutations = 0;
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', { media_buy_id: 'principal-isolated-buy', revision: 1 });
    };
    const options = principalScope => ({
      principalScope,
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    const noisyCoordinators = [];
    for (let principal = 0; principal < 4; principal += 1) {
      response = {
        proposals: Array.from({ length: 300 }, (_, index) => ({
          ...protectedProposal,
          proposal_id: `noisy-principal-${principal}-proposal-${index}`,
        })),
      };
      const noisyCoordinator = await agent.negotiateMediaBuyLifecycle(options(`noisy-principal-${principal}`));
      await noisyCoordinator.requestProposals({ brief: 'pressure', account: { account_id: 'account-1' } });
      assert.ok(noisyCoordinator.proposalSnapshotStore.entries.size <= 256);
      noisyCoordinators.push(noisyCoordinator);
    }

    response = { proposals: [protectedProposal] };
    const protectedCoordinator = await agent.negotiateMediaBuyLifecycle(options('protected-principal'));
    await protectedCoordinator.requestProposals({ brief: 'protected', account: { account_id: 'account-1' } });
    assert.equal(protectedCoordinator.proposalSnapshotStore.entries.size, 1);
    for (const noisyCoordinator of noisyCoordinators) {
      assert.notEqual(noisyCoordinator.proposalSnapshotStore, protectedCoordinator.proposalSnapshotStore);
    }

    await protectedCoordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: protectedProposal.proposal_id,
      proposal_terms_digest: digest,
    });
    assert.equal(mutations, 1);
    noisyCoordinators.forEach(coordinator => coordinator.dispose());
    protectedCoordinator.dispose();
  });

  test('an honest 3.0/3.1 proposal remains executable with explicit legacy guarantee losses', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    const calls = [];
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'legacy-proposal-1',
            name: 'Legacy proposal',
            proposal_status: 'committed',
            expires_at: '2099-12-31T23:59:59Z',
            allocations: [{ product_id: 'product-1', pricing_option_id: 'option-1', allocation_percentage: 100 }],
          },
        ],
        cache_scope: 'account',
      });
    agent.createMediaBuy = async request => {
      calls.push(request);
      return completed('create_media_buy', { media_buy_id: 'mb-legacy', revision: 1 });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ],
    });
    await coordinator.requestProposals({
      brief: 'test',
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
    });

    const result = await coordinator.acceptProposal({
      account: { account_id: 'account-1' },
      proposal_id: 'legacy-proposal-1',
      total_budget: { amount: 1000, currency: 'USD' },
      established_fallback: {
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].proposal_id, 'legacy-proposal-1');
    assert.equal(calls[0].proposal_terms_digest, undefined);
    assert.deepEqual(result.compatibility.losses, [
      'proposal_terms_digest_not_enforced',
      'proposal_terms_digest_unavailable',
      'proposal_snapshot_not_immutable',
    ]);
  });

  test('caller mutation cannot alter the private seller proposal snapshot', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const sellerDigest = proposalTermsDigest(commercialTerms);
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-1',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            terms_digest: sellerDigest,
            expires_at: '2099-12-31T23:59:59Z',
            commercial_terms: commercialTerms,
          },
        ],
        cache_scope: 'account',
      });
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    const requested = await coordinator.requestProposals({
      brief: 'test',
      account: { account_id: 'account-1' },
    });
    const exposed = requested.data.proposals[0];
    exposed.commercial_terms.brand.domain = 'attacker.example';
    exposed.terms_digest = proposalTermsDigest(exposed.commercial_terms);

    await assert.rejects(
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-1',
        proposal_terms_digest: exposed.terms_digest,
      }),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.code === 'PROPOSAL_DIGEST_MISMATCH'
    );
    assert.equal(mutations, 0);
  });

  test('legacy proposal acceptance is account-scoped and committed-new-buy only', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const sellerDigest = proposalTermsDigest(commercialTerms);
    let proposal = {
      proposal_id: 'proposal-shared',
      proposal_kind: 'media_buy_cancellation',
      proposal_status: 'committed',
      terms_digest: sellerDigest,
      commercial_terms: commercialTerms,
    };
    agent.getProducts = async () => completed('get_products', { proposals: [proposal], cache_scope: 'account' });
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-a' } });

    const accept = (account_id, proposal_id = 'proposal-shared') =>
      coordinator.acceptProposal({
        account: { account_id },
        proposal_id,
        proposal_terms_digest: sellerDigest,
      });
    await assert.rejects(
      accept('account-b'),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_snapshot/account_scope'
    );
    await assert.rejects(
      accept('account-a'),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_kind'
    );

    proposal = { ...proposal, proposal_id: 'proposal-draft', proposal_kind: 'new_media_buy', proposal_status: 'draft' };
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-a' } });
    await assert.rejects(
      accept('account-a', 'proposal-draft'),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'proposal_status'
    );
    assert.equal(mutations, 0);
  });

  test('legacy proposal acceptance requires opt-in for an unverifiable hold and rejects an expired hold', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.1' }));
    let mutations = 0;
    let expires_at;
    const commercialTerms = {
      brand: { domain: 'example.com' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-02-01T00:00:00Z',
    };
    const digest = proposalTermsDigest(commercialTerms);
    agent.getProducts = async () =>
      completed('get_products', {
        proposals: [
          {
            proposal_id: 'proposal-1',
            proposal_kind: 'new_media_buy',
            proposal_status: 'committed',
            terms_digest: digest,
            ...(expires_at && { expires_at }),
            commercial_terms: commercialTerms,
          },
        ],
        cache_scope: 'account',
      });
    agent.createMediaBuy = async () => {
      mutations += 1;
      return completed('create_media_buy', {});
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle({
      principalScope: 'buyer-tenant-1',
      allowedLosses: ['proposal_terms_digest_not_enforced'],
    });
    const accept = () =>
      coordinator.acceptProposal({
        account: { account_id: 'account-1' },
        proposal_id: 'proposal-1',
        proposal_terms_digest: digest,
      });

    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });
    await assert.rejects(
      accept(),
      error =>
        error instanceof MediaBuyLifecycleCompatibilityError && error.losses.includes('proposal_hold_not_verifiable')
    );

    expires_at = '2000-01-01T00:00:00Z';
    await coordinator.requestProposals({ brief: 'test', account: { account_id: 'account-1' } });
    await assert.rejects(
      accept(),
      error => error instanceof MediaBuyLifecycleCompatibilityError && error.feature === 'expires_at'
    );
    assert.equal(mutations, 0);
  });

  test('legacy operational control maps revision, pause, and cancellation exactly', async () => {
    const agent = clientWithCaps(capabilities({ version: '3.0' }));
    const calls = [];
    agent.updateMediaBuy = async request => {
      calls.push(request);
      return completed('update_media_buy', { media_buy_id: request.media_buy_id, revision: 4 });
    };
    const coordinator = await agent.negotiateMediaBuyLifecycle();

    const paused = await coordinator.controlMediaBuy({
      idempotency_key: 'control-compat-key-0001',
      account: { account_id: 'account-1' },
      media_buy_id: 'mb-1',
      revision: 3,
      paused: true,
    });
    const canceled = await coordinator.controlMediaBuy({
      idempotency_key: 'control-compat-key-0002',
      account: { account_id: 'account-1' },
      media_buy_id: 'mb-1',
      revision: 4,
      canceled: true,
      cancellation_reason: 'buyer request',
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(
      {
        idempotency_key: calls[0].idempotency_key,
        media_buy_id: calls[0].media_buy_id,
        revision: calls[0].revision,
        paused: calls[0].paused,
        canceled: calls[0].canceled,
      },
      {
        idempotency_key: 'control-compat-key-0001',
        media_buy_id: 'mb-1',
        revision: 3,
        paused: true,
        canceled: undefined,
      }
    );
    assert.deepEqual(
      {
        idempotency_key: calls[1].idempotency_key,
        media_buy_id: calls[1].media_buy_id,
        revision: calls[1].revision,
        paused: calls[1].paused,
        canceled: calls[1].canceled,
        cancellation_reason: calls[1].cancellation_reason,
      },
      {
        idempotency_key: 'control-compat-key-0002',
        media_buy_id: 'mb-1',
        revision: 4,
        paused: undefined,
        canceled: true,
        cancellation_reason: 'buyer request',
      }
    );
    assert.equal(paused.compatibility.compatibility, 'lossless_projection');
    assert.equal(canceled.compatibility.compatibility, 'lossless_projection');
  });
});
