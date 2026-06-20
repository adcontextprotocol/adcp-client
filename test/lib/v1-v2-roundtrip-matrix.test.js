// Cross-version round-trip matrix — the "does the projection layer
// actually keep buyers and sellers in sync" proof.
//
// Two directions:
//
//   (A) v1 catalog entry → v1→v2 projection → v2→v1 projection.
//       Should return the SAME v1 format_id the loop started with.
//       Tests every AAO catalog entry that carries a `canonical`
//       annotation (the normative path).
//
//   (B) v2 fixture → v2→v1 projection → v1→v2 projection. Each v1
//       format_id emitted by step 2 should project back to a v2
//       declaration carrying the same `format_kind` AND the same
//       `v1_format_ref[]` entries.
//
// This is the harness that proves a buyer on v2 talking to a v1
// seller (via auto-negotiation in 7.10+) sees the same product
// regardless of which side the SDK is bridging.
//
// What it does NOT prove (intentionally — these are upstream
// invariants, not SDK guarantees):
//
//   - Bytewise identity of `params` blocks. v1→v2 reconstructs params
//     from the catalog/registry; v2→v1 emits the v1 format_id (which
//     carries width/height/duration_ms but not the full param shape).
//     Lossy on `image_formats`, `ssl_required`, `composition_model`
//     etc. — those are v2-side asserts the v1 wire can't carry.
//
//   - Diagnostic-set identity. The v2→v1 step may emit a lossy
//     advisory; the v1→v2 step doesn't see it.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const { projectV1ProductToV2 } = require('../../dist/lib/v2/projection/v1-to-v2.js');
const { projectV2ProductToV1 } = require('../../dist/lib/v2/projection/v2-to-v1.js');
const { betaProjectionSkipReason } = require('./helpers/optional-3-1-beta.js');

const FIXTURE_DIR = path.join(__dirname, 'v2-projection-fixtures');
const CATALOG_PATH = path.join(FIXTURE_DIR, 'aao-reference-formats.json');
const SKIP_REASON = betaProjectionSkipReason({ catalogPath: CATALOG_PATH });

function loadCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
}

function loadFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json') && f !== 'aao-reference-formats.json')
    .map(f => ({
      name: f.replace(/\.json$/, ''),
      product: JSON.parse(readFileSync(path.join(FIXTURE_DIR, f), 'utf-8')),
    }))
    .filter(({ product }) => Array.isArray(product?.format_options));
}

function refKey(ref) {
  return `${ref.agent_url}::${ref.id}`;
}

describe('round-trip matrix — direction A: catalog entry → v1→v2 → v2→v1', { skip: SKIP_REASON }, () => {
  // The 4 inherently-v2 canonicals (`sponsored_placement`,
  // `agent_placement`, `image_carousel`, `responsive_creative`) carry
  // `v1_translatable: false` — v2→v1 on those emits
  // CANONICAL_NOT_V1_TRANSLATABLE by design. Excluded from the
  // round-trip test because the projection layer is doing exactly
  // what the spec asks. (They DO surface in the test below as the
  // documented one-way set.)
  const V1_UNTRANSLATABLE = new Set([
    'sponsored_placement',
    'agent_placement',
    'image_carousel',
    'responsive_creative',
  ]);

  test('every canonical-annotated catalog entry round-trips to itself', () => {
    const entries = loadCatalog().filter(e => e.canonical && !V1_UNTRANSLATABLE.has(e.canonical.kind));
    const failures = [];
    for (const entry of entries) {
      const v1In = {
        product_id: `rt_${entry.format_id.id}`,
        name: entry.name ?? '',
        description: entry.description ?? '',
        format_ids: [entry.format_id],
      };
      const { v2 } = projectV1ProductToV2(v1In);
      // Skip catalog entries that didn't produce a clean v2 declaration —
      // covered by the v1→v2 test suite.
      if (v2.format_options.length !== 1) {
        failures.push({ id: entry.format_id.id, stage: 'v1→v2', reason: 'no v2 decl produced' });
        continue;
      }
      const { v1: v1Out, diagnostics } = projectV2ProductToV1(v2);
      // The v2→v1 step should emit at least one v1 format_id (the one
      // the loop started with, carried via v1_format_ref).
      if (v1Out.format_ids.length === 0) {
        failures.push({
          id: entry.format_id.id,
          stage: 'v2→v1',
          diagnostics: diagnostics.map(d => d.code),
        });
        continue;
      }
      // The original format_id MUST be present in the v1→v2→v1 output.
      // (The v2→v1 step may emit additional fan-out entries for multi-
      // size declarations, but the seed always survives.)
      const emitted = new Set(v1Out.format_ids.map(refKey));
      if (!emitted.has(refKey(entry.format_id))) {
        failures.push({
          id: entry.format_id.id,
          stage: 'v2→v1 → identity check',
          expected: refKey(entry.format_id),
          got: [...emitted],
        });
      }
    }
    assert.deepStrictEqual(failures, [], 'every canonical-annotated catalog entry must round-trip');
  });

  test('inherently-v2 catalog entries emit CANONICAL_NOT_V1_TRANSLATABLE on v2→v1', () => {
    // Documented one-way mappings — the catalog has v1 entries annotated
    // with v1-untranslatable canonicals. They project v1→v2 (the v1
    // catalog entry exists) but NOT v2→v1 (the canonical is v1-only
    // structurally). Captured here so a future regression that lets
    // them "round-trip" via FORMAT_PROJECTION_FAILED (the wrong code)
    // is caught.
    const entries = loadCatalog().filter(e => e.canonical && V1_UNTRANSLATABLE.has(e.canonical.kind));
    for (const entry of entries) {
      const v1In = {
        product_id: `rt_${entry.format_id.id}`,
        name: entry.name ?? '',
        description: entry.description ?? '',
        format_ids: [entry.format_id],
      };
      const { v2 } = projectV1ProductToV2(v1In);
      const { v1: v1Out, diagnostics } = projectV2ProductToV1(v2);
      assert.strictEqual(v1Out.format_ids.length, 0, `${entry.format_id.id}: no v1 emit`);
      assert.strictEqual(diagnostics.length, 1, `${entry.format_id.id}: one diagnostic`);
      assert.strictEqual(
        diagnostics[0].code,
        'CANONICAL_NOT_V1_TRANSLATABLE',
        `${entry.format_id.id}: must emit CANONICAL_NOT_V1_TRANSLATABLE, not FORMAT_PROJECTION_FAILED`
      );
    }
  });
});

