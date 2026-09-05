const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ProposalNegotiator,
  ProposalCommercialTermsVerificationError,
  ProposalRefinementValidationError,
  assertProposalCommercialTerms,
  buildRefineProposalsRequest,
  canonicalize,
  extractProposalRefinementSupport,
  proposalTermsDigest,
  validateRefineProposalsRequest,
  validateRefineProposalsResponseShape,
  verifyProposalCommercialTerms,
  verifyRefineProposalsResponse,
} = require('../../dist/lib/index.js');
const { withExternalSchemaRoot } = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

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

function clone(value) {
  return structuredClone(value);
}

test('commercial-terms verifier accepts a digest-bound exact reviewed snapshot', () => {
  const terms = commercialTerms({
    purchase_order_ref: 'PO-2027-001',
    change_terms: [
      {
        term_id: 'term-budget-1',
        action: 'increase_budget',
        service_mode: 'self_serve',
        constraints: { kind: 'budget', max_delta_amount: { amount: 1000, currency: 'USD' } },
        terms_ref: 'contract-2027-001',
      },
    ],
  });
  const result = verifyProposalCommercialTerms(
    proposal('proposal-terms', 'source-1', { commercial_terms: terms }),
    terms,
    { adcpVersion: '3.2-rc.1' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, ADCP_VERSION);
  assert.deepEqual(result.mismatches, []);
  assert.doesNotThrow(() =>
    assertProposalCommercialTerms(proposal('proposal-terms', 'source-1', { commercial_terms: terms }), terms)
  );
});

test('commercial-terms verifier checks terms_digest before producing field comparisons', () => {
  const reviewed = commercialTerms();
  const offered = commercialTerms({ total_budget: { amount: 9000, currency: 'USD' } });
  const tampered = proposal('proposal-tampered', 'source-1', {
    commercial_terms: offered,
    terms_digest: proposalTermsDigest(reviewed),
  });

  const result = verifyProposalCommercialTerms(tampered, reviewed);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, [
    {
      kind: 'digest_mismatch',
      path: '/terms_digest',
      message: 'proposal terms_digest does not match commercial_terms',
    },
  ]);
});

test('commercial-terms verifier enforces schema-declared pricing integrity', () => {
  const pricingIdentity = commercialTerms();
  pricingIdentity.purchases[0].pricing.pricing_option_id = 'different-price';

  const mixedCurrencies = commercialTerms();
  mixedCurrencies.purchases.push({
    ...clone(mixedCurrencies.purchases[0]),
    product_id: 'product-2',
    pricing_option_id: 'price-2',
    pricing: {
      ...clone(mixedCurrencies.purchases[0].pricing),
      pricing_option_id: 'price-2',
      currency: 'EUR',
    },
  });

  const budgetCurrency = commercialTerms({ total_budget: { amount: 8000, currency: 'GBP' } });
  for (const [terms, expectedPath] of [
    [pricingIdentity, '/commercial_terms/purchases/0/pricing/pricing_option_id'],
    [mixedCurrencies, '/commercial_terms/purchases/1/pricing/currency'],
    [budgetCurrency, '/commercial_terms/total_budget/currency'],
  ]) {
    const result = verifyProposalCommercialTerms(
      proposal('proposal-invalid-pricing', 'source-1', { commercial_terms: terms }),
      terms
    );
    assert.equal(result.ok, false);
    assert.equal(result.mismatches[0].kind, 'invalid_terms');
    assert.equal(result.mismatches[0].keyword, 'x-adcp-validation');
    assert.equal(result.mismatches[0].path, expectedPath);
  }
});

