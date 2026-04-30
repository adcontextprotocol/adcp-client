const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildProduct, buildPricingOption, buildPackage } = require('../dist/lib/server');
const { validateResponse } = require('../dist/lib/validation/schema-validator');

describe('buildProduct — emits correct wire shape', () => {
  it('minimal input produces wire-valid Product', () => {
    const product = buildProduct({
      id: 'sports_display',
      name: 'Sports Display',
      formats: ['display_300x250'],
      delivery_type: 'non_guaranteed',
      pricing: { model: 'cpm', floor: 5.0, currency: 'USD' },
      publisher_domain: 'sports.example',
      agentUrl: 'http://127.0.0.1:4200/mcp',
    });
    assert.equal(product.publisher_properties[0].publisher_domain, 'sports.example');
    assert.equal(product.publisher_properties[0].selection_type, 'all');

    // sanity for the rest of the suite
    assert.equal(product.product_id, 'sports_display');
    assert.equal(product.name, 'Sports Display');
    assert.equal(product.description, 'Sports Display');
    assert.equal(product.delivery_type, 'non_guaranteed');
    assert.deepEqual(product.format_ids, [{ id: 'display_300x250', agent_url: 'http://127.0.0.1:4200/mcp' }]);
    assert.equal(product.pricing_options.length, 1);
    assert.equal(product.pricing_options[0].pricing_model, 'cpm');
    assert.equal(product.pricing_options[0].floor_price, 5.0);
    assert.equal(product.pricing_options[0].currency, 'USD');
    assert.ok(product.publisher_properties);
    assert.ok(product.reporting_capabilities);
  });

  it('passes get_products response schema validation', () => {
    const product = buildProduct({
      id: 'sports_display',
      name: 'Sports Display',
      formats: ['display_300x250'],
      delivery_type: 'non_guaranteed',
      pricing: { model: 'cpm', floor: 5.0, currency: 'USD' },
      publisher_domain: 'sports.example',
      agentUrl: 'http://127.0.0.1:4200/mcp',
    });
    const result = validateResponse('get_products', { products: [product] });
    if (!result.valid) {
      // eslint-disable-next-line no-console
      console.error('validation issues:', JSON.stringify(result.issues, null, 2));
    }
    assert.equal(result.valid, true, 'buildProduct output should validate against the wire schema');
  });

  it('accepts ctx_metadata for SDK round-trip', () => {
    const product = buildProduct({
      id: 'p1',
      name: 'P1',
      formats: ['f1'],
      delivery_type: 'guaranteed',
      pricing: { model: 'cpm', fixed: 10, currency: 'USD' },
      publisher_domain: 'pub.example',
      agentUrl: 'http://127.0.0.1:4200/mcp',
      ctx_metadata: { gam: { ad_unit_ids: ['au_1'] } },
    });
    assert.deepEqual(product.ctx_metadata, { gam: { ad_unit_ids: ['au_1'] } });
  });

  it('accepts multiple pricing options as array', () => {
    const product = buildProduct({
      id: 'multi',
      name: 'Multi',
      formats: ['f'],
      delivery_type: 'guaranteed',
      publisher_domain: 'pub.example',
      agentUrl: 'http://127.0.0.1:4200/mcp',
      pricing: [
        buildPricingOption({ id: 'po_cpm', model: 'cpm', fixed: 25, currency: 'USD' }),
        buildPricingOption({ id: 'po_flat', model: 'flat_rate', fixed: 50000, currency: 'USD' }),
      ],
    });
    assert.equal(product.pricing_options.length, 2);
    assert.equal(product.pricing_options[0].pricing_option_id, 'po_cpm');
    assert.equal(product.pricing_options[1].pricing_option_id, 'po_flat');
  });

  it('accepts string and structured format ids', () => {
    const product = buildProduct({
      id: 'p',
      name: 'P',
      formats: ['simple_id', { id: 'cross_agent', agent_url: 'https://other.example/mcp' }],
      delivery_type: 'non_guaranteed',
      publisher_domain: 'pub.example',
      agentUrl: 'http://127.0.0.1:4200/mcp',
    });
    assert.deepEqual(product.format_ids, [
      { id: 'simple_id', agent_url: 'http://127.0.0.1:4200/mcp' },
      { id: 'cross_agent', agent_url: 'https://other.example/mcp' },
    ]);
  });

  it('emits a CPM placeholder when pricing is omitted (loud-default)', () => {
    const product = buildProduct({
      id: 'p',
      name: 'P',
      formats: ['f'],
      delivery_type: 'non_guaranteed',
      publisher_domain: 'pub.example',
      agentUrl: 'http://127.0.0.1:4200/mcp',
    });
    assert.equal(product.pricing_options.length, 1, 'placeholder pricing emitted');
    assert.equal(product.pricing_options[0].pricing_model, 'cpm');
  });

  it('throws when neither publisher_domain nor publisher_properties is provided', () => {
    assert.throws(
      () =>
        buildProduct({
          id: 'p',
          name: 'P',
          formats: [{ id: 'f', agent_url: 'http://127.0.0.1:4200/mcp' }], // pre-empt the agentUrl throw
          delivery_type: 'non_guaranteed',
        }),
      /publisher_domain.*publisher_properties/
    );
  });
});

