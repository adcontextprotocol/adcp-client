const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProposalNegotiator,
  ProposalRefinementValidationError,
  ProposalResponseVerificationError,
  RefineProposalsTaskError,
  buildRefineProposalsRequest,
  classifyProposalRefinementFailure,
  createProposalRefinementHandler,
  createProposalSuccessor,
  proposalTermsDigest,
  unwrapVerifiedRefineProposals,
  verifyRefineProposalsResponse,
} = require('../../dist/lib/index.js');

const KEY = 'refine-key-0000000001';

function terms(overrides = {}) {
  return {
    brand: { domain: 'coffee.example' },
    purchases: [
      {
        product_id: 'product-1',
        pricing_option_id: 'price-1',
        pricing: { pricing_option_id: 'price-1', pricing_model: 'cpm', currency: 'USD', fixed_price: 8 },
        impressions: 1_000_000,
        start_time: '2027-01-01T00:00:00.000Z',
        end_time: '2027-02-01T00:00:00.000Z',
      },
    ],
    start_time: '2027-01-01T00:00:00.000Z',
    end_time: '2027-02-01T00:00:00.000Z',
    total_budget: { amount: 8_000, currency: 'USD' },
    ...overrides,
  };
}

function proposal(id, parent, status = 'draft', termOverrides = {}) {
  const commercial_terms = terms(termOverrides);
  return {
    proposal_id: id,
    proposal_kind: 'new_media_buy',
    parent_proposal_id: parent,
    proposal_status: status,
    ...(status === 'committed' && { expires_at: '2100-01-01T00:00:00.000Z' }),
    name: id,
    commercial_terms,
    terms_digest: proposalTermsDigest(commercial_terms),
  };
}

function revise(overrides = {}) {
  return { proposal_id: 'source-1', action: 'revise', ask: 'A stronger offer', ...overrides };
}

function request(refinements = [revise()]) {
  return { adcp_version: '3.2-rc.0', adcp_major_version: 3, idempotency_key: KEY, refinements };
}

function completed(data) {
  return {
    success: true,
    status: 'completed',
    data,
    metadata: {
      taskId: 'task-1',
      taskName: 'refine_proposals',
      agent: { id: 'seller', name: 'Seller', protocol: 'mcp' },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'completed',
    },
  };
}

test('buyer builder enforces explicit capability omissions for every typed dimension', () => {
  const cases = [
    revise({ constraints: { total_budget: { currency: 'USD', max: 10_000 } }, ask: undefined }),
    revise({ constraints: { cpm: { currency: 'USD', max: 10 } }, ask: undefined }),
    revise({ constraints: { impressions: { min: 10 } }, ask: undefined }),
    revise({ constraints: { flight: { start_no_later_than: '2027-01-01T00:00:00Z' } }, ask: undefined }),
    revise({ product_changes: { 'product-2': 'include' }, ask: undefined }),
    revise({ alternatives: { count: 2 }, ask: undefined }),
    revise({ criteria: { product_ids: ['product-1'] }, ask: undefined }),
  ];
  for (const refinement of cases) {
    assert.throws(
      () => buildRefineProposalsRequest({ refinements: [refinement] }, { supported_dimensions: [] }),
      ProposalRefinementValidationError
    );
  }
  assert.doesNotThrow(() =>
    buildRefineProposalsRequest({
      refinements: cases.map((entry, index) => ({ ...entry, proposal_id: `source-${index}` })),
    })
  );
});

test('buyer builder enforces protocol and seller alternative ceilings', () => {
  assert.equal(
    buildRefineProposalsRequest(
      { refinements: [revise({ alternatives: { count: 10 } })] },
      { supported_dimensions: ['alternatives'], max_alternatives: 10 }
    ).refinements[0].alternatives.count,
    10
  );
  assert.throws(() => buildRefineProposalsRequest({ refinements: [revise({ alternatives: { count: 11 } })] }), /2-10/);
  assert.throws(
    () =>
      buildRefineProposalsRequest(
        { refinements: [revise({ alternatives: { count: 5 } })] },
        { supported_dimensions: ['alternatives'], max_alternatives: 4 }
      ),
    /exceeds seller/
  );
});

test('buyer builder accepts 25 refinements, rejects 26, duplicates, and mixed finalize batches', () => {
  const twentyFive = Array.from({ length: 25 }, (_, i) => revise({ proposal_id: `source-${i}` }));
  assert.equal(buildRefineProposalsRequest({ refinements: twentyFive }).refinements.length, 25);
  assert.throws(
    () => buildRefineProposalsRequest({ refinements: [...twentyFive, revise({ proposal_id: 'source-26' })] }),
    /1-25/
  );
  assert.throws(() => buildRefineProposalsRequest({ refinements: [revise(), revise()] }), /unique/);
  assert.throws(
    () =>
      buildRefineProposalsRequest({
        refinements: [revise(), { proposal_id: 'source-2', action: 'finalize' }],
      }),
    /only finalize/
  );
});