test('commercial-terms verifier enforces schema-declared change-term invariants', () => {
  const duplicateActions = commercialTerms({
    change_terms: [
      { term_id: 'pause-1', action: 'pause', service_mode: 'self_serve' },
      { term_id: 'pause-2', action: 'pause', service_mode: 'seller_managed' },
    ],
  });
  const incompatibleKind = commercialTerms({
    change_terms: [
      {
        term_id: 'pause-budget',
        action: 'pause',
        service_mode: 'self_serve',
        constraints: { kind: 'budget', max_delta_amount: { amount: 100, currency: 'USD' } },
      },
    ],
  });
  const wrongCurrency = commercialTerms({
    change_terms: [
      {
        term_id: 'increase-eur',
        action: 'increase_budget',
        service_mode: 'self_serve',
        constraints: { kind: 'budget', max_delta_amount: { amount: 100, currency: 'EUR' } },
      },
    ],
  });
  const inconsistentRange = commercialTerms({
    change_terms: [
      {
        term_id: 'increase-range',
        action: 'increase_budget',
        service_mode: 'self_serve',
        constraints: {
          kind: 'budget',
          min_result_amount: { amount: 1000, currency: 'USD' },
          max_result_amount: { amount: 500, currency: 'USD' },
        },
      },
    ],
  });

  for (const [terms, expectedPath] of [
    [duplicateActions, '/commercial_terms/change_terms/1/action'],
    [incompatibleKind, '/commercial_terms/change_terms/0/constraints/kind'],
    [wrongCurrency, '/commercial_terms/change_terms/0/constraints/max_delta_amount/currency'],
    [inconsistentRange, '/commercial_terms/change_terms/0/constraints'],
  ]) {
    const result = verifyProposalCommercialTerms(
      proposal('proposal-invalid-change-term', 'source-1', { commercial_terms: terms }),
      terms
    );
    assert.equal(result.ok, false);
    assert.equal(result.mismatches[0].kind, 'invalid_terms');
    assert.equal(result.mismatches[0].keyword, 'x-adcp-validation');
    assert.equal(result.mismatches[0].path, expectedPath);
  }
});

test('commercial-terms verifier recursively reports binding changes with JSON Pointer paths', () => {
  const reviewed = commercialTerms({
    purchase_order_ref: 'PO-ORIGINAL',
    change_terms: [
      {
        term_id: 'term-flight-1',
        action: 'extend_flight',
        service_mode: 'self_serve',
        allowed_statuses: ['active'],
        terms_ref: 'contract-original',
      },
    ],
  });
  const offered = clone(reviewed);
  offered.purchases[0].pricing.fixed_price = 9;
  offered.purchases[0].product_id = 'product-2';
  offered.end_time = '2027-03-01T00:00:00Z';
  offered.total_budget.amount = 9000;
  offered.purchase_order_ref = 'PO-CHANGED';
  offered.change_terms[0].service_mode = 'seller_managed';
  offered.change_terms[0].terms_ref = 'contract-changed';

  const result = verifyProposalCommercialTerms(
    proposal('proposal-changed', 'source-1', { commercial_terms: offered }),
    reviewed
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.mismatches.map(mismatch => [mismatch.kind, mismatch.path]),
    [
      ['changed', '/commercial_terms/change_terms/0/service_mode'],
      ['changed', '/commercial_terms/change_terms/0/terms_ref'],
      ['changed', '/commercial_terms/end_time'],
      ['changed', '/commercial_terms/purchase_order_ref'],
      ['changed', '/commercial_terms/purchases/0/pricing/fixed_price'],
      ['changed', '/commercial_terms/purchases/0/product_id'],
      ['changed', '/commercial_terms/total_budget/amount'],
    ]
  );
  assert.throws(
    () =>
      assertProposalCommercialTerms(proposal('proposal-changed', 'source-1', { commercial_terms: offered }), reviewed),
    ProposalCommercialTermsVerificationError
  );
});

test('commercial-terms verifier rejects fields outside the selected schema', () => {
  const terms = commercialTerms({ unrecognized_binding: 'must-not-pass' });
  const result = verifyProposalCommercialTerms(
    proposal('proposal-unknown', 'source-1', { commercial_terms: terms }),
    terms
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.mismatches.map(({ kind, subject, path, keyword }) => ({ kind, subject, path, keyword })),
    [
      {
        kind: 'invalid_terms',
        subject: 'proposal',
        path: '/commercial_terms/unrecognized_binding',
        keyword: 'additionalProperties',
      },
    ]
  );
});

