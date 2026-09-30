const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  loadCanonicalPrincipalStoryboard,
  loadCanonicalReportingCoreStoryboard,
  loadCanonicalStoryboardFixtureProvenance,
} = require('@adcp/sdk/compliance-fixtures');
const { applyStoryboardVersionOptions, getComplianceCacheDir, parseStoryboard } = require('@adcp/sdk/testing');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function assertCanonicalPackagedFixture({
  fixtureName,
  packageSubpath,
  cacheFileName,
  expectedSha256,
  expectedShape,
  load,
}) {
  const packagedPath = require.resolve(packageSubpath);
  const packagedBytes = fs.readFileSync(packagedPath);
  const loaded = load();
  const fixtureSetProvenance = loadCanonicalStoryboardFixtureProvenance();
  const provenance = fixtureSetProvenance.files[fixtureName];
  const bundledCacheBytes = fs.readFileSync(
    path.join(getComplianceCacheDir({ version: fixtureSetProvenance.protocol_version }), 'universal', cacheFileName)
  );

  assert.deepEqual(packagedBytes, bundledCacheBytes);
  assert.equal(provenance.sha256, expectedSha256);
  assert.equal(provenance.size_bytes, packagedBytes.byteLength);
  assert.equal(sha256(packagedBytes), expectedSha256);
  assert.equal(loaded.yaml, packagedBytes.toString('utf8'));
  const {
    adcp_version: loadedVersion,
    compliance_dir: loadedComplianceDirectory,
    ...canonicalStoryboard
  } = loaded.storyboard;
  assert.deepEqual(canonicalStoryboard, parseStoryboard(packagedBytes.toString('utf8')));
  assert.deepEqual(
    {
      id: loaded.storyboard.id,
      phase_count: loaded.storyboard.phases.length,
      step_count: loaded.storyboard.phases.reduce((count, phase) => count + phase.steps.length, 0),
    },
    expectedShape
  );
  assert.deepEqual(loaded.provenance, provenance);
  assert.equal(
    applyStoryboardVersionOptions(loaded.storyboard, {}).complianceDir,
    getComplianceCacheDir({ version: fixtureSetProvenance.protocol_version })
  );
  assert.equal(
    applyStoryboardVersionOptions(loaded.storyboard, {
      adcpVersion: fixtureSetProvenance.protocol_version,
    }).complianceDir,
    getComplianceCacheDir({ version: fixtureSetProvenance.protocol_version })
  );
  assert.equal(loadedVersion, fixtureSetProvenance.protocol_version);
  assert.equal(loadedComplianceDirectory, getComplianceCacheDir({ version: fixtureSetProvenance.protocol_version }));
  assert.equal(Object.isFrozen(fixtureSetProvenance.files[fixtureName]), true);
  assert.equal(fixtureSetProvenance.protocol_version, '3.2.1');
  assert.equal(fixtureSetProvenance.source_commit, 'a07bbbba8d51fdec95a1b517251863fd99908b16');
  assert.equal(fixtureSetProvenance.bundle_sha256, '942b24c66500839b3db21e74f69f2fe34d6ac18f898acc1f67aa126e35547994');
}

test('packaged consumers receive the exact canonical universal/principal storyboard', () => {
  assertCanonicalPackagedFixture({
    fixtureName: 'principal',
    packageSubpath: '@adcp/sdk/compliance-fixtures/principal.yaml',
    cacheFileName: 'principal.yaml',
    expectedSha256: 'cb16beb0a38220abef54d84d7dc61119743874728c01a83e43e68a07953a6331',
    expectedShape: { id: 'principal', phase_count: 7, step_count: 11 },
    load: loadCanonicalPrincipalStoryboard,
  });
});

test('packaged consumers receive the exact canonical universal/reporting-core storyboard', () => {
  assertCanonicalPackagedFixture({
    fixtureName: 'reporting_core',
    packageSubpath: '@adcp/sdk/compliance-fixtures/reporting-core.yaml',
    cacheFileName: 'reporting-core.yaml',
    expectedSha256: '0209f91aa87b204f8980a95031ddc1c0787ba70c5aecac39d06f2955e93e5621',
    expectedShape: { id: 'reporting_core', phase_count: 4, step_count: 23 },
    load: loadCanonicalReportingCoreStoryboard,
  });
});

test('ESM consumers retain trusted compliance provenance with an explicit matching version', async () => {
  const fixtures = await import('@adcp/sdk/compliance-fixtures');
  const testing = await import('@adcp/sdk/testing');
  const provenance = fixtures.loadCanonicalStoryboardFixtureProvenance();
  const expectedComplianceDirectory = testing.getComplianceCacheDir({ version: provenance.protocol_version });

  for (const load of [fixtures.loadCanonicalPrincipalStoryboard, fixtures.loadCanonicalReportingCoreStoryboard]) {
    const fixture = load();
    assert.equal(
      testing.applyStoryboardVersionOptions(fixture.storyboard, {
        adcpVersion: provenance.protocol_version,
      }).complianceDir,
      expectedComplianceDirectory
    );
  }
});
