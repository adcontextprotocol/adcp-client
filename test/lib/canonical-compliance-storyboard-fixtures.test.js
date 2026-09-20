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
  assert.equal(fixtureSetProvenance.protocol_version, '3.2.0-rc.4');
  assert.equal(fixtureSetProvenance.source_commit, '94976657c8456e5ad6de55d9793a883542a4fc5f');
  assert.equal(fixtureSetProvenance.bundle_sha256, '773bee016d279345d6fae91a0ce684a22ca9b81c2edd2cdb9a71dbfea65954d2');
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
    expectedSha256: 'fc56c154d40b76a797b62b5470ecb37d72500eeec3aa1800e05d6bb26367688d',
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
