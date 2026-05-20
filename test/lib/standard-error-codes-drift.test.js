// Drift guard: STANDARD_ERROR_CODES must enumerate every code the SDK
// claims to know — both manifest-derived (`ErrorCodeValues`) and forward-
// compat overlay (`FORWARD_COMPAT_ERROR_CODES`).
//
// This test catches two failure modes:
//   1. Spec rev adds new codes to error-code.json, codegen picks them up in
//      ErrorCodeValues, but the runtime table loses sync. (The `satisfies`
//      check in error-codes.ts catches this at compile time; this test is
//      the runtime backstop.)
//   2. A code that lived in the forward-compat overlay also landed in the
//      manifest because the primary `ADCP_VERSION` pin advanced — the
//      overlay entry is now redundant and must be deleted. (Otherwise the
//      table carries divergent metadata for the same code.)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { STANDARD_ERROR_CODES, isStandardErrorCode } = require('../../dist/lib/types/error-codes');
const { ErrorCodeValues } = require('../../dist/lib/types/enums.generated');
const { FORWARD_COMPAT_ERROR_CODES } = require('../../dist/lib/types/forward-compat-error-codes');

describe('StandardErrorCode: drift guard against manifest + overlay', () => {
  it('STANDARD_ERROR_CODES covers manifest ∪ overlay (no orphans, no gaps)', () => {
    const tableKeys = new Set(Object.keys(STANDARD_ERROR_CODES));
    const expected = new Set([...ErrorCodeValues, ...Object.keys(FORWARD_COMPAT_ERROR_CODES)]);
    assert.deepStrictEqual(
      [...tableKeys].sort(),
      [...expected].sort(),
      'STANDARD_ERROR_CODES out of sync with ErrorCodeValues ∪ FORWARD_COMPAT_ERROR_CODES — add description+recovery rows for any new codes, or delete redundant overlay entries when the primary pin advances.'
    );
  });

  it('manifest and overlay are disjoint (overlay entries are deleted when the pin catches up)', () => {
    const manifestCodes = new Set(ErrorCodeValues);
    const overlap = Object.keys(FORWARD_COMPAT_ERROR_CODES).filter(c => manifestCodes.has(c));
    assert.deepStrictEqual(
      overlap,
      [],
      `Forward-compat overlay contains codes already in the manifest: ${overlap.join(', ')}. ` +
        `When the primary ADCP_VERSION pin advances to a release that includes a code, delete the overlay entry in the same PR.`
    );
  });

  it('every entry has a non-empty description and a valid recovery classification', () => {
    const validRecovery = new Set(['transient', 'correctable', 'terminal']);
    for (const [code, info] of Object.entries(STANDARD_ERROR_CODES)) {
      assert.ok(typeof info.description === 'string' && info.description.length > 0, `${code}: description missing`);
      assert.ok(validRecovery.has(info.recovery), `${code}: invalid recovery classification "${info.recovery}"`);
    }
  });

  it('overlay entries carry a sinceAdcpVersion attribution', () => {
    for (const [code, info] of Object.entries(FORWARD_COMPAT_ERROR_CODES)) {
      assert.ok(
        typeof info.sinceAdcpVersion === 'string' && /^\d+\.\d+/.test(info.sinceAdcpVersion),
        `${code}: sinceAdcpVersion missing or malformed`
      );
    }
  });

  it('isStandardErrorCode recognizes every manifest code', () => {
    for (const code of ErrorCodeValues) {
      assert.strictEqual(isStandardErrorCode(code), true, `isStandardErrorCode rejected spec code "${code}"`);
    }
  });

  it('isStandardErrorCode recognizes every overlay code', () => {
    for (const code of Object.keys(FORWARD_COMPAT_ERROR_CODES)) {
      assert.strictEqual(isStandardErrorCode(code), true, `isStandardErrorCode rejected overlay code "${code}"`);
    }
  });

  it('isStandardErrorCode rejects unknown codes', () => {
    assert.strictEqual(isStandardErrorCode('NOT_A_REAL_CODE'), false);
    assert.strictEqual(isStandardErrorCode(''), false);
  });
});
