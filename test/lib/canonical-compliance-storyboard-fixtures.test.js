const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ADCP_VERSION } = require('@adcp/sdk');

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
  assert.equal(
    fixtureSetProvenance.protocol_version,
    ADCP_VERSION,
    'canonical fixture provenance must select the primary compliance cache shipped with this SDK'
  );
  // Pinned to the actual signed 3.2.8 release: tag v3.2.8 -> commit 3512882b
  // (the TAG commit, not the producer), bundle digest 5cc94606. The two fixture
  // files are byte-identical to 3.2.4, so their per-file hashes are unchanged —
  // only the release identity moves. Asserting the identity here is what stops
  // unchanged bytes from silently keeping a stale release provenance.
  assert.equal(fixtureSetProvenance.protocol_version, '3.2.8');
  assert.equal(fixtureSetProvenance.source_commit, '6ed4b25e261f54d6b106938d0724757bea9dc5fc');
  assert.equal(fixtureSetProvenance.bundle_sha256, 'e2c0db24203a72cf578cfc914b7bc32302fdcfe29272b02a1024f36cc44129c2');
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
