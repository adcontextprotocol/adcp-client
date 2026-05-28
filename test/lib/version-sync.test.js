const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { LIBRARY_VERSION, VERSION_INFO, toReleasePrecisionVersion } = require('../../dist/lib/version.js');

test('exported SDK library version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.equal(LIBRARY_VERSION, pkg.version);
  assert.equal(VERSION_INFO.library, pkg.version);
});

test('AdCP semver pins normalize to release-precision wire values', () => {
  assert.equal(toReleasePrecisionVersion('3.1.0-beta.7'), '3.1-beta.7');
  assert.equal(toReleasePrecisionVersion('3.1.0'), '3.1');
  assert.equal(toReleasePrecisionVersion('3.1-beta.7'), '3.1-beta.7');
});
