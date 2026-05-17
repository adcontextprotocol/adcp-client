// Exercise the v2 → v1 projection layer against the 13 reference
// fixtures from adcontextprotocol/adcp#3307
// (static/examples/products/canonical/). These fixtures span the full
// canonical-format catalog: image, html5, display_tag, image_carousel,
// video_hosted (×2), video_vast, audio_hosted, audio_daast,
// sponsored_placement, responsive_creative, agent_placement, custom.
//
// The interesting question this test answers: how many of the 13
// real-world v2 declarations have a clean v1 form, and how many would
// be unreachable from a v1-only buyer? The answer informs whether the
// 8.0 design's "v2-only public type with projection at the boundary"
// is operable today, or whether sellers need to start adding
// v1_format_ref before the SDK can downgrade gracefully.

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

describe('v2 → v1 Product projection — per-fixture verdict', () => {
  for (const { name, product } of loadFixtures()) {
    test(name, () => {
      const { v1, diagnostics } = projectV2ProductToV1(product);
      // Every fixture's product_id passes through unchanged — the
      // projection rewrites only format_ids / format_options.
      assert.strictEqual(v1.product_id, product.product_id);
      // The structural invariant: format_ids count + diagnostic count
      // equals total format_options count (every input declaration
      // produces either a format_id OR a diagnostic, never both, never
      // neither).
      const declCount = product.format_options.length;
      assert.strictEqual(
        v1.format_ids.length + diagnostics.length,
        declCount,
        `every format_options[i] must produce either a v1 emit or a diagnostic`
      );
    });
  }
});

describe('v2 → v1 projection — explicit canonical_formats_only opt-out', () => {
  test('nytimes_homepage_takeover_custom is unreachable from v1', () => {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'nytimes_homepage_takeover_custom.json'), 'utf-8'));
    const { v1, diagnostics } = projectV2ProductToV1(fixture);
    assert.strictEqual(v1.format_ids.length, 0);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, 'FORMAT_DECLARATION_V1_UNREACHABLE');
    assert.strictEqual(diagnostics[0].details.reason, 'canonical_formats_only');
    assert.match(diagnostics[0].details.hint, /opts out of v1/);
  });
});

describe('v2 → v1 projection — IAB image with registry-matched dimensions', () => {
  test('nytimes_homepage_mrec projects to iab/mrec_300x250', () => {
    // The only fixture whose canonical (image) + params (300x250) lines
    // up with an invertible registry entry. The synthesized id carries
    // the slash, surfacing the cross-schema mismatch we filed upstream
    // (format-id.json pattern rejects slashes).
    const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'nytimes_homepage_mrec.json'), 'utf-8'));
    const { v1, diagnostics } = projectV2ProductToV1(fixture);
    assert.strictEqual(diagnostics.length, 0);
    assert.strictEqual(v1.format_ids.length, 1);
    const fid = v1.format_ids[0];
    assert.strictEqual(fid.id, 'iab/mrec_300x250');
    assert.strictEqual(fid.width, 300);
    assert.strictEqual(fid.height, 250);
    assert.strictEqual(fid.agent_url, 'https://creative.adcontextprotocol.org');
  });
});

describe('v2 → v1 projection — ecosystem-wide summary', () => {
  test('emit a coverage report (informational, always passes)', () => {
    const fixtures = loadFixtures();
    const buckets = {
      clean_v1_emit: [],
      explicit_opt_out: [],
      ambiguous_registry: [],
      no_registry_match: [],
    };
    for (const { name, product } of fixtures) {
      const { v1, diagnostics } = projectV2ProductToV1(product);
      if (diagnostics.length === 0 && v1.format_ids.length > 0) {
        buckets.clean_v1_emit.push(name);
        continue;
      }
      for (const d of diagnostics) {
        if (d.code === 'FORMAT_DECLARATION_V1_UNREACHABLE') {
          if (d.details.reason === 'canonical_formats_only') {
            buckets.explicit_opt_out.push(`${name} (${d.details.format_kind})`);
          } else {
            buckets.no_registry_match.push(`${name} (${d.details.format_kind})`);
          }
        } else if (d.code === 'FORMAT_DECLARATION_V1_AMBIGUOUS') {
          buckets.ambiguous_registry.push(`${name} (${d.details.format_kind})`);
        }
      }
    }
    console.log('\n=== v2 → v1 projection coverage (13 spec fixtures) ===\n');
    console.log(`Clean v1 emit (${buckets.clean_v1_emit.length}/${fixtures.length}):`);
    for (const n of buckets.clean_v1_emit) console.log(`  ✓ ${n}`);
    console.log(`\nExplicit canonical_formats_only opt-out (${buckets.explicit_opt_out.length}):`);
    for (const n of buckets.explicit_opt_out) console.log(`  ✗ ${n}`);
    console.log(
      `\nAmbiguous registry match — family exists but not invertible (${buckets.ambiguous_registry.length}):`
    );
    for (const n of buckets.ambiguous_registry) console.log(`  ? ${n}`);
    console.log(`\nNo registry entry for the canonical (${buckets.no_registry_match.length}):`);
    for (const n of buckets.no_registry_match) console.log(`  ✗ ${n}`);
    console.log('');
    // Informational test — always passes. Real assertions live above.
    assert.ok(true);
  });
});
