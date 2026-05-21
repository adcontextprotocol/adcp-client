// Exercise the v2 → v1 projection layer against the 13 reference
// fixtures from adcontextprotocol/adcp#3307
// (static/examples/products/canonical/). These fixtures span the full
// canonical-format catalog: image, html5, display_tag, image_carousel,
// video_hosted (×2), video_vast, audio_hosted, audio_daast,
// sponsored_placement, responsive_creative, agent_placement, custom.
//
// Tests align with the normative rules in
// `core/registries/v1-canonical-mapping.json` (direction-of-truth
// statement + step-5 ambiguous family rule) and the `v1_translatable`
// field on canonical schemas. SDK-local diagnostic codes
// (`FORMAT_DECLARATION_V1_NOT_APPLICABLE`, `CANONICAL_NOT_V1_TRANSLATABLE`)
// surface cases the spec leaves to SDK discretion.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const path = require('node:path');

const { projectV2ProductToV1 } = require('../../dist/lib/v2/projection/v2-to-v1.js');

const FIXTURE_DIR = path.join(__dirname, 'v2-projection-fixtures');

// The projection layer reads the v1-canonical-mapping registry and the
// canonical-format schemas (for v1_translatable). Both live under
// `schemas/cache/<3.1+>/` — CI now syncs `3.1.0-beta.1` via
// `npm run sync-schemas:3.1-beta`; the loader (registry.ts) tracks
// whichever 3.1 beta the workspace has.
const SCHEMAS_CACHE_ROOT = path.join(__dirname, '..', '..', 'schemas', 'cache');
const REGISTRY_EXISTS = ['3.1.0-beta.2', '3.1.0-beta.1', '3.1.0-beta.0', 'latest'].some(v =>
  existsSync(path.join(SCHEMAS_CACHE_ROOT, v, 'registries', 'v1-canonical-mapping.json'))
);
const SKIP_REASON = REGISTRY_EXISTS
  ? false
  : 'requires a 3.1+ schemas/cache/<beta>/ — only present in workspaces with a local 3.1-beta sync';

function loadFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      name: f.replace(/\.json$/, ''),
      product: JSON.parse(readFileSync(path.join(FIXTURE_DIR, f), 'utf-8')),
    }))
    .filter(({ product }) => Array.isArray(product?.format_options));
}

describe('v2 → v1 Product projection — per-fixture structural invariant', { skip: SKIP_REASON }, () => {
  for (const { name, product } of loadFixtures()) {
    test(name, () => {
      const { v1, diagnostics } = projectV2ProductToV1(product);
      assert.strictEqual(v1.product_id, product.product_id);
      // Every input declaration produces AT LEAST ONE of (v1 emit,
      // diagnostic). May produce both: a multi-size v2 declaration
      // emits a single v1 format_id (the representative size) AND a
      // FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE advisory so the buyer
      // knows N-1 sizes were dropped on the v1 wire.
      const declCount = product.format_options.length;
      assert.ok(
        v1.format_ids.length + diagnostics.length >= declCount,
        `every format_options[i] must produce at least one of (v1 emit, diagnostic); ` +
          `emits=${v1.format_ids.length} diagnostics=${diagnostics.length} declCount=${declCount}`
      );
      // Every diagnostic must carry the spec-mandated source + sdk_id.
      for (const d of diagnostics) {
        assert.strictEqual(d.source, 'sdk');
        assert.match(d.sdk_id, /^@adcp\/sdk@\d+\.\d+\.\d+/);
        assert.ok(d.field.includes(product.product_id), 'field must point at offending declaration');
      }
    });
  }
});

