const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  ProductPropertyPolicyError,
  normalizeDomainForPropertyPolicy,
  validateProductsAgainstPropertyPolicy,
} = require('../../dist/lib/media-buy');

function product(overrides) {
  return {
    product_id: 'prod_ok',
    name: 'Test product',
    publisher_properties: [{ selection_type: 'all', publisher_domain: 'example.com' }],
    ...overrides,
  };
}

describe('normalizeDomainForPropertyPolicy', () => {
  test('normalizes schemes, paths, casing, ports, and www equivalence', () => {
    assert.deepStrictEqual(normalizeDomainForPropertyPolicy('https://WWW.LADBible.com/news?id=1'), {
      input: 'https://WWW.LADBible.com/news?id=1',
      host: 'www.ladbible.com',
      comparable: 'ladbible.com',
    });

    assert.deepStrictEqual(normalizeDomainForPropertyPolicy('ladbible.com:443/sports'), {
      input: 'ladbible.com:443/sports',
      host: 'ladbible.com',
      comparable: 'ladbible.com',
    });
  });
});

describe('validateProductsAgainstPropertyPolicy', () => {
  test('audits products without changing the returned products array', () => {
    const products = [
      product({ product_id: 'prod_safe' }),
      product({
        product_id: 'prod_excluded',
        publisher_properties: [{ selection_type: 'all', publisher_domain: 'www.ladbible.com' }],
      }),
    ];

    const result = validateProductsAgainstPropertyPolicy({
      products,
      policy: { excludedDomains: ['ladbible.com'] },
      mode: 'audit',
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.products.map(p => p.product_id),
      ['prod_safe', 'prod_excluded']
    );
    assert.deepStrictEqual(
      result.acceptedProducts.map(p => p.product_id),
      ['prod_safe']
    );
    assert.deepStrictEqual(
      result.rejectedProducts.map(p => p.product_id),
      ['prod_excluded']
    );
    assert.strictEqual(result.diagnostics[0].code, 'excluded_domain');
    assert.strictEqual(result.diagnostics[0].matched_excluded_domain, 'ladbible.com');
  });

  test('filters products with all-selector excluded domains', () => {
    const result = validateProductsAgainstPropertyPolicy({
      products: [
        product({ product_id: 'prod_safe' }),
        product({
          product_id: 'prod_ladbible',
          publisher_properties: [{ selection_type: 'all', publisher_domain: 'https://ladbible.com/news' }],
        }),
      ],
      policy: { excludedDomains: ['www.ladbible.com'] },
      mode: 'filter',
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.products.map(p => p.product_id),
      ['prod_safe']
    );
    assert.strictEqual(result.diagnostics[0].normalized_domain, 'ladbible.com');
  });

  test('filters products outside resolved property-list identifiers', () => {
    const result = validateProductsAgainstPropertyPolicy({
      products: [
        product({
          product_id: 'prod_safe',
          publisher_properties: [{ selection_type: 'all', publisher_domain: 'www.example.com' }],
        }),
        product({
          product_id: 'prod_ladbible',
          publisher_properties: [{ selection_type: 'all', publisher_domain: 'www.ladbible.com' }],
        }),
      ],
      policy: {
        allowedPropertyIdentifiers: [{ type: 'domain', value: 'example.com' }],
        strict: true,
      },
      mode: 'filter',
    });

    assert.deepStrictEqual(
      result.products.map(p => p.product_id),
      ['prod_safe']
    );
    assert.strictEqual(result.diagnostics[0].code, 'outside_property_list');
    assert.strictEqual(result.diagnostics[0].normalized_domain, 'www.ladbible.com');
  });

  test('allows subset-targetable products with a property-list intersection', () => {
    const result = validateProductsAgainstPropertyPolicy({
      products: [
        product({
          product_id: 'prod_subset_ok',
          property_targeting_allowed: true,
          publisher_properties: [
            { selection_type: 'all', publisher_domain: 'www.example.com' },
            { selection_type: 'all', publisher_domain: 'www.ladbible.com' },
          ],
        }),
        product({
          product_id: 'prod_all_or_nothing_rejected',
          publisher_properties: [
            { selection_type: 'all', publisher_domain: 'www.example.com' },
            { selection_type: 'all', publisher_domain: 'www.ladbible.com' },
          ],
        }),
      ],
      policy: {
        allowedPropertyIdentifiers: [{ type: 'domain', value: 'example.com' }],
        strict: true,
      },
      mode: 'filter',
    });

    assert.deepStrictEqual(
      result.products.map(p => p.product_id),
      ['prod_subset_ok']
    );
    assert.strictEqual(result.diagnostics[0].product_id, 'prod_all_or_nothing_rejected');
    assert.strictEqual(result.diagnostics[0].code, 'outside_property_list');
  });

  test('allows subset-targetable products with an eligible selector despite explicit exclusions', () => {
    const result = validateProductsAgainstPropertyPolicy({
      products: [
        product({
          product_id: 'prod_subset_ok',
          property_targeting_allowed: true,
          publisher_properties: [
            { selection_type: 'all', publisher_domain: 'www.example.com' },
            { selection_type: 'all', publisher_domain: 'www.ladbible.com' },
          ],
        }),
        product({
          product_id: 'prod_subset_rejected',
          property_targeting_allowed: true,
          publisher_properties: [{ selection_type: 'all', publisher_domain: 'www.ladbible.com' }],
        }),
      ],
      policy: {
        allowedPropertyIdentifiers: [
          { type: 'domain', value: 'example.com' },
          { type: 'domain', value: 'ladbible.com' },
        ],
        excludedDomains: ['ladbible.com'],
        strict: true,
      },
      mode: 'filter',
    });

    assert.deepStrictEqual(
      result.products.map(p => p.product_id),
      ['prod_subset_ok']
    );
    assert.strictEqual(result.diagnostics[0].product_id, 'prod_subset_rejected');
    assert.strictEqual(result.diagnostics[0].code, 'outside_property_list');
  });

  test('rejects products when an enforced allowed property list is empty', () => {
    const result = validateProductsAgainstPropertyPolicy({
      products: [product({ product_id: 'prod_safe' })],
      policy: {
        allowedPropertyIdentifiers: [],
        requireAllowedPropertyMatch: true,
        strict: true,
      },
      mode: 'filter',
    });

    assert.deepStrictEqual(result.products, []);
    assert.strictEqual(result.diagnostics[0].code, 'outside_property_list');
  });

  test('rejects by_id selectors that include excluded property IDs', () => {
    const result = validateProductsAgainstPropertyPolicy({
      products: [
        product({
          product_id: 'prod_by_id',
          publisher_properties: [
            {
              selection_type: 'by_id',
              publisher_domain: 'news.example',
              property_ids: ['homepage', 'www_ladbible_com'],
            },
          ],
        }),
      ],
      policy: { excludedPropertyIds: ['www_ladbible_com'] },
      mode: 'filter',
    });

    assert.deepStrictEqual(result.products, []);
    assert.strictEqual(result.diagnostics[0].code, 'excluded_property_id');
    assert.deepStrictEqual(result.diagnostics[0].matched_property_ids, ['www_ladbible_com']);
  });

  test('reject_response throws a structured error with diagnostics', () => {
    assert.throws(
      () =>
        validateProductsAgainstPropertyPolicy({
          products: [
            product({
              product_id: 'prod_ladbible',
              publisher_properties: [{ selection_type: 'all', publisher_domain: 'ladbible.com' }],
            }),
          ],
          policy: { excludedDomains: ['ladbible.com'] },
          mode: 'reject_response',
        }),
      err => {
        assert.ok(err instanceof ProductPropertyPolicyError);
        assert.strictEqual(err.result.rejectedProducts[0].product_id, 'prod_ladbible');
        assert.strictEqual(err.result.diagnostics[0].code, 'excluded_domain');
        return true;
      }
    );
  });

  test('strict mode rejects products missing publisher_properties', () => {
    const result = validateProductsAgainstPropertyPolicy({
      products: [product({ product_id: 'prod_unknown', publisher_properties: undefined })],
      policy: { strict: true },
      mode: 'filter',
    });

    assert.deepStrictEqual(result.products, []);
    assert.strictEqual(result.diagnostics[0].code, 'missing_publisher_properties');
    assert.strictEqual(result.diagnostics[0].severity, 'rejected');
  });

  test('unresolved by_tag selectors are flagged by default and rejected when configured', () => {
    const products = [
      product({
        product_id: 'prod_by_tag',
        publisher_properties: [
          { selection_type: 'by_tag', publisher_domain: 'news.example', property_tags: ['sports'] },
        ],
      }),
    ];

    const flagged = validateProductsAgainstPropertyPolicy({
      products,
      policy: {},
      mode: 'filter',
    });
    assert.deepStrictEqual(
      flagged.products.map(p => p.product_id),
      ['prod_by_tag']
    );
    assert.strictEqual(flagged.diagnostics[0].code, 'unresolved_tag_selector');
    assert.strictEqual(flagged.diagnostics[0].severity, 'flagged');

    const rejected = validateProductsAgainstPropertyPolicy({
      products,
      policy: { unknownSelectorBehavior: 'reject' },
      mode: 'filter',
    });
    assert.deepStrictEqual(rejected.products, []);
    assert.strictEqual(rejected.diagnostics[0].severity, 'rejected');
  });

  test('compact publisher_domains selectors are malformed for product publisher_properties', () => {
    const products = [
      product({
        product_id: 'prod_compact_shape',
        publisher_properties: [{ selection_type: 'all', publisher_domains: ['example.com', 'ladbible.com'] }],
      }),
    ];

    const result = validateProductsAgainstPropertyPolicy({
      products,
      policy: { excludedDomains: ['ladbible.com'] },
      mode: 'filter',
    });
    assert.deepStrictEqual(
      result.products.map(p => p.product_id),
      []
    );
    assert.strictEqual(result.diagnostics[0].code, 'unknown_selector');
    assert.strictEqual(result.diagnostics[0].path, 'products[0].publisher_properties[0]');
    assert.deepStrictEqual(result.diagnostics[0].publisher_domains, ['example.com', 'ladbible.com']);
    assert.strictEqual(result.diagnostics[0].severity, 'rejected');

    const rejected = validateProductsAgainstPropertyPolicy({
      products,
      policy: { strict: true },
      mode: 'filter',
    });
    assert.deepStrictEqual(rejected.products, []);
    assert.strictEqual(rejected.diagnostics[0].severity, 'rejected');
  });

  test('malformed compact publisher_domains selectors are rejected before forwarding', () => {
    const products = [
      product({
        product_id: 'prod_compact_shape',
        publisher_properties: [{ selection_type: 'all', publisher_domains: 'ladbible.com' }],
      }),
    ];

    const rejectedByShape = validateProductsAgainstPropertyPolicy({
      products,
      policy: { excludedDomains: ['ladbible.com'] },
      mode: 'filter',
    });
    assert.deepStrictEqual(
      rejectedByShape.products.map(p => p.product_id),
      []
    );
    assert.strictEqual(rejectedByShape.diagnostics[0].code, 'unknown_selector');
    assert.strictEqual(rejectedByShape.diagnostics[0].severity, 'rejected');

    const rejected = validateProductsAgainstPropertyPolicy({
      products,
      policy: { excludedDomains: ['ladbible.com'], strict: true },
      mode: 'filter',
    });
    assert.deepStrictEqual(rejected.products, []);
    assert.strictEqual(rejected.diagnostics[0].severity, 'rejected');
  });
});
