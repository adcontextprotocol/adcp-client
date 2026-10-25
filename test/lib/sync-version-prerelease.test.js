const { test } = require('node:test');
const assert = require('node:assert/strict');

require('tsx/cjs');
const { nextLibraryVersion, buildCompatibleVersions } = require('../../scripts/sync-version.ts');

for (const prerelease of ['3.3.0-beta.0', '3.3.0-beta.2', '3.3.0-rc.1']) {
  test(`compatibility for ${prerelease} retains stable releases and only its exact preview`, () => {
    const versions = buildCompatibleVersions(prerelease);
    assert.ok(versions.includes(prerelease));
    assert.ok(versions.includes(prerelease.replace('3.3.0-', '3.3-')));
    for (const stable of ['3.0.25', '3.1.29', '3.2.1', '3.2.6', '3.2.7', '3.2']) {
      assert.ok(versions.includes(stable), stable);
    }
    assert.equal(versions.includes('3.2.0'), false);
    assert.equal(versions.includes('3.3'), false);
    assert.equal(versions.includes('3.3-beta'), false);
    assert.equal(versions.includes('3.3-rc'), false);
    assert.ok(
      versions
        .filter(version => /-(?:beta|rc)/.test(version))
        .every(version => version.includes(prerelease.split('-')[1]))
    );
  });
}

test('the stable 3.2.7 pin does not advertise 3.3 preview support', () => {
  assert.ok(buildCompatibleVersions('3.2.7').every(version => !version.startsWith('3.3')));
});

test('a 3.3 preview retains the active stable 3.2 pin', () => {
  const pin = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '../../ADCP_VERSION'), 'utf8')
    .trim();
  if (pin.startsWith('3.2.')) assert.ok(buildCompatibleVersions('3.3.0-beta.0').includes(pin));
});

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
