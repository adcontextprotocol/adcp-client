const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations');
const published = YAML.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../compliance/cache/3.2.7/domains/media-buy/scenarios/canonical_formats.yaml'),
    'utf8'
  )
);

function grade(request, products, expected, accepted, code = 'CONFLICTING_SELECTORS') {
  return runValidations(
    [{ check: 'canonical_format_satisfaction', value: expected, description: 'route equivalence' }],
    {
      taskName: 'create_media_buy',
      taskResult: {
        success: accepted,
        data: accepted
          ? { media_buy_id: 'accepted' }
          : { errors: [{ code, field: 'packages[0].format_options', message: 'Conflicting format selector routes' }] },
      },
      request: { transport: 'mcp', operation: 'create_media_buy', payload: request },
      storyboardContext: { products },
      agentUrl: 'https://seller.example/mcp',
      contributions: new Set(),
    }
  )[0];
}
for (const id of [
  'reject_conflicting_dual_emission',
  'reject_conflicting_canonical_routes',
  'reject_unprojectable_legacy_dual_emission',
]) {
  test(`published ${id} grades with the seeded product context present`, () => {
    const step = published.phases.flatMap(phase => phase.steps).find(step => step.id === id);
    const code = step.validations.find(validation => validation.check === 'error_code').value;
    const request = structuredClone(step.sample_request);
    const products = structuredClone(published.fixtures.products);
    const before = structuredClone({ request, products });
    const result = grade(request, products, false, false, code);
    assert.equal(result.passed, true, result.error);
    assert.equal(result.actual.local_satisfied, false);
    assert.deepEqual({ request, products }, before);
  });
}

const product = {
  product_id: 'multi',
  format_options: [
    {
      format_option_id: 'mrec',
      format_kind: 'image',
      params: { width: 300, height: 250 },
      v1_format_ref: [{ agent_url: 'https://creative.example', id: 'mrec' }],
    },
    {
      format_option_id: 'leaderboard',
      format_kind: 'image',
      params: { width: 728, height: 90 },
      v1_format_ref: [{ agent_url: 'https://creative.example', id: 'leaderboard' }],
    },
  ],
};
const refs = [{ format_option_id: 'mrec', scope: 'product' }];
const legacy = [{ agent_url: 'https://creative.example', id: 'mrec' }];
const selector = { format_kind: 'image', params: { width: 300, height: 250 } };
for (const routes of [
  { format_option_refs: refs, format_ids: legacy },
  { format_option_refs: refs, ...selector },
  { format_ids: legacy, ...selector },
  { format_option_refs: refs, format_ids: legacy, ...selector },
]) {
  test(`matching ${Object.keys(routes)
    .filter(key => key !== 'params')
    .join('+')} routes remain accepted`, () => {
    const result = grade({ packages: [{ product_id: 'multi', ...routes }] }, [product], true, true);
    assert.equal(result.passed, true, result.error);
  });
}
test('individually valid routes still conflict when selecting different declaration sets', () => {
  const result = grade(
    {
      packages: [
        {
          product_id: 'multi',
          format_option_refs: refs,
          format_ids: [{ agent_url: 'https://creative.example', id: 'leaderboard' }],
        },
      ],
    },
    [product],
    false,
    false
  );
  assert.equal(result.passed, true, result.error);
  assert.match(result.observations[0].detail, /different product format_options/);
});
test('route set comparison is independent of selector order and duplicate references', () => {
  const result = grade(
    {
      packages: [
        {
          product_id: 'multi',
          format_option_refs: [refs[0], { scope: 'product', format_option_id: 'leaderboard' }, refs[0]],
          format_ids: [{ agent_url: 'https://creative.example', id: 'leaderboard' }, legacy[0]],
        },
      ],
    },
    [product],
    true,
    true
  );
  assert.equal(result.passed, true, result.error);
});
