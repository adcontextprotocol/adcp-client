// Phase A of Stage 3: schema-loader holds per-version state, keyed by the
// resolved bundle key (`MAJOR.MINOR` for stable, full version for prereleases).
//
// Asserts that:
//   - Stable patch pins (`'3.0.0'`, `'3.0.1'`, `'3.0'`) collapse to one
//     compiled validator — the SDK doesn't ship distinct schemas per patch.
//   - Distinct minors (`'3.0'` vs a synthetic `'1.0'` fixture) produce
//     distinct compiled validators.
//   - Prereleases stay exact (cached separately from any stable bundle).
//
// The test creates a synthetic minor directory in `dist/lib/schemas-data/`
// so the assertions don't depend on whichever AdCP versions happen to be in
// the local cache. The build collapses stable patches to MAJOR.MINOR keys
// (see scripts/copy-schemas-to-dist.ts).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  getValidator,
  listValidatorKeys,
  resolveBundleKey,
  hasSchemaBundle,
  _resetValidationLoader,
} = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

// Synthetic fixture under a different MAJOR.MINOR so the loader's state map
// keeps it separate from the real bundle.
const FIXTURE_KEY = '1.0';
const FIXTURE_VERSION_PIN = '1.0.0';
const SCHEMAS_DATA_ROOT = path.resolve(__dirname, '..', '..', 'dist', 'lib', 'schemas-data');
const SOURCE_DIR = path.join(SCHEMAS_DATA_ROOT, resolveBundleKey(ADCP_VERSION));
const FIXTURE_DIR = path.join(SCHEMAS_DATA_ROOT, FIXTURE_KEY);

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

  test('resolveBundleKey collapses stable patches to MAJOR.MINOR', () => {
    assert.strictEqual(resolveBundleKey('3.0.0'), '3.0');
    assert.strictEqual(resolveBundleKey('3.0.1'), '3.0');
    assert.strictEqual(resolveBundleKey('3.0'), '3.0');
    assert.strictEqual(resolveBundleKey('3.1.0'), '3.1');
  });

  test('resolveBundleKey keeps prereleases exact', () => {
    assert.strictEqual(resolveBundleKey('3.1.0-beta.1'), '3.1.0-beta.1');
    assert.strictEqual(resolveBundleKey('3.1.0-rc.2'), '3.1.0-rc.2');
  });

  test('stable patch pins share a compiled validator (3.0.0 ≡ 3.0.1 ≡ 3.0)', () => {
    _resetValidationLoader();
    const v300 = getValidator('get_products', 'request', '3.0.0');
    const v301 = getValidator('get_products', 'request', '3.0.1');
    const vMinor = getValidator('get_products', 'request', '3.0');
    assert.ok(v300, '3.0.0 resolves to a compiled validator');
    assert.strictEqual(v300, v301, 'patch pins in same minor share a state');
    assert.strictEqual(v301, vMinor, 'minor pin shares the same state');
  });

  test('distinct minors produce distinct compiled validators', () => {
    _resetValidationLoader();
    const vCurrent = getValidator('get_products', 'request', ADCP_VERSION);
    const vFixture = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    assert.ok(vCurrent, `${ADCP_VERSION} validator compiled`);
    assert.ok(vFixture, `${FIXTURE_VERSION_PIN} validator compiled`);
    assert.notStrictEqual(vCurrent, vFixture, 'distinct minors compile distinct validator instances');
  });

  test('listValidatorKeys is per-bundle', () => {
    _resetValidationLoader();
    const keysCurrent = listValidatorKeys(ADCP_VERSION);
    const keysFixture = listValidatorKeys(FIXTURE_VERSION_PIN);
    assert.deepStrictEqual(keysCurrent, keysFixture);
  });

  test('repeated calls cache the per-bundle validator', () => {
    _resetValidationLoader();
    const first = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    const second = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    assert.strictEqual(first, second);
  });

  test('unknown version throws with a clear message', () => {
    _resetValidationLoader();
    assert.throws(
      () => getValidator('get_products', 'request', '99.99.99-not-a-real-version'),
      err => /AdCP schema data for version "99\.99\.99-not-a-real-version" not found/.test(err.message)
    );
  });

  test('default version path aliases to ADCP_VERSION explicit path', () => {
    _resetValidationLoader();
    const fromDefault = getValidator('get_products', 'request');
    const fromExplicit = getValidator('get_products', 'request', ADCP_VERSION);
    assert.strictEqual(fromDefault, fromExplicit);
  });

  test('_resetValidationLoader(version) clears one bundle, leaves others', () => {
    _resetValidationLoader();
    const vCurrentFirst = getValidator('get_products', 'request', ADCP_VERSION);
    const vFixtureFirst = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    _resetValidationLoader(ADCP_VERSION);
    const vCurrentAfter = getValidator('get_products', 'request', ADCP_VERSION);
    const vFixtureAfter = getValidator('get_products', 'request', FIXTURE_VERSION_PIN);
    assert.notStrictEqual(vCurrentFirst, vCurrentAfter, 'reset bundle re-compiles');
    assert.strictEqual(vFixtureFirst, vFixtureAfter, 'untouched bundle stays cached');
  });

  test('reset by stable patch pin clears the same bundle as the minor pin', () => {
    _resetValidationLoader();
    const beforeReset = getValidator('get_products', 'request', '3.0');
    _resetValidationLoader('3.0.1'); // patch-pinned reset must clear the '3.0' bundle
    const afterReset = getValidator('get_products', 'request', '3.0');
    assert.notStrictEqual(beforeReset, afterReset, 'resetting via a patch-pin clears the resolved minor bundle');
  });

  test('hasSchemaBundle returns true for shipped versions', () => {
    assert.strictEqual(hasSchemaBundle(ADCP_VERSION), true);
    assert.strictEqual(hasSchemaBundle('3.0.0'), true, '3.0.0 collapses to the 3.0 bundle');
    assert.strictEqual(hasSchemaBundle('3.0'), true, 'bare minor resolves to the same bundle');
  });

  test('hasSchemaBundle returns false for unshipped versions', () => {
    assert.strictEqual(hasSchemaBundle('4.0.0'), false, 'no major-4 bundle');
    assert.strictEqual(hasSchemaBundle('99.0.0-beta.1'), false, 'no synthetic prerelease bundle');
  });

  test('hasSchemaBundle returns false for non-version garbage (defense in depth)', () => {
    // resolveBundleKey throws ConfigurationError for unrecognized shapes;
    // hasSchemaBundle's try/catch surfaces the throw as `false` so a
    // malformed input never reaches `path.join` as a directory component.
    assert.strictEqual(hasSchemaBundle('../etc'), false);
    assert.strictEqual(hasSchemaBundle('3foo'), false);
    assert.strictEqual(hasSchemaBundle(''), false);
  });

  test('resolveBundleKey rejects prerelease tags with non-SemVer chars (path-traversal hardening)', () => {
    // Prerelease group restricts to [0-9A-Za-z-] so traversal-like strings
    // can't slip through verbatim into `path.join`. SemVer §9 identifiers
    // are dot-separated alphanumerics; anything else is rejected.
    assert.throws(
      () => resolveBundleKey('3.0.0-/../etc'),
      err => err.code === 'CONFIGURATION_ERROR'
    );
    assert.throws(
      () => resolveBundleKey('3.0.0-foo/bar'),
      err => err.code === 'CONFIGURATION_ERROR'
    );
    assert.throws(
      () => resolveBundleKey('3.0.0-..'),
      err => err.code === 'CONFIGURATION_ERROR'
    );
    assert.strictEqual(hasSchemaBundle('3.0.0-/../etc'), false);
    // Valid SemVer prereleases still pass through.
    assert.strictEqual(resolveBundleKey('3.1.0-beta.1'), '3.1.0-beta.1');
    assert.strictEqual(resolveBundleKey('3.1.0-rc.2'), '3.1.0-rc.2');
    assert.strictEqual(resolveBundleKey('3.0.0-beta-final'), '3.0.0-beta-final');
  });

  test('resolveBundleKey throws ConfigurationError for non-version input', () => {
    assert.throws(
      () => resolveBundleKey('../etc'),
      err => err.code === 'CONFIGURATION_ERROR' && /not a recognized version format/.test(err.message)
    );
    assert.throws(
      () => resolveBundleKey('3foo'),
      err => err.code === 'CONFIGURATION_ERROR'
    );
  });

  test('resolveBundleKey accepts legacy v-prefix aliases', () => {
    assert.strictEqual(resolveBundleKey('v3'), 'v3');
    assert.strictEqual(resolveBundleKey('v2.5'), 'v2.5');
    assert.strictEqual(resolveBundleKey('v2.6'), 'v2.6');
  });
});
