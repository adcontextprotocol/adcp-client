const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runValidations } = require('../../dist/lib/testing/storyboard/validations');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

const validation = {
  id: 'format_ids_removed_in_4_0',
  check: 'all_fields_present',
  path: 'products[*].format_options',
  description: 'Every product carries format_options for AdCP 4.0',
};

function grade(data, overrides = {}) {
  return runValidations([{ ...validation, ...overrides }], {
    taskName: 'get_products',
    taskResult: { success: true, data },
    agentUrl: 'https://example.test/mcp',
    contributions: new Set(),
  })[0];
}

describe('all_fields_present (#3343)', () => {
  test('passes when every item has a non-null field, including falsey values and empty arrays', () => {
    const result = grade({ products: [[], {}, false, 0, ''].map(format_options => ({ format_options })) });
    assert.equal(result.passed, true);
    assert.equal(result.not_applicable, undefined);
    assert.equal(result.id, validation.id);
    assert.equal(result.severity, 'required');
  });

  test('reports every missing or explicitly null field in array order', () => {
    const result = grade({ products: [{ format_options: [] }, {}, { format_options: null }] });
    assert.equal(result.passed, false);
    assert.equal(result.not_applicable, undefined);
    assert.equal(result.expected, validation.path);
    assert.deepEqual(result.actual, ['/products/1/format_options', '/products/2/format_options']);
    assert.equal(result.json_pointer, result.actual[0]);
  });

  test('supports nested array and field paths and escapes RFC 6901 pointers', () => {
    const path = 'catalogs[0].products[*].details.format/options~key';
    const result = grade(
      { catalogs: [{ products: [{ details: { 'format/options~key': [] } }, { details: {} }] }] },
      { path }
    );
    assert.equal(result.passed, false);
    assert.equal(result.expected, path);
    assert.deepEqual(result.actual, ['/catalogs/0/products/1/details/format~1options~0key']);
    assert.equal(result.json_pointer, result.actual[0]);
  });

  test('keeps diagnostics concise while preserving every missing-field pointer', () => {
    const products = Array.from({ length: 400 }, () => ({}));
    const result = grade({ products });
    assert.equal(result.passed, false);
    assert.equal(result.actual.length, products.length);
    assert.equal(result.actual[399], '/products/399/format_options');
    assert.match(result.error, /400 of 400 items/);
    assert.ok(result.error.length < 200);
  });

  test('treats null items, primitive items, and inherited fields as missing', () => {
    const result = grade({ products: [null, false, Object.create({ format_options: [] })] });
    assert.equal(result.passed, false);
    assert.deepEqual(result.actual, [
      '/products/0/format_options',
      '/products/1/format_options',
      '/products/2/format_options',
    ]);
  });

  for (const [name, data] of [
    ['empty', { products: [] }],
    ['absent', {}],
    ['null', { products: null }],
  ]) {
    test(`grades an ${name} array not_applicable before advisory promotion`, () => {
      const result = grade(data, { severity: 'advisory', expires_after_version: '1.0.0' });
      assert.equal(result.passed, true);
      assert.equal(result.not_applicable, true);
      assert.match(result.note, /products/);
      assert.equal(result.id, validation.id);
      assert.equal(result.severity, 'advisory');
      assert.equal(result.severity_promoted_from_advisory, undefined);
    });
  }

  for (const products of [{}, 'products', false, 0]) {
    test(`fails for a non-array value: ${JSON.stringify(products)}`, () => {
      const result = grade({ products });
      assert.equal(result.passed, false);
      assert.equal(result.not_applicable, undefined);
      assert.equal(result.expected, 'array');
      assert.equal(result.actual, products);
      assert.equal(result.json_pointer, '/products');
    });
  }

  for (const path of [
    undefined,
    'products',
    'products[*]',
    'products[*].',
    'products[*]..',
    'products[*].[0]',
    '.[*].format_options',
    `products[*].${'x'.repeat(1025)}`,
    'products[].format_options',
    'products[*].format_options[*].id',
    'products[*].format_options[]',
  ]) {
    test(`rejects an authored path without exactly one [*] and a field: ${path?.slice(0, 60)}`, () => {
      const result = grade({ products: [] }, { path });
      assert.equal(result.passed, false);
      assert.equal(result.not_applicable, undefined);
      assert.match(result.error, /exactly one \[\*\]/);
    });
  }
});

describe('all_fields_present runner output', () => {
  const storyboard = {
    id: 'format_options_compatibility',
    version: '1.0',
    title: 'Format options compatibility',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'discovery',
        title: 'Discovery',
        steps: ['get_products_brief', 'get_products_brief_buyer_selected_timezone'].map(id => ({
          id,
          title: id,
          task: 'get_products',
          validations: [
            {
              ...validation,
              severity: 'advisory',
              permanent_advisory: { reason: 'AdCP 4.0 compatibility signal' },
            },
          ],
        })),
      },
    ],
  };
  const profile = { name: 'Test agent', tools: ['get_products'] };

  for (const [name, data, passed, notApplicable] of [
    ['canonical fields', { products: [{ format_options: [] }] }, true, false],
    ['legacy fields only', { products: [{ format_ids: [] }] }, false, false],
    ['empty array', { products: [] }, true, true],
    ['absent array', {}, true, true],
    ['null array', { products: null }, true, true],
  ]) {
    test(`grades and counts ${name} without changing advisory step outcomes`, async () => {
      const result = await runStoryboard('https://example.test/mcp', storyboard, {
        protocol: 'mcp',
        _client: { executeTask: async () => ({ success: true, data }) },
        _profile: profile,
        agentTools: profile.tools,
      });
      assert.equal(result.overall_passed, true);
      assert.equal(result.failed_count, 0);
      assert.equal(result.validations_not_applicable ?? 0, notApplicable ? 2 : 0);
      assert.equal(result.validations_advisory_failed ?? 0, passed ? 0 : 2);
      for (const step of result.phases[0].steps) {
        const check = step.validations.find(v => v.check === 'all_fields_present');
        assert.equal(check.id, validation.id);
        assert.equal(check.passed, passed);
        assert.equal(check.not_applicable ?? false, notApplicable);
        assert.equal(check.severity, 'advisory');
        assert.equal(check.severity_promoted_from_advisory, undefined);
      }
    });
  }
});
