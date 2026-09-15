const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const modulePromise = import(
  pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'check-publish-protocol-artifacts.mjs')).href
);

const currentProtocolVersion = '3.2.0-rc.3';
const compatibleVersions = ['v2.5', 'v3', '3.0.25', '3.1.18', currentProtocolVersion, '3.2-rc.3'];

function fixture(overrides = {}) {
  return {
    packageInfo: {
      files: [
        { path: 'dist/lib/schemas-data/v2.5/bundled.schemas.br' },
        { path: 'dist/lib/schemas-data/3.0/bundled.schemas.br' },
        { path: 'dist/lib/schemas-data/3.1/bundled.schemas.br' },
        { path: `dist/lib/schemas-data/${currentProtocolVersion}/bundled.schemas.br` },
        { path: 'compliance/cache/3.0.25/index.json' },
        { path: 'compliance/cache/3.1.18/index.json' },
        { path: `compliance/cache/${currentProtocolVersion}/index.json` },
        { path: 'docs/releases/14.0.0-beta.0.md' },
      ],
    },
    manifest: { exports: { '.': './dist/lib/index.js' }, typesVersions: { '*': {} } },
    currentProtocolVersion,
    compatibleVersions,
    ...overrides,
  };
}

test('allows the current RC, stable compatibility bundles, and historical beta release notes', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  assert.doesNotThrow(() => assertPublishProtocolArtifacts(fixture()));
});

test('rejects superseded schema, compliance, and type preview bundles', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  for (const [forbiddenPath, expected] of [
    ['dist/lib/schemas-data/3.2.0-beta.10/bundled.schemas.br', /unsupported schema bundle 3\.2\.0-beta\.10/],
    ['compliance/cache/3.1.0-beta.7/index.json', /unsupported compliance bundle 3\.1\.0-beta\.7/],
    ['compliance/cache/3.2.0-rc.2/index.json', /unsupported compliance bundle 3\.2\.0-rc\.2/],
    ['dist/lib/types/v3-1-beta/index.d.ts', /versioned preview type bundle v3-1-beta/],
  ]) {
    const value = fixture();
    value.packageInfo.files.push({ path: forbiddenPath });
    assert.throws(() => assertPublishProtocolArtifacts(value), expected);
  }
});

test('requires the exact maintained stable compliance inventory', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  const missingStable = fixture();
  missingStable.packageInfo.files = missingStable.packageInfo.files.filter(
    file => !file.path.startsWith('compliance/cache/3.1.18/')
  );
  assert.throws(
    () => assertPublishProtocolArtifacts(missingStable),
    /3\.1\.18 \(required compliance bundle is missing\)/
  );

  const staleStable = fixture();
  staleStable.packageInfo.files.push({ path: 'compliance/cache/3.0.1/index.json' });
  assert.throws(() => assertPublishProtocolArtifacts(staleStable), /unsupported compliance bundle 3\.0\.1/);
});

test('requires every maintained stable schema root including v2.5', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  const missingV25 = fixture();
  missingV25.packageInfo.files = missingV25.packageInfo.files.filter(
    file => !file.path.startsWith('dist/lib/schemas-data/v2.5/')
  );
  assert.throws(() => assertPublishProtocolArtifacts(missingV25), /v2\.5 \(required schema bundle is missing\)/);
});

test('rejects preview type entry points and superseded advertised previews', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  assert.throws(
    () =>
      assertPublishProtocolArtifacts(
        fixture({
          manifest: {
            exports: { './types/v3-1-beta/tools': './dist/lib/types/v3-1-beta/tools.js' },
            typesVersions: { '*': { 'types/v3-1-beta': ['dist/lib/types/v3-1-beta/index.d.ts'] } },
          },
        })
      ),
    /versioned preview package entry point/
  );
  assert.throws(
    () => assertPublishProtocolArtifacts(fixture({ compatibleVersions: [...compatibleVersions, '3.1.0-beta.7'] })),
    /superseded advertised protocol preview/
  );
});

test('allows a beta only when it is the exact current primary pin', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  const beta = '4.0.0-beta.2';
  assert.doesNotThrow(() =>
    assertPublishProtocolArtifacts(
      fixture({
        currentProtocolVersion: beta,
        compatibleVersions: [beta, '4.0-beta.2'],
        packageInfo: {
          files: [
            { path: 'dist/lib/schemas-data/v2.5/index.json' },
            { path: 'dist/lib/schemas-data/3.0/bundled.schemas.br' },
            { path: 'dist/lib/schemas-data/3.1/bundled.schemas.br' },
            { path: `dist/lib/schemas-data/${beta}/bundled.schemas.br` },
            { path: 'compliance/cache/3.0.25/index.json' },
            { path: 'compliance/cache/3.1.18/index.json' },
            { path: `compliance/cache/${beta}/index.json` },
          ],
        },
      })
    )
  );
});

test('release scripts do not sync or export the retired 3.1 beta bundle', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  assert.doesNotMatch(manifest.scripts['sync-schemas:all'], /beta/);
  assert.doesNotMatch(manifest.scripts['generate-types:all'], /beta/);
  assert.match(manifest.scripts.prepublishOnly, /check:publish-protocol-artifacts/);
  assert.equal(manifest.exports['./types/v3-1-beta'], undefined);
  assert.equal(manifest.typesVersions['*']['types/v3-1-beta'], undefined);
});
