// Experimental AdCP 3.3 refine_proposals additions: the extend_hold action
// (media_buy.hold_extension), include_collections / collections
// (media_buy.collection_cards), and expected_confirmation_at (adcp-client#3601).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProposalNegotiator,
  ProposalRefinementValidationError,
  ProposalResponseVerificationError,
  buildRefineProposalsRequest,
  createProposalRefinementHandler,
  extractProposalRefinementSupport,
  proposalTermsDigest,
  refinementDimensions,
  validateRefineProposalsRequest,
  validateRefineProposalsResponseShape,
  verifyHoldExtension,
  verifyRefineProposalsResponse,
} = require('../../dist/lib/index.js');

const KEY = 'hold-extension-key-0001';
const HOLD_CAPABILITIES = { supported_dimensions: [], hold_extension: true };

function terms() {
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
  };
}

function committed(id, parent, expires_at, overrides = {}) {
  const commercial_terms = overrides.commercial_terms ?? terms();
  return {
    proposal_id: id,
    proposal_kind: 'new_media_buy',
    parent_proposal_id: parent,
    proposal_status: 'committed',
    expires_at,
    name: id,
    commercial_terms,
    terms_digest: proposalTermsDigest(commercial_terms),
    ...overrides,
  };
}

function extendHold(proposal_id = 'held-1', extra = {}) {
  return { proposal_id, action: 'extend_hold', ...extra };
}

function request(refinements = [extendHold()], extra = {}) {
  return { adcp_version: '3.3-rc.3', adcp_major_version: 3, idempotency_key: KEY, refinements, ...extra };
}

function finalized(source = 'held-1', successor = 'held-2', expires_at = '2100-01-02T00:00:00.000Z') {
  return { source_proposal_id: source, outcome: 'finalized', proposal: committed(successor, source, expires_at) };
}

function collection(overrides = {}) {
  return {
    publisher_domain: 'pub.example',
    collection_id: 'show-1',
    name: 'Morning Show',
    kind: 'series',
    ...overrides,
  };
}

function rejects(fn, pattern, field) {
  assert.throws(fn, error => {
    assert.ok(error instanceof ProposalRefinementValidationError, String(error));
    assert.match(error.message, pattern);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  });
}

// --- Request validation ---------------------------------------------------

test('extend_hold is accepted on AdCP 3.3 with only proposal_id, action, and ext', () => {
  assert.doesNotThrow(() => validateRefineProposalsRequest(request()));
  assert.doesNotThrow(() => validateRefineProposalsRequest(request(), HOLD_CAPABILITIES));
  assert.doesNotThrow(() =>
    validateRefineProposalsRequest(request([extendHold('held-1', { ext: { vendor: { trace: 'a' } } })]))
  );
  assert.doesNotThrow(() =>
    validateRefineProposalsRequest(request([extendHold('held-1'), extendHold('held-2')]), HOLD_CAPABILITIES)
  );
  assert.deepEqual(refinementDimensions(extendHold()), []);

  // The builder defaults to the SDK's 3.3 pin.
  const built = buildRefineProposalsRequest({ refinements: [extendHold()] }, HOLD_CAPABILITIES);
  assert.match(built.adcp_version, /^3\.3/);
  assert.deepEqual(built.refinements, [extendHold()]);
});

test('extend_hold is refused below AdCP 3.3', () => {
  rejects(
    () => validateRefineProposalsRequest(request([extendHold()], { adcp_version: '3.2' })),
    /extend_hold requires AdCP 3\.3/,
    'refinements[0].action'
  );
});

test('extend_hold forbids every revise field and still rejects unknown keys', () => {
  for (const [key, value] of [
    ['ask', 'longer please'],
    ['change_kind', 'amendment'],
    ['constraints', { total_budget: { currency: 'USD', max: 10 } }],
    ['product_changes', { 'product-1': 'include' }],
    ['alternatives', { count: 2 }],
    ['criteria', { product_ids: ['product-1'] }],
    ['remove_media_buy_frequency_cap', true],
    ['installment_changes', []],
    ['expires_at', '2100-01-01T00:00:00Z'],
    ['vendor_field', true],
  ]) {
    rejects(
      () => validateRefineProposalsRequest(request([extendHold('held-1', { [key]: value })])),
      new RegExp(`${key} is not allowed`),
      `refinements[0].${key}`
    );
  }
  rejects(
    () => validateRefineProposalsRequest(request([extendHold('held-1', { ext: 'not-an-object' })])),
    /ext must be an object/,
    'refinements[0].ext'
  );
});

