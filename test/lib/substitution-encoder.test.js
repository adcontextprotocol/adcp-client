const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SubstitutionEncoder,
  MacroInRawValueError,
  CATALOG_MACRO_VECTORS,
  encodeUnreserved,
  isUnreservedOnly,
} = require('../../dist/lib/index.js');

describe('SubstitutionEncoder — RFC 3986 unreserved whitelist', () => {
  const encoder = new SubstitutionEncoder();

  for (const vector of CATALOG_MACRO_VECTORS) {
    it(`matches fixture: ${vector.name}`, () => {
      const encoded = encoder.encode_for_url_context(vector.value);
      const fullUrl = vector.template.split(vector.macro).join(encoded);
      assert.equal(fullUrl, vector.expected, `URL produced by encoder must match fixture expected`);
    });
  }

  it('encodes unreserved characters through unchanged', () => {
    const unreserved = 'abcXYZ0123456789-._~';
    assert.equal(encoder.encode_for_url_context(unreserved), unreserved);
  });

  it('percent-encodes parens (sub-delims), unlike encodeURIComponent', () => {
    assert.equal(encoder.encode_for_url_context('alert(0)'), 'alert%280%29');
    assert.notEqual(encoder.encode_for_url_context('alert(0)'), encodeURIComponent('alert(0)'));
  });

  it('encodes CR + LF as %0D%0A (CRLF injection neutralized)', () => {
    const out = encoder.encode_for_url_context('a\r\nb');
    assert.equal(out, 'a%0D%0Ab');
  });

  it('encodes braces so AdCP macros cannot re-expand', () => {
    assert.equal(encoder.encode_for_url_context('{DEVICE_ID}'), '%7BDEVICE_ID%7D');
  });

  it('emits uppercase hex per RFC 3986 §2.1', () => {
    const encoded = encoder.encode_for_url_context('é');
    assert.equal(encoded, '%C3%A9');
    assert.notEqual(encoded, encoded.toLowerCase());
  });

  it('encodes U+202E bidi override via UTF-8 bytes', () => {
    assert.equal(encoder.encode_for_url_context('\u202E'), '%E2%80%AE');
  });

  it('encodes non-ASCII via UTF-8 (RFC 3986 §2.5)', () => {
    // U+1F600 grinning face → F0 9F 98 80
    assert.equal(encoder.encode_for_url_context('\u{1F600}'), '%F0%9F%98%80');
  });
});

describe('SubstitutionEncoder — reject_if_contains_macro', () => {
  const encoder = new SubstitutionEncoder();

  it('accepts values without macro syntax', () => {
    assert.doesNotThrow(() => encoder.reject_if_contains_macro('café-amsterdam'));
    assert.doesNotThrow(() => encoder.reject_if_contains_macro('00013&cmd=drop'));
  });

  it('throws MacroInRawValueError when value contains an AdCP macro', () => {
    assert.throws(
      () => encoder.reject_if_contains_macro('vacancy-{DEVICE_ID}-42'),
      err => err instanceof MacroInRawValueError && err.matched_macro === '{DEVICE_ID}'
    );
  });

  it('ignores lowercase / non-macro brace usage', () => {
    // {foo} doesn't match the macro naming convention (uppercase-only leading char).
    assert.doesNotThrow(() => encoder.reject_if_contains_macro('price {usd}'));
  });
});

describe('encodeUnreserved and isUnreservedOnly primitives', () => {
  it('encodeUnreserved is available as a function export', () => {
    assert.equal(typeof encodeUnreserved, 'function');
    assert.equal(encodeUnreserved('café'), 'caf%C3%A9');
  });

  it('isUnreservedOnly accepts valid outputs', () => {
    for (const vector of CATALOG_MACRO_VECTORS) {
      const encoded = encodeUnreserved(vector.value);
      assert.ok(
        isUnreservedOnly(encoded),
        `expected encoded form of ${vector.name} to pass unreserved-only check: ${encoded}`
      );
    }
  });

  it('isUnreservedOnly rejects raw reserved characters', () => {
    assert.equal(isUnreservedOnly('a&b'), false);
    assert.equal(isUnreservedOnly('a=b'), false);
    assert.equal(isUnreservedOnly('(foo)'), false);
  });

  it('isUnreservedOnly rejects malformed percent sequences', () => {
    assert.equal(isUnreservedOnly('%GG'), false);
    assert.equal(isUnreservedOnly('%1'), false);
  });
});
