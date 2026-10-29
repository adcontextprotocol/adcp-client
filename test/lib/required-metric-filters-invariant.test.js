const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAssertion } = require('../../dist/lib/testing/storyboard/assertions');
const { registerDefaultInvariants } = require('../../dist/lib/testing/storyboard/default-invariants');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

registerDefaultInvariants();
const invariant = getAssertion('discovery.required_metric_filters');
const context = { storyboard: {}, agentUrl: 'https://seller.example/mcp', options: {}, state: {} };
const vendor = (domain, metric, brandId) => ({
  vendor: { domain, ...(brandId ? { brand_id: brandId } : {}) },
  metric_id: metric,
});
const product = (metrics = [], vendors) => ({
  product_id: 'seller-product',
  reporting_capabilities: { available_metrics: metrics, ...(vendors ? { vendor_metrics: vendors } : {}) },
});
function check(filters, products, request = {}) {
  return invariant.onStep(context, {
    step_id: 'filtered',
    task: 'get_products',
    passed: true,
    request: { payload: { filters, ...request } },
    response: { products },
  });
}
const failures = results => results.filter(result => !result.passed);

test('required metric filters are a default invariant and absent filters impose no declaration requirement', () => {
  assert.equal(invariant.default, true);
  assert.deepEqual(check({}, [{ product_id: 'no-optional-metrics' }]), []);
});

test('all standard requirements apply to every returned product', () => {
  const filters = { required_metrics: ['completed_views', 'clicks'] };
  assert.equal(
    failures(check(filters, [product(['completed_views', 'clicks']), product(['completed_views', 'clicks'])])).length,
    0
  );
  const badLater = failures(check(filters, [product(['completed_views', 'clicks']), product(['clicks'])]));
  assert.equal(badLater.length, 1);
  assert.match(badLater[0].error, /products\[1\].*completed_views/);
  assert.equal(failures(check(filters, [{ product_id: 'no-reporting-declaration' }])).length, 1);
});

test('direct products cannot hide standard or vendor metric failures behind a data extension', () => {
  const filters = { required_metrics: ['completed_views'], required_vendor_metrics: [{ metric_id: 'attention' }] };
  const products = [product()];
  for (const data of [{}, { products: [product(['completed_views'], [vendor('metrics.example', 'attention')])] }]) {
    const findings = invariant.onStep(context, {
      step_id: 'filtered',
      task: 'get_products',
      passed: true,
      request: { payload: { filters } },
      response: { products, data },
    });
    assert.equal(failures(findings).length, 2);
  }
});

test('implicit impressions/spend and documented scalar derivations are honored', () => {
  assert.equal(failures(check({ required_metrics: ['impressions', 'spend', 'cpm'] }, [product()])).length, 0);
  assert.equal(failures(check({ required_metrics: ['ctr', 'cost_per_click'] }, [product(['clicks'])])).length, 0);
  assert.equal(
    failures(
      check({ required_metrics: ['completion_rate', 'cost_per_completed_view'] }, [product(['completed_views'])])
    ).length,
    0
  );
  assert.equal(
    failures(
      check({ required_metrics: ['roas', 'cost_per_acquisition'] }, [product(['conversion_value', 'conversions'])])
    ).length,
    0
  );
  assert.equal(failures(check({ required_metrics: ['completion_rate'] }, [product(['clicks'])])).length, 1);
  assert.equal(
    failures(check({ required_metrics: ['engagement_rate'] }, [product(['engagements'])])).length,
    1,
    'platform-specific engagement rate is not inferred from a generic count'
  );
  assert.equal(
    failures(check({ required_metrics: ['new_to_brand_rate'] }, [product(['new_to_brand_units', 'units_sold'])]))
      .length,
    1,
    'transaction fraction cannot be reconstructed from unit-volume counts'
  );
});

test('numeric containers subsume leaves while structured distributions require explicit declaration', () => {
  assert.equal(
    failures(
      check({ required_metrics: ['viewable_rate', 'viewed_seconds', 'quartile_100'] }, [
        product(['viewability', 'quartile_data']),
      ])
    ).length,
    0
  );
  assert.equal(
    failures(
      check({ required_metrics: ['viewable_rate'] }, [product(['viewable_impressions', 'measurable_impressions'])])
    ).length,
    0
  );
  assert.equal(
    failures(check({ required_metrics: ['viewed_seconds_percentiles'] }, [product(['viewability'])])).length,
    1
  );
  assert.equal(
    failures(check({ required_metrics: ['viewed_seconds_percentiles'] }, [product(['viewed_seconds_percentiles'])]))
      .length,
    0
  );
});

