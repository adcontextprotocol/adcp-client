/**
 * Self-consistency check: the auto-derived COMPATIBLE_ADCP_VERSIONS list
 * (scripts/sync-version.ts) MUST contain the current ADCP_VERSION pin.
 *
 * Background: the 3.0.9 / 3.0.10 / 3.0.11 chore PRs forgot to manually
 * append the new patch to the hardcoded array literal that previously
 * lived in the version.ts template — capping the compat surface at
 * 3.0.8 even though ADCP_VERSION moved to 3.0.11. Tied to the
 * SDK-build-time schema URL pinning drift surfaced by
 * adcontextprotocol/adcp#4419. The script is now auto-derived; this
 * test locks the invariant so a future regression (e.g. someone
 * reverting the auto-derive to the old hardcoded shape) fails loud at
 * CI rather than slipping out as schema URL drift on the next release.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { ADCP_VERSION, COMPATIBLE_ADCP_VERSIONS, isCompatibleWith } = require('../../dist/lib/version.js');

describe('COMPATIBLE_ADCP_VERSIONS self-consistency', () => {
  test('includes the current ADCP_VERSION pin', () => {
    assert.ok(
      COMPATIBLE_ADCP_VERSIONS.includes(ADCP_VERSION),
      `ADCP_VERSION=${ADCP_VERSION} is not present in COMPATIBLE_ADCP_VERSIONS=` +
        `[${COMPATIBLE_ADCP_VERSIONS.join(', ')}]. ` +
        `Run \`npm run sync-version\` to regenerate src/lib/version.ts so the ` +
        `compat list extends through the current pin.`
    );
  });

  test('isCompatibleWith returns true for the current ADCP_VERSION', () => {
    assert.equal(isCompatibleWith(ADCP_VERSION), true);
  });

  test('enumerates every 3.0.x patch from .0 up through the current pin', () => {
    const match = /^3\.0\.(\d+)$/.exec(ADCP_VERSION);
    if (!match) return; // pre-release or future major/minor — separate gate
    const patch = Number(match[1]);
    for (let p = 0; p <= patch; p++) {
      const v = `3.0.${p}`;
      assert.ok(
        COMPATIBLE_ADCP_VERSIONS.includes(v),
        `Expected ${v} in COMPATIBLE_ADCP_VERSIONS — auto-derivation should fill the ` +
          `3.0.0..${ADCP_VERSION} range without gaps.`
      );
    }
  });

  test('preserves the pre-3.0 legacy aliases (COMPATIBLE_PREFIX)', () => {
    // Belt-and-suspenders against a regression that drops legacy entries
    // while keeping 3.0.x intact (e.g. a future "clean up old aliases" PR
    // that loses them silently). Catches that class without coupling to
    // the exact prefix membership — adopters that pinned `v2.5` /
    // `v2.6` / `v3` legacy aliases must keep matching.
    for (const legacy of ['v2.5', 'v2.6', 'v3', '3.0.0-beta.1', '3.0.0-beta.3']) {
      assert.ok(
        COMPATIBLE_ADCP_VERSIONS.includes(legacy),
        `Legacy alias ${legacy} dropped from COMPATIBLE_ADCP_VERSIONS — would break ` +
          `adopters who pinned the alias as their adcpVersion option.`
      );
    }
  });
});