test('a batch containing extend_hold contains only extend_hold entries', () => {
  rejects(
    () =>
      validateRefineProposalsRequest(
        request([extendHold(), { proposal_id: 'draft-1', action: 'revise', ask: 'cheaper' }])
      ),
    /only extend_hold entries/,
    'refinements[1].action'
  );
  rejects(
    () => validateRefineProposalsRequest(request([extendHold(), { proposal_id: 'draft-1', action: 'finalize' }])),
    /only (finalize|extend_hold) entries/
  );
  rejects(
    () => validateRefineProposalsRequest(request([extendHold('held-1'), extendHold('held-1')])),
    /proposal_id values must be unique/
  );
});

test('extend_hold requires a declared hold_extension when seller capabilities are known', () => {
  for (const capabilities of [{ supported_dimensions: [] }, { supported_dimensions: [], hold_extension: false }]) {
    assert.throws(
      () => validateRefineProposalsRequest(request(), capabilities),
      error =>
        error instanceof ProposalRefinementValidationError &&
        error.code === 'VALIDATION_ERROR' &&
        error.field === 'refinements[0].action' &&
        /hold_extension/.test(error.message)
    );
  }
  rejects(
    () => validateRefineProposalsRequest(request(), { supported_dimensions: [], hold_extension: 'yes' }),
    /hold_extension must be a boolean/,
    'capabilities.hold_extension'
  );
  // The declaration does not gate finalize or revise.
  assert.doesNotThrow(() =>
    validateRefineProposalsRequest(request([{ proposal_id: 'draft-1', action: 'finalize' }]), {
      supported_dimensions: [],
    })
  );
});

test('capability discovery carries hold_extension', () => {
  const support = extractProposalRefinementSupport({
    media_buy: { lifecycle_tools: ['refine_proposals'], proposal_refinement: HOLD_CAPABILITIES },
  });
  assert.equal(support.supported, true);
  assert.equal(support.capabilities.hold_extension, true);
  const absent = extractProposalRefinementSupport({
    media_buy: { lifecycle_tools: ['refine_proposals'], proposal_refinement: { supported_dimensions: [] } },
  });
  assert.equal(Object.hasOwn(absent.capabilities, 'hold_extension'), false);
  assert.throws(
    () =>
      extractProposalRefinementSupport({
        media_buy: { proposal_refinement: { supported_dimensions: [], hold_extension: 1 } },
      }),
    /hold_extension must be a boolean/
  );
});

test('include_collections is a 3.3 boolean', () => {
  const finalize = [{ proposal_id: 'draft-1', action: 'finalize' }];
  assert.doesNotThrow(() => validateRefineProposalsRequest(request(finalize, { include_collections: true })));
  assert.doesNotThrow(() => validateRefineProposalsRequest(request(finalize, { include_collections: false })));
  rejects(
    () => validateRefineProposalsRequest(request(finalize, { include_collections: 'true' })),
    /include_collections must be a boolean/,
    'include_collections'
  );
  rejects(
    () => validateRefineProposalsRequest(request(finalize, { adcp_version: '3.2', include_collections: true })),
    /include_collections requires AdCP 3\.3/,
    'include_collections'
  );
});

// --- Response verification ------------------------------------------------

test('a successful extension verifies as a committed finalized successor', () => {
  const result = verifyRefineProposalsResponse(request(), { results: [finalized()], products: [] });
  assert.deepEqual(result.issues, []);

  const batch = verifyRefineProposalsResponse(request([extendHold('held-1'), extendHold('held-3')]), {
    results: [finalized('held-1', 'held-2'), finalized('held-3', 'held-4')],
    products: [],
  });
  assert.deepEqual(batch.issues, []);
});

