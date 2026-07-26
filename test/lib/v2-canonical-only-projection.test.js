// toCanonicalOnlyProduct / toCanonicalOnlyResponse — read-side canonical
// narrowing. Returns format_options[] with format_ids[] DROPPED, and the
// guarantee that dropping legacy never silently loses a format: every input
// format_id is either represented in format_options[] or surfaced in
// diagnostics.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

const {
  toCanonicalOnlyProduct,
  toCanonicalOnlyResponse,
  augmentProductWithFormatOptions,
} = require('../../dist/lib/v2/projection/index.js');

const CATALOG_PATH = path.join(__dirname, 'v2-projection-fixtures', 'aao-reference-formats.json');
// v1-path cases project via the catalog and (for unmappable ids) the
// registry, which loadRegistry() throws on when absent.
const DIST_SCHEMAS = path.join(__dirname, '..', '..', 'dist', 'lib', 'schemas-data');
const SRC_CACHE = path.join(__dirname, '..', '..', 'schemas', 'cache');
const REGISTRY_PRESENT = [DIST_SCHEMAS, SRC_CACHE].some(
  root =>
    existsSync(root) &&
    readdirSync(root).some(v => existsSync(path.join(root, v, 'registries', 'v1-canonical-mapping.json')))
);
const SKIP_REASON =
  existsSync(CATALOG_PATH) && REGISTRY_PRESENT
    ? false
    : 'requires the vendored AAO catalog + a v1-canonical-mapping registry (run npm run build:lib)';

const AAO = 'https://creative.adcontextprotocol.org/';
const REPORTING_CAPABILITIES = {
  available_reporting_frequencies: ['daily'],
  expected_delay_minutes: 60,
  timezone: 'UTC',
  supports_webhooks: false,
  available_metrics: ['impressions'],
  date_range_support: 'date_range',
};

