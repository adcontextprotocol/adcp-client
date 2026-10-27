const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ADCP_VERSION } = require('../../dist/lib/version.js');
const { getComplianceCacheDir } = require('../../dist/lib/testing/storyboard/compliance.js');
const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/index.js');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations.js');
const {
  productCanonicalFormatSatisfies,
} = require('../../dist/lib/testing/storyboard/canonical-format-satisfaction.js');
const {
  matchesFixtureRequirements,
  normalizeFixtureMatchExpression,
} = require('../../dist/lib/testing/storyboard/fixture-resolution.js');
const { ENDPOINT, transport } = require('../helpers/fixture-discovery-seller.js');

// Use the published declaration and positive selector together: duplicating
// either in a hand-written fixture hid this mismatch in the original tests.
const published = YAML.parse(
  readFileSync(
    path.join(getComplianceCacheDir({ version: ADCP_VERSION }), 'domains/media-buy/scenarios/canonical_formats.yaml'),
    'utf8'
  )
);
const authoredStep = published.phases
  .flatMap(phase => phase.steps)
  .find(step => step.id === 'create_media_buy_with_direct_canonical_selector');
const selector = authoredStep.sample_request.packages[0];
const product = published.fixtures.products.find(entry => entry.product_id === selector.product_id);
const validation = authoredStep.validations.find(entry => entry.check === 'canonical_format_satisfaction');
const metadata = ['ssl_required', 'asset_source', 'buyer_asset_acceptance', 'composition_model', 'slots'];

function grade(params, accepted = true, selectedProduct = product, expected = validation) {
  return runValidations([expected], {
    taskName: 'create_media_buy',
    taskResult: {
      success: accepted,
      data: accepted
        ? { media_buy_id: 'accepted-buy' }
        : { errors: [{ code: 'UNSUPPORTED_FEATURE', message: 'format selector cannot satisfy product' }] },
    },
    request: {
      transport: 'mcp',
      operation: 'create_media_buy',
      payload: { packages: [{ ...selector, params }] },
    },
    storyboardContext: { products: [selectedProduct] },
    agentUrl: ENDPOINT,
    contributions: new Set(),
  })[0];
}

test('the published positive selector satisfies its enriched product without copying declaration metadata', () => {
  assert.equal(validation.value, true);
  for (const key of metadata) {
    assert.ok(Object.hasOwn(product.format_options[0].params, key), `published declaration includes ${key}`);
    assert.equal(Object.hasOwn(selector.params, key), false, `published selector omits ${key}`);
  }
  const before = structuredClone({ product, selector });
  assert.equal(productCanonicalFormatSatisfies(product, selector), true);
  const result = grade(selector.params);
  assert.equal(result.passed, true, result.error);
  assert.equal(result.actual.local_satisfied, true);
  assert.deepEqual({ product, selector }, before);
});

for (const key of metadata) {
  test(`omitting ${key} does not require repeating the declaration`, () => {
    const params = { ...product.format_options[0].params };
    delete params[key];
    assert.equal(grade(params).passed, true);
  });
}

const conflicts = {
  ssl_required: false,
  asset_source: 'agent_synthesized',
  buyer_asset_acceptance: 'rejected',
  composition_model: 'algorithmic',
  slots: [{ asset_group_id: 'different', asset_type: 'text', required: true }],
};
test('omission does not infer buyer-uploaded assets or other default policy values', () => {
  const declared = structuredClone(product);
  Object.assign(declared.format_options[0].params, conflicts);
  assert.equal(productCanonicalFormatSatisfies(declared, selector), true);
  assert.equal(grade(selector.params, true, declared).passed, true);
});

for (const [key, value] of Object.entries(conflicts)) {
  test(`an explicit conflicting ${key} still fails matching`, () => {
    const params = { ...selector.params, [key]: value };
    assert.equal(productCanonicalFormatSatisfies(product, { ...selector, params }), false);
    const result = grade(params);
    assert.equal(result.passed, false);
    assert.equal(result.actual.local_satisfied, false);
    assert.match(result.actual.detail, new RegExp(key));
  });
}

test('matching explicit metadata remains accepted and a seller rejection remains a failure', () => {
  assert.equal(grade({ ...product.format_options[0].params }).passed, true);
  const rejected = grade(selector.params, false);
  assert.equal(rejected.passed, false);
  assert.equal(rejected.actual.local_satisfied, true);
});

test('fixed dimensions remain mandatory', () => {
  for (const key of ['width', 'height']) {
    const params = { ...selector.params };
    delete params[key];
    assert.equal(productCanonicalFormatSatisfies(product, { ...selector, params }), false, key);
  }
});

