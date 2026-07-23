// getPackageRoot() replaces the per-file `__dirname` arithmetic that used to be
// duplicated across 7 schema/data loaders (validation/schema-loader.ts,
// conformance/schemaLoader.ts, server/error-arm-tools.ts,
// v2/projection/{catalog,registry,canonical-properties}.ts,
// testing/storyboard/compliance.ts). It resolves the package root via
// `require.resolve('@adcp/sdk/package.json')` self-reference — independent of
// the calling module's own directory depth — falling back to a directory walk.

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const {
  getPackageRoot,
  _resetPackageRootCache,
  _resolvePackageRootViaDirectoryWalk,
} = require('../../dist/lib/internal/package-root.js');

describe('getPackageRoot', () => {
  test('resolves to the actual package root via self-reference', () => {
    _resetPackageRootCache();
    const root = getPackageRoot();
    assert.strictEqual(root, REPO_ROOT);
  });

  test('resolved root contains a package.json named @adcp/sdk', () => {
    _resetPackageRootCache();
    const root = getPackageRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    assert.strictEqual(pkg.name, '@adcp/sdk');
  });

  test('memoizes across calls', () => {
    _resetPackageRootCache();
    const first = getPackageRoot();
    const second = getPackageRoot();
    assert.strictEqual(first, second);
  });

  test('_resetPackageRootCache() forces recomputation without changing the result', () => {
    const before = getPackageRoot();
    _resetPackageRootCache();
    const after = getPackageRoot();
    assert.strictEqual(before, after);
  });
});

describe('_resolvePackageRootViaDirectoryWalk (fallback path)', () => {
  let tmpRoot;

  after(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('finds an ancestor package.json named @adcp/sdk from a nested start dir', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-package-root-walk-'));
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: '@adcp/sdk' }));
    const nested = path.join(tmpRoot, 'dist', 'lib', 'internal');
    fs.mkdirSync(nested, { recursive: true });

    const found = _resolvePackageRootViaDirectoryWalk(nested);
    assert.strictEqual(found, tmpRoot);
  });

  test('skips an ancestor package.json with a different name', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-package-root-walk-'));
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'some-other-package' }));
    const nested = path.join(tmpRoot, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });

    const found = _resolvePackageRootViaDirectoryWalk(nested);
    assert.strictEqual(found, undefined);
  });

  test('returns undefined when no package.json exists in the ancestry up to the filesystem root', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-package-root-walk-'));
    const nested = path.join(tmpRoot, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });

    const found = _resolvePackageRootViaDirectoryWalk(nested);
    assert.strictEqual(found, undefined);
  });

  test('tolerates a malformed package.json in the ancestry and keeps walking up', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-package-root-walk-'));
    const middle = path.join(tmpRoot, 'middle');
    fs.mkdirSync(middle, { recursive: true });
    fs.writeFileSync(path.join(middle, 'package.json'), '{ not valid json');
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: '@adcp/sdk' }));
    const nested = path.join(middle, 'nested');
    fs.mkdirSync(nested, { recursive: true });

    const found = _resolvePackageRootViaDirectoryWalk(nested);
    assert.strictEqual(found, tmpRoot);
  });
});