describe('toCanonicalOnlyProduct', { skip: SKIP_REASON }, () => {
  test('v1-shaped product: drops format_ids, adds format_options, no loss for mappable ids', () => {
    const v1 = {
      product_id: 'p1',
      name: 'Homepage MREC',
      description: 'IAB MREC',
      format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
    };
    const { product, diagnostics } = toCanonicalOnlyProduct(v1);
    assert.strictEqual('format_ids' in product, false, 'format_ids must be dropped');
    assert.strictEqual(product.format_options.length, 1);
    assert.strictEqual(product.format_options[0].format_kind, 'image');
    assert.deepStrictEqual(diagnostics, []);
  });

  test('preserves non-format fields verbatim', () => {
    const v1 = {
      product_id: 'p_keep',
      name: 'N',
      description: 'D',
      pricing_options: [{ pricing_option_id: 'po1' }],
      format_ids: [{ agent_url: AAO, id: 'video_vast_30s' }],
    };
    const { product } = toCanonicalOnlyProduct(v1);
    assert.deepStrictEqual(product.pricing_options, [{ pricing_option_id: 'po1' }]);
    assert.strictEqual(product.name, 'N');
  });

  test('v1-shaped with an unmappable ref: dropped ref is FLAGGED, never silently lost', () => {
    const v1 = {
      product_id: 'p2',
      name: 'N',
      description: 'D',
      format_ids: [
        { agent_url: AAO, id: 'display_300x250_image' }, // maps -> image
        { agent_url: 'https://bespoke.example/', id: 'totally_custom_xyz' }, // no mapping
      ],
    };
    const { product, diagnostics } = toCanonicalOnlyProduct(v1);
    assert.strictEqual('format_ids' in product, false);
    assert.strictEqual(product.format_options.length, 1, 'only the mappable ref becomes an option');
    assert.strictEqual(diagnostics.length, 1, 'the unmappable ref is surfaced');
    assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
    assert.strictEqual(diagnostics[0].source, 'sdk');
  });

  test('v2-native product with fully-covered format_ids: drops them, no diagnostics', () => {
    const v2 = {
      product_id: 'p3',
      name: 'N',
      description: 'D',
      format_options: [
        { format_kind: 'image', params: {}, v1_format_ref: [{ agent_url: 'https://x/', id: 'covered' }] },
      ],
      format_ids: [{ agent_url: 'https://x/', id: 'covered' }],
    };
    const { product, diagnostics } = toCanonicalOnlyProduct(v2);
    assert.strictEqual('format_ids' in product, false);
    assert.strictEqual(product.format_options.length, 1);
    assert.deepStrictEqual(diagnostics, []);
  });

  test('v2-native product with an orphan format_id: drops it but emits LEGACY_FORMAT_ID_DROPPED_UNMAPPED', () => {
    const v2 = {
      product_id: 'p4',
      name: 'N',
      description: 'D',
      format_options: [
        { format_kind: 'image', params: {}, v1_format_ref: [{ agent_url: 'https://x/', id: 'covered' }] },
      ],
      format_ids: [
        { agent_url: 'https://x/', id: 'covered' },
        { agent_url: 'https://x/', id: 'orphan' },
      ],
    };
    const { product, diagnostics } = toCanonicalOnlyProduct(v2);
    assert.strictEqual('format_ids' in product, false);
    assert.strictEqual(diagnostics.length, 1);
    const diag = diagnostics[0];
    assert.strictEqual(diag.code, 'LEGACY_FORMAT_ID_DROPPED_UNMAPPED');
    // Full diagnostic envelope (ProjectionDiagnosticBase contract).
    assert.strictEqual(diag.source, 'sdk');
    assert.match(diag.sdk_id, /^@adcp\/sdk@/);
    assert.strictEqual(diag.field, 'products[p4].format_options');
    assert.strictEqual(diag.error.details.resolution_failure, 'unmapped_legacy_format');
    assert.strictEqual(JSON.stringify(diag).includes('https://x/'), false);
    assert.strictEqual(diag.error.details.product_id, 'p4');
  });

  test('multi-size: a sized format_id no v1_format_ref covers is FLAGGED, not collapsed by id', () => {
    // v1_format_ref covers 300x250; format_ids also carries 728x90 under the
    // SAME {agent_url, id}. Keying on agent_url::id alone would mark 728x90
    // "covered" and silently drop it. The coverage key must include size.
    const v2 = {
      product_id: 'p_multisize',
      name: 'N',
      description: 'D',
      format_options: [
        {
          format_kind: 'image',
          params: {},
          v1_format_ref: [{ agent_url: 'https://x/', id: 'banner', width: 300, height: 250 }],
        },
      ],
      format_ids: [
        { agent_url: 'https://x/', id: 'banner', width: 300, height: 250 },
        { agent_url: 'https://x/', id: 'banner', width: 728, height: 90 },
      ],
    };
    const { diagnostics } = toCanonicalOnlyProduct(v2);
    assert.strictEqual(diagnostics.length, 1, 'the uncovered 728x90 size must be surfaced');
    assert.strictEqual(diagnostics[0].code, 'LEGACY_FORMAT_ID_DROPPED_UNMAPPED');
    assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'unmapped_legacy_format');
    assert.strictEqual(JSON.stringify(diagnostics[0]).includes('agent_url'), false);
  });

  test('v2-native with empty format_options[] and populated format_ids: flags every dropped ref', () => {
    const v2 = {
      product_id: 'p_empty',
      name: 'N',
      description: 'D',
      format_options: [],
      format_ids: [
        { agent_url: 'https://x/', id: 'a' },
        { agent_url: 'https://x/', id: 'b' },
      ],
    };
    const { product, diagnostics } = toCanonicalOnlyProduct(v2);
    assert.strictEqual('format_ids' in product, false);
    assert.deepStrictEqual(product.format_options, []);
    assert.strictEqual(diagnostics.length, 2, 'both refs dropped with nothing to cover them');
    assert.ok(diagnostics.every(d => d.code === 'LEGACY_FORMAT_ID_DROPPED_UNMAPPED'));
  });

  test('v2-native coverage check is trailing-slash insensitive', () => {
    const v2 = {
      product_id: 'p7',
      name: 'N',
      description: 'D',
      format_options: [
        { format_kind: 'image', params: {}, v1_format_ref: [{ agent_url: 'https://x', id: 'covered' }] },
      ],
      format_ids: [{ agent_url: 'https://x/', id: 'covered' }],
    };
    const { diagnostics } = toCanonicalOnlyProduct(v2);
    assert.deepStrictEqual(diagnostics, [], 'https://x and https://x/ are the same agent');
  });

  test('neither shape: empty format_options, no format_ids, no diagnostics', () => {
    const { product, diagnostics } = toCanonicalOnlyProduct({ product_id: 'p5', name: 'N', description: 'D' });
    assert.strictEqual('format_ids' in product, false);
    assert.deepStrictEqual(product.format_options, []);
    assert.deepStrictEqual(diagnostics, []);
  });

  test('valid format-agnostic format_ids:[] product is omitted with an honest portable error', () => {
    const response = {
      products: [{ product_id: 'format-agnostic', name: 'N', description: 'D', format_ids: [] }],
    };
    const { response: canonical, diagnostics } = toCanonicalOnlyResponse(response);
    assert.deepStrictEqual(canonical.products, []);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(canonical.errors.length, 1);
    assert.strictEqual(canonical.errors[0].code, 'CANONICAL_PRODUCT_FORMATS_UNAVAILABLE');
    assert.strictEqual(canonical.errors[0].source, 'sdk');
    assert.strictEqual(canonical.errors[0].details.product_id, 'format-agnostic');
    assert.strictEqual(canonical.errors[0].details.reason, 'legacy_format_list_empty');
    assert.strictEqual(canonical.errors[0].error, undefined, 'protocol Error details are top-level');
    assert.match(canonical.errors[0].message, /canonical-only surface/);
  });

  test('composition: augmentProductWithFormatOptions then toCanonicalOnlyProduct round-trips cleanly', () => {
    // The highest-value real-world path: augment a v1 seller product (adds
    // format_options[] with echoed v1_format_ref, keeps format_ids[]), then
    // narrow to canonical-only. The echoed refs must cover the kept format_ids,
    // so the narrowing drops them with ZERO diagnostics.
    const v1 = {
      product_id: 'p_compose',
      name: 'N',
      description: 'D',
      format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
    };
    const { product: augmented } = augmentProductWithFormatOptions(v1);
    assert.strictEqual('format_ids' in augmented, true, 'augment preserves format_ids (additive)');
    const { product, diagnostics } = toCanonicalOnlyProduct(augmented);
    assert.strictEqual('format_ids' in product, false, 'narrowing drops format_ids');
    assert.strictEqual(product.format_options.length, 1);
    assert.deepStrictEqual(diagnostics, [], 'echoed v1_format_ref covers the kept format_ids — no loss');
  });
});