describe('v2 → v1 projection — seller-asserted v1_format_ref (the only normative path)', { skip: SKIP_REASON }, () => {
  // After the publisher-scoped format catalog landed (adcp commit
  // e2fae6b086), publisher-specific formats live at the AAO community
  // mirror under `creative.adcontextprotocol.org/translated/<publisher>`
  // until the publisher adopts adagents.json#/formats themselves.
  // Each fixture below is single-size (fixed width+height) so the
  // projection produces ZERO diagnostics. The multi-size case is
  // covered by the dedicated nytimes_homepage_flex_display test below.
  const sellerAsserted = [
    ['nytimes_homepage_html5', 'https://creative.adcontextprotocol.org/', 'display_300x250_html'],
    ['gam_3p_display_tag', 'https://creative.adcontextprotocol.org/', 'display_js'],
    ['youtube_vast_preroll', 'https://creative.adcontextprotocol.org/', 'video_vast_30s'],
    ['meta_reels_us', 'https://creative.adcontextprotocol.org/translated/meta', 'meta_reels'],
  ];

  for (const [fixture, expectedAgentUrl, expectedId] of sellerAsserted) {
    test(`${fixture} projects via v1_format_ref → ${expectedId}`, () => {
      const product = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${fixture}.json`), 'utf-8'));
      const { v1, diagnostics } = projectV2ProductToV1(product);
      assert.strictEqual(diagnostics.length, 0, `expected zero diagnostics; got ${JSON.stringify(diagnostics)}`);
      assert.strictEqual(v1.format_ids.length, 1);
      assert.strictEqual(v1.format_ids[0].agent_url, expectedAgentUrl);
      assert.strictEqual(v1.format_ids[0].id, expectedId);
    });
  }
});

describe('v2 → v1 projection — multi-size full-coverage (seller asserts ref-per-size)', { skip: SKIP_REASON }, () => {
  // The flex-display fixture has 3 format_options (image / html5 /
  // display_tag), each declaring `sizes: [3]` AND `v1_format_ref: [3]`
  // — the seller has asserted one ref per size, the spec's preferred
  // shape. With full seller coverage, the projection emits all refs
  // verbatim and emits NO lossy advisory (refs.length >= sizes.length).
  test('nytimes_homepage_flex_display: seller refs cover all sizes (clean emit, no advisory)', () => {
    const product = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'nytimes_homepage_mrec.json'), 'utf-8'));
    const { v1, diagnostics } = projectV2ProductToV1(product);
    assert.strictEqual(product.product_id, 'nytimes_homepage_flex_display');
    assert.strictEqual(product.format_options.length, 3);

    // 3 refs × 3 format_options = 9 v1 emits; no advisories.
    assert.strictEqual(v1.format_ids.length, 9, '3 refs × 3 format_options = 9 total emits');
    assert.strictEqual(diagnostics.length, 0, 'seller refs cover all sizes; no lossy advisory needed');
  });

  // Synthetic fixture: seller asserts ONE ref for a 3-size declaration.
  // SDK fans out via catalog lookup AND emits the lossy advisory so the
  // buyer knows partial coverage was inferred (not seller-asserted).
  test('partial-coverage (refs=1, sizes=3): fan-out + lossy advisory', () => {
    const product = {
      product_id: 'synthetic_partial_multi_size',
      name: 'synthetic partial multi-size',
      description: 'seller asserts one ref; SDK fans the rest via catalog',
      format_options: [
        {
          format_kind: 'image',
          v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
          params: {
            sizes: [
              { width: 300, height: 250 },
              { width: 728, height: 90 },
              { width: 970, height: 250 },
            ],
          },
        },
      ],
    };
    const { v1, diagnostics } = projectV2ProductToV1(product);
    // Catalog should fan out to 3 sized image entries.
    assert.strictEqual(v1.format_ids.length, 3, 'SDK fan-out widens 1 seller ref to 3 catalog entries');
    assert.strictEqual(diagnostics.length, 1, 'partial seller coverage triggers advisory');
    assert.strictEqual(diagnostics[0].code, 'FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE');
    assert.strictEqual(diagnostics[0].error.details.declared_sizes_count, 3);
    assert.strictEqual(diagnostics[0].error.details.emitted_sizes_count, 3);
  });
});

describe('v2 → v1 projection — canonical_formats_only opt-out', { skip: SKIP_REASON }, () => {
  // Two fixtures use this now: the NYTimes custom takeover (no v1 form
  // possible — multi-placement) and triton_daast (catalog has no DAAST
  // entry yet, so the seller opted out rather than fabricating an id).
  const optOuts = [
    ['nytimes_homepage_takeover_custom', 'custom'],
    ['triton_daast_audio_30s', 'audio_daast'],
  ];
  for (const [fixture, kind] of optOuts) {
    test(`${fixture} (${kind}) emits FORMAT_DECLARATION_V1_NOT_APPLICABLE`, () => {
      const product = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${fixture}.json`), 'utf-8'));
      const { v1, diagnostics } = projectV2ProductToV1(product);
      assert.strictEqual(v1.format_ids.length, 0);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].code, 'FORMAT_DECLARATION_V1_NOT_APPLICABLE');
      assert.strictEqual(diagnostics[0].error.details.reason, 'canonical_formats_only');
    });
  }
});

