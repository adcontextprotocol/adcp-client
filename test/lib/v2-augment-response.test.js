// withFormatOptions / augmentProductWithFormatOptions — buyer-side
// augmentation of v1 get_products responses with v2 format_options[].

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { existsSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { withFormatOptions, augmentProductWithFormatOptions } = require('../../dist/lib/v2/projection/index.js');
const { loadCatalog, _resetCatalogCache } = require('../../dist/lib/v2/projection/catalog.js');

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

  test('fails closed when inline discriminators contradict fixed catalog requirements', () => {
    for (const formatId of [
      {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'display_320x50_html',
        width: 728,
        height: 90,
      },
      {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'audio_30s',
        duration_ms: 15000,
      },
    ]) {
      const { product, diagnostics } = augmentProductWithFormatOptions({
        product_id: `conflict_${formatId.id}`,
        name: 'n',
        description: 'd',
        format_ids: [formatId],
      });
      assert.deepStrictEqual(product.format_options, []);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
      assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'catalog_requirement_conflict');
    }
  });

  test('projects parameterized generic aliases from inline discriminators', () => {
    for (const [formatId, kind, expectedParams] of [
      [
        {
          agent_url: 'https://creative.adcontextprotocol.org/',
          id: 'display_static',
          width: 320,
          height: 50,
        },
        'image',
        { width: 320, height: 50 },
      ],
      [
        {
          agent_url: 'https://creative.adcontextprotocol.org/',
          id: 'video_hosted',
          duration_ms: 30000,
        },
        'video_hosted',
        { duration_ms_exact: 30000 },
      ],
    ]) {
      const { product, diagnostics } = augmentProductWithFormatOptions({
        product_id: `parameterized_${formatId.id}`,
        name: 'n',
        description: 'd',
        format_ids: [formatId],
      });
      assert.deepStrictEqual(diagnostics, []);
      assert.strictEqual(product.format_options.length, 1);
      assert.strictEqual(product.format_options[0].format_kind, kind);
      assert.deepStrictEqual(product.format_options[0].params, expectedParams);
    }
  });

  test('fails closed on malformed inline discriminators', () => {
    for (const formatId of [
      {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'display_static',
        width: 320,
      },
      {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'display_static',
        width: 0,
        height: 50,
      },
      {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'video_hosted',
        duration_ms: 0,
      },
    ]) {
      const { product, diagnostics } = augmentProductWithFormatOptions({
        product_id: `malformed_${formatId.id}`,
        name: 'n',
        description: 'd',
        format_ids: [formatId],
      });
      assert.deepStrictEqual(product.format_options, []);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
      assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'invalid_format_id_parameters');
    }
  });

  test('fails closed when a catalog entry contains conflicting fixed requirements', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adcp-conflicting-catalog-'));
    const catalogPath = path.join(dir, 'catalog.json');
    writeFileSync(
      catalogPath,
      JSON.stringify([
        {
          format_id: {
            agent_url: 'https://creative.adcontextprotocol.org/',
            id: 'conflicting_display',
          },
          canonical: { kind: 'html5' },
          renders: [
            { role: 'primary', dimensions: { width: 320, height: 50 } },
            { role: 'alternate', dimensions: { width: 728, height: 90 } },
          ],
        },
        {
          format_id: {
            agent_url: 'https://creative.adcontextprotocol.org/',
            id: 'conflicting_audio',
          },
          canonical: { kind: 'audio_hosted' },
          assets: [
            { requirements: { min_duration_ms: 30000, max_duration_ms: 30000 } },
            { requirements: { min_duration_ms: 15000, max_duration_ms: 30000 } },
          ],
        },
        {
          format_id: {
            agent_url: 'https://creative.adcontextprotocol.org/',
            id: 'partial_dimensions',
          },
          canonical: { kind: 'html5' },
          assets: [{ requirements: { width: 320 } }],
        },
        {
          format_id: {
            agent_url: 'https://creative.adcontextprotocol.org/',
            id: 'fractional_duration',
          },
          canonical: { kind: 'audio_hosted' },
          assets: [{ requirements: { min_duration_ms: 30000.5, max_duration_ms: 30000.5 } }],
        },
      ])
    );
    _resetCatalogCache();
    loadCatalog(catalogPath);
    try {
      for (const id of ['conflicting_display', 'conflicting_audio', 'partial_dimensions', 'fractional_duration']) {
        const { product, diagnostics } = augmentProductWithFormatOptions({
          product_id: `catalog_${id}`,
          name: 'n',
          description: 'd',
          format_ids: [
            {
              agent_url: 'https://creative.adcontextprotocol.org/',
              id,
            },
          ],
        });
        assert.deepStrictEqual(product.format_options, []);
        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'catalog_requirement_conflict');
      }
    } finally {
      _resetCatalogCache();
      rmSync(dir, { recursive: true, force: true });
    }
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
