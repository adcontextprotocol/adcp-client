const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProposalNegotiator,
  ProposalRefinementValidationError,
  buildRefineProposalsRequest,
  canonicalize,
  extractProposalRefinementSupport,
  proposalTermsDigest,
  validateRefineProposalsRequest,
  validateRefineProposalsResponseShape,
  verifyRefineProposalsResponse,
} = require('../../dist/lib/index.js');

const KEY = 'refine-validation-0001';

function commercialTerms(overrides = {}) {
  return {
    brand: { domain: 'buyer.example' },
    purchases: [
      {
        product_id: 'product-1',
        pricing_option_id: 'price-1',
        pricing: {
          pricing_option_id: 'price-1',
          pricing_model: 'cpm',
          currency: 'USD',
          fixed_price: 8,
        },
        impressions: 1_000_000,
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      },
    ],
    start_time: '2027-01-01T00:00:00Z',
    end_time: '2027-02-01T00:00:00Z',
    total_budget: { amount: 8_000, currency: 'USD' },
    ...overrides,
  };
}

function proposal(id = 'successor-1', parent = 'source-1', overrides = {}) {
  const commercial_terms = overrides.commercial_terms ?? commercialTerms();
  return {
    proposal_id: id,
    proposal_kind: 'new_media_buy',
    parent_proposal_id: parent,
    proposal_status: 'draft',
    name: id,
    ...overrides,
    commercial_terms,
    terms_digest: overrides.terms_digest ?? proposalTermsDigest(commercial_terms),
  };
}

function request(refinements = [{ proposal_id: 'source-1', action: 'revise', ask: 'Improve the terms' }]) {
  return { adcp_version: '3.2', adcp_major_version: 3, idempotency_key: KEY, refinements };
}

function response(proposals = [proposal()]) {
  return {
    results: [{ source_proposal_id: 'source-1', outcome: 'revised', proposals }],
    products: [],
  };
}

function shapeIssues(req, payload) {
  return verifyRefineProposalsResponse(req, payload).issues.filter(issue => issue.code === 'shape');
}

test('buyer validation fails closed on malformed union arms, non-finite values, and non-RFC3339 dates', () => {
  assert.throws(
    () => buildRefineProposalsRequest({ refinements: [{ proposal_id: 'source-1', action: 'unknown' }] }),
    /action must be revise or finalize/
  );
  assert.throws(
    () =>
      buildRefineProposalsRequest({
        refinements: [{ proposal_id: 'source-1', action: 'finalize', ask: 'silently forbidden' }],
      }),
    /ask is not allowed/
  );
  assert.throws(
    () =>
      buildRefineProposalsRequest({
        refinements: [
          {
            proposal_id: 'source-1',
            action: 'revise',
            constraints: { total_budget: { currency: 'USD', max: Number.NaN } },
          },
        ],
      }),
    /finite|non-negative/
  );
  assert.throws(
    () =>
      buildRefineProposalsRequest({
        refinements: [
          {
            proposal_id: 'source-1',
            action: 'revise',
            constraints: { flight: { start_no_later_than: '2027-02-30T00:00:00Z' } },
          },
        ],
      }),
    /ISO date-times/
  );
  assert.throws(
    () => buildRefineProposalsRequest({ refinements: request().refinements }, {}),
    /require supported_dimensions/
  );
});

test('builder pins the 3.2 wire envelope and returns an immutable deep snapshot for exact retry', () => {
  const input = {
    context: { planning: { attempt: 1 } },
    refinements: request().refinements,
  };
  const built = buildRefineProposalsRequest(input);
  input.context.planning.attempt = 2;
  input.refinements[0].ask = 'Changed after construction';

  assert.equal(built.adcp_version, '3.2');
  assert.equal(built.adcp_major_version, 3);
  assert.equal(built.context.planning.attempt, 1);
  assert.equal(built.refinements[0].ask, 'Improve the terms');
  assert.equal(Object.isFrozen(built), true);
  assert.equal(Object.isFrozen(built.refinements), true);
  assert.equal(Object.isFrozen(built.refinements[0]), true);
  assert.throws(
    () => buildRefineProposalsRequest({ adcp_version: '3.1.13', refinements: request().refinements }),
    ProposalRefinementValidationError
  );
  assert.throws(
    () => buildRefineProposalsRequest({ adcp_major_version: 4, refinements: request().refinements }),
    ProposalRefinementValidationError
  );
});