test('response verifier accepts all eight reason codes with their required machine-readable shape', () => {
  const reasons = [
    'commercially_declined',
    'constraint_unsatisfiable',
    'unsupported_dimension',
    'uninterpreted',
    'alternatives_unavailable',
    'source_unavailable',
    'hold_unavailable',
    'batch_aborted',
  ];
  for (const reason_code of reasons) {
    const req = request([revise({ constraints: { total_budget: { currency: 'USD', max: 5_000 } }, ask: undefined })]);
    const response = {
      results: [
        {
          source_proposal_id: 'source-1',
          outcome: 'unable',
          reason_code,
          reason: reason_code,
          ...(reason_code === 'constraint_unsatisfiable' && { unsatisfied_constraints: ['total_budget'] }),
        },
      ],
      products: [],
    };
    assert.equal(verifyRefineProposalsResponse(req, response).ok, true, reason_code);
  }
});

test('seller failure classification gives typed constraints precedence over commercial refusal', () => {
  assert.equal(
    classifyProposalRefinementFailure({
      unsatisfied_constraints: ['cpm'],
      alternatives_unavailable: true,
      commercially_declined: true,
    }),
    'constraint_unsatisfiable'
  );
  assert.equal(classifyProposalRefinementFailure({ hold_unavailable: true }), 'hold_unavailable');
  assert.equal(classifyProposalRefinementFailure({}), 'uninterpreted');
});

test('response verifier checks ordering, lineage, JCS digest, and distinct alternatives', () => {
  const req = request([revise({ alternatives: { count: 2 } })]);
  const duplicate = proposal('draft-2', 'wrong-parent');
  duplicate.terms_digest = 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const verified = verifyRefineProposalsResponse(req, {
    results: [
      {
        source_proposal_id: 'wrong-source',
        outcome: 'revised',
        proposals: [proposal('draft-1', 'source-1'), duplicate],
      },
    ],
    products: [],
  });
  assert.equal(verified.ok, false);
  assert.deepEqual(
    new Set(verified.issues.map(issue => issue.code)),
    new Set(['result_order', 'lineage', 'terms_digest', 'duplicate_terms'])
  );
});

test('partial proposals satisfy every constraint outside the advertised unsatisfied subset', () => {
  const req = request([
    revise({
      ask: undefined,
      alternatives: { count: 2 },
      constraints: {
        total_budget: { currency: 'USD', max: 5_000 },
        impressions: { min: 900_000 },
      },
    }),
  ]);
  const valid = {
    results: [
      {
        source_proposal_id: 'source-1',
        outcome: 'partial',
        proposals: [proposal('draft-1', 'source-1')],
        reason_code: 'constraint_unsatisfiable',
        reason: 'budget unavailable',
        unsatisfied_constraints: ['total_budget'],
      },
    ],
    products: [],
  };
  assert.equal(verifyRefineProposalsResponse(req, valid).ok, true);
  valid.results[0].proposals[0] = proposal('draft-2', 'source-1', 'draft', {
    purchases: [{ ...terms().purchases[0], impressions: 1 }],
  });
  assert.equal(
    verifyRefineProposalsResponse(req, valid).issues.some(issue => issue.code === 'partial_invariant'),
    true
  );
  valid.results[0].proposals = [
    proposal('draft-1', 'source-1'),
    proposal('draft-2', 'source-1', 'draft', { total_budget: { amount: 7_000, currency: 'USD' } }),
    proposal('draft-3', 'source-1'),
  ];
  assert.equal(
    verifyRefineProposalsResponse(req, valid).issues.some(issue => issue.code === 'alternative_count'),
    true
  );
});

test('ProposalNegotiator reuses exact keys on transport retry and mints keys for changed intent', async () => {
  let calls = 0;
  const seen = [];
  const transport = async req => {
    seen.push(req);
    if (calls++ === 0) throw new Error('socket reset');
    return completed({
      results: [
        {
          source_proposal_id: 'source-1',
          outcome: 'revised',
          proposals: [proposal('draft-1', 'source-1')],
        },
      ],
      products: [],
    });
  };
  const negotiator = new ProposalNegotiator(transport, { transportRetries: 1 });
  const executed = await negotiator.execute({ refinements: [revise()] });
  assert.strictEqual(seen[0], seen[1]);
  assert.equal(seen[0].idempotency_key, seen[1].idempotency_key);
  const changed = negotiator.changedRequest(executed.request, [revise({ ask: 'Different intent' })]);
  assert.notEqual(changed.idempotency_key, executed.request.idempotency_key);
});

