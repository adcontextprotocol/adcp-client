'use strict';

// `adcp diagnose-auth` prints values taken from the agent and its
// authorization server. These tests pin the formatting that keeps a hostile
// token from crashing the command or writing control sequences (#3299).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { formatJwtExpClaim, escapeTerminalControlChars } = require('../../bin/adcp-storyboard-summary.js');

describe('formatJwtExpClaim', () => {
  test('formats a valid NumericDate', () => {
    assert.strictEqual(formatJwtExpClaim(1700000000), '2023-11-14T22:13:20.000Z');
    assert.strictEqual(formatJwtExpClaim(0), '1970-01-01T00:00:00.000Z');
  });

  test('reports a missing claim', () => {
    assert.strictEqual(formatJwtExpClaim(undefined), '(missing)');
    assert.strictEqual(formatJwtExpClaim(null), '(missing)');
  });

  test('does not throw on values outside the Date range', () => {
    assert.strictEqual(formatJwtExpClaim(1e300), '(invalid: 1e+300)');
    assert.strictEqual(formatJwtExpClaim(Number.MAX_VALUE), `(invalid: ${String(Number.MAX_VALUE)})`);
    assert.strictEqual(formatJwtExpClaim(Infinity), '(invalid: Infinity)');
    assert.strictEqual(formatJwtExpClaim(NaN), '(invalid: NaN)');
  });

  test('does not throw on non-numeric values, and escapes and truncates them', () => {
    assert.strictEqual(formatJwtExpClaim('soon'), '(invalid: "soon")');
    assert.strictEqual(formatJwtExpClaim({ a: 1 }), '(invalid: {"a":1})');
    const hostile = formatJwtExpClaim('\u001b]0;pwned\u0007');
    assert.doesNotMatch(hostile, /[\u0000-\u001f]/);
    const long = formatJwtExpClaim('x'.repeat(500));
    assert.ok(long.length < 100, 'long values are truncated');
  });
});

describe('escapeTerminalControlChars on token-derived strings', () => {
  test('neutralizes escape sequences in an iss claim', () => {
    const out = escapeTerminalControlChars('https://as.example\u001b[2J\u001b]8;;evil\u0007');
    assert.doesNotMatch(out, /[\u0000-\u001f\u007f-\u009f]/);
    assert.match(out, /\\u001b/);
  });
});