test('commercial-terms verifier derives newly added binding fields from the selected bundle', () => {
  const schemaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-commercial-terms-schema-'));
  try {
    const mediaBuyDir = path.join(schemaRoot, 'media-buy');
    fs.mkdirSync(mediaBuyDir, { recursive: true });
    fs.writeFileSync(path.join(schemaRoot, 'index.json'), JSON.stringify({ adcp_version: ADCP_VERSION }));
    fs.writeFileSync(
      path.join(mediaBuyDir, 'commercial-terms.json'),
      JSON.stringify({
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: `https://adcontextprotocol.org/schemas/${ADCP_VERSION}/media-buy/commercial-terms.json`,
        type: 'object',
        properties: {
          brand: { type: 'object' },
          purchases: { type: 'array', minItems: 1 },
          start_time: { type: 'string' },
          end_time: { type: 'string' },
          future_binding: { type: 'string' },
        },
        patternProperties: { '^x_': { type: 'string' } },
        required: ['brand', 'purchases', 'start_time', 'end_time'],
        additionalProperties: false,
      })
    );
    const reviewed = {
      brand: { domain: 'buyer.example' },
      purchases: [{}],
      start_time: 'asap',
      end_time: '2027-02-01T00:00:00Z',
    };
    const offered = {
      ...reviewed,
      future_binding: 'new-contract-value',
      x_dynamic_binding: 'pattern-contract-value',
    };
    const result = withExternalSchemaRoot(ADCP_VERSION, schemaRoot, () =>
      verifyProposalCommercialTerms(
        { commercial_terms: offered, terms_digest: proposalTermsDigest(offered) },
        reviewed,
        { adcpVersion: ADCP_VERSION }
      )
    );

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.mismatches.map(({ kind, path }) => ({ kind, path })),
      [
        { kind: 'unexpected', path: '/commercial_terms/future_binding' },
        { kind: 'unexpected', path: '/commercial_terms/x_dynamic_binding' },
      ]
    );
  } finally {
    fs.rmSync(schemaRoot, { recursive: true, force: true });
  }
});

test('commercial-terms verifier fails closed when the requested schema bundle is unavailable', () => {
  const terms = commercialTerms();
  const result = verifyProposalCommercialTerms(
    proposal('proposal-version', 'source-1', { commercial_terms: terms }),
    terms,
    {
      adcpVersion: '3.2.0-rc.199',
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.mismatches[0].kind, 'schema_unavailable');
  assert.equal(result.mismatches[0].message, 'the selected AdCP commercial-terms schema is unavailable');
});

test('commercial-terms verifier caps mismatch diagnostics', () => {
  const reviewed = commercialTerms();
  reviewed.purchases[0].ext = { vendor: {} };
  const offered = clone(reviewed);
  for (let index = 0; index < 101; index++) {
    reviewed.purchases[0].ext.vendor[`field_${index}`] = `reviewed_${index}`;
    offered.purchases[0].ext.vendor[`field_${index}`] = `offered_${index}`;
  }

  const result = verifyProposalCommercialTerms(
    proposal('proposal-many-differences', 'source-1', { commercial_terms: offered }),
    reviewed
  );
  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
  assert.equal(result.mismatches.length, 100);
});

test('commercial-terms verifier rejects oversized and accessor-backed trees before canonicalization', () => {
  const oversized = commercialTerms();
  oversized.purchases[0].ext = { vendor: { payload: 'x'.repeat(256 * 1024 + 1) } };
  const oversizedResult = verifyProposalCommercialTerms(
    { commercial_terms: oversized, terms_digest: 'sha256:unchecked' },
    oversized
  );
  assert.equal(oversizedResult.ok, false);
  assert.match(oversizedResult.mismatches[0].message, /exceed 256 KiB/);

  let reads = 0;
  const accessorTerms = commercialTerms();
  Object.defineProperty(accessorTerms.purchases[0], 'ext', {
    enumerable: true,
    get() {
      reads++;
      return { vendor: {} };
    },
  });
  const accessorResult = verifyProposalCommercialTerms(
    { commercial_terms: accessorTerms, terms_digest: 'sha256:unchecked' },
    accessorTerms
  );
  assert.equal(accessorResult.ok, false);
  assert.match(accessorResult.mismatches[0].message, /data properties only/);
  assert.equal(reads, 0);
});

test('commercial-terms verifier accepts shared references but bounds node count and depth', () => {
  const shared = { value: 'same' };
  const aliased = commercialTerms();
  aliased.purchases[0].ext = { vendor: { first: shared, second: shared } };
  assert.equal(
    verifyProposalCommercialTerms(
      proposal('proposal-shared-reference', 'source-1', { commercial_terms: aliased }),
      aliased
    ).ok,
    true
  );

  const tooManyNodes = commercialTerms();
  tooManyNodes.purchases[0].ext = { vendor: { sparse: new Array(50_001) } };
  const nodeResult = verifyProposalCommercialTerms(
    { commercial_terms: tooManyNodes, terms_digest: 'sha256:unchecked' },
    tooManyNodes
  );
  assert.equal(nodeResult.ok, false);
  assert.match(nodeResult.mismatches[0].message, /50,000-node/);

  const tooDeep = commercialTerms();
  let cursor = {};
  tooDeep.purchases[0].ext = { vendor: cursor };
  for (let depth = 0; depth < 257; depth++) {
    cursor.next = {};
    cursor = cursor.next;
  }
  const depthResult = verifyProposalCommercialTerms(
    { commercial_terms: tooDeep, terms_digest: 'sha256:unchecked' },
    tooDeep
  );
  assert.equal(depthResult.ok, false);
  assert.match(depthResult.mismatches[0].message, /maximum JSON depth/);
});

test('commercial-terms verifier caps diagnostic bytes and keeps attacker keys out of error messages', () => {
  const longKey = `hostile\n\u001b[31m${'x'.repeat(70_000)}`;
  const reviewed = commercialTerms();
  const offered = commercialTerms();
  reviewed.purchases[0].ext = { vendor: { [longKey]: { value: 'reviewed' } } };
  offered.purchases[0].ext = { vendor: { [longKey]: { value: 'offered' } } };

  const candidate = proposal('proposal-long-diagnostic', 'source-1', { commercial_terms: offered });
  const result = verifyProposalCommercialTerms(candidate, reviewed);
  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.mismatches, []);
  assert.throws(
    () => assertProposalCommercialTerms(candidate, reviewed),
    error =>
      error instanceof ProposalCommercialTermsVerificationError &&
      error.message === 'proposal commercial terms failed verification (0 mismatches, diagnostics truncated)' &&
      !error.message.includes('hostile')
  );

  const unknownKey = `unknown_${'y'.repeat(70_000)}`;
  const unknownTerms = commercialTerms({ [unknownKey]: 'value' });
  const schemaResult = verifyProposalCommercialTerms(
    proposal('proposal-long-schema-path', 'source-1', { commercial_terms: unknownTerms }),
    unknownTerms
  );
  assert.equal(schemaResult.ok, false);
  assert.equal(schemaResult.truncated, true);
  assert.deepEqual(schemaResult.mismatches, []);
});

