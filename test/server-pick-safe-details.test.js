// Unit tests for pickSafeDetails — security primitive that filters
// freeform error/event detail objects through an explicit allowlist
// with depth + size caps. Adopters use this BEFORE constructing
// AdcpError to ensure no credentials / PII / stack traces cross the
// wire boundary.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { pickSafeDetails } = require('../dist/lib/server/pick-safe-details');

describe('pickSafeDetails — allowlist filtering', () => {
  it('returns undefined for null/undefined input', () => {
    assert.strictEqual(pickSafeDetails(null, ['a']), undefined);
    assert.strictEqual(pickSafeDetails(undefined, ['a']), undefined);
  });

  it('returns undefined for non-object input', () => {
    assert.strictEqual(pickSafeDetails('string', ['a']), undefined);
    assert.strictEqual(pickSafeDetails(42, ['a']), undefined);
    assert.strictEqual(pickSafeDetails(true, ['a']), undefined);
  });

  it('returns undefined for arrays at the top level (use a wrapping object)', () => {
    assert.strictEqual(pickSafeDetails([1, 2, 3], ['a']), undefined);
  });

  it('returns undefined for empty allowlist', () => {
    assert.strictEqual(pickSafeDetails({ a: 1, b: 2 }, []), undefined);
  });

  it('keeps only allowlisted keys at the top level', () => {
    const result = pickSafeDetails(
      { http_status: 503, request_id: 'abc-123', auth_token: 'SECRET', stack: 'at line 42' },
      ['http_status', 'request_id']
    );
    assert.deepStrictEqual(result, { http_status: 503, request_id: 'abc-123' });
  });

  it('returns undefined when no allowlisted keys are present', () => {
    const result = pickSafeDetails({ auth_token: 'SECRET', stack: 'at line 42' }, ['http_status', 'request_id']);
    assert.strictEqual(result, undefined);
  });

  it('preserves primitive values: string, number, boolean, null', () => {
    const result = pickSafeDetails({ s: 'string', n: 42, b: true, nl: null, dropped: 'x' }, ['s', 'n', 'b', 'nl']);
    assert.deepStrictEqual(result, { s: 'string', n: 42, b: true, nl: null });
  });

  it('drops functions, symbols, undefined values', () => {
    const result = pickSafeDetails({ a: () => 0, b: Symbol('x'), c: undefined, d: 'kept' }, ['a', 'b', 'c', 'd']);
    assert.deepStrictEqual(result, { d: 'kept' });
  });

  it('drops Date / RegExp / Map / Set / Error / class instances', () => {
    class MyClass {}
    const result = pickSafeDetails(
      {
        date: new Date(),
        re: /abc/,
        map: new Map(),
        set: new Set(),
        err: new Error('x'),
        instance: new MyClass(),
        kept: 'hi',
      },
      ['date', 're', 'map', 'set', 'err', 'instance', 'kept']
    );
    assert.deepStrictEqual(result, { kept: 'hi' });
  });

  it('recursively filters nested objects with the same allowlist', () => {
    const result = pickSafeDetails(
      {
        outer: { http_status: 503, auth_token: 'SECRET' },
        http_status: 200,
        dropped: 'x',
      },
      ['outer', 'http_status']
    );
    assert.deepStrictEqual(result, {
      outer: { http_status: 503 },
      http_status: 200,
    });
  });

  it('caps depth at default maxDepth=2 — shallow keys keep, deep paths drop', () => {
    // Mixed: top-level has primitive `shallow`, and a nested object
    // whose own primitive is reachable; deeper-still nesting drops
    // entirely. Default maxDepth=2 = top-level + 1 nested level.
    const result = pickSafeDetails(
      {
        shallow: 'kept',
        nested: {
          shallow: 'kept_at_level2',
          even_deeper: { shallow: 'should_drop' },
        },
      },
      ['shallow', 'nested', 'even_deeper']
    );
    assert.ok(result, 'result should not be undefined');
    assert.strictEqual(result.shallow, 'kept');
    assert.strictEqual(result.nested.shallow, 'kept_at_level2');
    assert.ok(!JSON.stringify(result).includes('should_drop'), 'deeply-nested values must drop at default depth');
  });

  it('respects custom maxDepth', () => {
    const input = { a: { a: { a: 'should_keep' } } };
    const result = pickSafeDetails(input, ['a'], { maxDepth: 5 });
    assert.ok(JSON.stringify(result).includes('should_keep'));
  });

  it('returns undefined when serialized result exceeds maxSizeBytes', () => {
    const huge = 'x'.repeat(5000);
    const result = pickSafeDetails({ data: huge }, ['data'], { maxSizeBytes: 1024 });
    assert.strictEqual(result, undefined);
  });

  it('respects custom maxSizeBytes', () => {
    const result = pickSafeDetails({ data: 'small' }, ['data'], { maxSizeBytes: 1024 });
    assert.deepStrictEqual(result, { data: 'small' });
  });

  it('preserves arrays of primitives', () => {
    const result = pickSafeDetails({ tags: ['a', 'b', 'c'], dropped: 'x' }, ['tags']);
    assert.deepStrictEqual(result, { tags: ['a', 'b', 'c'] });
  });

  it('filters arrays of objects by the same allowlist', () => {
    const result = pickSafeDetails(
      {
        items: [
          { code: 'X', secret: 'y' },
          { code: 'Y', secret: 'z' },
        ],
      },
      ['items', 'code']
    );
    assert.deepStrictEqual(result, {
      items: [{ code: 'X' }, { code: 'Y' }],
    });
  });

  it('common adopter pattern: sanitize an upstream-API error response', () => {
    // Realistic shape: GAM rejects an order with a verbose error body
    // that includes credentials in the trace.
    const upstream = {
      http_status: 503,
      request_id: 'gam-req-abc-123',
      gam_error_code: 'INVALID_ARGUMENT',
      details: 'order budget below network minimum',
      // Sensitive fields adopters MUST NOT leak:
      authorization_header: 'Bearer secret-token-XYZ',
      stack_trace: 'at line 42 in /opt/internal/billing.ts',
      tenant_secret_key: 'kms-key-id-aaa',
    };
    const safe = pickSafeDetails(upstream, ['http_status', 'request_id', 'gam_error_code', 'details']);
    assert.deepStrictEqual(safe, {
      http_status: 503,
      request_id: 'gam-req-abc-123',
      gam_error_code: 'INVALID_ARGUMENT',
      details: 'order budget below network minimum',
    });
    assert.ok(!('authorization_header' in safe));
    assert.ok(!('stack_trace' in safe));
    assert.ok(!('tenant_secret_key' in safe));
  });
});
