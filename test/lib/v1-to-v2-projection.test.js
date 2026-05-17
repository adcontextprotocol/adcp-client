// Exercise the v1 → v2 projection layer against the full AAO
// catalog (reference-formats.json). Every catalog entry is a v1 format
// definition — we wrap each one in a minimal v1 Product and run it
// through the projection to see how many land cleanly in v2 shape.
//
// Skips in CI when the 3.1-beta cache + vendored catalog aren't
// present — same pattern as the v2 → v1 prototype tests.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const { projectV1ProductToV2 } = require('../../dist/lib/v2/projection/v1-to-v2.js');

const FIXTURE_DIR = path.join(__dirname, 'v2-projection-fixtures');
const CATALOG_PATH = path.join(FIXTURE_DIR, 'aao-reference-formats.json');
const REGISTRY_PATH = path.join(
  __dirname,
  '..',
  '..',
  'schemas',
  'cache',
  '3.1.0-beta.0',
  'registries',
  'v1-canonical-mapping.json'
);

const SKIP_REASON =
  existsSync(CATALOG_PATH) && existsSync(REGISTRY_PATH)
    ? false
    : 'requires schemas/cache/3.1.0-beta.0/ + vendored aao-reference-formats.json — only present in workspaces with a local 3.1-beta sync';

function loadCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
}

/**
 * Wrap a catalog entry in a minimal v1 Product for the projection. Real
 * v1 Products carry pricing_options / publisher_properties / etc.;
 * for a projection test we only need format_ids + a product_id.
 */
function v1ProductFor(catalogEntry, productId) {
  return {
    product_id: productId,
    name: catalogEntry.name ?? productId,
    description: catalogEntry.description ?? '',
    format_ids: [catalogEntry.format_id],
  };
}

describe('v1 → v2 projection — every catalog entry projects', { skip: SKIP_REASON }, () => {
  test('all entries with `canonical` annotations project via Step 1', () => {
    const entries = loadCatalog().filter(e => e.canonical);
    const failures = [];
    for (const entry of entries) {
      const v1 = v1ProductFor(entry, `test_${entry.format_id.id}`);
      const { v2, diagnostics } = projectV1ProductToV2(v1);
      if (diagnostics.length > 0 || v2.format_options.length !== 1) {
        failures.push({
          id: entry.format_id.id,
          expected_canonical: entry.canonical,
          diagnostics: diagnostics.map(d => d.code),
        });
        continue;
      }
      if (v2.format_options[0].format_kind !== entry.canonical) {
        failures.push({
          id: entry.format_id.id,
          expected: entry.canonical,
          got: v2.format_options[0].format_kind,
        });
      }
    }
    assert.deepStrictEqual(failures, [], `catalog entries with \`canonical\` MUST all project cleanly`);
  });

  test('round-trip v1_format_ref preserves the input', () => {
    const entry = loadCatalog().find(e => e.canonical === 'image' && e.format_id.id === 'display_image');
    assert.ok(entry, 'expected display_image entry in the catalog');
    const v1 = v1ProductFor(entry, 'rt_display_image');
    const { v2 } = projectV1ProductToV2(v1);
    const decl = v2.format_options[0];
    assert.strictEqual(decl.v1_format_ref.agent_url, entry.format_id.agent_url);
    assert.strictEqual(decl.v1_format_ref.id, entry.format_id.id);
  });
});

describe('v1 → v2 projection — registry glob fallback for un-annotated formats', { skip: SKIP_REASON }, () => {
  test('an id that matches a registry literal projects without a catalog entry', () => {
    // A v1 product whose format_id matches a registry literal but uses
    // a non-AAO agent_url (so the catalog lookup misses and the
    // projection has to fall through to Step 2). The registry's
    // `display_300x250_image` is a literal glob (no `*`), so it matches
    // exactly.
    const v1 = {
      product_id: 'registry_only_fallback',
      name: 'test',
      description: 'test',
      format_ids: [
        {
          agent_url: 'https://some-publisher.example/',
          id: 'display_300x250_image',
        },
      ],
    };
    const { v2, diagnostics } = projectV1ProductToV2(v1);
    assert.strictEqual(diagnostics.length, 0);
    assert.strictEqual(v2.format_options.length, 1);
    assert.strictEqual(v2.format_options[0].format_kind, 'image');
    assert.strictEqual(v2.format_options[0].params.width, 300);
    assert.strictEqual(v2.format_options[0].params.height, 250);
  });
});

describe('v1 → v2 projection — fail-closed for fully-unknown formats', { skip: SKIP_REASON }, () => {
  test('a bespoke format with no catalog/registry/structural match surfaces FORMAT_PROJECTION_FAILED', () => {
    const v1 = {
      product_id: 'bespoke_proprietary',
      name: 'test',
      description: 'test',
      format_ids: [
        {
          agent_url: 'https://obscure-publisher.example/',
          id: 'definitely_not_in_catalog_or_registry',
        },
      ],
    };
    const { v2, diagnostics } = projectV1ProductToV2(v1);
    assert.strictEqual(v2.format_options.length, 0);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
    assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'no_match');
  });
});

describe('v1 → v2 projection — every-catalog-entry coverage report', { skip: SKIP_REASON }, () => {
  test('emit per-canonical coverage', () => {
    const catalog = loadCatalog();
    const buckets = {
      step1_catalog_canonical: [], // seller-asserted, normative
      catalog_lacks_canonical: [], // catalog has entry, no v2 mapping yet
      no_match: [], // not in catalog, no registry, no structural
    };
    for (const entry of catalog) {
      const v1 = v1ProductFor(entry, `cov_${entry.format_id.id}`);
      const { v2, diagnostics } = projectV1ProductToV2(v1);
      const projectedKind = v2.format_options[0]?.format_kind;
      const tag = `${entry.format_id.id} → ${projectedKind ?? '✗'}`;
      if (diagnostics.length === 0) {
        buckets.step1_catalog_canonical.push(tag);
        continue;
      }
      const reason = diagnostics[0].error.details.resolution_failure;
      if (reason === 'catalog_lacks_canonical_annotation') {
        buckets.catalog_lacks_canonical.push(entry.format_id.id);
      } else {
        buckets.no_match.push(entry.format_id.id);
      }
    }
    console.log('\n=== v1 → v2 projection coverage (full AAO catalog, 57 entries) ===\n');
    const line = (label, list) => {
      console.log(`${label} (${list.length}):`);
      for (const n of list) console.log(`  ${n}`);
    };
    line('Step 1 — catalog `canonical` annotation (NORMATIVE, clean projection)', buckets.step1_catalog_canonical);
    console.log();
    line(
      'catalog_lacks_canonical_annotation (AAO knows the format, no v2 mapping yet — Native/DOOH/broadcast/card categories)',
      buckets.catalog_lacks_canonical
    );
    console.log();
    line('no_match (not in catalog, no registry hit, no structural)', buckets.no_match);
    console.log();
    assert.ok(true);
  });
});
