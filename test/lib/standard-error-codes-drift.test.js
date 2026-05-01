// Drift guard: STANDARD_ERROR_CODES must enumerate every value in
// ErrorCodeValues (auto-generated from the spec's error-code.json enum).
//
// This test catches the failure mode that produced the v6.x drift: someone
// ships a spec rev that adds new codes to error-code.json, the codegen picks
// them up in ErrorCodeValues, but error-codes.ts is hand-maintained and
// nobody updates the description/recovery rows. Without this guard, the
// `satisfies` check in error-codes.ts catches the missing keys at compile
// time only because StandardErrorCode is now type-derived from the generated
// enum — but if someone breaks that derivation, this test still fires.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { STANDARD_ERROR_CODES, isStandardErrorCode } = require('../../dist/lib/types/error-codes');
const { ErrorCodeValues } = require('../../dist/lib/types/enums.generated');

describe('StandardErrorCode: drift guard against generated enum', () => {
  it('STANDARD_ERROR_CODES covers every ErrorCodeValues entry', () => {
    const tableKeys = Object.keys(STANDARD_ERROR_CODES).sort();
    const enumValues = [...ErrorCodeValues].sort();
    assert.deepStrictEqual(
      tableKeys,
      enumValues,
      'STANDARD_ERROR_CODES is out of sync with ErrorCodeValues — add description+recovery rows for any new codes'
    );
  });

  it('every entry has a non-empty description and a valid recovery classification', () => {
    const validRecovery = new Set(['transient', 'correctable', 'terminal']);
    for (const [code, info] of Object.entries(STANDARD_ERROR_CODES)) {
      assert.ok(typeof info.description === 'string' && info.description.length > 0, `${code}: description missing`);
      assert.ok(validRecovery.has(info.recovery), `${code}: invalid recovery classification "${info.recovery}"`);
    }
  });

  it('isStandardErrorCode recognizes every ErrorCodeValues entry', () => {
    for (const code of ErrorCodeValues) {
      assert.strictEqual(isStandardErrorCode(code), true, `isStandardErrorCode rejected spec code "${code}"`);
    }
  });

  it('isStandardErrorCode rejects unknown codes', () => {
    assert.strictEqual(isStandardErrorCode('NOT_A_REAL_CODE'), false);
    assert.strictEqual(isStandardErrorCode(''), false);
  });
});