test('a declined extension verifies as unable', () => {
  for (const reason_code of ['hold_unavailable', 'batch_aborted', 'source_unavailable']) {
    const result = verifyRefineProposalsResponse(request(), {
      results: [{ source_proposal_id: 'held-1', outcome: 'unable', reason_code, reason: 'No extension.' }],
      products: [],
    });
    assert.deepEqual(result.issues, [], reason_code);
  }
});

test('extension results are rejected when they are not finalized or unable, or break the batch', () => {
  const has = (req, payload, code, path) =>
    verifyRefineProposalsResponse(req, payload).issues.some(issue => issue.code === code && issue.path === path);

  const draft = committed('held-2', 'held-1', undefined, { proposal_status: 'draft' });
  delete draft.expires_at;
  assert.ok(
    has(
      request(),
      { results: [{ source_proposal_id: 'held-1', outcome: 'revised', proposals: [draft] }], products: [] },
      'outcome',
      'results[0].outcome'
    )
  );
  // All-or-none: one extended entry and one declined entry is a broken batch.
  assert.ok(
    has(
      request([extendHold('held-1'), extendHold('held-3')]),
      {
        results: [
          finalized('held-1', 'held-2'),
          { source_proposal_id: 'held-3', outcome: 'unable', reason_code: 'hold_unavailable', reason: 'No.' },
        ],
        products: [],
      },
      'outcome',
      'results'
    )
  );
  // Lineage, status and a live hold are checked as for finalize.
  const wrongParent = finalized();
  wrongParent.proposal.parent_proposal_id = 'someone-else';
  assert.ok(
    has(request(), { results: [wrongParent], products: [] }, 'lineage', 'results[0].proposal.parent_proposal_id')
  );
  assert.ok(
    has(
      request(),
      { results: [finalized('held-1', 'held-2', '2000-01-01T00:00:00.000Z')], products: [] },
      'hold_expired',
      'results[0].proposal.expires_at'
    )
  );
  const reused = finalized('held-1', 'held-1');
  assert.ok(
    has(request(), { results: [reused], products: [] }, 'proposal_identity', 'results[0].proposal.proposal_id')
  );
});

test('collections are verified when the request asked for them', () => {
  const finalize = [{ proposal_id: 'draft-1', action: 'finalize' }];
  const response = collections => ({ results: [finalized('draft-1', 'held-1')], products: [], collections });

  const asked = verifyRefineProposalsResponse(
    request(finalize, { include_collections: true }),
    response([collection()])
  );
  assert.deepEqual(asked.issues, []);

  const unasked = verifyRefineProposalsResponse(request(finalize), response([collection()]));
  assert.ok(unasked.issues.some(issue => issue.path === 'collections' && /include_collections/.test(issue.message)));

  const empty = verifyRefineProposalsResponse(request(finalize, { include_collections: true }), response([]));
  assert.ok(empty.issues.some(issue => issue.code === 'shape' && issue.path === 'collections'));

  const noPublisher = collection();
  delete noPublisher.publisher_domain;
  const malformed = verifyRefineProposalsResponse(
    request(finalize, { include_collections: true }),
    response([noPublisher])
  );
  assert.ok(malformed.issues.some(issue => issue.code === 'shape' && issue.path.startsWith('collections[0]')));
});

test('a 3.2 contract still rejects the 3.3 response fields', () => {
  const req = {
    adcp_version: '3.2',
    adcp_major_version: 3,
    idempotency_key: KEY,
    refinements: [{ proposal_id: 'draft-1', action: 'finalize' }],
  };
  const result = verifyRefineProposalsResponse(
    req,
    { adcp_version: '3.2', results: [finalized('draft-1', 'held-1')], products: [], collections: [collection()] },
    { adcpVersion: '3.2.8' }
  );
  assert.ok(result.issues.some(issue => issue.path === 'response.collections' && /not allowed/.test(issue.message)));

  const submitted = validateRefineProposalsResponseShape(
    { adcp_version: '3.2', status: 'submitted', task_id: 'task-1', expected_confirmation_at: '2100-01-01T00:00:00Z' },
    { adcpVersion: '3.2.8' }
  );
  assert.ok(submitted.issues.some(issue => issue.path === 'response.expected_confirmation_at'));
});