describe('toCanonicalOnlyResponse', { skip: SKIP_REASON }, () => {
  test('drops format_ids, omits wholly unmappable products, and augments portable errors', async () => {
    const response = {
      adcp_version: '3.1.0',
      products: [
        {
          product_id: 'a',
          name: 'N',
          description: 'D',
          publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
          delivery_type: 'non_guaranteed',
          pricing_options: [{ pricing_option_id: 'po', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
          reporting_capabilities: REPORTING_CAPABILITIES,
          format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
        },
        {
          product_id: 'b',
          name: 'N',
          description: 'D',
          publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
          delivery_type: 'non_guaranteed',
          pricing_options: [{ pricing_option_id: 'po', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
          reporting_capabilities: REPORTING_CAPABILITIES,
          format_ids: [{ agent_url: 'https://bespoke.example/', id: 'nope' }],
        },
      ],
    };
    const { response: out, diagnostics } = toCanonicalOnlyResponse(response);
    assert.strictEqual(out.adcp_version, '3.1.0', 'response envelope fields preserved');
    assert.strictEqual(out.products.length, 1, 'only protocol-valid canonical products remain');
    assert.strictEqual(out.products[0].product_id, 'a');
    assert.strictEqual(
      out.products.some(p => 'format_ids' in p),
      false,
      'no product retains format_ids'
    );
    assert.strictEqual(diagnostics.length, 1, 'the one unmappable ref is surfaced');
    assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
    assert.strictEqual(diagnostics[0].field, 'products');
    assert.strictEqual(out.errors.length, 1);
    assert.strictEqual(out.errors[0].code, 'FORMAT_PROJECTION_FAILED');
    assert.strictEqual(out.errors[0].details.product_id, 'b');
    assert.strictEqual(out.errors[0].error, undefined);
    const { ProductSchema } = await import('../../dist/lib/types/schemas.generated.js');
    assert.ok(out.products.every(product => ProductSchema.safeParse(product).success));
  });

  test('retains partially mappable products, preserves seller errors, and deduplicates projection errors', () => {
    const duplicate = {
      code: 'FORMAT_PROJECTION_FAILED',
      message: 'Already observed upstream',
      field: 'products[0].format_options',
      details: {
        format_kind: 'custom',
        product_id: 'mixed',
        resolution_failure: 'no_match',
      },
    };
    const materiallyDifferent = {
      code: 'FORMAT_PROJECTION_FAILED',
      message: 'Different failure at the same field',
      field: 'products[0].format_options',
      details: {
        format_kind: 'custom',
        product_id: 'mixed',
        resolution_failure: 'custom_converter_failed',
      },
    };
    const response = {
      errors: [duplicate, materiallyDifferent],
      products: [
        {
          product_id: 'mixed',
          name: 'Mixed',
          description: 'One known and one custom legacy ref',
          format_ids: [
            { agent_url: AAO, id: 'display_300x250_image' },
            { agent_url: 'https://bespoke.example/', id: 'nope' },
          ],
        },
      ],
    };
    const { response: out, diagnostics } = toCanonicalOnlyResponse(response);
    assert.strictEqual(out.products.length, 1);
    assert.strictEqual(out.products[0].format_options.length, 1);
    assert.strictEqual(diagnostics.length, 1);
    assert.deepStrictEqual(
      out.errors,
      [duplicate, materiallyDifferent],
      'only details-equivalent entries dedupe; materially different failures survive'
    );
  });

  test('remaps kept-product pointers after earlier omissions and uses collection pointers for dropped products', () => {
    const response = {
      errors: [
        {
          code: 'SELLER_DROP',
          message: 'drop',
          field: 'products[0].name',
          issues: [{ pointer: '/products/0/name', message: 'drop' }],
        },
        {
          code: 'SELLER_KEEP',
          message: 'keep',
          field: 'products[1].name',
          issues: [{ pointer: '/products/1/name', message: 'keep' }],
        },
      ],
      products: [
        {
          product_id: 'dropped',
          name: 'Dropped',
          description: 'No canonical mapping',
          format_ids: [{ agent_url: 'https://bespoke.example/', id: 'drop_me' }],
        },
        {
          product_id: 'partial',
          name: 'Partial',
          description: 'One canonical mapping remains',
          format_ids: [
            { agent_url: AAO, id: 'display_300x250_image' },
            { agent_url: 'https://bespoke.example/', id: 'keep_diagnostic' },
          ],
        },
      ],
    };
    const { response: out, diagnostics } = toCanonicalOnlyResponse(response);
    assert.deepStrictEqual(
      out.products.map(product => product.product_id),
      ['partial']
    );
    assert.strictEqual(diagnostics[0].field, 'products');
    assert.strictEqual(diagnostics[0].error.details.product_id, 'dropped');
    assert.strictEqual(diagnostics[1].field, 'products[0].format_options');
    assert.strictEqual(diagnostics[1].error.details.product_id, 'partial');
    assert.strictEqual(out.errors[0].field, 'products');
    assert.strictEqual(out.errors[0].issues[0].pointer, '/products');
    assert.strictEqual(out.errors[0].details.product_id, 'dropped');
    assert.strictEqual(out.errors[1].field, 'products[0].name');
    assert.strictEqual(out.errors[1].issues[0].pointer, '/products/0/name');
  });

  test('response with no products array: empty products, no diagnostics', () => {
    const { response, diagnostics } = toCanonicalOnlyResponse({ adcp_version: '3.1.0' });
    assert.deepStrictEqual(response.products, []);
    assert.deepStrictEqual(diagnostics, []);
  });

  test('strips legacy identifiers from nested placement declarations', () => {
    const { product } = toCanonicalOnlyProduct({
      product_id: 'nested',
      name: 'Nested',
      description: 'Nested placement formats',
      format_options: [{ format_kind: 'image', params: {} }],
      placements: [
        {
          kind: 'seller_inline',
          placement_id: 'hero',
          name: 'Hero',
          mode: 'targetable',
          format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
          format_options: [
            {
              format_kind: 'image',
              params: {},
              v1_format_ref: [{ agent_url: AAO, id: 'display_300x250_image' }],
            },
          ],
        },
      ],
    });
    assert.strictEqual(product.placements[0].format_ids, undefined);
    assert.strictEqual(product.placements[0].format_options[0].v1_format_ref, undefined);
    assert.doesNotMatch(JSON.stringify(product), /agent_url|format_id/);
  });

  test('projects legacy-only nested placements and surfaces unmapped placement diagnostics', () => {
    const { product, diagnostics } = toCanonicalOnlyProduct({
      product_id: 'nested-legacy-only',
      name: 'Nested legacy only',
      description: 'Every placement ref must convert or diagnose',
      format_options: [{ format_kind: 'image', params: {} }],
      placements: [
        {
          kind: 'seller_inline',
          placement_id: 'known',
          name: 'Known',
          mode: 'targetable',
          format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
        },
        {
          kind: 'seller_inline',
          placement_id: 'unknown',
          name: 'Unknown',
          mode: 'targetable',
          format_ids: [{ agent_url: 'https://custom.example/formats', id: 'unmapped_takeover' }],
        },
      ],
    });

    assert.strictEqual(product.placements[0].format_options[0].format_kind, 'image');
    assert.strictEqual(product.placements[0].format_ids, undefined);
    assert.strictEqual(product.placements[1].format_ids, undefined);
    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].field, /products\[nested-legacy-only\]\.placements\[1\]/);
    assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
    assert.doesNotMatch(JSON.stringify({ product, diagnostics }), /unmapped_takeover|custom\.example/);
  });
});