describe('buildPricingOption — wire shape per pricing model', () => {
  it('CPM with floor (auction)', () => {
    const opt = buildPricingOption({ model: 'cpm', floor: 5.0, currency: 'USD' });
    assert.equal(opt.pricing_model, 'cpm');
    assert.equal(opt.floor_price, 5.0);
    assert.equal(opt.fixed_price, undefined);
    assert.equal(opt.currency, 'USD');
    assert.match(opt.pricing_option_id, /cpm.*5/);
  });

  it('CPM with fixed (guaranteed)', () => {
    const opt = buildPricingOption({ model: 'cpm', fixed: 12.5, currency: 'USD' });
    assert.equal(opt.fixed_price, 12.5);
    assert.equal(opt.floor_price, undefined);
  });

  it('throws when both fixed and floor are passed', () => {
    assert.throws(
      () => buildPricingOption({ model: 'cpm', fixed: 10, floor: 5, currency: 'USD' }),
      /mutually exclusive/
    );
  });

  it('default currency is USD', () => {
    const opt = buildPricingOption({ model: 'cpm', fixed: 10 });
    assert.equal(opt.currency, 'USD');
  });

  it('flat_rate', () => {
    const opt = buildPricingOption({ id: 'po_flat', model: 'flat_rate', fixed: 50000, currency: 'USD' });
    assert.equal(opt.pricing_option_id, 'po_flat');
    assert.equal(opt.pricing_model, 'flat_rate');
    assert.equal(opt.fixed_price, 50000);
  });

  it('every pricing model produces a valid option_id', () => {
    const models = ['cpm', 'vcpm', 'cpc', 'cpcv', 'cpv', 'cpp', 'cpa', 'flat_rate', 'time'];
    for (const m of models) {
      const opt = buildPricingOption({ model: m, fixed: 1, currency: 'USD' });
      assert.equal(opt.pricing_model, m);
      assert.ok(opt.pricing_option_id.length > 0);
    }
  });
});

describe('buildPackage — package response wire shape', () => {
  it('minimal package with status default', () => {
    const pkg = buildPackage({ id: 'pkg_1' });
    assert.equal(pkg.package_id, 'pkg_1');
    assert.equal(pkg.status, 'pending_creatives');
  });

  it('full package with ctx_metadata', () => {
    const pkg = buildPackage({
      id: 'pkg_2',
      buyer_ref: 'br_1',
      status: 'active',
      product_id: 'prod_a',
      pricing_option_id: 'po_cpm',
      ctx_metadata: { gam_line_item_id: 'gli_42' },
    });
    assert.equal(pkg.package_id, 'pkg_2');
    assert.equal(pkg.buyer_ref, 'br_1');
    assert.equal(pkg.status, 'active');
    assert.equal(pkg.product_id, 'prod_a');
    assert.equal(pkg.pricing_option_id, 'po_cpm');
    assert.deepEqual(pkg.ctx_metadata, { gam_line_item_id: 'gli_42' });
  });

  it('escape hatch via extra', () => {
    const pkg = buildPackage({
      id: 'pkg_3',
      extra: { delivery_target: { impressions: 1000 }, custom_field: 'x' },
    });
    assert.deepEqual(pkg.delivery_target, { impressions: 1000 });
    assert.equal(pkg.custom_field, 'x');
  });
});
