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
// Track whichever 3.1+ cache the workspace happens to have synced —
// CI syncs `3.1.0-beta.1` via `npm run sync-schemas:3.1-beta`; older
// workspaces may still have `3.1.0-beta.0`. Either is fine; the
// registry loader (`src/lib/v2/projection/registry.ts`) reads from
// whichever exists.
const SCHEMAS_CACHE_ROOT = path.join(__dirname, '..', '..', 'schemas', 'cache');
const REGISTRY_EXISTS = ['3.1.0-beta.1', '3.1.0-beta.0', 'latest'].some(v =>
  existsSync(path.join(SCHEMAS_CACHE_ROOT, v, 'registries', 'v1-canonical-mapping.json'))
);

const SKIP_REASON =
  existsSync(CATALOG_PATH) && REGISTRY_EXISTS
    ? false
    : 'requires a 3.1+ schemas/cache/<beta>/ + vendored aao-reference-formats.json — only present in workspaces with a local 3.1-beta sync';

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
      if (v2.format_options[0].format_kind !== entry.canonical.kind) {
        failures.push({
          id: entry.format_id.id,
          expected: entry.canonical.kind,
          got: v2.format_options[0].format_kind,
        });
      }
    }
    assert.deepStrictEqual(failures, [], `catalog entries with \`canonical\` MUST all project cleanly`);
  });

  test('round-trip v1_format_ref preserves the input', () => {
    const entry = loadCatalog().find(e => e.canonical?.kind === 'image' && e.format_id.id === 'display_image');
    assert.ok(entry, 'expected display_image entry in the catalog');
    const v1 = v1ProductFor(entry, 'rt_display_image');
    const { v2 } = projectV1ProductToV2(v1);
    const decl = v2.format_options[0];
    // v1_format_ref is always an array per 3.1-beta spec (minItems:1).
    assert.ok(Array.isArray(decl.v1_format_ref), 'v1_format_ref MUST be an array');
    assert.strictEqual(decl.v1_format_ref.length, 1);
    assert.strictEqual(decl.v1_format_ref[0].agent_url, entry.format_id.agent_url);
    assert.strictEqual(decl.v1_format_ref[0].id, entry.format_id.id);
  });
});

describe(
  'v1 → v2 projection — structural fallback (registry is structural-only post-3.1-GA)',
  { skip: SKIP_REASON },
  () => {
    // After the publisher-scoped format catalog landed (adcp commit
    // f88522cfc5), the registry shrank from 17 entries to 7 pure-
    // structural fallbacks. The literal globs (`iab_mrec_300x250` etc.)
    // moved into per-publisher catalogs declared via
    // `adagents.json#/formats` (or the AAO community mirror for
    // publishers who haven't adopted yet). The SDK's
    // `forwardLookupByGlob` path stays in place for forward-compat —
    // the registry MAY grow literal entries again — but at 3.1 GA it
    // never fires for catalog-known formats.

    test('publisher-bespoke id without catalog entry falls through to structural', () => {
      // A v1 product whose format_id doesn't match the AAO catalog OR
      // a registry literal, but DOES have a structural signature the
      // registry recognizes. The SDK needs to know about the format's
      // assets — we can't fetch them at projection time (auto-
      // negotiation surface concern), so we expect fail-closed with
      // `no_match` here. Structural Step 3 only fires when a catalog
      // lookup returned an entry without a `canonical:` annotation.
      const v1 = {
        product_id: 'bespoke_unknown',
        name: 'test',
        description: 'test',
        format_ids: [
          {
            agent_url: 'https://some-publisher.example/',
            id: 'definitely_not_in_catalog_or_registry',
          },
        ],
      };
      const { v2, diagnostics } = projectV1ProductToV2(v1);
      // Either fail-closed (the realistic case — we don't know the
      // publisher's format definition) or a structural fallback.
      // The prototype's scope means the publisher-fetch side is
      // deferred to the auto-negotiation surface, so this is fail-
      // closed today.
      assert.strictEqual(v2.format_options.length, 0);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].code, 'FORMAT_PROJECTION_FAILED');
      assert.strictEqual(diagnostics[0].error.details.resolution_failure, 'no_match');
    });
  }
);

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
