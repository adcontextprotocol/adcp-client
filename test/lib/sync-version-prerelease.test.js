const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

require('tsx/cjs');
const { nextLibraryVersion } = require('../../scripts/sync-version.ts');
const ROOT = path.resolve(__dirname, '../..');
const CURRENT_PACKAGE = require('../../package.json');

function generateCandidateVersion(adcpVersion) {
  const candidateRoot = mkdtempSync(path.join(tmpdir(), 'adcp-version-candidate-'));
  try {
    mkdirSync(path.join(candidateRoot, 'scripts'));
    mkdirSync(path.join(candidateRoot, 'src/lib'), { recursive: true });
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(candidateRoot, 'node_modules'), 'dir');
    copyFileSync(path.join(ROOT, 'scripts/sync-version.ts'), path.join(candidateRoot, 'scripts/sync-version.ts'));
    writeFileSync(path.join(candidateRoot, 'ADCP_VERSION'), `${adcpVersion}\n`);
    writeFileSync(
      path.join(candidateRoot, 'package.json'),
      JSON.stringify({ version: CURRENT_PACKAGE.version, adcp_version: CURRENT_PACKAGE.adcp_version })
    );
    const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', 'scripts/sync-version.ts', '--force'], {
      cwd: candidateRoot,
      encoding: 'utf8',
    });
    if (result.status !== 0) return result;
    return { ...result, generated: require(path.join(candidateRoot, 'src/lib/version.ts')) };
  } finally {
    rmSync(candidateRoot, { recursive: true, force: true });
  }
}

test('schema sync accepts exact 3.3 beta and RC pins while retaining maintained GA compatibility', () => {
  for (const prerelease of ['beta.0', 'beta.7', 'rc.2']) {
    const version = `3.3.0-${prerelease}`;
    const result = generateCandidateVersion(version);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const generated = result.generated;
    assert.equal(generated.ADCP_VERSION, version);
    assert.equal(generated.LIBRARY_VERSION, CURRENT_PACKAGE.version);
    for (const stable of [
      'v3',
      '3.0',
      '3.0.0',
      '3.0.25',
      '3.1',
      '3.1.0',
      '3.1.29',
      '3.2',
      '3.2.1',
      '3.2.2',
      '3.2.3',
      '3.2.4',
      '3.2.5',
    ]) {
      assert.ok(generated.isCompatibleWith(stable), `${version} must retain ${stable}`);
    }
    assert.deepEqual(
      generated.COMPATIBLE_ADCP_VERSIONS.filter(value => value.includes('-')),
      [version, `3.3-${prerelease}`]
    );
    for (const unsupported of ['3.2.0', '3.2.6', '3.3', '3.3.0', '3.3-beta', '3.3-rc', '3.4']) {
      assert.equal(generated.isCompatibleWith(unsupported), false, `${version} must not advertise ${unsupported}`);
    }
    assert.equal(new Set(generated.COMPATIBLE_ADCP_VERSIONS).size, generated.COMPATIBLE_ADCP_VERSIONS.length);
  }
});

test('schema sync preserves the current stable pin and its generated compatibility metadata', () => {
  const current = require('../../src/lib/version.ts');
  const result = generateCandidateVersion(current.ADCP_VERSION);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.generated.ADCP_VERSION, current.ADCP_VERSION);
  assert.equal(result.generated.LIBRARY_VERSION, current.LIBRARY_VERSION);
  assert.deepEqual(result.generated.COMPATIBLE_ADCP_VERSIONS, current.COMPATIBLE_ADCP_VERSIONS);
});

test('schema sync still rejects unsupported future lines and unreviewed 3.3 release shapes', () => {
  for (const version of [
    '3.3.0',
    '3.3.1-beta.0',
    '3.3.0-alpha.0',
    '3.3.0-beta',
    '3.3.0-beta.00',
    '3.4.0-beta.0',
    '4.0.0-beta.0',
  ]) {
    const result = generateCandidateVersion(version);
    assert.equal(result.status, 1, `${version} must fail: ${result.stdout}`);
    assert.match(result.stderr, /unrecognized prerelease|outside the 3\.0\.x range/);
  }
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