test('canonical request validation requires both 3.2 envelope fields', () => {
  const canonical = request();
  assert.doesNotThrow(() => validateRefineProposalsRequest(canonical));
  assert.throws(() => validateRefineProposalsRequest({ ...canonical, adcp_version: undefined }), /adcp_version 3\.2/);
  assert.throws(
    () => validateRefineProposalsRequest({ ...canonical, adcp_major_version: undefined }),
    /adcp_major_version 3/
  );
});

test('proposal capability discovery accepts raw and normalized responses and fails closed on malformed declarations', () => {
  const raw = {
    media_buy: {
      lifecycle_tools: ['get_products', 'refine_proposals'],
      proposal_refinement: {
        supported_dimensions: ['total_budget', 'alternatives'],
        max_alternatives: 4,
      },
    },
  };

  for (const source of [raw, { _raw: raw }, { success: true, status: 'completed', data: raw }]) {
    const support = extractProposalRefinementSupport(source);
    assert.equal(support.supported, true);
    assert.deepEqual(support.capabilities, raw.media_buy.proposal_refinement);
    assert.equal(Object.isFrozen(support), true);
    assert.equal(Object.isFrozen(support.capabilities.supported_dimensions), true);
  }

  assert.deepEqual(extractProposalRefinementSupport({ media_buy: { lifecycle_tools: ['get_products'] } }), {
    supported: false,
  });
  assert.throws(
    () =>
      extractProposalRefinementSupport({
        media_buy: { lifecycle_tools: ['refine_proposals'], proposal_refinement: {} },
      }),
    /supported_dimensions/
  );
  assert.throws(
    () =>
      extractProposalRefinementSupport({
        media_buy: {
          lifecycle_tools: ['refine_proposals'],
          proposal_refinement: { supported_dimensions: ['total_budget'], max_alternatives: 4 },
        },
      }),
    /requires alternatives/
  );
});

test('criteria validation uses the closed 3.2 top-level vocabulary', () => {
  assert.doesNotThrow(() =>
    buildRefineProposalsRequest({
      refinements: [
        {
          proposal_id: 'source-1',
          action: 'revise',
          criteria: {
            product_ids: ['product-1'],
            catalog: { catalog_id: 'catalog-1', type: 'product' },
            targeting_overlay: { geo: ['US'] },
          },
        },
      ],
    })
  );
  for (const criteria of [
    {},
    { channels: ['ctv'] },
    { product_ids: ['product-1', 'product-1'] },
    { catalog: { type: 'publisher' } },
    { catalog: { catalog_id: 'catalog-1', type: 'publisher' } },
    { catalog: { catalog_id: 'catalog-1', gtins: ['not-a-gtin'] } },
    { targeting_overlay: [] },
  ]) {
    assert.throws(() =>
      buildRefineProposalsRequest({
        refinements: [{ proposal_id: 'source-1', action: 'revise', criteria }],
      })
    );
  }
});

test('compact submitted responses validate without completed-field access', () => {
  const submitted = {
    adcp_version: '3.2',
    status: 'submitted',
    task_id: 'proposal-task-1',
    message: 'Inventory underwriting is pending.',
    errors: [{ code: 'UNDERWRITING_DELAY', message: 'Manual review requested.' }],
    context: { correlation_id: 'corr-1' },
    ext: { seller: 'example' },
  };
  assert.equal(validateRefineProposalsResponseShape(submitted).ok, true);

  const semantic = verifyRefineProposalsResponse(request(), submitted);
  assert.equal(semantic.ok, false);
  assert.equal(
    semantic.issues.some(issue => issue.message.includes('requires a completed response')),
    true
  );

  for (const invalid of [
    { ...submitted, task_id: '' },
    { ...submitted, errors: ['not-an-error'] },
    { ...submitted, results: [] },
    { ...submitted, message: 'x'.repeat(2001) },
  ]) {
    assert.equal(validateRefineProposalsResponseShape(invalid).ok, false);
  }
});

