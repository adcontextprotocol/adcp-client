// Tests for the oneOf variant-selection fix (issue #1337).
//
// The bug: when a success variant has two missing `required` fields and an
// error variant has only a single `not`-at-root error (rejecting because the
// payload has success-shaped fields), `compactUnionErrors` was picking the
// error variant as "best" because it had fewer total residuals (1 vs 2).
// The fix promotes variants with at least one non-`not` residual above
// variants whose only residuals are root-level `not` errors.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { _compactUnionErrors } = require('../../dist/lib/validation/schema-validator.js');

/**
 * Build a minimal synthetic AJV ErrorObject for testing.
 * Only the fields compactUnionErrors inspects are required.
 */
function makeErr(overrides) {
  return {
    keyword: 'required',
    instancePath: '',
    schemaPath: '#/oneOf/0/required',
    params: {},
    message: 'must have required property',
    ...overrides,
  };
}

describe('compactUnionErrors — oneOf variant selection (issue #1337)', () => {
  // Root schema used across tests: a two-variant oneOf mimicking the
  // success | error pattern. Neither variant declares const-constrained
  // properties, so the discriminator-collapse path is not triggered and
  // the residual-count / not-penalty path is exercised.
  const rootSchema = {
    oneOf: [
      {
        // variant 0: "success" — requires currency + timezone
        required: ['account', 'currency', 'period', 'timezone'],
        properties: {
          account: {},
          currency: { type: 'string' },
          period: {},
          timezone: { type: 'string' },
        },
      },
      {
        // variant 1: "error" — has a `not` that rejects success-shaped payloads
        required: ['errors'],
        properties: { errors: { type: 'array' } },
      },
    ],
  };

  test('success variant (required failures) beats error variant (only-not failure)', () => {
    // Error variant has 1 residual (a root `not` error); success variant has
    // 2 residuals (missing currency, missing timezone). Without the fix the
    // error variant won because 1 < 2. With the fix, the success variant wins
    // because at least one of its residuals is a `required` (not a `not`).
    const oneOfRoot = makeErr({
      keyword: 'oneOf',
      schemaPath: '#/oneOf',
      instancePath: '',
      params: { passingSchemas: null },
      message: 'must match exactly one schema in oneOf',
    });
    const successCurrencyErr = makeErr({
      keyword: 'required',
      instancePath: '',
      schemaPath: '#/oneOf/0/required',
      params: { missingProperty: 'currency' },
      message: "must have required property 'currency'",
    });
    const successTimezoneErr = makeErr({
      keyword: 'required',
      instancePath: '',
      schemaPath: '#/oneOf/0/required',
      params: { missingProperty: 'timezone' },
      message: "must have required property 'timezone'",
    });
    const errorNotErr = makeErr({
      keyword: 'not',
      instancePath: '',
      schemaPath: '#/oneOf/1/not',
      params: {},
      message: 'must NOT be valid',
    });

    const compacted = _compactUnionErrors(
      [oneOfRoot, successCurrencyErr, successTimezoneErr, errorNotErr],
      rootSchema
    );

    const surviving = compacted.filter(e => e.keyword !== 'oneOf');
    const survivingPaths = surviving.map(e => e.schemaPath);

    // Success variant's errors should survive, not the error variant's `not`.
    assert.ok(
      survivingPaths.some(p => p.includes('/oneOf/0/')),
      `expected success-variant (oneOf/0) errors to survive, got: ${JSON.stringify(survivingPaths)}`
    );
    assert.ok(
      !survivingPaths.some(p => p.includes('/oneOf/1/')),
      `error-variant (oneOf/1) errors should be dropped, got: ${JSON.stringify(survivingPaths)}`
    );

    // The specific missing fields should be surfaced.
    const pointers = surviving.map(e => e.instancePath + (e.params?.missingProperty ? `/${e.params.missingProperty}` : ''));
    assert.ok(pointers.some(p => p.includes('currency')), `expected /currency in surviving issues, got ${JSON.stringify(pointers)}`);
    assert.ok(pointers.some(p => p.includes('timezone')), `expected /timezone in surviving issues, got ${JSON.stringify(pointers)}`);
  });

  test('regression: error variant with mixed residuals (not + required) can still win on count', () => {
    // When the error variant has BOTH a `not` error AND a `required` error (not
    // all-not), the `onlyNotAtRoot` penalty does not apply. The original count
    // comparison decides — the variant with fewer residuals wins.
    const oneOfRoot = makeErr({
      keyword: 'oneOf',
      schemaPath: '#/oneOf',
      instancePath: '',
      params: { passingSchemas: null },
      message: 'must match exactly one schema in oneOf',
    });
    // Success variant: 3 missing fields (worse)
    const s1 = makeErr({ schemaPath: '#/oneOf/0/required', params: { missingProperty: 'currency' } });
    const s2 = makeErr({ schemaPath: '#/oneOf/0/required', params: { missingProperty: 'timezone' } });
    const s3 = makeErr({ schemaPath: '#/oneOf/0/required', params: { missingProperty: 'account' } });
    // Error variant: not + required (2 residuals, but NOT all-not)
    const eNot = makeErr({ keyword: 'not', instancePath: '', schemaPath: '#/oneOf/1/not', params: {} });
    const eReq = makeErr({ schemaPath: '#/oneOf/1/required', params: { missingProperty: 'errors' } });

    const compacted = _compactUnionErrors([oneOfRoot, s1, s2, s3, eNot, eReq], rootSchema);
    const surviving = compacted.filter(e => e.keyword !== 'oneOf');
    const survivingPaths = surviving.map(e => e.schemaPath);

    // Error variant (2 residuals including non-`not`) beats success variant (3 residuals).
    assert.ok(
      survivingPaths.some(p => p.includes('/oneOf/1/')),
      `expected error-variant (oneOf/1) to win when it has fewer mixed residuals, got: ${JSON.stringify(survivingPaths)}`
    );
    assert.ok(
      !survivingPaths.some(p => p.includes('/oneOf/0/')),
      `success-variant (oneOf/0) should be dropped, got: ${JSON.stringify(survivingPaths)}`
    );
  });

  test('regression: both variants have only-not residuals — falls back to count', () => {
    // Unusual but valid: both variants have only root `not` errors. The
    // `onlyNotAtRoot` tie-break is equal (both = 1) and count decides.
    const oneOfRoot = makeErr({
      keyword: 'oneOf',
      schemaPath: '#/oneOf',
      instancePath: '',
      params: { passingSchemas: null },
    });
    const notA = makeErr({ keyword: 'not', instancePath: '', schemaPath: '#/oneOf/0/not', params: {} });
    const notB1 = makeErr({ keyword: 'not', instancePath: '', schemaPath: '#/oneOf/1/not', params: {} });
    const notB2 = makeErr({ keyword: 'not', instancePath: '', schemaPath: '#/oneOf/1/not', params: {}, message: 'not2' });

    const compacted = _compactUnionErrors([oneOfRoot, notA, notB1, notB2], rootSchema);
    const surviving = compacted.filter(e => e.keyword !== 'oneOf');
    const survivingPaths = surviving.map(e => e.schemaPath);

    // Variant 0 has 1 `not` residual; variant 1 has 2. Variant 0 wins.
    assert.ok(
      survivingPaths.some(p => p.includes('/oneOf/0/')),
      `expected variant 0 (fewer all-not residuals) to survive, got: ${JSON.stringify(survivingPaths)}`
    );
    assert.ok(
      !survivingPaths.some(p => p.includes('/oneOf/1/')),
      `variant 1 should be dropped, got: ${JSON.stringify(survivingPaths)}`
    );
  });

  test('regression: not error nested inside variant does not trigger penalty', () => {
    // A `not` error at a nested path (e.g. /account/0/not) should NOT trigger
    // the onlyNotAtRoot penalty — only `not` errors with instancePath === '' do.
    const oneOfRoot = makeErr({
      keyword: 'oneOf',
      schemaPath: '#/oneOf',
      instancePath: '',
      params: { passingSchemas: null },
    });
    // Variant 0: nested `not` at /account (not at root) + required
    const nestedNot = makeErr({ keyword: 'not', instancePath: '/account', schemaPath: '#/oneOf/0/properties/account/not' });
    // Variant 1: required (fewer errors)
    const req = makeErr({ schemaPath: '#/oneOf/1/required', params: { missingProperty: 'errors' } });

    const compacted = _compactUnionErrors([oneOfRoot, nestedNot, req], rootSchema);
    const surviving = compacted.filter(e => e.keyword !== 'oneOf');
    const survivingPaths = surviving.map(e => e.schemaPath);

    // Variant 0 has 1 error (nested not — NOT penalised); variant 1 has 1 error.
    // They're equal on count and equal on onlyNotAtRoot (variant 0's `not` is
    // nested, so onlyNotAtRoot=0). First-inserted (variant 0) wins.
    assert.ok(
      survivingPaths.some(p => p.includes('/oneOf/0/')),
      `nested not should not trigger penalty; variant 0 should survive, got: ${JSON.stringify(survivingPaths)}`
    );
  });
});
