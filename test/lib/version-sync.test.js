const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  ADCP_VERSION,
  COMPATIBLE_ADCP_VERSIONS,
  LIBRARY_VERSION,
  VERSION_INFO,
  toReleasePrecisionVersion,
} = require('../../dist/lib/version.js');

test('exported SDK library version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.equal(LIBRARY_VERSION, pkg.version);
  assert.equal(VERSION_INFO.library, pkg.version);
});

test('AdCP semver pins normalize to release-precision wire values', () => {
  assert.equal(toReleasePrecisionVersion('3.1.0-beta.7'), '3.1-beta.7');
  assert.equal(toReleasePrecisionVersion('3.2.0-beta.1'), '3.2-beta.1');
  assert.equal(toReleasePrecisionVersion('3.1.0'), '3.1');
  assert.equal(toReleasePrecisionVersion('3.1-beta.7'), '3.1-beta.7');
});

test('3.2 beta remains exact while retaining the complete supported 3.0 and 3.1 GA lines', () => {
  assert.equal(ADCP_VERSION, '3.2.0-beta.3');
  assert.ok(COMPATIBLE_ADCP_VERSIONS.includes('3.0.24'));
  assert.ok(COMPATIBLE_ADCP_VERSIONS.includes('3.1.15'));
  assert.ok(COMPATIBLE_ADCP_VERSIONS.includes('3.2.0-beta.3'));
  assert.ok(COMPATIBLE_ADCP_VERSIONS.includes('3.2-beta.3'));
  assert.ok(!COMPATIBLE_ADCP_VERSIONS.includes('3.2.0-beta.1'));
  assert.ok(!COMPATIBLE_ADCP_VERSIONS.includes('3.2-beta.1'));
  assert.ok(!COMPATIBLE_ADCP_VERSIONS.includes('3.2.0-beta.0'));
  assert.ok(!COMPATIBLE_ADCP_VERSIONS.includes('3.2-beta.0'));
  assert.ok(!COMPATIBLE_ADCP_VERSIONS.includes('3.2-beta'));
  assert.ok(!COMPATIBLE_ADCP_VERSIONS.includes('3.2'));
});
