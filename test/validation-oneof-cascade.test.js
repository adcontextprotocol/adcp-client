const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateResponse } = require('../dist/lib/validation/schema-validator');

// Minimal valid Product fixture for AdCP 3.0.1 get_products response.
function makeProduct(overrides = {}) {
  const base = {
    product_id: 'cpm_standard',
    name: 'Standard CPM',
    description: 'A standard CPM product',
    publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
    format_ids: [{ agent_url: 'https://example.com/creative', id: 'display_300x250' }],
    delivery_type: 'non_guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'po-cpm-homepage',
        pricing_model: 'cpm',
        currency: 'USD',
        fixed_price: 5,
      },
    ],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions'],
      date_range_support: 'date_range',
    },
  };
  return { ...base, ...overrides };
}

describe('schema-validator — oneOf cascade compaction (#1111)', () => {
  it('baseline product validates clean (no false-positive cascade)', () => {
    const out = validateResponse('get_products', { products: [makeProduct()] });
    assert.equal(out.valid, true, `expected valid; got issues: ${JSON.stringify(out.issues)}`);
  });

  it('bad pricing_model collapses 9-variant cascade to one enum issue', () => {
    const product = makeProduct();
    product.pricing_options[0].pricing_model = 'totally_made_up';
    const out = validateResponse('get_products', { products: [product] });
    assert.equal(out.valid, false);
    // Pre-fix this surfaced 14 issues (9 const + 4 required + 1 oneOf root).
    // Post-fix it must be exactly 1 enum issue at the discriminator path.
    assert.equal(
      out.issues.length,
      1,
      `expected 1 issue, got ${out.issues.length}: ${JSON.stringify(out.issues, null, 2)}`
    );
    const issue = out.issues[0];
    assert.equal(issue.keyword, 'enum');
    assert.equal(issue.pointer, '/products/0/pricing_options/0/pricing_model');
    assert.ok(
      Array.isArray(issue.allowedValues) && issue.allowedValues.length >= 5,
      `allowedValues must list every variant's const: ${JSON.stringify(issue.allowedValues)}`
    );
    assert.ok(issue.allowedValues.includes('cpm'));
    assert.ok(issue.allowedValues.includes('cpc'));
    assert.match(issue.message, /must be one of: "cpm"/);
    // Synthetic issue must not carry a fabricated schemaPath that won't
    // round-trip if a downstream consumer dereferences it.
    assert.equal(issue.schemaPath, '', `synthetic enum schemaPath must be empty, got: ${issue.schemaPath}`);
  });

  it('correct discriminator + missing required surfaces the residual, not noise', () => {
    const product = makeProduct();
    delete product.pricing_options[0].pricing_option_id;
    const out = validateResponse('get_products', { products: [product] });
    assert.equal(out.valid, false);
    // The variant the user picked (CPM) reports its missing required field;
    // we additionally keep the synthetic oneOf root so callers can see the
    // union shape via variants[]. No const-cascade noise from non-CPM
    // variants should appear.
    const constNoise = out.issues.filter(
      i => i.keyword === 'const' && i.pointer === '/products/0/pricing_options/0/pricing_model'
    );
    assert.equal(constNoise.length, 0, `unexpected const cascade: ${JSON.stringify(constNoise)}`);
    const requiredIssue = out.issues.find(
      i => i.keyword === 'required' && i.pointer === '/products/0/pricing_options/0/pricing_option_id'
    );
    assert.ok(requiredIssue, `expected missing-required residual, got: ${JSON.stringify(out.issues, null, 2)}`);
  });

  it('cascade in one field does not smother an unrelated nested error', () => {
    // The upstream symptom (#1111): a bad pricing_model on one product was
    // burying a real `reporting_capabilities` shape error. Both must surface.
    const product = makeProduct();
    product.pricing_options[0].pricing_model = 'totally_made_up';
    delete product.reporting_capabilities.available_reporting_frequencies;
    const out = validateResponse('get_products', { products: [product] });
    assert.equal(out.valid, false);
    const reportingIssue = out.issues.find(i => i.pointer.startsWith('/products/0/reporting_capabilities/'));
    assert.ok(
      reportingIssue,
      `reporting_capabilities residual must survive cascade compaction: ${JSON.stringify(out.issues, null, 2)}`
    );
    const enumIssue = out.issues.find(
      i => i.keyword === 'enum' && i.pointer === '/products/0/pricing_options/0/pricing_model'
    );
    assert.ok(enumIssue, `pricing_model collapse must survive: ${JSON.stringify(out.issues, null, 2)}`);
  });

  // #1337 — Success/Error oneOf where the Error variant has a `not` clause
  // forbidding the Success variant's required fields. A payload that's
  // SHAPED like Success but missing some required fields should surface the
  // Success-variant residuals — NOT the unactionable "must NOT be valid"
  // (variant 1 not-clause failure) plus "must have required property
  // 'errors'" (variant 1 required-clause failure).
  it("near-miss Success payload surfaces Success-variant residuals, not Error variant's not-clause failure", () => {
    // get_account_financials response — Success requires
    //   { account, period, currency, timezone, spend, ... }
    // Error has a not-clause forbidding those fields and requires
    //   { errors[] }
    // This payload is shaped like Success but missing currency + timezone.
    const payload = {
      account: { account_id: 'acc_123' },
      period: { start: '2026-01-01', end: '2026-01-31' },
      spend: { total: 1000, currency: 'USD' },
    };
    const out = validateResponse('get_account_financials', payload);
    assert.equal(out.valid, false);

    // Pre-fix: the issues pointed at the Error variant's `not` clause
    // (`#/oneOf/1/not`) and Error's missing `errors` field. Post-fix: the
    // Success variant's missing-required diagnostics survive instead.
    const successResiduals = out.issues.filter(
      i => i.keyword === 'required' && i.schemaPath && i.schemaPath.includes('/oneOf/0/')
    );
    assert.ok(
      successResiduals.length >= 2,
      `expected ≥2 Success-variant required-field residuals, got ${out.issues.length} issue(s): ` +
        JSON.stringify(out.issues, null, 2)
    );

    // No `not`-keyword issue should leak through — that's the diagnostic the
    // adopter can't act on.
    const notIssue = out.issues.find(i => i.keyword === 'not');
    assert.equal(notIssue, undefined, `not-clause failure must be filtered: ${JSON.stringify(notIssue)}`);

    // The Error variant's "missing errors" should NOT be the surfaced diagnosis
    // (it's a side-effect of the variant being unreachable).
    const errorMisroute = out.issues.find(
      i => i.keyword === 'required' && i.pointer === '/errors' && i.schemaPath?.includes('/oneOf/1/')
    );
    assert.equal(
      errorMisroute,
      undefined,
      `Error-variant residual must be filtered when Success is the obvious near-miss: ${JSON.stringify(errorMisroute)}`
    );
  });

  it('two independent oneOf failures stay independent (instancePath scoping)', () => {
    const p1 = makeProduct();
    p1.pricing_options[0].pricing_model = 'totally_made_up';
    const p2 = makeProduct();
    p2.product_id = 'cpc_standard';
    p2.pricing_options[0].pricing_model = 'also_made_up';
    const out = validateResponse('get_products', { products: [p1, p2] });
    assert.equal(out.valid, false);
    const enums = out.issues.filter(i => i.keyword === 'enum');
    const paths = enums.map(i => i.pointer).sort();
    assert.deepEqual(
      paths,
      ['/products/0/pricing_options/0/pricing_model', '/products/1/pricing_options/0/pricing_model'],
      `each product's cascade must collapse independently: ${JSON.stringify(enums)}`
    );
  });
});
