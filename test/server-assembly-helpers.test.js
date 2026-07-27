const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildProduct, buildProductLegacy, buildPricingOption, buildPackage } = require('../dist/lib/server');
const { validateResponse } = require('../dist/lib/validation/schema-validator');

describe('buildProduct — emits correct wire shape', () => {
  it('minimal input produces wire-valid Product', () => {
    const product = buildProduct({
      id: 'sports_display',
      name: 'Sports Display',
      format_options: [
        { format_option_id: 'display_300x250', format_kind: 'image', params: { width: 300, height: 250 } },
      ],
      delivery_type: 'non_guaranteed',
      pricing: { model: 'cpm', floor: 5.0, currency: 'USD' },
      publisher_domain: 'sports.example',
    });
    assert.equal(product.publisher_properties[0].publisher_domain, 'sports.example');
    assert.equal(product.publisher_properties[0].selection_type, 'all');

    // sanity for the rest of the suite
    assert.equal(product.product_id, 'sports_display');
    assert.equal(product.name, 'Sports Display');
    assert.equal(product.description, 'Sports Display');
    assert.equal(product.delivery_type, 'non_guaranteed');
    assert.deepEqual(product.format_options, [
      { format_option_id: 'display_300x250', format_kind: 'image', params: { width: 300, height: 250 } },
    ]);
    assert.equal(product.format_ids, undefined);
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
      format_options: [
        { format_option_id: 'display_300x250', format_kind: 'image', params: { width: 300, height: 250 } },
      ],
      delivery_type: 'non_guaranteed',
      pricing: { model: 'cpm', floor: 5.0, currency: 'USD' },
      publisher_domain: 'sports.example',
    });
    // `cache_scope: 'public'` is required on the populated-products branch
    // of `get-products-response.json`'s top-level `if (unchanged) ... else`
    // since 3.1.0-beta.3.
    const result = validateResponse('get_products', { products: [product], cache_scope: 'public' });
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
      format_options: [{ format_option_id: 'f1', format_kind: 'image', params: {} }],
      delivery_type: 'guaranteed',
      pricing: { model: 'cpm', fixed: 10, currency: 'USD' },
      publisher_domain: 'pub.example',
      ctx_metadata: { gam: { ad_unit_ids: ['au_1'] } },
    });
    assert.deepEqual(product.ctx_metadata, { gam: { ad_unit_ids: ['au_1'] } });
  });

  it('accepts multiple pricing options as array', () => {
    const product = buildProduct({
      id: 'multi',
      name: 'Multi',
      format_options: [{ format_option_id: 'f', format_kind: 'image', params: {} }],
      delivery_type: 'guaranteed',
      publisher_domain: 'pub.example',
      pricing: [
        buildPricingOption({ id: 'po_cpm', model: 'cpm', fixed: 25, currency: 'USD' }),
        buildPricingOption({ id: 'po_flat', model: 'flat_rate', fixed: 50000, currency: 'USD' }),
      ],
    });
    assert.equal(product.pricing_options.length, 2);
    assert.equal(product.pricing_options[0].pricing_option_id, 'po_cpm');
    assert.equal(product.pricing_options[1].pricing_option_id, 'po_flat');
  });

  it('accepts canonical format declarations', () => {
    const product = buildProduct({
      id: 'p',
      name: 'P',
      format_options: [
        { format_option_id: 'simple-image', format_kind: 'image', params: { width: 300, height: 250 } },
        { format_option_id: 'vast-video', format_kind: 'video_vast', params: {} },
      ],
      delivery_type: 'non_guaranteed',
      publisher_domain: 'pub.example',
    });
    assert.deepEqual(product.format_options, [
      { format_option_id: 'simple-image', format_kind: 'image', params: { width: 300, height: 250 } },
      { format_option_id: 'vast-video', format_kind: 'video_vast', params: {} },
    ]);
  });

  it('keeps legacy product assembly behind an explicit helper name', () => {
    const product = buildProductLegacy({
      id: 'legacy',
      name: 'Legacy',
      formats: ['display_300x250'],
      agentUrl: 'https://legacy.example/mcp',
      delivery_type: 'non_guaranteed',
      publisher_domain: 'pub.example',
    });
    assert.deepEqual(product.format_ids, [{ id: 'display_300x250', agent_url: 'https://legacy.example/mcp' }]);
  });

  it('rejects legacy identity and canonical field overrides through extra', () => {
    const base = {
      id: 'safe-extra',
      name: 'Safe extra',
      format_options: [{ format_option_id: 'image', format_kind: 'image', params: {} }],
      delivery_type: 'non_guaranteed',
      publisher_domain: 'pub.example',
    };
    assert.throws(
      () => buildProduct({ ...base, extra: { format_ids: [{ id: 'legacy', agent_url: 'https://legacy.example' }] } }),
      /cannot override a canonical product field/
    );
    assert.throws(
      () => buildProduct({ ...base, extra: { format_options: [] } }),
      /cannot override a canonical product field/
    );
    assert.throws(
      () => buildProduct({ ...base, extra: { vendor: { agent_url: 'https:\/\/legacy.example' } } }),
      /contains legacy creative identity/
    );
  });

  it('descriptor-clones format_options without invoking getters or custom iterators', () => {
    let getterCalls = 0;
    let iteratorCalls = 0;
    const unsafe = { format_kind: 'image', params: {} };
    Object.defineProperty(unsafe, 'agent_url', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'https://legacy.example';
      },
    });
    assert.throws(
      () =>
        buildProduct({
          id: 'unsafe-option',
          name: 'Unsafe option',
          format_options: [unsafe],
          delivery_type: 'non_guaranteed',
          publisher_domain: 'pub.example',
        }),
      /must be a data property, not an accessor/
    );
    assert.equal(getterCalls, 0);

    const options = [{ format_option_id: 'safe', format_kind: 'image', params: { width: 300, height: 250 } }];
    Object.defineProperty(options, Symbol.iterator, {
      value() {
        iteratorCalls += 1;
        throw new Error('format option iterator must not run');
      },
    });
    const product = buildProduct({
      id: 'safe-options',
      name: 'Safe options',
      format_options: options,
      delivery_type: 'non_guaranteed',
      publisher_domain: 'pub.example',
    });
    assert.equal(iteratorCalls, 0);
    assert.equal(product.format_options[0].format_kind, 'image');
  });

  it('rejects direct and nested legacy identity in format_options', () => {
    const base = {
      id: 'legacy-option',
      name: 'Legacy option',
      delivery_type: 'non_guaranteed',
      publisher_domain: 'pub.example',
    };
    assert.throws(
      () =>
        buildProduct({
          ...base,
          format_options: [{ format_kind: 'image', params: {}, v1_format_ref: [{ id: 'legacy' }] }],
        }),
      /contains legacy creative identity/
    );
    assert.throws(
      () =>
        buildProduct({
          ...base,
          format_options: [{ format_kind: 'custom', params: { nested: { format_id: 'legacy' } } }],
        }),
      /contains legacy creative identity/
    );
  });

  it('rejects serialization hooks without invoking them', () => {
    let hookCalls = 0;
    const maliciousParams = {};
    Object.defineProperty(maliciousParams, 'toJSON', {
      value() {
        hookCalls += 1;
        return { format_id: { id: 'legacy', agent_url: 'https://legacy.example' } };
      },
    });
    assert.throws(
      () =>
        buildProduct({
          id: 'option-to-json',
          name: 'Option toJSON',
          format_options: [{ format_kind: 'custom', params: maliciousParams }],
          delivery_type: 'non_guaranteed',
          publisher_domain: 'pub.example',
        }),
      /toJSON is not allowed/
    );

    const maliciousExtra = { vendor: {} };
    Object.defineProperty(maliciousExtra.vendor, 'toJSON', {
      enumerable: true,
      value() {
        hookCalls += 1;
        return { agent_url: 'https://legacy.example', format_id: 'legacy' };
      },
    });
    assert.throws(
      () =>
        buildProduct({
          id: 'extra-to-json',
          name: 'Extra toJSON',
          format_options: [{ format_kind: 'image', params: {} }],
          delivery_type: 'non_guaranteed',
          publisher_domain: 'pub.example',
          extra: maliciousExtra,
        }),
      /toJSON is not allowed/
    );
    assert.equal(hookCalls, 0);

    const accessorInput = {
      id: 'extra-accessor',
      name: 'Extra accessor',
      format_options: [{ format_kind: 'image', params: {} }],
      delivery_type: 'non_guaranteed',
      publisher_domain: 'pub.example',
    };
    Object.defineProperty(accessorInput, 'extra', {
      enumerable: true,
      get() {
        hookCalls += 1;
        return { format_id: 'legacy' };
      },
    });
    assert.throws(() => buildProduct(accessorInput), /extra must be an own data property, not an accessor/);
    assert.equal(hookCalls, 0);
  });

  it('emits a CPM placeholder when pricing is omitted (loud-default)', () => {
    const product = buildProduct({
      id: 'p',
      name: 'P',
      format_options: [{ format_option_id: 'f', format_kind: 'image', params: {} }],
      delivery_type: 'non_guaranteed',
      publisher_domain: 'pub.example',
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
          format_options: [{ format_option_id: 'f', format_kind: 'image', params: {} }],
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
