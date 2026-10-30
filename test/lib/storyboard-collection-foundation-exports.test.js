/**
 * Packaging qualification for the collection/prepared-fixture foundation:
 * the surface must be reachable from the real published entry points, in
 * both CJS and ESM, and the prepared-state binding must actually observe a
 * swapped schema artifact.
 *
 * A foundation that only works through deep `dist/lib/...` requires is not a
 * foundation a consumer can adopt.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The intended ADOPTER surface, not everything that happens to be exported.
// Incidental helpers (pair formatting/comparison, operand normalization, the
// witness-returning matcher) stay on the deep path on purpose.
const REQUIRED_VALUES = [
  'COLLECTION_DIAGNOSTIC_LIMIT',
  'COLLECTION_PAIR_LIMIT',
  'COLLECTION_TARGETING_MODES',
  'COLLECTION_WITNESS_KINDS',
  'PREPARED_FIXTURES_CONTRACT_VERSION',
  'PROTECTED_CONTEXT_PREFIX',
  'PreparedStoryboardFixtures',
  'ProtectedContextViolation',
  'diffCollectionPairSets',
  'evaluateCollectionSelection',
  'isProtectedContextKey',
  'isTrustedPreparedFixtures',
  'normalizeCollectionSelectors',
  'prepareStoryboardFixtures',
  'productSatisfiesCollectionSelection',
  'readCollectionWitness',
  'formatCollectionPair',
  'summarizeCollectionPairs',
  'withPreparedFixtures',
];

// Runner internals that must NOT become semver-stable surface on the
// top-level testing barrel.
const DEEP_PATH_ONLY = [
  'compareCollectionPairs',
  'normalizeCollectionSelectionSelector',
  'matchFixtureRequirementsWithWitness',
  'normalizeFixtureContextOutputs',
  'createProtectedContextWriter',
  'applyProtectedContextPatch',
  'createPreparedStoryboardFixtures',
  // Preparation internals. `fingerprintCredential` and `digestStoryboard`
  // in particular: a consumer that could call them could mint a binding
  // that compares equal to someone else's, which is the whole trust model.
  'fingerprintCredential',
  'digestStoryboard',
  'buildPreparedBinding',
  'resolvePreparedFixtures',
  'preparedBindingRegistryFor',
  'diffPreparedBinding',
];

const CJS_ENTRY = path.resolve(__dirname, '../../dist/lib/testing/index.js');
const ESM_ENTRY = path.resolve(__dirname, '../../dist/lib/testing/index.mjs');

test('the CJS testing entry point exports the adopter surface', () => {
  const api = require(CJS_ENTRY);
  assert.deepEqual(
    REQUIRED_VALUES.filter(name => api[name] === undefined),
    []
  );
  assert.equal(api.PROTECTED_CONTEXT_PREFIX, '__adcp_fixture_');
  assert.equal(typeof api.prepareStoryboardFixtures, 'function');
  // `diffCollectionPairSets` returns `CollectionPair[]`; without its two
  // renderers a consumer reimplements the quoted `"domain":"id"` /
  // `"domain":*` form by hand and gets it subtly different — the drift one
  // shared normalizer exists to prevent. They ship as a unit.
  assert.equal(typeof api.formatCollectionPair, 'function');
  assert.equal(typeof api.summarizeCollectionPairs, 'function');
  assert.equal(api.formatCollectionPair({ publisher_domain: 'd.example', collection_id: 'x' }), '"d.example":"x"');
  assert.equal(api.formatCollectionPair({ publisher_domain: 'd.example', collection_id: null }), '"d.example":*');
});

test('runner internals stay off the top-level barrel', async () => {
  const cjs = require(CJS_ENTRY);
  const esm = await import(pathToFileURL(ESM_ENTRY).href);
  for (const api of [cjs, esm]) {
    assert.deepEqual(
      DEEP_PATH_ONLY.filter(name => api[name] !== undefined),
      [],
      'promoting these to the public barrel makes them semver-stable surface nobody asked for'
    );
  }
});

test('the write capability is not reachable from any package entry point', async () => {
  const cjs = require(CJS_ENTRY);
  const esm = await import(pathToFileURL(ESM_ENTRY).href);
  for (const api of [cjs, esm]) {
    assert.equal(api.createProtectedContextWriter, undefined);
    assert.equal(api.applyProtectedContextPatch, undefined);
    assert.equal(api.createPreparedStoryboardFixtures, undefined);
  }
  // A capability a consumer can mint is not a capability.
  const pkg = require('../../package.json');
  const subpaths = Object.keys(pkg.exports ?? {});
  assert.equal(
    subpaths.some(subpath => subpath.includes('storyboard/*') || subpath === './*'),
    false,
    'no wildcard subpath may expose dist/lib/testing/storyboard/* directly'
  );
});

test('the ESM testing entry point exports the same surface', async () => {
  const api = await import(pathToFileURL(ESM_ENTRY).href);
  assert.deepEqual(
    REQUIRED_VALUES.filter(name => api[name] === undefined),
    []
  );
  assert.equal(api.PROTECTED_CONTEXT_PREFIX, '__adcp_fixture_');
});

test('CJS and ESM agree on the normalizer, so a mixed-caller suite cannot drift', async () => {
  const cjs = require(CJS_ENTRY);
  const esm = await import(pathToFileURL(ESM_ENTRY).href);
  const selectors = [
    { publisher_domain: 'owner.example', collection_ids: ['news', 'music'] },
    { publisher_domain: 'owner.example', collection_ids: ['music'] },
  ];
  const fromCjs = cjs.normalizeCollectionSelectors(selectors);
  const fromEsm = esm.normalizeCollectionSelectors(selectors);
  // Assert success first: two failures would deep-equal vacuously.
  assert.equal(fromCjs.ok, true);
  assert.equal(fromEsm.ok, true);
  assert.equal(fromCjs.value.pairs.length, 2);
  assert.deepEqual(fromCjs.value.pairs, fromEsm.value.pairs);
  const selector = { collection_targeting: 'selectable', minimum_pairs: 2, require_cross_publisher_collection: false };
  const candidate = { product_id: 'p', collections: selectors, collection_targeting_allowed: true };
  // Assert the discriminating value, not just agreement: two `false`s agree
  // vacuously.
  assert.equal(cjs.productSatisfiesCollectionSelection(candidate, selector), true);
  assert.equal(esm.productSatisfiesCollectionSelection(candidate, selector), true);
});

test('the documented authored forms are compile-checked', () => {
  // The real check is `src/lib/testing/storyboard/collection-selection.type-checks.ts`,
  // which `npm run typecheck` compiles (and the pre-push hook runs). This
  // asserts the fixture exists and covers both directions, so deleting it
  // fails here rather than silently dropping the coverage.
  const fs = require('node:fs');
  const fixture = fs.readFileSync(
    path.resolve(__dirname, '../../src/lib/testing/storyboard/collection-selection.type-checks.ts'),
    'utf8'
  );
  assert.match(
    fixture,
    /value: \{ collection_targeting: 'fixed' \}/,
    'the guide\u2019s minimal operand must be covered'
  );
  assert.match(fixture, /snapshot: 'selected_entity'/);
  assert.ok((fixture.match(/@ts-expect-error/g) ?? []).length >= 5, 'negative cases must be covered too');
});

test('the prepared-state binding observes a swapped schema artifact', () => {
  const { resolveSchemaArtifact } = require('../../dist/lib/testing/storyboard/prepared-fixtures.js');
  const { withExternalSchemaRoot } = require('../../dist/lib/validation/schema-loader.js');
  const builtin = resolveSchemaArtifact('3.2.5');
  assert.equal(builtin.external, false);
  assert.match(builtin.digest, /^[0-9a-f]{64}$/);

  // A caller-supplied bundle for a DIFFERENT version resolves to a different
  // artifact, so a prepared state pinned to one cannot be reused under the
  // other. A mutable version label alone would not catch this.
  const other = resolveSchemaArtifact('3.1.31');
  assert.notEqual(other.bundle_key, builtin.bundle_key);
  assert.notEqual(other.digest, builtin.digest);

  // A caller-supplied bundle flips `external` and reports that root's own
  // digest, so a prepared state pinned to the packaged snapshot cannot be
  // reused under a scope that swapped the bundle out.
  const externalRoot = path.resolve(__dirname, '../../schemas/cache/3.1.31');
  const scoped = withExternalSchemaRoot('3.1.31', externalRoot, () => resolveSchemaArtifact('3.1.31'));
  // The discriminating comparison is scoped-vs-unscoped at the SAME version:
  // comparing against the 3.2.5 builtin would pass on the version alone.
  assert.equal(scoped.external, true);
  assert.equal(other.external, false);
  assert.equal(scoped.bundle_key, other.bundle_key);
  assert.notEqual(scoped.digest, builtin.digest);
  // Documented limit: the digest is bundle identity at FIRST observation of a
  // root, so an in-place mutation of an already-seen root is not detected.
  assert.deepEqual(resolveSchemaArtifact('3.2.5'), builtin);
});

test('withPreparedFixtures pairs state with its authorizer atomically', async () => {
  const cjs = require(CJS_ENTRY);
  const esm = await import(pathToFileURL(ESM_ENTRY).href);
  for (const api of [cjs, esm]) {
    assert.equal(typeof api.withPreparedFixtures, 'function');
    const authorizer = () => ({ authorized: true });
    const state = { ref: 'r', resolve: () => undefined };
    assert.deepEqual(api.withPreparedFixtures(state, authorizer), {
      prepared_fixtures: state,
      prepared_fixtures_authorizer: authorizer,
    });
  }
});
