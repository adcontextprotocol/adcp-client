// Phase A of Stage 3: schema-loader holds per-version state.
//
// Asserts that the loader keys its compiled validators by AdCP version, so
// the same SDK process can hold validators for `3.0.1`, `3.1.0-beta.1`, and
// any future version side by side. The test creates a synthetic version
// directory in `dist/lib/schemas-data/` so we don't depend on whichever
// patch versions happen to be in the local schemas/cache (the build copies
// only the latest patch per stable minor — see scripts/copy-schemas-to-dist.ts).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  getValidator,
  listValidatorKeys,
  _resetValidationLoader,
} = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

// Create a synthetic 'test-fixture' version by copying the bundled ADCP_VERSION
// directory under a different name. The loader has no version-string
// validation — it only checks that schemas-data/<version>/ exists — so this
// gives us a second real-schema-tree to assert per-version state on without
// requiring multiple AdCP releases be in the cache.
const FIXTURE_VERSION = 'test-fixture-1.0.0';
const SCHEMAS_DATA_ROOT = path.resolve(__dirname, '..', '..', 'dist', 'lib', 'schemas-data');
const SOURCE_DIR = path.join(SCHEMAS_DATA_ROOT, ADCP_VERSION);
const FIXTURE_DIR = path.join(SCHEMAS_DATA_ROOT, FIXTURE_VERSION);

before(() => {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Test setup expects ${SOURCE_DIR} to exist. Run \`npm run build:lib\` first.`);
  }
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
  fs.cpSync(SOURCE_DIR, FIXTURE_DIR, { recursive: true });
});

after(() => {
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
});

describe('schema-loader per-version state', () => {
  test('default version (no argument) uses ADCP_VERSION', () => {
    _resetValidationLoader();
    const keys = listValidatorKeys();
    assert.ok(keys.length > 0, 'default loader has validators');
    assert.ok(keys.includes('get_products::request'), 'expected get_products::request in default version');
  });

  test('two distinct versions produce distinct compiled validators', () => {
    _resetValidationLoader();

    const vCurrent = getValidator('get_products', 'request', ADCP_VERSION);
    const vFixture = getValidator('get_products', 'request', FIXTURE_VERSION);

    assert.ok(vCurrent, `${ADCP_VERSION} validator compiled`);
    assert.ok(vFixture, `${FIXTURE_VERSION} validator compiled`);
    assert.notStrictEqual(
      vCurrent,
      vFixture,
      'each version compiles its own validator instance — they must not be aliased'
    );
  });

  test('listValidatorKeys is per-version', () => {
    _resetValidationLoader();
    const keysCurrent = listValidatorKeys(ADCP_VERSION);
    const keysFixture = listValidatorKeys(FIXTURE_VERSION);
    // Fixture is a copy of current — same key set.
    assert.deepStrictEqual(keysCurrent, keysFixture);
  });

  test('repeated calls cache the per-version validator', () => {
    _resetValidationLoader();
    const first = getValidator('get_products', 'request', FIXTURE_VERSION);
    const second = getValidator('get_products', 'request', FIXTURE_VERSION);
    assert.strictEqual(first, second, 'same call returns the same compiled validator instance');
  });

  test('unknown version throws with a clear message', () => {
    _resetValidationLoader();
    assert.throws(
      () => getValidator('get_products', 'request', '99.99.99-not-a-real-version'),
      err =>
        /AdCP schema data for version "99\.99\.99-not-a-real-version" not found/.test(err.message) &&
        /sync-schemas/.test(err.message)
    );
  });

  test('default version path aliases to ADCP_VERSION explicit path', () => {
    _resetValidationLoader();
    const fromDefault = getValidator('get_products', 'request');
    const fromExplicit = getValidator('get_products', 'request', ADCP_VERSION);
    assert.strictEqual(
      fromDefault,
      fromExplicit,
      'default version path must alias to ADCP_VERSION explicit path (same compiled validator)'
    );
  });

  test('_resetValidationLoader(version) clears one version, leaves others', () => {
    _resetValidationLoader();
    const vCurrentFirst = getValidator('get_products', 'request', ADCP_VERSION);
    const vFixtureFirst = getValidator('get_products', 'request', FIXTURE_VERSION);
    _resetValidationLoader(ADCP_VERSION);
    const vCurrentAfter = getValidator('get_products', 'request', ADCP_VERSION);
    const vFixtureAfter = getValidator('get_products', 'request', FIXTURE_VERSION);
    assert.notStrictEqual(
      vCurrentFirst,
      vCurrentAfter,
      `${ADCP_VERSION} was reset — should re-compile to a new function instance`
    );
    assert.strictEqual(
      vFixtureFirst,
      vFixtureAfter,
      `${FIXTURE_VERSION} was untouched — should still be the same instance`
    );
  });
});
