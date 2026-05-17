// toReleasePrecisionWire normalizes bundle keys / version strings to the
// release-precision shape the AdCP 3.1 envelope schema accepts. The wire
// pattern (declared in core/version-envelope.json) is
// `^\d+\.\d+(-[a-zA-Z0-9.-]+)?$` — full-semver bundle keys
// (`'3.1.0-beta.0'`) are NOT valid wire values per the schema's own
// normalization rule, and a 3.1-pinned client must collapse the PATCH
// segment before emitting `adcp_version`.
//
// Without this normalization, buildVersionEnvelope emits the bundle key
// verbatim, sellers AJV-reject the request body with a pattern error,
// and 3.1+ pinning is silently broken.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { toReleasePrecisionWire } = require('../../dist/lib/index.js');

// The exact pattern from /schemas/3.1.0-beta.0/core/version-envelope.json.
// Pinned here so the test catches a wire-emit regression even if a future
// schema cache isn't present in CI.
const WIRE_PATTERN = /^\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;

describe('toReleasePrecisionWire — release-precision normalization', () => {
  test('stable bundle keys pass through unchanged', () => {
    assert.strictEqual(toReleasePrecisionWire('3.0'), '3.0');
    assert.strictEqual(toReleasePrecisionWire('3.1'), '3.1');
    assert.strictEqual(toReleasePrecisionWire('4.0'), '4.0');
  });

  test('full stable semver collapses PATCH segment', () => {
    assert.strictEqual(toReleasePrecisionWire('3.0.0'), '3.0');
    assert.strictEqual(toReleasePrecisionWire('3.0.11'), '3.0');
    assert.strictEqual(toReleasePrecisionWire('3.1.2'), '3.1');
  });

  test('prerelease semver collapses PATCH, preserves prerelease tag', () => {
    assert.strictEqual(toReleasePrecisionWire('3.1.0-beta.0'), '3.1-beta.0');
    assert.strictEqual(toReleasePrecisionWire('3.1.0-beta.1'), '3.1-beta.1');
    assert.strictEqual(toReleasePrecisionWire('3.1.0-rc.2'), '3.1-rc.2');
    assert.strictEqual(toReleasePrecisionWire('3.0.0-beta.3'), '3.0-beta.3');
  });

  test('release-precision-shaped input passes through unchanged', () => {
    // Sellers advertise supported_versions in this exact shape — buyers
    // pinning to a string they read off the wire must be idempotent.
    assert.strictEqual(toReleasePrecisionWire('3.1-beta'), '3.1-beta');
    assert.strictEqual(toReleasePrecisionWire('3.1-beta.0'), '3.1-beta.0');
    assert.strictEqual(toReleasePrecisionWire('3.0-rc.1'), '3.0-rc.1');
  });

  test('legacy aliases pass through unchanged', () => {
    // Legacy-aliased clients don't carry the envelope field anyway, so
    // round-tripping these is documentation-only — but the function MUST
    // not throw on inputs the rest of the version surface accepts.
    assert.strictEqual(toReleasePrecisionWire('v3'), 'v3');
    assert.strictEqual(toReleasePrecisionWire('v2.5'), 'v2.5');
    assert.strictEqual(toReleasePrecisionWire('v2.6'), 'v2.6');
  });

  test('all valid outputs match the version-envelope.json wire pattern', () => {
    // Cross-check: every non-legacy output of the normalizer must be
    // accepted by the schema's own `adcp_version` pattern. Without this
    // assertion the function could "succeed" while emitting a value
    // sellers will pattern-reject.
    const stableBundles = ['3.0', '3.1', '4.0', '5.2'];
    const fullSemvers = ['3.0.0', '3.0.11', '3.1.2'];
    const prereleases = ['3.1.0-beta.0', '3.0.0-rc.1', '3.1.0-rc.2'];
    const releasePrecision = ['3.1-beta', '3.1-beta.0', '3.0-rc.1'];

    for (const input of [...stableBundles, ...fullSemvers, ...prereleases, ...releasePrecision]) {
      const wire = toReleasePrecisionWire(input);
      assert.match(
        wire,
        WIRE_PATTERN,
        `toReleasePrecisionWire(${JSON.stringify(input)}) = ${JSON.stringify(wire)} ` +
          `must satisfy version-envelope.json pattern ${WIRE_PATTERN}`
      );
    }
  });

  test('rejects unrecognized shapes loudly', () => {
    // Internal misuse surfaces as a ConfigurationError rather than a
    // silent wire-shape violation. Don't tighten the assertion to a
    // specific class — the throw is enough.
    assert.throws(() => toReleasePrecisionWire(''));
    assert.throws(() => toReleasePrecisionWire('not-a-version'));
    assert.throws(() => toReleasePrecisionWire('3'));
    assert.throws(() => toReleasePrecisionWire('3.x'));
    assert.throws(() => toReleasePrecisionWire('3.0.0.0'));
    // Trailing dot on prerelease — wire regex would accept (`.` is in the
    // wire char class) but SemVer §9 says prerelease IDs can't be empty,
    // so this is rejected. Confirms the "stricter than wire pattern" note
    // in the JSDoc is enforced by code, not just doc.
    assert.throws(() => toReleasePrecisionWire('3.1.0-beta.'));
    assert.throws(() => toReleasePrecisionWire('3.0.'));
  });

  test('leading-zero inputs round-trip (wire-valid by spec pattern)', () => {
    // The spec wire pattern is `\d+\.\d+` — `'03.01'` matches. The
    // normalizer follows suit rather than imposing extra structure no
    // upstream caller is asking for. Documents the precedence story:
    // we don't normalize numeric components, only the patch-collapse.
    assert.strictEqual(toReleasePrecisionWire('03.01'), '03.01');
  });
});
