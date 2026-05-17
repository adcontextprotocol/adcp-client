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
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const { projectV2ProductToV1 } = require('../../dist/lib/v2/projection/v2-to-v1.js');

const FIXTURE_DIR = path.join(__dirname, 'v2-projection-fixtures');

function loadFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      name: f.replace(/\.json$/, ''),
      product: JSON.parse(readFileSync(path.join(FIXTURE_DIR, f), 'utf-8')),
    }));
}

describe('v2 → v1 Product projection — per-fixture structural invariant', () => {
  for (const { name, product } of loadFixtures()) {
    test(name, () => {
      const { v1, diagnostics } = projectV2ProductToV1(product);
      assert.strictEqual(v1.product_id, product.product_id);
      // Every input declaration produces either a v1 emit or a
      // diagnostic — never both, never neither.
      const declCount = product.format_options.length;
      assert.strictEqual(
        v1.format_ids.length + diagnostics.length,
        declCount,
        `every format_options[i] must produce either a v1 emit or a diagnostic`
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

describe('v2 → v1 projection — seller-asserted v1_format_ref (the only normative path)', () => {
  test('nytimes_homepage_mrec projects via v1_format_ref', () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'nytimes_homepage_mrec.json'), 'utf-8'));
    const { v1, diagnostics } = projectV2ProductToV1(fixture);
    assert.strictEqual(diagnostics.length, 0);
    assert.strictEqual(v1.format_ids.length, 1);
    // Comes from the declaration's v1_format_ref, not from registry
    // synthesis — the registry path is non-normative.
    assert.strictEqual(v1.format_ids[0].agent_url, 'https://nytimes.adcp');
    assert.strictEqual(v1.format_ids[0].id, 'iab_mrec_300x250');
  });

  test('triton_daast_audio_30s projects via v1_format_ref', () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'triton_daast_audio_30s.json'), 'utf-8'));
    const { v1, diagnostics } = projectV2ProductToV1(fixture);
    assert.strictEqual(diagnostics.length, 0);
    assert.strictEqual(v1.format_ids.length, 1);
    assert.strictEqual(v1.format_ids[0].agent_url, 'https://triton.adcp');
    assert.strictEqual(v1.format_ids[0].id, 'daast_audio_30s_v1_1');
  });
});

describe('v2 → v1 projection — canonical_formats_only opt-out', () => {
  test('nytimes_homepage_takeover_custom emits FORMAT_DECLARATION_V1_NOT_APPLICABLE', () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'nytimes_homepage_takeover_custom.json'), 'utf-8'));
    const { v1, diagnostics } = projectV2ProductToV1(fixture);
    assert.strictEqual(v1.format_ids.length, 0);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, 'FORMAT_DECLARATION_V1_NOT_APPLICABLE');
    assert.strictEqual(diagnostics[0].error.details.reason, 'canonical_formats_only');
  });
});

describe('v2 → v1 projection — v1_translatable: false (4 inherently-v2 canonicals)', () => {
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

describe('v2 → v1 projection — coverage report (informational)', () => {
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