test('expected_confirmation_at is accepted only on a submitted response', () => {
  const submitted = extra => ({ status: 'submitted', task_id: 'task-1', ...extra });
  assert.deepEqual(
    validateRefineProposalsResponseShape(submitted({ expected_confirmation_at: '2100-01-01T00:00:00Z' })).issues,
    []
  );
  assert.ok(
    validateRefineProposalsResponseShape(submitted({ expected_confirmation_at: 'tomorrow' })).issues.some(
      issue => issue.path === 'expected_confirmation_at'
    )
  );
  assert.ok(
    validateRefineProposalsResponseShape(submitted({ collections: [collection()] })).issues.some(
      issue => issue.path === 'collections'
    )
  );
  const completed = verifyRefineProposalsResponse(request(), {
    results: [finalized()],
    products: [],
    expected_confirmation_at: '2100-01-01T00:00:00Z',
  });
  assert.ok(completed.issues.some(issue => issue.path === 'expected_confirmation_at'));
});

// --- Source-aware extension checks ----------------------------------------

test('verifyHoldExtension checks the successor against the extended source', () => {
  const holdFields = {
    hold_policy: { available: true, min_duration: 'P1D', max_duration: 'P3D', extendable: true },
    hold_placed_at: '2099-12-30T00:00:00.000Z',
  };
  const source = committed('held-1', 'draft-1', '2100-01-01T00:00:00.000Z', holdFields);
  const successor = committed('held-2', 'held-1', '2100-01-02T00:00:00.000Z', holdFields);
  assert.deepEqual(verifyHoldExtension(source, successor).issues, []);

  const issuesFor = changes => verifyHoldExtension(source, { ...successor, ...changes }).issues.map(i => i.path);
  assert.deepEqual(issuesFor({ expires_at: '2100-01-01T00:00:00.000Z' }), ['proposal.expires_at']);
  assert.deepEqual(issuesFor({ hold_placed_at: '2100-01-01T00:00:00.000Z' }), ['proposal.hold_placed_at']);
  assert.deepEqual(issuesFor({ hold_policy: { ...holdFields.hold_policy, max_duration: 'P5D' } }), [
    'proposal.hold_policy',
  ]);
  assert.deepEqual(issuesFor({ parent_proposal_id: 'draft-1' }), ['proposal.parent_proposal_id']);
  const changedTerms = { ...terms(), total_budget: { amount: 9_000, currency: 'USD' } };
  assert.deepEqual(issuesFor({ terms_digest: proposalTermsDigest(changedTerms), commercial_terms: changedTerms }), [
    'proposal.terms_digest',
  ]);
  assert.deepEqual(
    verifyHoldExtension({ ...source, proposal_status: 'draft' }, successor).issues.map(i => i.path),
    ['source.proposal_status']
  );
});

test('ProposalNegotiator.extendHold sends extend_hold and returns the verified successor', async () => {
  const source = committed('held-1', 'draft-1', '2100-01-01T00:00:00.000Z');
  const sent = [];
  const transport = successor => async req => {
    sent.push(req);
    return {
      success: true,
      status: 'completed',
      data: { results: [{ source_proposal_id: 'held-1', outcome: 'finalized', proposal: successor }], products: [] },
      metadata: {},
    };
  };

  const negotiator = new ProposalNegotiator(transport(committed('held-2', 'held-1', '2100-01-02T00:00:00.000Z')), {
    capabilities: HOLD_CAPABILITIES,
  });
  const extended = await negotiator.extendHold(source);
  assert.equal(extended.proposal_id, 'held-2');
  assert.deepEqual(sent[0].refinements, [{ proposal_id: 'held-1', action: 'extend_hold' }]);

  // A seller that changed the terms on extension is caught even though the
  // response itself is internally consistent.
  const changedTerms = { ...terms(), total_budget: { amount: 9_000, currency: 'USD' } };
  const sneaky = new ProposalNegotiator(
    transport(committed('held-2', 'held-1', '2100-01-02T00:00:00.000Z', { commercial_terms: changedTerms })),
    { capabilities: HOLD_CAPABILITIES }
  );
  await assert.rejects(
    sneaky.extendHold(source),
    error => error instanceof ProposalResponseVerificationError && error.issues[0].code === 'terms_digest'
  );

  // The capability gate applies before any transport call.
  const undeclared = new ProposalNegotiator(transport(extended), { capabilities: { supported_dimensions: [] } });
  await assert.rejects(undeclared.extendHold(source), /hold_extension/);
  await assert.rejects(negotiator.extendHold({ ...source, proposal_status: 'draft' }), /committed/);
  assert.equal(sent.length, 2);
});