describe('v2 → v1 projection — v1_translatable: false (4 inherently-v2 canonicals)', { skip: SKIP_REASON }, () => {
  const inherentlyV2 = [
    ['amazon_sponsored_products', 'sponsored_placement'],
    ['chatgpt_brand_mention', 'agent_placement'],
    ['google_performance_max', 'responsive_creative'],
    ['meta_carousel', 'image_carousel'],
  ];

  for (const [fixture, kind] of inherentlyV2) {
    test(`${fixture} (${kind}) emits CANONICAL_NOT_V1_TRANSLATABLE (not FORMAT_PROJECTION_FAILED)`, () => {
      const product = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${fixture}.json`), 'utf-8'));
      const { v1, diagnostics } = projectV2ProductToV1(product);
      assert.strictEqual(v1.format_ids.length, 0);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(
        diagnostics[0].code,
        'CANONICAL_NOT_V1_TRANSLATABLE',
        'spec is explicit: MUST NOT emit FORMAT_PROJECTION_FAILED for v1_translatable: false canonicals'
      );
      assert.strictEqual(diagnostics[0].error.details.format_kind, kind);
    });
  }
});

describe('v2 → v1 projection — coverage report (informational)', { skip: SKIP_REASON }, () => {
  test('emit a bucket-by-bucket coverage report', () => {
    const fixtures = loadFixtures();
    const buckets = {
      clean_v1_emit_via_v1_format_ref: [],
      clean_v1_emit_via_registry_match: [],
      canonical_formats_only_optout: [],
      canonical_not_v1_translatable: [],
      ambiguous_registry_match: [],
      no_registry_match: [],
    };
    for (const { name, product } of fixtures) {
      const { v1, diagnostics } = projectV2ProductToV1(product);
      if (diagnostics.length === 0 && v1.format_ids.length > 0) {
        // Distinguish v1_format_ref (normative) from registry synthesis (non-normative).
        const usedV1FormatRef = product.format_options.some(o => o.v1_format_ref);
        (usedV1FormatRef ? buckets.clean_v1_emit_via_v1_format_ref : buckets.clean_v1_emit_via_registry_match).push(
          name
        );
        continue;
      }
      for (const d of diagnostics) {
        const tag = `${name} (${d.error.details.format_kind})`;
        switch (d.code) {
          case 'FORMAT_DECLARATION_V1_NOT_APPLICABLE':
            buckets.canonical_formats_only_optout.push(tag);
            break;
          case 'CANONICAL_NOT_V1_TRANSLATABLE':
            buckets.canonical_not_v1_translatable.push(tag);
            break;
          case 'FORMAT_DECLARATION_V1_AMBIGUOUS':
            buckets.ambiguous_registry_match.push(tag);
            break;
          case 'FORMAT_PROJECTION_FAILED':
            buckets.no_registry_match.push(tag);
            break;
        }
      }
    }
    console.log('\n=== v2 → v1 projection coverage (13 spec fixtures, post-upstream-fixes) ===\n');
    const line = (label, list) => {
      console.log(`${label} (${list.length}):`);
      for (const n of list) console.log(`  ${n}`);
    };
    line('Clean v1 emit via v1_format_ref (NORMATIVE)', buckets.clean_v1_emit_via_v1_format_ref);
    console.log();
    line('Clean v1 emit via registry synthesis (NON-NORMATIVE)', buckets.clean_v1_emit_via_registry_match);
    console.log();
    line('Seller-asserted canonical_formats_only opt-out', buckets.canonical_formats_only_optout);
    console.log();
    line('Inherently v2 — v1_translatable: false on canonical', buckets.canonical_not_v1_translatable);
    console.log();
    line('Ambiguous registry family (FORMAT_DECLARATION_V1_AMBIGUOUS)', buckets.ambiguous_registry_match);
    console.log();
    line('No registry coverage (FORMAT_PROJECTION_FAILED)', buckets.no_registry_match);
    console.log();
    assert.ok(true);
  });
});
