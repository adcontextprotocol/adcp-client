// Regression test for adcp-client#1909-sibling: the v1↔v2 projection
// loaders (`registry.ts`, `canonical-properties.ts`) must resolve their
// JSON sources via the published-tarball path
// `dist/lib/schemas-data/<version>/...` and NOT depend on the source-tree
// `schemas/cache/<version>/...` directory.
//
// The original 7.10.0 loaders only knew the source-tree path. After `npm
// install`, the tarball ships `dist/lib/schemas-data/<version>/...` (per
// `scripts/copy-schemas-to-dist.ts`) but no `schemas/cache/`. The loaders
// would throw at first call — manifested as cascading product-discovery
// failures in compliance matrices.
//
// 7.10.1 fixed the sibling catalog loader the same way. This test fakes a
// published-tarball layout (only the dist files exist; no schemas/cache)
// in a temp directory and confirms both registry + canonical-properties
// loaders resolve without falling back to source-tree paths.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIST = path.join(REPO_ROOT, 'dist');
const SRC_SCHEMAS_DATA = path.join(SRC_DIST, 'lib', 'schemas-data');
const { ADCP_VERSION } = require('../../dist/lib/version.js');
const { resolveBundleKey } = require('../../dist/lib/validation/schema-loader.js');
const { BETA_VERSIONS_TO_TRY } = require('../../dist/lib/v2/projection/cache-versions.js');
const ADCP_BUNDLE_KEY = resolveBundleKey(ADCP_VERSION);

let tmpRoot;

before(() => {
  if (!fs.existsSync(path.join(SRC_DIST, 'lib', 'v2', 'projection', 'registry.js'))) {
    throw new Error('Test setup expects dist/ to be built. Run `npm run build:lib` first.');
  }
  if (!fs.existsSync(path.join(SRC_SCHEMAS_DATA, ADCP_BUNDLE_KEY, 'registries', 'v1-canonical-mapping.json'))) {
    throw new Error(
      `Test setup expects dist/lib/schemas-data/${ADCP_BUNDLE_KEY}/registries/v1-canonical-mapping.json. ` +
        'Run `npm run sync-schemas && npm run build:lib` first.'
    );
  }

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-projection-loader-paths-'));
  // Mimic node_modules/@adcp/sdk/dist by copying only the dist tree.
  // Intentionally do NOT copy schemas/cache — that's the bug we're guarding.
  fs.cpSync(SRC_DIST, path.join(tmpRoot, 'dist'), { recursive: true });
});

after(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

/**
 * Run a snippet in a child process whose CWD is the fake-install temp dir.
 * Requires the compiled loader from the temp dir, so __dirname inside the
 * loader resolves under tmpRoot — exactly the situation a consumer hits
 * after `npm install @adcp/sdk` (no source-tree fallback available).
 */
function runInFakeInstall(snippet) {
  const result = spawnSync(process.execPath, ['-e', snippet], {
    cwd: tmpRoot,
    encoding: 'utf-8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('v1↔v2 projection loaders resolve from published-tarball paths', () => {
  test('projection cache preference starts with the current pin and bundle key', () => {
    assert.strictEqual(BETA_VERSIONS_TO_TRY[0], ADCP_VERSION);
    assert.ok(BETA_VERSIONS_TO_TRY.includes(ADCP_BUNDLE_KEY));
  });

  test('registry.ts loadRegistry() finds v1-canonical-mapping.json in dist/lib/schemas-data', () => {
    const registryPath = path.join(tmpRoot, 'dist', 'lib', 'v2', 'projection', 'registry.js').replace(/\\/g, '/');
    const { code, stdout, stderr } = runInFakeInstall(
      `const { loadRegistry } = require(${JSON.stringify(registryPath)});` +
        `const reg = loadRegistry();` +
        `console.log(JSON.stringify({ ok: true, mappings: reg.mappings.length }));`
    );
    assert.strictEqual(code, 0, `loadRegistry threw under fake install:\nstdout:${stdout}\nstderr:${stderr}`);
    const parsed = JSON.parse(stdout.trim());
    assert.strictEqual(parsed.ok, true);
    assert.ok(parsed.mappings > 0, `expected non-empty mappings, got ${parsed.mappings}`);
  });

  test('canonical-properties.ts isCanonicalV1Translatable() finds canonical schemas in dist/lib/schemas-data', () => {
    const cpPath = path.join(tmpRoot, 'dist', 'lib', 'v2', 'projection', 'canonical-properties.js').replace(/\\/g, '/');
    const { code, stdout, stderr } = runInFakeInstall(
      `const { isCanonicalV1Translatable } = require(${JSON.stringify(cpPath)});` +
        // image_carousel is one of the 4 inherently-v2 canonicals
        `const carousel = isCanonicalV1Translatable('image_carousel');` +
        `const image = isCanonicalV1Translatable('image');` +
        `console.log(JSON.stringify({ carousel, image }));`
    );
    assert.strictEqual(
      code,
      0,
      `isCanonicalV1Translatable threw under fake install:\nstdout:${stdout}\nstderr:${stderr}`
    );
    const parsed = JSON.parse(stdout.trim());
    assert.strictEqual(parsed.carousel, false, 'image_carousel must report v1_translatable: false');
    assert.strictEqual(parsed.image, true, 'image must report v1_translatable: true (base default)');
  });

  test('loaders do NOT depend on schemas/cache/ in the fake-install tree', () => {
    // Sanity assertion — if this directory ever appears under tmpRoot the
    // test isn't actually exercising the published-tarball path.
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'schemas')), 'fake install must not contain schemas/');
  });
});
