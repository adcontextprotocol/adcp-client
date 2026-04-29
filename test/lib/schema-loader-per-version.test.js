// Phase A of Stage 3: schema-loader holds per-version state.
//
// Asserts that the same SDK process can compile validators for `3.0.0`
// and `3.0.1` side by side, and that asking for an unbundled version
// produces a clear error rather than silently falling back to the
// SDK-pinned default.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  getValidator,
  listValidatorKeys,
  _resetValidationLoader,
} = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

describe('schema-loader per-version state', () => {
  test('default version (no argument) uses ADCP_VERSION', () => {
    _resetValidationLoader();
    const keys = listValidatorKeys();
    assert.ok(keys.length > 0, 'default loader has validators');
    assert.ok(keys.includes('get_products::request'), 'expected get_products::request in default version');
  });

  test('3.0.0 and 3.0.1 produce distinct compiled validators', () => {
    _resetValidationLoader();

    const v300 = getValidator('get_products', 'request', '3.0.0');
    const v301 = getValidator('get_products', 'request', '3.0.1');

    assert.ok(v300, '3.0.0 validator compiled');
    assert.ok(v301, '3.0.1 validator compiled');
    assert.notStrictEqual(v300, v301, 'each version compiles its own validator instance — they must not be aliased');
  });

  test('listValidatorKeys is per-version', () => {
    _resetValidationLoader();
    const keys300 = listValidatorKeys('3.0.0');
    const keys301 = listValidatorKeys('3.0.1');
    // Both versions ship the same canonical AdCP tool surface; the keys
    // should match. (When a future minor adds a tool, this assertion lifts
    // to a containment check on the older version.)
    assert.deepStrictEqual(keys300, keys301);
  });

  test('repeated calls cache the per-version validator', () => {
    _resetValidationLoader();
    const first = getValidator('get_products', 'request', '3.0.1');
    const second = getValidator('get_products', 'request', '3.0.1');
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

  test('default version export matches package state', () => {
    // Sanity check: the default falls back to ADCP_VERSION (currently 3.0.1).
    // If ADCP_VERSION ever bumps without a corresponding schema bundle, this
    // test surfaces the mismatch immediately.
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
    const v300First = getValidator('get_products', 'request', '3.0.0');
    const v301First = getValidator('get_products', 'request', '3.0.1');
    _resetValidationLoader('3.0.0');
    const v300After = getValidator('get_products', 'request', '3.0.0');
    const v301After = getValidator('get_products', 'request', '3.0.1');
    assert.notStrictEqual(v300First, v300After, '3.0.0 was reset — should re-compile to a new function instance');
    assert.strictEqual(v301First, v301After, '3.0.1 was untouched — should still be the same instance');
  });
});