test('commercial-terms verifier rejects values that cannot appear on the JSON wire', () => {
  for (const invalidValue of [undefined, () => 'secret source', Symbol('secret'), 1n, Number.NaN]) {
    const terms = commercialTerms();
    terms.purchases[0].ext = { vendor: { invalid: invalidValue } };
    const result = verifyProposalCommercialTerms({ commercial_terms: terms, terms_digest: 'sha256:unchecked' }, terms);
    assert.equal(result.ok, false);
    assert.equal(result.mismatches[0].message, 'commercial terms must contain JSON values only');
  }
});

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

  assert.equal(built.adcp_version, '3.2-rc.1');
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

test('canonical request validation requires both 3.2 envelope fields and accepts prerelease pins', () => {
  const canonical = request();
  assert.doesNotThrow(() => validateRefineProposalsRequest(canonical));
  assert.doesNotThrow(() => validateRefineProposalsRequest({ ...canonical, adcp_version: '3.2-beta.5' }));
  assert.throws(
    () => validateRefineProposalsRequest({ ...canonical, adcp_version: undefined }),
    /adcp_version on the 3\.2 release line/
  );
  assert.throws(
    () => validateRefineProposalsRequest({ ...canonical, adcp_major_version: undefined }),
    /adcp_major_version 3/
  );
});