// --- Seller engine ----------------------------------------------------------

test('the proposal refinement engine does not claim hold extension yet (#3600)', async () => {
  const options = {
    store: { get: () => null, begin: () => assert.fail('no transaction expected') },
    scope: () => ({ tenant_id: 'tenant', principal_id: 'buyer' }),
    evaluate: () => assert.fail('no evaluation expected'),
  };
  assert.throws(
    () => createProposalRefinementHandler({ ...options, capabilities: HOLD_CAPABILITIES }),
    /does not support extend_hold/
  );
  const handler = createProposalRefinementHandler({ ...options, capabilities: { supported_dimensions: [] } });
  await assert.rejects(handler(request(), {}), error => error.code === 'VALIDATION_ERROR');
});

// --- End to end: AgentClient.refineProposals is what the storyboard runner
// dispatches refine_proposals through (testing/storyboard/task-map).

test('AgentClient.refineProposals sends extend_hold and include_collections to a 3.3 seller', async () => {
  const { AgentClient } = require('../../dist/lib/index.js');
  const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');
  const { createIdempotencyStore, memoryBackend, InMemoryStateStore } = require('../../dist/lib/server/index.js');
  const { getSdkServer } = require('../../dist/lib/server/adcp-server.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

  const received = [];
  const server = createAdcpServer({
    name: 'hold-extension-seller',
    version: '1.0.0',
    adcpVersion: '3.3.0-rc.3',
    validation: { requests: 'strict', responses: 'strict' },
    stateStore: new InMemoryStateStore(),
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 3600 }),
    resolveIdempotencyPrincipal: () => 'buyer-a',
    proposalNegotiation: {
      capabilities: HOLD_CAPABILITIES,
      resolveScope: () => ({ tenant_id: 'seller', principal_id: 'buyer-a' }),
      refineProposals: async params => {
        received.push(params);
        return {
          status: 'completed',
          results: params.refinements.map(entry => ({
            source_proposal_id: entry.proposal_id,
            outcome: 'finalized',
            proposal: committed(`${entry.proposal_id}-extended`, entry.proposal_id, '2100-01-02T00:00:00.000Z'),
          })),
          products: [],
          ...(params.include_collections && { collections: [collection()] }),
        };
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await getSdkServer(server).connect(serverTransport);
  const onmessage = serverTransport.onmessage;
  serverTransport.onmessage = (message, extra) =>
    onmessage(message, { ...extra, authInfo: { token: 'redacted', clientId: 'buyer-a', scopes: [] } });
  const mcp = new Client({ name: 'hold-extension-buyer', version: '1.0.0' });
  try {
    await mcp.connect(clientTransport);
    const buyer = AgentClient.fromMCPClient(mcp, { adcpVersion: '3.3.0-rc.3', validation: { responses: 'strict' } });

    const extended = await buyer.refineProposals(
      { refinements: [{ proposal_id: 'held-1', action: 'extend_hold' }], include_collections: true },
      undefined,
      { proposalRefinementCapabilities: HOLD_CAPABILITIES }
    );
    assert.equal(extended.success, true, extended.error);
    assert.equal(extended.data.results[0].outcome, 'finalized');
    assert.equal(extended.data.results[0].proposal.parent_proposal_id, 'held-1');
    assert.equal(extended.data.collections[0].collection_id, 'show-1');
    assert.match(received[0].adcp_version, /^3\.3/);
    assert.deepEqual(received[0].refinements, [{ proposal_id: 'held-1', action: 'extend_hold' }]);
    assert.equal(received[0].include_collections, true);

    // Without the seller's declaration the client refuses before sending.
    await assert.rejects(
      buyer.refineProposals({ refinements: [{ proposal_id: 'held-1', action: 'extend_hold' }] }, undefined, {
        proposalRefinementCapabilities: { supported_dimensions: [] },
      }),
      /hold_extension/
    );
    assert.equal(received.length, 1);
  } finally {
    await mcp.close();
  }
});