test('response verifier accepts only release-precision values on the AdCP 3.2 line', () => {
  const submitted = {
    status: 'submitted',
    task_id: 'proposal-task-version',
  };

  for (const adcp_version of ['3.2', '3.2-beta.0', '3.2-rc.1', '3.2-beta..1']) {
    assert.equal(validateRefineProposalsResponseShape({ ...submitted, adcp_version }).ok, true, adcp_version);
  }

  for (const adcp_version of [
    '3.1',
    '4.0',
    '3.2.0',
    '3.2.0-beta.0',
    '3.2-.',
    '3.2-.beta',
    '3.2-beta.',
    '3.2--',
    'garbage',
    3.2,
    null,
    {},
    true,
  ]) {
    const result = validateRefineProposalsResponseShape({ ...submitted, adcp_version });
    assert.equal(result.ok, false, String(adcp_version));
    assert.equal(result.issues[0]?.path, 'adcp_version');
    assert.match(result.issues[0]?.message ?? '', /3\.2 release line; received/);
  }

  assert.match(
    validateRefineProposalsResponseShape({ ...submitted, adcp_version: 3.2 }).issues[0]?.message ?? '',
    /received 3\.2$/
  );
  assert.match(
    validateRefineProposalsResponseShape({ ...submitted, adcp_version: null }).issues[0]?.message ?? '',
    /received null$/
  );
});

test('response verifier validates discriminated result shapes before semantic checks', () => {
  const req = request();
  const cases = [
    [{ results: [{ source_proposal_id: 'source-1', outcome: 'mystery' }], products: [] }, 'outcome'],
    [
      {
        results: [
          {
            source_proposal_id: 'source-1',
            outcome: 'revised',
            proposals: [proposal()],
            reason: 'forbidden',
          },
        ],
        products: [],
      },
      'forbidden',
    ],
    [
      {
        results: [
          {
            source_proposal_id: 'source-1',
            outcome: 'partial',
            proposals: [proposal()],
            reason_code: 'commercially_declined',
          },
        ],
        products: [],
      },
      'reason',
    ],
    [
      {
        results: [
          {
            source_proposal_id: 'source-1',
            outcome: 'unable',
            reason_code: 'made_up',
            reason: 'No',
          },
        ],
        products: [],
      },
      'reason_code',
    ],
    [{ results: response().results, products: null }, 'products'],
  ];
  for (const [payload, expectedPath] of cases) {
    assert.equal(
      shapeIssues(req, payload).some(
        issue => issue.path.includes(expectedPath) || issue.message.includes(expectedPath)
      ),
      true
    );
  }
});

test('canonical proposal validation requires nonempty purchases, finite values, strict dates, and pricing identity', () => {
  const mutations = [
    value => {
      value.results[0].proposals[0].commercial_terms.purchases = [];
    },
    value => {
      value.results[0].proposals[0].commercial_terms.total_budget.amount = Number.POSITIVE_INFINITY;
    },
    value => {
      value.results[0].proposals[0].commercial_terms.purchases[0].start_time = 'next Tuesday';
    },
    value => {
      value.results[0].proposals[0].commercial_terms.purchases[0].pricing.pricing_option_id = 'other-price';
    },
    value => {
      delete value.results[0].proposals[0].proposal_kind;
    },
  ];
  for (const mutate of mutations) {
    const payload = structuredClone(response());
    mutate(payload);
    assert.equal(shapeIssues(request(), payload).length > 0, true);
  }
});

test('successor IDs are globally unique and distinct from every source ID', () => {
  const sourceReuse = response([proposal('source-1')]);
  assert.equal(
    verifyRefineProposalsResponse(request(), sourceReuse).issues.some(issue => issue.code === 'proposal_identity'),
    true
  );

  const req = request([
    { proposal_id: 'source-1', action: 'revise', ask: 'A' },
    { proposal_id: 'source-2', action: 'revise', ask: 'B' },
  ]);
  const payload = {
    results: [
      { source_proposal_id: 'source-1', outcome: 'revised', proposals: [proposal('same-id', 'source-1')] },
      {
        source_proposal_id: 'source-2',
        outcome: 'revised',
        proposals: [
          proposal('same-id', 'source-2', {
            commercial_terms: commercialTerms({ total_budget: { amount: 7_000, currency: 'USD' } }),
          }),
        ],
      },
    ],
    products: [],
  };
  assert.equal(
    verifyRefineProposalsResponse(req, payload).issues.some(issue => issue.code === 'proposal_identity'),
    true
  );
});

