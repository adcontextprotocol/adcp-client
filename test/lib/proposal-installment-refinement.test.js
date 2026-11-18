// Experimental AdCP 3.3 installment refinement (media_buy.installment_refinement, adcp#8974).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProposalRefinementValidationError,
  classifyProposalRefinementFailure,
  extractProposalRefinementSupport,
  refinementDimensions,
  validateRefineProposalsRequest,
  verifyRefineProposalsResponse,
} = require('../../dist/lib/index.js');

const KEY = 'installment-refine-0001';

function ref(installmentId = 'ep-1', collectionId = 'show-1') {
  return {
    collection_ref: { publisher_domain: 'pub.example', collection_id: collectionId },
    installment_id: installmentId,
  };
}

function change(overrides = {}) {
  return { product_id: 'product-1', installment_ref: ref(), action: 'omit', ...overrides };
}

function request(installment_changes = [change()], adcp_version = '3.3-beta.6') {
  return {
    adcp_version,
    adcp_major_version: 3,
    idempotency_key: KEY,
    refinements: [{ proposal_id: 'source-1', action: 'revise', installment_changes }],
  };
}

function unable(extra = {}) {
  return {
    results: [
      {
        source_proposal_id: 'source-1',
        outcome: 'unable',
        reason_code: 'constraint_unsatisfiable',
        reason: 'The installment is sold.',
        ...extra,
      },
    ],
    products: [],
  };
}

const CAPABILITIES = { supported_dimensions: ['product_changes', 'installment_changes'] };

test('capability discovery recognizes the installment_changes dimension', () => {
  const support = extractProposalRefinementSupport({
    media_buy: { lifecycle_tools: ['refine_proposals'], proposal_refinement: CAPABILITIES },
  });
  assert.equal(support.supported, true);
  assert.deepEqual([...support.capabilities.supported_dimensions], CAPABILITIES.supported_dimensions);
});

test('a 3.3 revise may carry only installment_changes', () => {
  const req = request([change(), change({ installment_ref: ref('ep-2'), action: 'include' })]);
  assert.doesNotThrow(() => validateRefineProposalsRequest(req, CAPABILITIES));
  assert.deepEqual(refinementDimensions(req.refinements[0]), ['installment_changes']);
});

test('installment_changes is refused before AdCP 3.3', () => {
  assert.throws(
    () => validateRefineProposalsRequest(request([change()], '3.2')),
    /installment_changes requires AdCP 3\.3/
  );
});

test('installment_changes requires unique, well-formed canonical entries', () => {
  const cases = [
    [[], /1-500 entries/],
    [[change(), change({ action: 'include' })], /unique by product_id and installment_ref/],
    [[change({ action: 'swap' })], /include or omit/],
    [[change({ product_id: '' })], /non-empty product_id/],
    [[change({ installment_ref: { ...ref(), extra: true } })], /canonical installment_ref/],
    [
      [change({ installment_ref: { collection_ref: { collection_id: 'show-1' }, installment_id: 'ep-1' } })],
      /canonical/,
    ],
    [[change({ installment_ref: ref('ep-1', '') })], /canonical/],
    [[{ ...change(), ext: {} }], /ext is not allowed/],
    [Array.from({ length: 501 }, (_, index) => change({ installment_ref: ref(`ep-${index}`) })), /1-500 entries/],
  ];
  for (const [changes, pattern] of cases) {
    assert.throws(
      () => validateRefineProposalsRequest(request(changes)),
      error => error instanceof ProposalRefinementValidationError && pattern.test(error.message)
    );
  }
});

test('a seller that does not advertise installment_changes gets UNSUPPORTED_FEATURE', () => {
  assert.throws(
    () => validateRefineProposalsRequest(request(), { supported_dimensions: ['product_changes'] }),
    error => error.code === 'UNSUPPORTED_FEATURE' && error.details.unsupported_dimension === 'installment_changes'
  );
});

test('unsatisfied installment changes classify as constraint_unsatisfiable', () => {
  assert.equal(
    classifyProposalRefinementFailure({ unsatisfied_installment_changes: [{ ...change(), reason: 'Sold.' }] }),
    'constraint_unsatisfiable'
  );
});

test('response verifier accepts unsatisfied installment changes that repeat a request entry', () => {
  const result = verifyRefineProposalsResponse(
    request(),
    unable({ unsatisfied_installment_changes: [{ ...change(), reason: 'Sold.' }] })
  );
  assert.deepEqual(result.issues, []);
});

test('response verifier rejects unrequested, malformed, or misplaced unsatisfied installment changes', () => {
  const has = (payload, code, pathSuffix) =>
    verifyRefineProposalsResponse(request(), payload).issues.some(
      issue => issue.code === code && issue.path.endsWith(pathSuffix)
    );
  const entry = (overrides = {}) => ({ ...change(overrides), reason: 'Sold.' });

  assert.ok(
    has(
      unable({ unsatisfied_installment_changes: [entry({ action: 'include' })] }),
      'unsatisfied_subset',
      'unsatisfied_installment_changes[0]'
    )
  );
  assert.ok(has(unable({ unsatisfied_installment_changes: [change()] }), 'shape', 'unsatisfied_installment_changes'));
  assert.ok(
    has(
      unable({ reason_code: 'commercially_declined', unsatisfied_installment_changes: [entry()] }),
      'unsatisfied_subset',
      'reason_code'
    )
  );
  assert.ok(
    has(
      {
        results: [
          {
            source_proposal_id: 'source-1',
            outcome: 'finalized',
            proposal: {},
            unsatisfied_installment_changes: [entry()],
          },
        ],
        products: [],
      },
      'shape',
      'unsatisfied_installment_changes'
    )
  );
});