test('an omitted encoding limit, enum or other constraint inherits the product value; a stated one must be contained', () => {
  for (const key of ['max_file_size_kb', 'image_formats']) {
    const params = { ...selector.params };
    delete params[key];
    assert.equal(productCanonicalFormatSatisfies(product, { ...selector, params }), true, key);
  }
  assert.equal(
    productCanonicalFormatSatisfies(product, {
      ...selector,
      params: { ...selector.params, max_file_size_kb: product.format_options[0].params.max_file_size_kb + 1 },
    }),
    false
  );
  assert.equal(
    productCanonicalFormatSatisfies(product, { ...selector, params: { ...selector.params, image_formats: ['tiff'] } }),
    false
  );
  const constrained = structuredClone(product);
  constrained.format_options[0].params.publisher_specific_constraint = 'required-value';
  assert.equal(productCanonicalFormatSatisfies(constrained, selector), true);
  assert.equal(
    productCanonicalFormatSatisfies(constrained, {
      ...selector,
      params: { ...selector.params, publisher_specific_constraint: 'other-value' },
    }),
    false
  );
});

test('the published bare-selector negative still requires dimensions and a format-related rejection', () => {
  const negative = published.phases
    .flatMap(phase => phase.steps)
    .find(step => step.id === 'reject_bare_image_selector_for_fixed_mrec');
  const expectation = negative.validations.find(entry => entry.check === 'canonical_format_satisfaction');
  assert.equal(expectation.value, false);
  const params = negative.sample_request.packages[0].params ?? {};
  const rejected = grade(params, false, product, expectation);
  assert.equal(rejected.passed, true, rejected.error);
  assert.equal(rejected.actual.local_satisfied, false);
  assert.equal(grade(params, true, product, expectation).passed, false);
});

test('fixture discovery uses the same selector semantics for the published product', () => {
  const clauses = normalizeFixtureMatchExpression(
    [
      {
        path: '',
        operator: 'canonical_format_satisfies',
        value: { format_kind: selector.format_kind, params: selector.params },
      },
    ],
    'match'
  );
  assert.equal(matchesFixtureRequirements(product, clauses), true);
  const wrongSize = structuredClone(product);
  wrongSize.format_options[0].params.width = selector.params.width + 1;
  assert.equal(matchesFixtureRequirements(wrongSize, clauses), false);
});

test('a legacy format projection can inherit declaration policy without a direct v1 link', () => {
  const declared = structuredClone(product);
  const option = declared.format_options[0];
  delete option.v1_format_ref;
  // Isolate the policy fields from additional encoding constraints that
  // this legacy named format does not express.
  delete option.params.max_file_size_kb;
  delete option.params.image_formats;
  const request = { ...selector, format_ids: product.format_ids };
  delete request.format_kind;
  delete request.params;
  const evaluate = () =>
    runValidations([validation], {
      taskName: 'create_media_buy',
      taskResult: { success: true, data: { media_buy_id: 'legacy-buy' } },
      request: { transport: 'mcp', operation: 'create_media_buy', payload: { packages: [request] } },
      storyboardContext: { products: [declared] },
      agentUrl: ENDPOINT,
      contributions: new Set(),
    })[0];
  assert.equal(evaluate().passed, true);
  option.params.width += 1;
  assert.equal(evaluate().passed, false, 'projection cannot bypass fixed dimensions');
});

for (const standalone of [false, true]) {
  test(`the published direct selector passes through the ${standalone ? 'standalone' : 'full'} runner`, async () => {
    const io = transport([]);
    const doc = {
      id: 'canonical_formats/selector-metadata',
      version: '1.0.0',
      title: 'Published canonical selector',
      agent: published.agent,
      caller: published.caller,
      phases: [{ id: 'buy', title: 'Buy', steps: [authoredStep] }],
    };
    const options = { ...io.options, adcpVersion: ADCP_VERSION, context: { products: [product] } };
    const result = standalone
      ? await runStoryboardStep(ENDPOINT, doc, authoredStep.id, options)
      : await runStoryboard(ENDPOINT, doc, options);
    const step = standalone ? result : result.phases[0].steps[0];
    assert.equal(step.passed, true, JSON.stringify(result));
    assert.notEqual(step.skipped, true);
    assert.equal(step.validations.find(check => check.check === 'canonical_format_satisfaction').passed, true);
    for (const authored of authoredStep.validations) {
      const observed = step.validations.find(
        check => check.check === authored.check && check.description === authored.description
      );
      assert.ok(observed, `authored ${authored.check} ran`);
      assert.equal(observed.passed, true, observed.error);
    }
    const sent = io.calls.find(call => call.task === 'create_media_buy');
    assert.ok(sent, 'the official MCP client dispatched the buy');
    assert.deepEqual(sent.request.packages[0].params, selector.params);
    assert.equal(Object.hasOwn(sent.request.packages[0].params, 'asset_source'), false);
  });
}
