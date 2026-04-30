// AdCP 3.1 envelope-level version string emission per spec PR
// adcontextprotocol/adcp#3493. Buyers pinned to 3.1+ dual-emit
// `adcp_major_version` (integer, deprecated) and `adcp_version`
// (release-precision string). 3.0-pinned buyers emit only the integer.
// `extractVersionUnsupportedDetails` parses seller's structured error
// response so buyers can downgrade their pin and retry.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { bundleSupportsAdcpVersionField, extractVersionUnsupportedDetails } = require('../../dist/lib/index.js');

describe('bundleSupportsAdcpVersionField gate', () => {
  test('3.0 stable bundle does not have the field', () => {
    assert.strictEqual(bundleSupportsAdcpVersionField('3.0'), false);
  });

  test('3.0 prerelease bundle does not have the field', () => {
    // Bundle keys for 3.0 prereleases stay verbatim; major=3 minor=0 → no field.
    assert.strictEqual(bundleSupportsAdcpVersionField('3.0.0-beta.1'), false);
    assert.strictEqual(bundleSupportsAdcpVersionField('3.0.0-rc.2'), false);
  });

  test('3.1 stable bundle has the field', () => {
    assert.strictEqual(bundleSupportsAdcpVersionField('3.1'), true);
  });

  test('3.1 prerelease bundle has the field', () => {
    assert.strictEqual(bundleSupportsAdcpVersionField('3.1.0-beta.1'), true);
    assert.strictEqual(bundleSupportsAdcpVersionField('3.1.0-rc.2'), true);
  });

  test('major 4+ bundles have the field', () => {
    assert.strictEqual(bundleSupportsAdcpVersionField('4.0'), true);
    assert.strictEqual(bundleSupportsAdcpVersionField('4.0.0-beta.1'), true);
    assert.strictEqual(bundleSupportsAdcpVersionField('5.2'), true);
  });

  test('legacy v2 aliases do not have the field', () => {
    assert.strictEqual(bundleSupportsAdcpVersionField('v3'), false);
    assert.strictEqual(bundleSupportsAdcpVersionField('v2.5'), false);
    assert.strictEqual(bundleSupportsAdcpVersionField('v2.6'), false);
  });

  test('non-version garbage returns false (defense in depth)', () => {
    assert.strictEqual(bundleSupportsAdcpVersionField(''), false);
    assert.strictEqual(bundleSupportsAdcpVersionField('not-a-version'), false);
  });
});

describe('extractVersionUnsupportedDetails', () => {
  test('parses raw data block with all fields', () => {
    const out = extractVersionUnsupportedDetails({
      supported_versions: ['3.0', '3.1'],
      requested_version: '4.0',
      build_version: '3.1.2',
    });
    assert.deepStrictEqual(out, {
      supported_versions: ['3.0', '3.1'],
      requested_version: '4.0',
      build_version: '3.1.2',
    });
  });

  test('parses error envelope wrapper (data nested)', () => {
    const out = extractVersionUnsupportedDetails({
      data: { supported_versions: ['3.0'], requested_version: '3.1' },
    });
    assert.deepStrictEqual(out, {
      supported_versions: ['3.0'],
      requested_version: '3.1',
    });
  });

  test('parses error envelope wrapper (details nested)', () => {
    const out = extractVersionUnsupportedDetails({
      details: { supported_versions: ['3.1'] },
    });
    assert.deepStrictEqual(out, { supported_versions: ['3.1'] });
  });

  test('parses adcp_error.data nesting', () => {
    const out = extractVersionUnsupportedDetails({
      adcp_error: {
        code: 'VERSION_UNSUPPORTED',
        data: { supported_versions: ['3.0', '3.1'] },
      },
    });
    assert.deepStrictEqual(out, { supported_versions: ['3.0', '3.1'] });
  });

  test('returns undefined for empty / missing details', () => {
    assert.strictEqual(extractVersionUnsupportedDetails(undefined), undefined);
    assert.strictEqual(extractVersionUnsupportedDetails(null), undefined);
    assert.strictEqual(extractVersionUnsupportedDetails({}), undefined);
    assert.strictEqual(extractVersionUnsupportedDetails({ data: {} }), undefined);
  });

  test('filters non-string entries from supported_versions', () => {
    const out = extractVersionUnsupportedDetails({
      supported_versions: ['3.0', 3.1, null, '3.1', undefined],
    });
    assert.deepStrictEqual(out, { supported_versions: ['3.0', '3.1'] });
  });

  test('drops fields with wrong types silently', () => {
    const out = extractVersionUnsupportedDetails({
      supported_versions: 'not-an-array',
      requested_version: 42,
      build_version: { not: 'a string' },
    });
    assert.strictEqual(out, undefined);
  });

  test('partial population — supported_versions only', () => {
    const out = extractVersionUnsupportedDetails({ supported_versions: ['3.0'] });
    assert.deepStrictEqual(out, { supported_versions: ['3.0'] });
  });
});