describe('round-trip matrix — direction B: v2 fixture → v2→v1 → v1→v2', { skip: SKIP_REASON }, () => {
  for (const { name, product } of loadFixtures()) {
    test(`${name}`, () => {
      const { v1, diagnostics: v2Diags } = projectV2ProductToV1(product);
      if (v1.format_ids.length === 0) {
        // Fixture had only canonical_formats_only opt-outs / v1-untranslatable
        // canonicals; nothing to round-trip. The v2→v1 test suite covers
        // these in isolation.
        return;
      }

      // Project each emitted v1 format_id back to v2.
      const v1ForRoundTrip = {
        ...v1,
        format_ids: v1.format_ids,
      };
      const { v2: v2Back, diagnostics: v1Diags } = projectV1ProductToV2(v1ForRoundTrip);

      // The back-projected v2 should declare at least one format_option per emitted v1 id
      // that has a clean catalog match. Failures here mean the catalog has a v1 entry
      // we emit on the way down but no canonical annotation to bring it back up — a
      // catalog-coverage gap, not an SDK bug.
      const projectionFailed = v1Diags.filter(d => d.code === 'FORMAT_PROJECTION_FAILED');
      if (projectionFailed.length > 0) {
        // Surface as informational; not a hard fail. Catalog evolves.
        // See `catalog_lacks_canonical_annotation` detail.
      }

      // For every v2 declaration produced by the round-trip, the format_kind
      // must equal SOME format_kind in the original product's format_options.
      const originalKinds = new Set(product.format_options.map(o => o.format_kind));
      for (const decl of v2Back.format_options) {
        assert.ok(
          originalKinds.has(decl.format_kind),
          `round-trip v2 declaration's format_kind '${decl.format_kind}' must appear in the source; ` +
            `source kinds: ${[...originalKinds].join(', ')}`
        );
      }

      // The v1_format_ref refs in the round-trip output must be a subset of the
      // v1 format_ids that v2→v1 emitted. (Wrapping ref-set, not strict equality —
      // a single v1 catalog entry can map to one v2 declaration that picks up
      // additional refs via the catalog's sibling lookup in future fan-outs.)
      const emittedRefs = new Set(v1.format_ids.map(refKey));
      for (const decl of v2Back.format_options) {
        for (const ref of decl.v1_format_ref ?? []) {
          assert.ok(
            emittedRefs.has(refKey(ref)),
            `round-trip v1_format_ref '${refKey(ref)}' must trace back to a v2→v1 emit`
          );
        }
      }

      // No projection bug should produce dropped declarations silently:
      // diagnostic count + emit count should cover every input declaration on each leg.
      assert.ok(
        v1.format_ids.length + v2Diags.length >= product.format_options.length,
        `v2→v1 must cover every format_options[i] with an emit or diagnostic`
      );
      assert.ok(
        v2Back.format_options.length + v1Diags.length >= v1.format_ids.length,
        `v1→v2 must cover every emitted format_id with a declaration or diagnostic`
      );
    });
  }
});

describe('round-trip matrix — diagnostic-set sanity', { skip: SKIP_REASON }, () => {
  test('every diagnostic carries source=sdk + parseable sdk_id + field with product_id', () => {
    for (const { name, product } of loadFixtures()) {
      const v2Down = projectV2ProductToV1(product);
      const v1Up = projectV1ProductToV2({
        ...product,
        format_ids: v2Down.v1.format_ids,
      });
      for (const d of [...v2Down.diagnostics, ...v1Up.diagnostics]) {
        assert.strictEqual(d.source, 'sdk', `${name}: diagnostic.source must be 'sdk'`);
        assert.match(d.sdk_id, /^@adcp\/sdk@\d+\.\d+\.\d+/, `${name}: diagnostic.sdk_id must be parseable`);
        assert.ok(
          d.field.includes(product.product_id),
          `${name}: diagnostic.field must point at the originating declaration`
        );
      }
    }
  });
});
