const { test } = require('node:test');
const assert = require('node:assert/strict');

require('tsx/cjs');
const { nextLibraryVersion } = require('../../scripts/sync-version.ts');

test('schema sync advances an active SDK beta without producing NaN', () => {
  assert.equal(nextLibraryVersion('14.0.0-beta.6', '3.2.0-beta.4', '3.2.0-beta.5'), '14.0.0-beta.7');
});

test('schema sync preserves the active prerelease tag', () => {
  assert.equal(nextLibraryVersion('14.0.0-rc.2', '3.2.0-beta.4', '3.2.0-beta.5'), '14.0.0-rc.3');
});

test('schema sync starts a new prerelease train for protocol major and minor advances', () => {
  assert.equal(nextLibraryVersion('14.0.0-beta.6', '3.2.0-beta.4', '3.3.0-beta.1'), '14.1.0-beta.0');
  assert.equal(nextLibraryVersion('14.0.0-beta.6', '3.2.0-beta.4', '4.0.0-beta.1'), '15.0.0-beta.0');
});

test('schema sync retains stable version bump behavior outside prerelease mode', () => {
  assert.equal(nextLibraryVersion('13.2.4', '3.1.18', '3.1.19'), '13.2.5');
  assert.equal(nextLibraryVersion('13.2.4', '3.1.18', '3.2.0'), '13.3.0');
  assert.equal(nextLibraryVersion('13.2.4', '3.1.18', '4.0.0'), '14.0.0');
});

test('schema sync rejects malformed versions before writing package metadata', () => {
  assert.throws(
    () => nextLibraryVersion('14.0.0-beta.6', '3.2.0-beta.4', 'not-a-version'),
    /next adcp_version must be a valid semantic version/
  );
});
