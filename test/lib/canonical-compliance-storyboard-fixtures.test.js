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
  assert.equal(fixtureSetProvenance.protocol_version, '3.2.0-rc.3');
  assert.equal(fixtureSetProvenance.source_commit, '71f9cd5414454e94ccfef87ce25777ead6fad228');
  assert.equal(fixtureSetProvenance.bundle_sha256, '1cd940f76516b43327cbfa6c17c0befd4c093ca85b53a81a4062d38bb522d831');
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
    expectedSha256: '795fe58f00903ad0390c50378518895ae45cfe88bbdb3e7ea880a8c12160e1af',
    expectedShape: { id: 'reporting_core', phase_count: 4, step_count: 22 },
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
