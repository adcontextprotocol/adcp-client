const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const modulePromise = import(
  pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'check-publish-protocol-artifacts.mjs')).href
);

const currentProtocolVersion = '3.3.0-beta.1';
const compatibleVersions = [
  'v3',
  '3.0.1',
  '3.0.25',
  '3.1.24',
  '3.1.29',
  '3.2.7',
  '3.2',
  currentProtocolVersion,
  '3.3-beta.1',
];

function fixture(overrides = {}) {
  return {
    packageInfo: {
      files: [
        { path: 'dist/lib/schemas-data/3.0/bundled.schemas.br' },
        { path: 'dist/lib/schemas-data/3.1/bundled.schemas.br' },
        { path: 'dist/lib/schemas-data/3.2/bundled.schemas.br' },
        { path: `dist/lib/schemas-data/${currentProtocolVersion}/bundled.schemas.br` },
        { path: 'compliance/cache/3.0.25/index.json' },
        { path: 'compliance/cache/3.1.29/index.json' },
        { path: 'compliance/cache/3.2.7/index.json' },
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

test('allows the current release, stable compatibility bundles, and historical beta release notes', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  assert.doesNotThrow(() => assertPublishProtocolArtifacts(fixture()));
});

test('rejects retired AdCP 2 schemas, type exports, and advertised versions', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  for (const path of ['dist/lib/schemas-data/v2.5/bundled.schemas.br', 'dist/lib/types/v2-5/index.d.ts']) {
    const value = fixture();
    value.packageInfo.files.push({ path });
    assert.throws(() => assertPublishProtocolArtifacts(value), /v2[.-]5/);
  }
  assert.throws(
    () => assertPublishProtocolArtifacts(fixture({ compatibleVersions: ['v2.5', 'v3'] })),
    /retired AdCP 2/
  );
  assert.throws(
    () =>
      assertPublishProtocolArtifacts(
        fixture({ manifest: { exports: { './types/v2-5': './dist/lib/types/v2-5/index.js' } } })
      ),
    /v2-5/
  );
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

test('requires the exact current and maintained stable compliance inventory', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  const missingStable = fixture();
  missingStable.packageInfo.files = missingStable.packageInfo.files.filter(
    file => !file.path.startsWith('compliance/cache/3.1.29/')
  );
  assert.throws(
    () => assertPublishProtocolArtifacts(missingStable),
    /3\.1\.29 \(required compliance bundle is missing\)/
  );

  for (const staleVersion of ['3.0.1', '3.1.24', '3.2.4']) {
    const staleStable = fixture();
    staleStable.packageInfo.files.push({ path: `compliance/cache/${staleVersion}/index.json` });
    assert.throws(
      () => assertPublishProtocolArtifacts(staleStable),
      error => error.message.includes(`unsupported compliance bundle ${staleVersion}`)
    );
  }
});

test('requires every maintained stable schema root including AdCP 3.0', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  const missingV30 = fixture();
  missingV30.packageInfo.files = missingV30.packageInfo.files.filter(
    file => !file.path.startsWith('dist/lib/schemas-data/3.0/')
  );
  assert.throws(() => assertPublishProtocolArtifacts(missingV30), /3\.0 \(required schema bundle is missing\)/);
});

test('the 3.3 beta package retains the stable 3.2 schema and compliance bundles', async () => {
  const { assertPublishProtocolArtifacts } = await modulePromise;
  for (const [prefix, expected] of [
    ['dist/lib/schemas-data/3.2/', /3\.2 \(required schema bundle is missing\)/],
    ['compliance/cache/3.2.7/', /3\.2\.7 \(required compliance bundle is missing\)/],
  ]) {
    const value = fixture();
    value.packageInfo.files = value.packageInfo.files.filter(file => !file.path.startsWith(prefix));
    assert.throws(() => assertPublishProtocolArtifacts(value), expected);
  }
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
            { path: 'dist/lib/schemas-data/3.0/bundled.schemas.br' },
            { path: 'dist/lib/schemas-data/3.1/bundled.schemas.br' },
            { path: 'dist/lib/schemas-data/3.2/bundled.schemas.br' },
            { path: `dist/lib/schemas-data/${beta}/bundled.schemas.br` },
            { path: 'compliance/cache/3.0.25/index.json' },
            { path: 'compliance/cache/3.1.29/index.json' },
            { path: 'compliance/cache/3.2.7/index.json' },
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
