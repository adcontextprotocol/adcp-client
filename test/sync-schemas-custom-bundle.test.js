const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const TAR_MODULE = require.resolve('tar');

function runHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-custom-bundle-'));
  const script = path.join(directory, 'harness.ts');
  const output = path.join(directory, 'output.json');
  fs.writeFileSync(
    script,
    `
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import tar = require(${JSON.stringify(TAR_MODULE)});
import { discoverAllSchemaFiles } from ${JSON.stringify(path.join(REPO_ROOT, 'scripts/generate-types.ts'))};
import {
  createProtocolBundleProvenance,
  cacheMatchesCodegenProvenance,
  installProtocolBundle,
  isSafeProtocolSkillName,
  normalizeBundleSha256,
  officialBundleUrlForCommit,
  parseSyncCommandLine,
  readCodegenProvenance,
  resolveCustomBundleRequest,
  syncFromCustomBundle,
} from ${JSON.stringify(path.join(REPO_ROOT, 'scripts/sync-schemas.ts'))};

async function main() {
const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const url = 'https://adcontextprotocol.org/protocol/pr/' + commit + '/latest.tgz';
const capture = (fn: () => unknown) => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const validDocument = {
  schema_version: 1,
  source_repository: 'adcontextprotocol/adcp',
  source_commit: commit,
  published_version: '3.2.0-beta.9',
  bundle_sha256: digest,
  bundle_url: url,
};
const provenancePath = ${JSON.stringify(path.join(directory, 'provenance.json'))};
writeFileSync(provenancePath, JSON.stringify(validDocument));
const wrongVersionProvenancePath = ${JSON.stringify(path.join(directory, 'wrong-version-provenance.json'))};
writeFileSync(wrongVersionProvenancePath, JSON.stringify({ ...validDocument, published_version: '3.2.0-beta.8' }));
const localProvenancePath = ${JSON.stringify(path.join(directory, 'local-provenance.json'))};
const { bundle_url: _bundleUrl, ...localProvenance } = validDocument;
writeFileSync(localProvenancePath, JSON.stringify(localProvenance));
const noDeclarationPath = ${JSON.stringify(path.join(directory, 'no-declaration.json'))};
const noCacheProvenancePath = ${JSON.stringify(path.join(directory, 'no-cache-provenance.json'))};
const mismatchedCacheProvenancePath = ${JSON.stringify(path.join(directory, 'mismatched-cache-provenance.json'))};
writeFileSync(mismatchedCacheProvenancePath, JSON.stringify({ ...validDocument, bundle_sha256: 'c'.repeat(64) }));

const fixtureRoot = ${JSON.stringify(path.join(directory, 'fixture'))};
const bundleRootName = 'adcp-3.2.0-beta.9';
const bundleRoot = path.join(fixtureRoot, bundleRootName);
mkdirSync(path.join(bundleRoot, 'schemas'), { recursive: true });
mkdirSync(path.join(bundleRoot, 'compliance'), { recursive: true });
writeFileSync(path.join(bundleRoot, 'schemas/index.json'), JSON.stringify({ adcp_version: '3.2.0-beta.9', schemas: {} }));
writeFileSync(path.join(bundleRoot, 'compliance/index.json'), JSON.stringify({ adcp_version: '3.2.0-beta.9' }));
writeFileSync(path.join(bundleRoot, 'manifest.json'), JSON.stringify({
  published_version: '3.2.0-beta.9',
  source: { repository: 'adcontextprotocol/adcp', commit_sha: commit },
}));
const bundlePath = ${JSON.stringify(path.join(directory, 'latest.tgz'))};
tar.c({ cwd: fixtureRoot, file: bundlePath, gzip: true, sync: true }, [bundleRootName]);
const bundleBytes = readFileSync(bundlePath);
const fixtureDigest = createHash('sha256').update(bundleBytes).digest('hex');
const installRoot = ${JSON.stringify(path.join(directory, 'install'))};
const installedProvenance = await installProtocolBundle({
  version: '3.2.0-beta.9',
  tgzBuf: bundleBytes,
  expectedSha256: fixtureDigest,
  source: bundlePath,
  includeSharedSurfaces: false,
  expectedProtocolCommit: commit,
  repoRoot: installRoot,
  schemaCacheDir: path.join(installRoot, 'schemas'),
  complianceCacheDir: path.join(installRoot, 'compliance'),
  skillsDir: path.join(installRoot, 'skills'),
});
const matchingDeclarationPath = ${JSON.stringify(path.join(directory, 'matching-declaration.json'))};
writeFileSync(matchingDeclarationPath, JSON.stringify(installedProvenance));

const results = {
  digest: normalizeBundleSha256('sha256:' + digest),
  officialUrl: officialBundleUrlForCommit(url, commit),
  validSkillNames: ['adcp-media-buy', 'skill_2', 'A1'].map(isSafeProtocolSkillName),
  unsafeSkillNames: [
    '',
    '.',
    '..',
    '../outside',
    'nested/skill',
    'nested' + String.fromCharCode(92) + 'skill',
    '-leading',
    'trailing-',
  ].map(isSafeProtocolSkillName),
  localPath: officialBundleUrlForCommit('/tmp/latest.tgz', commit),
  parsedFlags: parseSyncCommandLine([
    '3.2.0-beta.9',
    '--bundle', url,
    '--bundle-sha256=sha256:' + digest,
    '--protocol-commit', commit,
  ], {}),
  parsedEnv: parseSyncCommandLine([], {
    ADCP_BUNDLE_URL: '/tmp/latest.tgz',
    ADCP_BUNDLE_SHA256: digest,
    ADCP_PROTOCOL_COMMIT_SHA: commit,
  }),
  rejectedExplicitSideBundle: capture(() => resolveCustomBundleRequest(
    '3.1.18',
    '3.2.0-beta.9',
    { bundle: url, bundleSha256: digest, protocolCommit: commit }
  )),
  ignoredEnvironmentSideBundle: resolveCustomBundleRequest(
    '3.1.18',
    '3.2.0-beta.9',
    { bundle: url, bundleSha256: digest, protocolCommit: commit },
    provenancePath,
    'environment'
  ),
  readProvenance: readCodegenProvenance(provenancePath),
  resolvedDeclaration: resolveCustomBundleRequest(
    '3.2.0-beta.9',
    '3.2.0-beta.9',
    undefined,
    provenancePath,
    'environment'
  ),
  ignoredForSideBundle: resolveCustomBundleRequest(
    '3.1.18',
    '3.2.0-beta.9',
    undefined,
    provenancePath
  ),
  wrongDeclaredVersion: capture(() => resolveCustomBundleRequest(
    '3.2.0-beta.9',
    '3.2.0-beta.9',
    undefined,
    wrongVersionProvenancePath
  )),
  localDeclaration: capture(() => resolveCustomBundleRequest(
    '3.2.0-beta.9',
    '3.2.0-beta.9',
    undefined,
    localProvenancePath
  )),
  createdProvenance: createProtocolBundleProvenance(
    {
      published_version: '3.2.0-beta.9',
      source: { repository: 'adcontextprotocol/adcp', commit_sha: commit },
    },
    '3.2.0-beta.9',
    commit,
    digest,
    url
  ),
  uppercaseDigest: capture(() => normalizeBundleSha256('B'.repeat(64))),
  partialFlags: capture(() => parseSyncCommandLine(['--bundle', url], {})),
  conflictingEnv: capture(() => parseSyncCommandLine([], {
    ADCP_BUNDLE: '/tmp/one.tgz',
    ADCP_BUNDLE_URL: '/tmp/two.tgz',
    ADCP_BUNDLE_SHA256: digest,
    ADCP_PROTOCOL_COMMIT_SHA: commit,
  })),
  unknownFlag: capture(() => parseSyncCommandLine(['--wat'], {})),
  wrongHost: capture(() => officialBundleUrlForCommit(
    'https://example.com/protocol/pr/' + commit + '/latest.tgz',
    commit
  )),
  wrongUrlCommit: capture(() => officialBundleUrlForCommit(
    'https://adcontextprotocol.org/protocol/pr/' + 'c'.repeat(40) + '/latest.tgz',
    commit
  )),
  queryString: capture(() => officialBundleUrlForCommit(url + '?download=1', commit)),
  wrongManifestCommit: capture(() => createProtocolBundleProvenance(
    {
      published_version: '3.2.0-beta.9',
      source: { repository: 'adcontextprotocol/adcp', commit_sha: 'c'.repeat(40) },
    },
    '3.2.0-beta.9',
    commit,
    digest,
    url
  )),
  wrongManifestVersion: capture(() => createProtocolBundleProvenance(
    {
      published_version: '3.2.0-beta.8',
      source: { repository: 'adcontextprotocol/adcp', commit_sha: commit },
    },
    '3.2.0-beta.9',
    commit,
    digest,
    url
  )),
  installedProvenance,
  installedIndex: JSON.parse(readFileSync(path.join(installRoot, 'schemas/3.2.0-beta.9/index.json'), 'utf8')),
  installedCacheProvenance: JSON.parse(readFileSync(
    path.join(installRoot, 'schemas/3.2.0-beta.9/_provenance.json'),
    'utf8'
  )),
  matchingCacheProvenance: cacheMatchesCodegenProvenance(
    matchingDeclarationPath,
    path.join(installRoot, 'schemas/3.2.0-beta.9/_provenance.json')
  ),
  missingDeclaredCacheProvenance: cacheMatchesCodegenProvenance(provenancePath, noCacheProvenancePath),
  mismatchedCacheProvenance: cacheMatchesCodegenProvenance(provenancePath, mismatchedCacheProvenancePath),
  staleCustomCacheWithoutDeclaration: cacheMatchesCodegenProvenance(
    noDeclarationPath,
    path.join(installRoot, 'schemas/3.2.0-beta.9/_provenance.json')
  ),
  publishedCacheWithoutDeclaration: cacheMatchesCodegenProvenance(noDeclarationPath, noCacheProvenancePath),
  discoveredSchemaFiles: discoverAllSchemaFiles(path.join(installRoot, 'schemas/3.2.0-beta.9')),
  wrongFixtureDigest: await (async () => {
    try {
      await installProtocolBundle({
        version: '3.2.0-beta.9',
        tgzBuf: bundleBytes,
        expectedSha256: 'd'.repeat(64),
        source: bundlePath,
        includeSharedSurfaces: false,
        repoRoot: path.join(installRoot, 'wrong-digest'),
        schemaCacheDir: path.join(installRoot, 'wrong-digest/schemas'),
        complianceCacheDir: path.join(installRoot, 'wrong-digest/compliance'),
      });
      return {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })(),
  missingLocalBundle: await (async () => {
    try {
      await syncFromCustomBundle('3.2.0-beta.9', {
        bundle: path.join(installRoot, 'missing.tgz'),
        bundleSha256: digest,
        protocolCommit: commit,
      }, false, false);
      return {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })(),
  signatureRequired: await (async () => {
    try {
      await syncFromCustomBundle('3.2.0-beta.9', {
        bundle: bundlePath,
        bundleSha256: fixtureDigest,
        protocolCommit: commit,
      }, false, true);
      return {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })(),
};

writeFileSync(${JSON.stringify(output)}, JSON.stringify(results));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
`
  );

  try {
    const result = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), [script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `harness failed:\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('custom schema bundles are immutable, commit-addressed, and reproducible', () => {
  const results = runHarness();
  const commit = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const url = `https://adcontextprotocol.org/protocol/pr/${commit}/latest.tgz`;

  assert.equal(results.digest, digest);
  assert.equal(results.officialUrl, url);
  assert.deepEqual(results.validSkillNames, [true, true, true]);
  assert.deepEqual(results.unsafeSkillNames, [false, false, false, false, false, false, false, false]);
  assert.equal(results.localPath, undefined);
  assert.deepEqual(results.parsedFlags, {
    version: '3.2.0-beta.9',
    bundle: { bundle: url, bundleSha256: digest, protocolCommit: commit },
    bundleSource: 'arguments',
  });
  assert.deepEqual(results.parsedEnv, {
    bundle: { bundle: '/tmp/latest.tgz', bundleSha256: digest, protocolCommit: commit },
    bundleSource: 'environment',
  });
  assert.match(results.rejectedExplicitSideBundle.error, /may only target the primary ADCP_VERSION/);
  assert.equal(results.ignoredEnvironmentSideBundle, undefined);
  assert.deepEqual(results.readProvenance, results.createdProvenance);
  assert.deepEqual(results.resolvedDeclaration, {
    bundle: url,
    bundleSha256: digest,
    protocolCommit: commit,
  });
  assert.equal(results.ignoredForSideBundle, undefined);
  assert.match(results.wrongDeclaredVersion.error, /Codegen provenance version mismatch/);
  assert.match(results.localDeclaration.error, /no bundle_url for reproducible CI/);
  assert.match(results.uppercaseDigest.error, /64 lowercase hexadecimal/);
  assert.match(results.partialFlags.error, /require --bundle, --bundle-sha256, and --protocol-commit/);
  assert.match(results.conflictingEnv.error, /ADCP_BUNDLE and ADCP_BUNDLE_URL disagree/);
  assert.match(results.unknownFlag.error, /Unknown schema sync option/);
  assert.match(results.wrongHost.error, /official immutable URL/);
  assert.match(results.wrongUrlCommit.error, /official immutable URL/);
  assert.match(results.queryString.error, /official immutable URL/);
  assert.match(results.wrongManifestCommit.error, /commit mismatch/);
  assert.match(results.wrongManifestVersion.error, /manifest version mismatch/);
  assert.equal(results.installedProvenance.source_commit, commit);
  assert.equal(results.installedProvenance.bundle_sha256, results.installedCacheProvenance.bundle_sha256);
  assert.equal(results.installedIndex.adcp_version, '3.2.0-beta.9');
  assert.equal(results.matchingCacheProvenance, true);
  assert.equal(results.missingDeclaredCacheProvenance, false);
  assert.equal(results.mismatchedCacheProvenance, false);
  assert.equal(results.staleCustomCacheWithoutDeclaration, false);
  assert.equal(results.publishedCacheWithoutDeclaration, true);
  assert.ok(!results.discoveredSchemaFiles.includes('_provenance.json'));
  assert.match(results.wrongFixtureDigest.error, /sha256 mismatch/);
  assert.match(results.missingLocalBundle.error, /file not found/);
  assert.match(results.signatureRequired.error, /unsigned development artifacts/);
});
