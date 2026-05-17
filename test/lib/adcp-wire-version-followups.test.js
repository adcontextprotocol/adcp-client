// Follow-ups to PR #1807 surfaced during expert-review consolidation:
//   1. resolveBundleKey accepts release-precision pins ('3.1-beta',
//      '3.1-beta.0') and resolveSchemaRoot fuzzy-resolves them to the
//      highest matching prerelease cache directory.
//   2. validateAdcpVersionWire(value) throws with a hint pointing at
//      toReleasePrecisionWire when the value isn't a spec-shaped wire
//      string.
//   3. `wireVersion` namespace object groups the three helpers
//      (isSupported, normalize, validate) for stable adopter discovery.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  bundleSupportsAdcpVersionField,
  toReleasePrecisionWire,
  validateAdcpVersionWire,
  wireVersion,
} = require('../../dist/lib/index.js');

const { resolveBundleKey, hasSchemaBundle } = require('../../dist/lib/validation/schema-loader.js');

describe('resolveBundleKey accepts release-precision pins', () => {
  test('MAJOR.MINOR-PRE returns verbatim', () => {
    assert.strictEqual(resolveBundleKey('3.1-beta'), '3.1-beta');
    assert.strictEqual(resolveBundleKey('3.1-beta.0'), '3.1-beta.0');
    assert.strictEqual(resolveBundleKey('3.0-rc.1'), '3.0-rc.1');
    assert.strictEqual(resolveBundleKey('4.0-alpha.0'), '4.0-alpha.0');
  });

  test('rejects malformed release-precision shapes', () => {
    // Empty prerelease tag — SemVer §9 says ID can't be empty.
    assert.throws(() => resolveBundleKey('3.1-'));
    // Path-traversal attempt — same defense as resolveBundleKey's existing
    // hardening on full semver prereleases.
    assert.throws(() => resolveBundleKey('3.1-../etc'));
    // Spaces, slashes, and other non-SemVer §9 characters.
    assert.throws(() => resolveBundleKey('3.1-beta 0'));
    assert.throws(() => resolveBundleKey('3.1-beta/0'));
  });

  test('release-precision-pinned bundle resolves to a cached prerelease dir', () => {
    // hasSchemaBundle returns true when resolveSchemaRoot finds a directory.
    // The fuzzy lookup matches 3.1-beta against any cached 3.1.0-beta.* dir;
    // the cache in this workspace contains 3.1.0-beta.0.
    assert.strictEqual(hasSchemaBundle('3.1-beta'), true);
    assert.strictEqual(hasSchemaBundle('3.1-beta.0'), true);
    // Exact prerelease still works.
    assert.strictEqual(hasSchemaBundle('3.1.0-beta.0'), true);
  });

  test('non-matching release-precision pin returns false', () => {
    // No cached directory has prerelease tag starting with `gamma`.
    assert.strictEqual(hasSchemaBundle('3.1-gamma'), false);
    // No 4.x prerelease cached.
    assert.strictEqual(hasSchemaBundle('4.0-beta'), false);
  });
});

describe('validateAdcpVersionWire — wire-shape assertion', () => {
  test('accepts spec-shaped wire values', () => {
    // All of these match version-envelope.json's pattern.
    assert.doesNotThrow(() => validateAdcpVersionWire('3.0'));
    assert.doesNotThrow(() => validateAdcpVersionWire('3.1'));
    assert.doesNotThrow(() => validateAdcpVersionWire('3.1-beta'));
    assert.doesNotThrow(() => validateAdcpVersionWire('3.1-beta.0'));
    assert.doesNotThrow(() => validateAdcpVersionWire('4.0-rc.1'));
  });

  test('throws with a toReleasePrecisionWire hint on full-semver input', () => {
    // The most adopter-confusing path: a bundle key reached the wire
    // without going through normalization. Error message must name the
    // helper to call.
    const err = (() => {
      try {
        validateAdcpVersionWire('3.1.0-beta.0');
      } catch (e) {
        return e;
      }
      return null;
    })();
    assert.ok(err, 'expected validateAdcpVersionWire to throw');
    assert.match(err.message, /toReleasePrecisionWire/, 'error must name the helper');
    assert.match(err.message, /3\.1\.0-beta\.0/, 'error must echo the offending value');
  });

  test('throws on non-string input', () => {
    assert.throws(() => validateAdcpVersionWire(undefined));
    assert.throws(() => validateAdcpVersionWire(null));
    assert.throws(() => validateAdcpVersionWire(3.1));
    assert.throws(() => validateAdcpVersionWire(['3.1']));
  });

  test('throws on shaped-but-invalid strings', () => {
    // Patch segment present — wire pattern rejects.
    assert.throws(() => validateAdcpVersionWire('3.0.11'));
    assert.throws(() => validateAdcpVersionWire('3.1.0'));
    // Garbage.
    assert.throws(() => validateAdcpVersionWire(''));
    assert.throws(() => validateAdcpVersionWire('not-a-version'));
  });
});

describe('wireVersion namespace', () => {
  test('exposes the three helpers under stable member names', () => {
    assert.strictEqual(typeof wireVersion.isSupported, 'function');
    assert.strictEqual(typeof wireVersion.normalize, 'function');
    assert.strictEqual(typeof wireVersion.validate, 'function');
  });

  test('namespace members are reference-equal to the top-level exports', () => {
    // Same function identity — the namespace is a grouping, not a wrapper.
    // Adopters can pass either reference into APIs that compare by identity.
    assert.strictEqual(wireVersion.isSupported, bundleSupportsAdcpVersionField);
    assert.strictEqual(wireVersion.normalize, toReleasePrecisionWire);
    assert.strictEqual(wireVersion.validate, validateAdcpVersionWire);
  });

  test('round-trip via the namespace produces a valid wire value', () => {
    // The common adopter flow: pin to a bundle key, normalize, validate.
    const bundleKey = '3.1.0-beta.0';
    assert.strictEqual(wireVersion.isSupported(bundleKey), true);
    const wire = wireVersion.normalize(bundleKey);
    assert.strictEqual(wire, '3.1-beta.0');
    assert.doesNotThrow(() => wireVersion.validate(wire));
  });
});