test('task failures/intermediate states surface before response fields and expired holds cannot be accepted', async () => {
  const failed = {
    success: false,
    status: 'failed',
    error: 'INVALID_STATE: already finalized',
    metadata: completed({}).metadata,
  };
  assert.throws(() => unwrapVerifiedRefineProposals(failed, request()), RefineProposalsTaskError);

  let accepted = false;
  const negotiator = new ProposalNegotiator(async () => failed, {
    now: () => new Date('2100-01-02T00:00:00.000Z'),
  });
  await assert.rejects(
    () =>
      negotiator.accept(proposal('held', 'source-1', 'committed'), async () => {
        accepted = true;
      }),
    /hold has expired/
  );
  assert.equal(accepted, false);
});

test('AgentClient.refineProposals dispatches through the official MCP client with its configured wire pin', async () => {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { AgentClient } = require('../../dist/lib/index.js');
  const z = require('zod');
  let captured;
  const server = new McpServer({ name: 'Negotiation seller', version: '1.0.0' });
  server.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: '{}' }],
    structuredContent: {
      success: true,
      adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      supported_protocols: ['media_buy'],
      specialisms: [],
    },
  }));
  server.registerTool(
    'refine_proposals',
    {
      inputSchema: {
        adcp_version: z.string(),
        adcp_major_version: z.number(),
        idempotency_key: z.string(),
        refinements: z.array(z.any()),
      },
    },
    async args => {
      captured = args;
      return {
        content: [{ type: 'text', text: '{}' }],
        structuredContent: {
          success: true,
          results: [
            {
              source_proposal_id: 'source-1',
              outcome: 'revised',
              proposals: [proposal('draft-1', 'source-1')],
            },
          ],
          products: [],
        },
      };
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'Buyer', version: '1.0.0' });
  await mcpClient.connect(clientTransport);
  const agent = AgentClient.fromMCPClient(mcpClient, {
    adcpVersion: '3.2.0-rc.0',
    wireAdcpVersion: '3.2.0-beta.1',
  });

  const result = await agent.refineProposals({ refinements: [revise()] });
  assert.equal(result.success, true);
  assert.match(captured.idempotency_key, /^[A-Za-z0-9_.:-]{16,255}$/);
  assert.equal(captured.adcp_version, '3.2-beta.1');
  assert.equal(captured.adcp_major_version, 3);
  assert.equal(captured.refinements[0].proposal_id, 'source-1');

  await mcpClient.close();
  await server.close();
});

test('ADCPMultiAgentClient.simple forwards an exact prerelease wire pin to proposal requests', async () => {
  const { ADCPMultiAgentClient } = require('../../dist/lib/index.js');
  const client = ADCPMultiAgentClient.simple('https://seller.example.com/mcp', {
    adcpVersion: '3.2.0-rc.0',
    wireAdcpVersion: '3.2.0-beta.1',
  });
  const agent = client.agent('default-agent');
  let captured;
  agent.client.executeTask = async (_taskName, request) => {
    captured = request;
    return {
      success: false,
      status: 'failed',
      error: 'test transport stopped after request capture',
      metadata: {
        taskId: 'capture-1',
        taskName: 'refine_proposals',
        agent: { id: 'default-agent', name: 'Default Agent', protocol: 'mcp' },
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status: 'failed',
      },
    };
  };

  await agent.refineProposals({ refinements: [revise()] });
  assert.equal(client.getAdcpVersion(), '3.2.0-rc.0');
  assert.equal(captured.adcp_version, '3.2-beta.1');
  assert.equal(captured.adcp_major_version, 3);
});

test('seller handler commits a complete finalize batch atomically', async () => {
  const sources = new Map([
    ['source-1', proposal('source-1', undefined)],
    ['source-2', proposal('source-2', undefined)],
  ]);
  const staged = [];
  let commits = 0;
  const handler = createProposalRefinementHandler({
    capabilities: { supported_dimensions: [] },
    scope: () => ({ tenant_id: 'tenant-1', principal_id: 'buyer-1' }),
    store: {
      get: (_scope, id) => (sources.has(id) ? { proposal: sources.get(id), version: `v:${id}` } : null),
      begin: () => ({
        stage: proposals => staged.push(...proposals),
        commit: () => commits++,
        rollback: () => assert.fail('rollback not expected'),
      }),
    },
    evaluate: ({ refinement, source }) => ({
      source_proposal_id: refinement.proposal_id,
      outcome: 'finalized',
      proposal: createProposalSuccessor(source, {
        ...proposal(`held-${refinement.proposal_id}`, undefined, 'committed'),
      }),
    }),
  });
  const response = await handler(
    request([
      { proposal_id: 'source-1', action: 'finalize' },
      { proposal_id: 'source-2', action: 'finalize' },
    ]),
    {}
  );
  assert.equal(response.results.length, 2);
  assert.equal(staged.length, 2);
  assert.equal(commits, 1);
});

