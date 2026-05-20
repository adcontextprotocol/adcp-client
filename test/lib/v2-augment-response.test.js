// withFormatOptions / augmentProductWithFormatOptions — buyer-side
// augmentation of v1 get_products responses with v2 format_options[].

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const { withFormatOptions, augmentProductWithFormatOptions } = require('../../dist/lib/v2/projection/index.js');

const CATALOG_PATH = path.join(__dirname, 'v2-projection-fixtures', 'aao-reference-formats.json');
const SKIP_REASON = existsSync(CATALOG_PATH)
  ? false
  : 'requires test/lib/v2-projection-fixtures/aao-reference-formats.json';

describe('augmentProductWithFormatOptions', { skip: SKIP_REASON }, () => {
  test('v1 product gains format_options[] derived from format_ids[]', () => {
    const v1Product = {
      product_id: 'aug_display',
      name: 'Display banner',
      description: 'IAB MREC',
      format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
    };
    const { product, diagnostics } = augmentProductWithFormatOptions(v1Product);
    // Preserves format_ids (additive).
    assert.deepStrictEqual(product.format_ids, v1Product.format_ids);
    // Adds format_options.
    assert.strictEqual(product.format_options.length, 1);
    assert.strictEqual(product.format_options[0].format_kind, 'image');
    // v1_format_ref carries the source id back.
    assert.deepStrictEqual(product.format_options[0].v1_format_ref, [v1Product.format_ids[0]]);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('idempotent — already-v2 product passes through unchanged', () => {
    const v2Product = {
      product_id: 'native_v2',
      name: 'Native',
      description: 'v2 native',
      format_ids: [],
      format_options: [{ format_kind: 'image', params: { width: 1080, height: 1080 } }],
    };
    const { product, diagnostics } = augmentProductWithFormatOptions(v2Product);
    assert.strictEqual(product, v2Product, 'returns the same object reference (no re-wrap)');
    assert.strictEqual(diagnostics.length, 0);
  });

  test('product with neither format_ids nor format_options gets an empty format_options', () => {
    const naked = { product_id: 'bare', name: 'n', description: 'd' };
    const { product, diagnostics } = augmentProductWithFormatOptions(naked);
    assert.deepStrictEqual(product.format_options, []);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('surfaces projection diagnostics when format_id has no v2 mapping', () => {
    const v1Product = {
      product_id: 'unknown',
      name: 'n',
      description: 'd',
      format_ids: [{ agent_url: 'https://obscure.example/', id: 'mystery_format_xyz' }],
    };
    const { product, diagnostics } = augmentProductWithFormatOptions(v1Product);
    assert.strictEqual(product.format_options.length, 0);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
    assert.strictEqual(diagnostics[0].source, 'sdk');
  });
});

describe('withFormatOptions — get_products response', { skip: SKIP_REASON }, () => {
  test('augments every product in the response and aggregates diagnostics', () => {
    const v1Response = {
      products: [
        {
          product_id: 'good',
          name: 'g',
          description: 'd',
          format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
        },
        {
          product_id: 'bad',
          name: 'b',
          description: 'd',
          format_ids: [{ agent_url: 'https://obscure.example/', id: 'mystery_xyz' }],
        },
      ],
    };
    const { response, diagnostics } = withFormatOptions(v1Response);
    assert.strictEqual(response.products.length, 2);
    assert.strictEqual(response.products[0].format_options.length, 1);
    assert.strictEqual(response.products[1].format_options.length, 0);
    assert.strictEqual(diagnostics.length, 1);
    assert.ok(diagnostics[0].field.includes('bad'), 'diagnostic field carries the failing product_id');
  });

  test('passes through a v2-native response without re-projecting', () => {
    const v2Response = {
      products: [
        {
          product_id: 'native_v2',
          name: 'n',
          description: 'd',
          format_ids: [],
          format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
        },
      ],
    };
    const { response, diagnostics } = withFormatOptions(v2Response);
    assert.strictEqual(diagnostics.length, 0);
    assert.strictEqual(response.products[0].format_options[0].format_kind, 'image');
    // Same reference for the unchanged product.
    assert.strictEqual(response.products[0], v2Response.products[0]);
  });

  test('handles missing products array gracefully', () => {
    const empty = {};
    const { response, diagnostics } = withFormatOptions(empty);
    assert.deepStrictEqual(response.products, []);
    assert.strictEqual(diagnostics.length, 0);
  });
});
