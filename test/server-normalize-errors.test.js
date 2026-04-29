// Unit tests for the wire-error normalizer at @adcp/sdk/server.
// Coerces ad-hoc adopter shapes (strings, Error instances, plain
// objects, AdcpError-shaped objects) into the canonical wire `Error`
// shape so the response validator accepts the projected envelope.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { normalizeError, normalizeErrors } = require('../dist/lib/server/normalize-errors');

describe('normalizeError — single value coercion', () => {
  it('coerces null/undefined into a generic terminal error', () => {
    const a = normalizeError(null);
    assert.deepStrictEqual(a, { code: 'GENERIC_ERROR', message: 'Unknown error', recovery: 'terminal' });
    const b = normalizeError(undefined);
    assert.deepStrictEqual(b, { code: 'GENERIC_ERROR', message: 'Unknown error', recovery: 'terminal' });
  });

  it('coerces a string into GENERIC_ERROR with the string as message', () => {
    assert.deepStrictEqual(normalizeError('Budget too low'), {
      code: 'GENERIC_ERROR',
      message: 'Budget too low',
      recovery: 'terminal',
    });
  });

  it('coerces a native Error instance using its message', () => {
    const err = new Error('connection refused');
    assert.deepStrictEqual(normalizeError(err), {
      code: 'GENERIC_ERROR',
      message: 'connection refused',
      recovery: 'terminal',
    });
  });

  it('preserves wire-shaped objects with code + message', () => {
    const result = normalizeError({
      code: 'BUDGET_TOO_LOW',
      message: 'Budget below floor',
      recovery: 'correctable',
      field: 'total_budget',
      suggestion: 'Raise to at least $1000',
    });
    assert.strictEqual(result.code, 'BUDGET_TOO_LOW');
    assert.strictEqual(result.recovery, 'correctable');
    assert.strictEqual(result.field, 'total_budget');
    assert.strictEqual(result.suggestion, 'Raise to at least $1000');
  });

  it('whitelists wire-shape fields and drops vendor-specific keys', () => {
    const result = normalizeError({
      code: 'UPSTREAM_REJECTED',
      message: 'GAM rejected the order',
      gam_internal_request_id: 'should_be_dropped',
      stack_trace: 'should_be_dropped',
      recovery: 'transient',
    });
    assert.strictEqual(result.code, 'UPSTREAM_REJECTED');
    assert.strictEqual(result.recovery, 'transient');
    assert.ok(!('gam_internal_request_id' in result));
    assert.ok(!('stack_trace' in result));
  });

  it('clamps retry_after to [1, 3600]', () => {
    assert.strictEqual(normalizeError({ code: 'RATE_LIMITED', message: 'x', retry_after: 0 }).retry_after, 1);
    assert.strictEqual(normalizeError({ code: 'RATE_LIMITED', message: 'x', retry_after: 99999 }).retry_after, 3600);
    assert.strictEqual(normalizeError({ code: 'RATE_LIMITED', message: 'x', retry_after: 60 }).retry_after, 60);
  });

  it('rejects invalid recovery values silently (drops the field)', () => {
    const result = normalizeError({ code: 'X', message: 'y', recovery: 'maybe' });
    assert.strictEqual(result.recovery, undefined);
  });

  it('coerces empty code to GENERIC_ERROR', () => {
    const result = normalizeError({ code: '', message: 'something failed' });
    assert.strictEqual(result.code, 'GENERIC_ERROR');
  });

  it('falls back message to code when message is missing or empty', () => {
    assert.strictEqual(normalizeError({ code: 'X' }).message, 'X');
    assert.strictEqual(normalizeError({ code: 'X', message: '' }).message, 'X');
  });

  it('shallow-copies details so mutation does not leak back to caller', () => {
    const original = { upstream: { request_id: 'abc' } };
    const result = normalizeError({ code: 'X', message: 'y', details: original });
    result.details.upstream.request_id = 'mutated';
    // The shallow copy means the top-level object is independent, but
    // nested objects are shared. Adopters who care about deeper isolation
    // should pre-clone via pickSafeDetails.
    assert.notStrictEqual(result.details, original);
  });

  it('safely stringifies arbitrary objects with no code/message', () => {
    const result = normalizeError({ random: 'object' });
    assert.strictEqual(result.code, 'GENERIC_ERROR');
    assert.ok(result.message.includes('random') || result.message.includes('object'));
  });

  it('handles circular reference gracefully', () => {
    const obj = {};
    obj.self = obj;
    const result = normalizeError(obj);
    assert.strictEqual(result.code, 'GENERIC_ERROR');
    assert.ok(typeof result.message === 'string');
  });
});

describe('normalizeErrors — array coercion', () => {
  it('returns undefined for null/undefined', () => {
    assert.strictEqual(normalizeErrors(null), undefined);
    assert.strictEqual(normalizeErrors(undefined), undefined);
  });

  it('wraps a single value in an array', () => {
    const result = normalizeErrors('one error');
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].message, 'one error');
  });

  it('normalizes each entry of an array independently', () => {
    const result = normalizeErrors([
      'string error',
      new Error('native error'),
      { code: 'WIRE', message: 'wire error', recovery: 'transient' },
      null,
    ]);
    assert.strictEqual(result.length, 4);
    assert.strictEqual(result[0].code, 'GENERIC_ERROR');
    assert.strictEqual(result[1].message, 'native error');
    assert.strictEqual(result[2].code, 'WIRE');
    assert.strictEqual(result[3].message, 'Unknown error');
  });

  it('preserves empty arrays as empty (no auto-collapse to undefined)', () => {
    const result = normalizeErrors([]);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });
});