test('alternatives require both unique terms and unique digests', () => {
  const req = request([{ proposal_id: 'source-1', action: 'revise', alternatives: { count: 2 } }]);
  const sameTerms = commercialTerms();
  const duplicate = response([
    proposal('successor-1', 'source-1', { commercial_terms: sameTerms }),
    proposal('successor-2', 'source-1', { commercial_terms: structuredClone(sameTerms) }),
  ]);
  const issues = verifyRefineProposalsResponse(req, duplicate).issues;
  assert.equal(
    issues.some(issue => issue.code === 'duplicate_terms'),
    true
  );
  assert.equal(
    issues.some(issue => issue.code === 'duplicate_digest'),
    true
  );
});

test('proposal JCS rejects lone Unicode surrogates without changing shared canonicalization', () => {
  assert.equal(canonicalize({ value: '\ud800' }), '{"value":"\ud800"}');
  assert.equal(canonicalize({ value: '\ud83d\ude80' }), '{"value":"🚀"}');
  assert.throws(() => proposalTermsDigest({ value: '\ud800' }), /lone Unicode surrogate/);
  assert.throws(() => proposalTermsDigest({ ['\udc00']: 'value' }), /lone Unicode surrogate/);
  assert.doesNotThrow(() => proposalTermsDigest({ value: '\ud83d\ude80' }));
});

test('proposal digest validates the exact canonical bytes produced by accessors', () => {
  let reads = 0;
  const terms = {};
  Object.defineProperty(terms, 'value', {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? 'safe' : '\ud800';
    },
  });

  assert.throws(() => proposalTermsDigest(terms), /lone Unicode surrogate/);
});

test('counteroffer selection returns the verified canonical object and invalid hold expiries fail closed', async () => {
  const negotiator = new ProposalNegotiator(async () => {
    throw new Error('unused');
  });
  const canonical = proposal();
  const payload = response([canonical]);
  const selected = negotiator.selectCounteroffer(payload, ([candidate]) => ({
    ...candidate,
    name: 'selector-authored mutation',
  }));
  assert.strictEqual(selected, canonical);
  assert.equal(selected.name, 'successor-1');

  const invalidHold = proposal('held', 'source-1', {
    proposal_status: 'committed',
    expires_at: 'not-a-date',
  });
  let called = false;
  await assert.rejects(
    () =>
      negotiator.accept(invalidHold, async () => {
        called = true;
      }),
    /hold has expired/
  );
  assert.equal(called, false);
});

test('invalid injected clocks fail closed during verification, finalization, and acceptance', async () => {
  const committed = proposal('held-valid', 'source-1', {
    proposal_status: 'committed',
    expires_at: '2100-01-01T00:00:00Z',
  });
  const finalizeRequest = request([{ proposal_id: 'source-1', action: 'finalize' }]);
  const finalizeResponse = {
    results: [{ source_proposal_id: 'source-1', outcome: 'finalized', proposal: committed }],
    products: [],
  };

  const verification = verifyRefineProposalsResponse(finalizeRequest, finalizeResponse, {
    now: new Date('invalid'),
  });
  assert.equal(verification.ok, false);
  assert.equal(
    verification.issues.some(issue => issue.code === 'hold_expired' && issue.message.includes('current time')),
    true
  );

  const completedTask = {
    success: true,
    status: 'completed',
    data: finalizeResponse,
    metadata: {
      taskId: 'task-invalid-clock',
      taskName: 'refine_proposals',
      agent: { id: 'seller', name: 'Seller', protocol: 'mcp' },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'completed',
    },
  };
  const negotiator = new ProposalNegotiator(async () => completedTask, {
    now: () => new Date('invalid'),
  });
  let accepted = false;
  await assert.rejects(() => negotiator.accept(committed, async () => (accepted = true)), /current time is invalid/);
  assert.equal(accepted, false);
  await assert.rejects(() => negotiator.finalize('source-1'), /current time is invalid/);
});