test('seller validates the full response before opening a transaction', async () => {
  let begins = 0;
  const source = proposal('source-1', undefined);
  const handler = createProposalRefinementHandler({
    capabilities: { supported_dimensions: [] },
    scope: () => ({ tenant_id: 'tenant-1', principal_id: 'buyer-1' }),
    store: {
      get: () => ({ proposal: source, version: 'v:source-1' }),
      begin: () => {
        begins++;
        throw new Error('must not begin');
      },
    },
    evaluate: () => ({
      source_proposal_id: 'source-1',
      outcome: 'revised',
      proposals: [proposal('bad', 'wrong-parent')],
    }),
  });
  await assert.rejects(() => handler(request(), {}), ProposalResponseVerificationError);
  assert.equal(begins, 0);
});

test('seller preflight failures retain structured protocol codes and perform no work', async () => {
  let evaluations = 0;
  let begins = 0;
  const source = proposal('source-1', undefined, 'committed');
  const handler = createProposalRefinementHandler({
    capabilities: { supported_dimensions: [] },
    scope: () => ({ tenant_id: 'tenant-1', principal_id: 'buyer-1' }),
    store: {
      get: () => ({ proposal: source, version: 'v:source-1' }),
      begin: () => {
        begins++;
        throw new Error('must not begin');
      },
    },
    evaluate: () => {
      evaluations++;
      throw new Error('must not evaluate');
    },
  });
  await assert.rejects(
    () => handler(request([{ proposal_id: 'source-1', action: 'finalize' }]), {}),
    error =>
      error.name === 'AdcpError' &&
      error.code === 'INVALID_STATE' &&
      error.recovery === 'correctable' &&
      error.field === 'refinements[0].proposal_id'
  );
  assert.equal(evaluations, 0);
  assert.equal(begins, 0);
});

test('seller rejects a partially successful finalize batch before persistence', async () => {
  let begins = 0;
  const sources = new Map([
    ['source-1', proposal('source-1', undefined)],
    ['source-2', proposal('source-2', undefined)],
  ]);
  const handler = createProposalRefinementHandler({
    capabilities: { supported_dimensions: [] },
    scope: () => ({ tenant_id: 'tenant-1', principal_id: 'buyer-1' }),
    store: {
      get: (_scope, id) => (sources.has(id) ? { proposal: sources.get(id), version: `v:${id}` } : null),
      begin: () => {
        begins++;
        throw new Error('must not begin');
      },
    },
    evaluate: ({ refinement, source, index }) =>
      index === 0
        ? {
            source_proposal_id: refinement.proposal_id,
            outcome: 'finalized',
            proposal: createProposalSuccessor(source, {
              ...proposal('held-1', undefined, 'committed'),
            }),
          }
        : {
            source_proposal_id: refinement.proposal_id,
            outcome: 'unable',
            reason_code: 'hold_unavailable',
            reason: 'inventory changed',
          },
  });
  await assert.rejects(
    () =>
      handler(
        request([
          { proposal_id: 'source-1', action: 'finalize' },
          { proposal_id: 'source-2', action: 'finalize' },
        ]),
        {}
      ),
    ProposalResponseVerificationError
  );
  assert.equal(begins, 0);
});

test('seller rolls back the transaction when atomic commit fails', async () => {
  let rollbacks = 0;
  const source = proposal('source-1', undefined);
  const handler = createProposalRefinementHandler({
    capabilities: { supported_dimensions: [] },
    scope: () => ({ tenant_id: 'tenant-1', principal_id: 'buyer-1' }),
    store: {
      get: () => ({ proposal: source, version: 'v:source-1' }),
      begin: () => ({
        stage: () => {},
        commit: () => {
          throw new Error('hold race');
        },
        rollback: () => rollbacks++,
      }),
    },
    evaluate: () => ({
      source_proposal_id: 'source-1',
      outcome: 'revised',
      proposals: [proposal('draft-2', 'source-1')],
    }),
  });
  await assert.rejects(() => handler(request(), {}), /hold race/);
  assert.equal(rollbacks, 1);
});