test('unknown or prototype-shaped metric names never crash or inherit capabilities', () => {
  for (const metric of ['future_metric', '__proto__', 'toString']) {
    assert.equal(failures(check({ required_metrics: [metric] }, [product()])).length, 1);
    assert.equal(failures(check({ required_metrics: [metric] }, [product([metric])])).length, 0);
  }
});

test('vendor filters permit vendor-only and metric-only pins and require every filter row', () => {
  const a = vendor('measurement-a.example', 'attention');
  const b = vendor('measurement-b.example', 'emissions');
  const filters = {
    required_vendor_metrics: [{ vendor: { domain: 'measurement-a.example' } }, { metric_id: 'emissions' }],
  };
  assert.equal(failures(check(filters, [product([], [b, a])])).length, 0);
  assert.equal(failures(check(filters, [product([], [a])])).length, 1);
  assert.equal(
    failures(check(filters, [product()])).length,
    2,
    'omitted vendor_metrics is a non-match when the filter is supplied'
  );
});

test('vendor and metric pins must match one declared row on the same product', () => {
  const filters = {
    required_vendor_metrics: [{ vendor: { domain: 'measurement-a.example' }, metric_id: 'attention' }],
  };
  const a = vendor('measurement-a.example', 'emissions');
  const b = vendor('measurement-b.example', 'attention');
  assert.equal(
    failures(check(filters, [product([], [a, b])])).length,
    1,
    'pins cannot be satisfied by different vendors'
  );
  const good = product([], [vendor('measurement-a.example', 'attention')]);
  assert.equal(
    failures(check(filters, [good, product([], [b])])).length,
    1,
    'a matching earlier product cannot cover a later non-match'
  );
});

test('explicit vendor brand IDs are identity pins and domain-only filters remain broad', () => {
  const declared = [vendor('measurement.example', 'attention', 'panel-a')];
  assert.equal(
    failures(
      check({ required_vendor_metrics: [{ vendor: { domain: 'measurement.example' } }] }, [product([], declared)])
    ).length,
    0
  );
  assert.equal(
    failures(
      check({ required_vendor_metrics: [{ vendor: { domain: 'measurement.example', brand_id: 'panel-a' } }] }, [
        product([], declared),
      ])
    ).length,
    0
  );
  assert.equal(
    failures(
      check({ required_vendor_metrics: [{ vendor: { domain: 'measurement.example', brand_id: 'panel-b' } }] }, [
        product([], declared),
      ])
    ).length,
    1
  );
});

test('standard and vendor filters combine; valid empty matches remain valid', () => {
  const filters = { required_metrics: ['completed_views'], required_vendor_metrics: [{ metric_id: 'attention' }] };
  assert.deepEqual(check(filters, []), []);
  assert.equal(
    failures(check(filters, [product(['completed_views'], [vendor('measurement.example', 'attention')])])).length,
    0
  );
  assert.equal(failures(check(filters, [product(['completed_views'])])).length, 1);
});

test('projected-away capabilities are explicitly unproven rather than presumed unsupported', () => {
  const filters = { required_metrics: ['completed_views'], required_vendor_metrics: [{ metric_id: 'attention' }] };
  const findings = check(filters, [{ product_id: 'projected' }], { fields: ['product_id', 'pricing_options'] });
  assert.equal(failures(findings).length, 0);
  assert.equal(findings[0].status, 'not_applicable');
  assert.match(findings[0].description, /unproven/);
  assert.equal(
    failures(check(filters, [{ product_id: 'projected' }], { fields: ['product_id', 'reporting_capabilities'] }))
      .length,
    2
  );
  assert.equal(
    failures(check(filters, [product()], { fields: ['product_id'] })).length,
    2,
    'explicitly returned contradictions remain observable even on a lean projection'
  );
});

test('real storyboard results fail for a later product that does not meet the metric contract', async () => {
  const storyboard = {
    id: 'required-metric-integration',
    version: '1.0.0',
    title: 'Required metrics',
    category: 'test',
    summary: '',
    narrative: '',
    phases: [
      {
        id: 'discovery',
        title: 'Discovery',
        steps: [
          {
            id: 'filtered',
            title: 'Filtered products',
            task: 'get_products',
            sample_request: {
              buying_mode: 'brief',
              brief: 'Completion reporting',
              filters: { required_metrics: ['completed_views'] },
            },
            validations: [{ check: 'field_present', path: 'products' }],
          },
        ],
      },
    ],
  };
  for (const products of [[product(['completed_views'])], [product(['completed_views']), product(['clicks'])], []]) {
    const result = await runStoryboard('https://seller.example/mcp', storyboard, {
      agentTools: ['get_products'],
      _profile: { tools: ['get_products'] },
      _client: {
        resetContext() {},
        async getProducts() {
          return { success: true, data: { products, data: {} } };
        },
      },
    });
    assert.equal(result.overall_passed, products.length !== 2, JSON.stringify(result.assertions));
  }
});