test('response validation rejects malformed 3.2 prerelease pins', () => {
  for (const adcp_version of ['3.2-.', '3.2-rc.', '3.2--rc', '3.2-rc..1']) {
    const result = validateRefineProposalsResponseShape({ ...response(), adcp_version });
    assert.equal(result.ok, false);
    assert.match(result.issues[0].message, /adcp_version must be on the 3\.2 release line/);
  }
  for (const adcp_version of ['3.2', '3.2-beta', '3.2-beta.1', '3.2-beta-1']) {
    assert.equal(validateRefineProposalsResponseShape({ ...response(), adcp_version }).ok, true);
  }
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

test('response verifier accepts only the 3.2 response release line and reports rejected values', () => {
  for (const adcp_version of ['3.2', '3.2-beta.0', '3.2-rc.1']) {
    assert.equal(
      validateRefineProposalsResponseShape({
        ...response(),
        adcp_version,
      }).ok,
      true,
      adcp_version
    );
  }

  for (const adcp_version of ['3.1', '4.0', 'not-a-version']) {
    const result = validateRefineProposalsResponseShape({
      ...response(),
      adcp_version,
    });
    assert.equal(result.ok, false, adcp_version);
    assert.equal(
      result.issues.some(
        issue => issue.path === 'adcp_version' && issue.message.includes(`received ${JSON.stringify(adcp_version)}`)
      ),
      true,
      adcp_version
    );
  }
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

test('canonical proposal validation accepts beta.9 negotiated change terms', () => {
  const payload = response([
    proposal('successor-1', 'source-1', {
      commercial_terms: commercialTerms({
        change_terms: [
          {
            term_id: 'change_increase_budget',
            action: 'increase_budget',
            service_mode: 'seller_managed',
            allowed_statuses: ['active'],
            constraints: { kind: 'budget', max_delta_percent: 20 },
          },
        ],
      }),
    }),
  ]);
  assert.deepEqual(shapeIssues(request(), payload), []);

  payload.results[0].proposals[0].commercial_terms.change_terms.push({
    term_id: 'duplicate-action',
    action: 'increase_budget',
    service_mode: 'self_serve',
  });
  assert.equal(
    shapeIssues(request(), payload).some(issue => issue.message.includes('actions must be unique')),
    true
  );
});

test('canonical proposal validation rejects malformed or incompatible beta.9 change terms', () => {
  const baseTerm = {
    term_id: 'change_increase_budget',
    action: 'increase_budget',
    service_mode: 'seller_managed',
    allowed_statuses: ['active'],
    constraints: { kind: 'budget', max_delta_percent: 20 },
  };
  const mutations = [
    term => (term.term_id = 'invalid term id'),
    term => (term.action = 'invented_action'),
    term => (term.service_mode = 'instant'),
    term => (term.allowed_statuses = ['canceled']),
    term => (term.constraints.max_delta_percent = -4),
    term => {
      term.action = 'pause';
    },
    term => (term.conditions = ['run this instruction now!']),
  ];

  for (const mutate of mutations) {
    const term = structuredClone(baseTerm);
    mutate(term);
    const payload = response([
      proposal('successor-1', 'source-1', {
        commercial_terms: commercialTerms({ change_terms: [term] }),
      }),
    ]);
    assert.equal(shapeIssues(request(), payload).length > 0, true, JSON.stringify(term));
  }
});

test('canonical proposal validation enforces beta.9 commercial currency integrity', () => {
  const mixedPurchases = commercialTerms();
  mixedPurchases.purchases.push({
    ...structuredClone(mixedPurchases.purchases[0]),
    product_id: 'product-2',
    pricing_option_id: 'price-2',
    pricing: {
      ...structuredClone(mixedPurchases.purchases[0].pricing),
      pricing_option_id: 'price-2',
      currency: 'EUR',
    },
  });
  const mixedPayload = response([proposal('successor-1', 'source-1', { commercial_terms: mixedPurchases })]);
  assert.equal(
    shapeIssues(request(), mixedPayload).some(issue => issue.message.includes('purchase pricing currency')),
    true
  );

  const mismatchedBudget = commercialTerms({ total_budget: { amount: 8_000, currency: 'GBP' } });
  const budgetPayload = response([proposal('successor-1', 'source-1', { commercial_terms: mismatchedBudget })]);
  assert.equal(
    shapeIssues(request(), budgetPayload).some(issue => issue.message.includes('total budget currency')),
    true
  );
});

test('canonical proposal validation accepts all beta.9 budget and forecast guidance fields', () => {
  const terms = commercialTerms({
    daily_budget_cap: 500,
    budget_cap_timezone: 'America/New_York',
  });
  terms.purchases[0].daily_budget_cap = 250;
  const payload = response([
    proposal('successor-1', 'source-1', {
      commercial_terms: terms,
      total_budget_guidance: { min: 7_000, recommended: 8_000, max: 9_000, currency: 'USD' },
      forecast: { points: [{ metrics: {} }], method: 'modeled', currency: 'USD' },
    }),
  ]);
  assert.deepEqual(shapeIssues(request(), payload), []);
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
