const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('crypto');

const { canonicalize, canonicalJsonSha256 } = require('../../dist/lib/utils/jcs.js');

describe('JCS (RFC 8785) canonicalization', () => {
  describe('primitives', () => {
    it('serializes null, true, false', () => {
      assert.equal(canonicalize(null), 'null');
      assert.equal(canonicalize(true), 'true');
      assert.equal(canonicalize(false), 'false');
    });

    it('serializes numbers per ECMAScript Number::toString', () => {
      assert.equal(canonicalize(0), '0');
      assert.equal(canonicalize(-0), '0'); // JCS §3.2.2.3: -0 renders as 0
      assert.equal(canonicalize(1), '1');
      assert.equal(canonicalize(1.5), '1.5');
      assert.equal(canonicalize(1e100), '1e+100');
    });

    it('rejects non-finite numbers', () => {
      assert.throws(() => canonicalize(Infinity), /non-finite/);
      assert.throws(() => canonicalize(-Infinity), /non-finite/);
      assert.throws(() => canonicalize(NaN), /non-finite/);
    });

    it('rejects BigInt, undefined, function, symbol', () => {
      assert.throws(() => canonicalize(1n), /BigInt/);
      assert.throws(() => canonicalize(undefined), /undefined/);
      assert.throws(() => canonicalize(() => {}), /function/);
      assert.throws(() => canonicalize(Symbol('x')), /symbol/);
    });
  });

  describe('strings', () => {
    it('wraps in double quotes and escapes control chars', () => {
      assert.equal(canonicalize('hello'), '"hello"');
      assert.equal(canonicalize('with "quotes"'), '"with \\"quotes\\""');
      assert.equal(canonicalize('with\\backslash'), '"with\\\\backslash"');
      assert.equal(canonicalize('tab\there'), '"tab\\there"');
      assert.equal(canonicalize('nl\nhere'), '"nl\\nhere"');
      assert.equal(canonicalize('\u0001bell'), '"\\u0001bell"');
    });

    it('does not escape forward slash or non-ASCII', () => {
      assert.equal(canonicalize('path/to/resource'), '"path/to/resource"');
      assert.equal(canonicalize('café'), '"café"');
      assert.equal(canonicalize('日本'), '"日本"');
    });
  });

  describe('arrays', () => {
    it('preserves element order', () => {
      assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
    });

    it('coerces undefined elements to null (matches JSON.stringify)', () => {
      assert.equal(canonicalize([1, undefined, 3]), '[1,null,3]');
    });
  });

  describe('objects', () => {
    it('sorts keys by UTF-16 code units', () => {
      assert.equal(canonicalize({ b: 2, a: 1, c: 3 }), '{"a":1,"b":2,"c":3}');
    });

    it('produces identical output regardless of insertion order', () => {
      const a = { foo: 1, bar: 2 };
      const b = { bar: 2, foo: 1 };
      assert.equal(canonicalize(a), canonicalize(b));
    });

    it('drops undefined properties', () => {
      assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
    });

    it('distinguishes explicit null from missing', () => {
      assert.notEqual(canonicalize({ a: 1, b: null }), canonicalize({ a: 1 }));
    });

    it('handles nested objects with stable sort at every level', () => {
      const out = canonicalize({ z: { y: 2, x: 1 }, a: { c: 3, b: 2 } });
      assert.equal(out, '{"a":{"b":2,"c":3},"z":{"x":1,"y":2}}');
    });
  });

  describe('canonicalJsonSha256', () => {
    it('matches SHA-256 of canonical string', () => {
      const payload = { b: 2, a: 1 };
      const expected = createHash('sha256').update('{"a":1,"b":2}').digest('hex');
      assert.equal(canonicalJsonSha256(payload), expected);
    });

    it('produces same hash for semantically equivalent payloads', () => {
      const a = { budget: 5000, start: '2026-01-01', tags: ['a', 'b'] };
      const b = { tags: ['a', 'b'], start: '2026-01-01', budget: 5000 };
      assert.equal(canonicalJsonSha256(a), canonicalJsonSha256(b));
    });

    it('produces different hash when payload genuinely differs', () => {
      const a = { budget: 5000 };
      const b = { budget: 5001 };
      assert.notEqual(canonicalJsonSha256(a), canonicalJsonSha256(b));
    });
  });

  describe('RFC 8785 test vectors', () => {
    // Subset of vectors from https://www.rfc-editor.org/rfc/rfc8785#appendix-B
    it('A.1: simple object with number', () => {
      assert.equal(canonicalize({ 'a': 1, 'b': 2 }), '{"a":1,"b":2}');
    });

    it('key sorting: unicode vs ascii', () => {
      // 'a' (0x61) < 'b' (0x62) < 'é' (0xe9)
      assert.equal(canonicalize({ 'é': 3, 'b': 2, 'a': 1 }), '{"a":1,"b":2,"é":3}');
    });
  });
});
