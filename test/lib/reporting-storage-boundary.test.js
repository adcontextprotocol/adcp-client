/**
 * Dependency direction between `@adcp/sdk` and `@adcp/reporting-storage`.
 *
 * The storage package depends on the SDK (a peer dependency); the SDK must never depend on it. A
 * back-edge would make a cycle, ship storage with the protocol client again, and let a storage fix leak
 * into the SDK's version line. And the storage package may use only the SDK's public subpaths: a deep
 * import of `src/lib` or `dist/lib` would couple it to SDK internals the SDK is free to move.
 *
 * This test is the executable form of the rule; `npm run lint:boundaries` enforces the SDK-side half at
 * lint time.
 */
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const STORAGE = '@adcp/reporting-storage';

function walk(directory, extensions) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full, extensions));
    else if (extensions.some(extension => entry.endsWith(extension))) files.push(full);
  }
  return files;
}

/** Module specifiers in `import ... from`, `export ... from`, `import()` and `require()` (not comments' prose). */
function specifiers(source) {
  const found = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
  let match;
  // Only strings shaped like a module specifier count: SQL and prose in a source file can follow a `from '`.
  while ((match = pattern.exec(source))) if (/^[@.\w][\w@./:~-]*$/.test(match[2])) found.push(match[2]);
  return found;
}

/** Specifiers that appear only in `import type ... from` / `export type ... from`, which emit no runtime import. */
function typeOnlySpecifiers(source) {
  const found = new Set();
  const pattern = /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*(['"])([^'"\n]+)\1/g;
  let match;
  while ((match = pattern.exec(source))) found.add(match[2]);
  return found;
}

/** The package a bare specifier names: `@scope/name` or `name`. */
function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('SDK to storage dependency direction', () => {
  const sdkManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const storageManifest = JSON.parse(
    readFileSync(path.join(root, 'packages', 'reporting-storage', 'package.json'), 'utf8')
  );

  test('@adcp/sdk does not depend on @adcp/reporting-storage', () => {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      assert.equal(
        Object.keys(sdkManifest[field] ?? {}).includes(STORAGE),
        false,
        `package.json ${field} must not list ${STORAGE}`
      );
    }
    assert.equal(sdkManifest.name, '@adcp/sdk');
    assert.equal(storageManifest.name, STORAGE);
  });

  test('nothing the SDK publishes imports the storage package', () => {
    const files = [
      ...walk(path.join(root, 'src'), ['.ts', '.tsx', '.js', '.mjs', '.cjs']),
      ...walk(path.join(root, 'bin'), ['.js', '.mjs', '.cjs']),
      ...walk(path.join(root, 'examples'), ['.ts', '.js', '.mjs', '.cjs']),
    ];
    assert.ok(files.length > 500, 'the scan should see the whole SDK source tree');
    const offenders = [];
    for (const file of files) {
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        if (
          specifier === STORAGE ||
          specifier.startsWith(`${STORAGE}/`) ||
          /(^|\/)packages\/reporting-storage(\/|$)/.test(specifier)
        ) {
          offenders.push(`${path.relative(root, file)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'the SDK must not import @adcp/reporting-storage');
  });

  test('the storage package imports @adcp/sdk only through public subpaths and stays inside its own tree', () => {
    const publicSubpaths = new Set(
      Object.keys(sdkManifest.exports)
        .filter(key => key !== './package.json' && !key.includes('*'))
        .map(key => (key === '.' ? '@adcp/sdk' : `@adcp/sdk/${key.slice(2)}`))
    );
    // `./types/*` is a documented types-only wildcard (per-tool declaration slices): it has no runtime target, so
    // it may be imported only with `import type`, and the slice must exist.
    const wildcards = Object.keys(sdkManifest.exports)
      .filter(key => key.includes('*'))
      .map(key => `@adcp/sdk/${key.slice(2).replace('*', '')}`);
    const declared = new Set([
      ...Object.keys(storageManifest.peerDependencies ?? {}),
      ...Object.keys(storageManifest.dependencies ?? {}),
    ]);
    const builtins = new Set(require('node:module').builtinModules);
    const sourceRoot = path.join(root, 'packages', 'reporting-storage', 'src');
    const files = walk(sourceRoot, ['.ts']);
    assert.ok(files.length >= 20, 'the scan should see the storage package source');
    const offenders = [];
    for (const file of files) {
      const relative = path.relative(root, file);
      const source = readFileSync(file, 'utf8');
      const typeOnly = typeOnlySpecifiers(source);
      for (const specifier of specifiers(source)) {
        if (specifier.startsWith('@adcp/sdk')) {
          const wildcard = wildcards.find(prefix => specifier.startsWith(prefix));
          if (publicSubpaths.has(specifier)) continue;
          if (!wildcard) {
            offenders.push(`${relative} imports ${specifier}, which is not a public @adcp/sdk export`);
          } else if (!typeOnly.has(specifier)) {
            offenders.push(
              `${relative} imports ${specifier} at runtime, but that export is types-only (use import type)`
            );
          } else if (!existsSync(path.join(root, 'src', 'lib', 'types', `${specifier.slice(wildcard.length)}.ts`))) {
            offenders.push(`${relative} imports ${specifier}, which names no declaration slice`);
          }
        } else if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(file), specifier);
          if (!target.startsWith(sourceRoot + path.sep) && target !== sourceRoot) {
            offenders.push(`${relative} imports ${specifier}, which leaves the package`);
          }
        } else if (!specifier.startsWith('node:') && !builtins.has(specifier)) {
          const name = packageNameOf(specifier);
          if (!declared.has(name)) offenders.push(`${relative} imports ${name}, which the package does not declare`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('the storage package declares @adcp/sdk as a peer, with the cloud SDKs as optional peers', () => {
    assert.ok(storageManifest.peerDependencies['@adcp/sdk'], '@adcp/sdk must be a peer dependency');
    assert.equal(storageManifest.dependencies?.['@adcp/sdk'], undefined, '@adcp/sdk must not be a regular dependency');
    for (const peer of ['@aws-sdk/client-s3', '@azure/storage-blob', '@google-cloud/storage']) {
      assert.ok(storageManifest.peerDependencies[peer], `${peer} must be a peer of the storage package`);
      assert.equal(storageManifest.peerDependenciesMeta[peer]?.optional, true, `${peer} must be an optional peer`);
      assert.equal(sdkManifest.peerDependencies?.[peer], undefined, `${peer} must no longer be a peer of the SDK`);
    }
  });
});
