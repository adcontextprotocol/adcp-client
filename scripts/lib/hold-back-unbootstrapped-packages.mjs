/**
 * Keep a workspace package that has never been published from breaking the rest of a release.
 *
 * npm trusted publishing (GitHub OIDC) can only be configured for a package that already exists on the
 * registry, so a brand-new workspace package cannot make its first publish from `release.yml`: `npm publish`
 * answers 404 and `changeset publish` exits non-zero, after the other packages have already gone out. A
 * maintainer bootstraps the package once by hand (see docs/development/NPM-DIST-TAGS.md).
 *
 * Until then this module marks such a package `private` for the duration of `changeset publish`, which skips
 * private packages, and says so loudly. The package's version is left alone, so the first release after the
 * bootstrap publishes it without any other change.
 *
 * Only a definite "not on the registry" holds a package back. A lookup that fails for any other reason (a
 * network error, a 5xx) holds nothing back, so a flaky registry never silently drops a real release.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** Workspace packages other than the root, from the root `workspaces` globs (`dir/*` and plain directories). */
export function listWorkspacePackages(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const directories = [];
  for (const pattern of manifest.workspaces ?? []) {
    if (pattern === '.') continue;
    if (pattern.endsWith('/*')) {
      const parent = path.join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(path.join(parent, entry.name));
      }
    } else {
      directories.push(path.join(root, pattern));
    }
  }
  return directories
    .map(directory => ({ directory, manifestPath: path.join(directory, 'package.json') }))
    .filter(({ manifestPath }) => existsSync(manifestPath))
    .map(({ directory, manifestPath }) => {
      const text = readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(text);
      return {
        name: parsed.name,
        version: parsed.version,
        private: parsed.private === true,
        directory,
        manifestPath,
        manifestText: text,
      };
    });
}

/** `present`, `missing` (the registry answered 404) or `unknown` (anything else). */
export function npmRegistryLookup(name) {
  const result = spawnSync('npm', ['view', name, 'version', '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.status === 0) return 'present';
  return /E404|404 Not Found/.test(`${result.stdout}\n${result.stderr}`) ? 'missing' : 'unknown';
}

/** The publishable workspace packages the registry has never seen. */
export function findUnbootstrappedPackages(packages, lookup = npmRegistryLookup) {
  return packages.filter(pkg => !pkg.private && lookup(pkg.name) === 'missing');
}

export function describeHeldBack(held) {
  const names = held.map(pkg => `${pkg.name}@${pkg.version}`).join(', ');
  return (
    `Not publishing ${names}: the package has never been published, and npm trusted publishing can only be ` +
    `configured for a package that exists. Every other package is published as usual. A maintainer must make ` +
    `the one-time first publish and configure the trusted publisher; the next release then publishes it. ` +
    `Steps: docs/development/NPM-DIST-TAGS.md#first-publish-of-a-new-workspace-package`
  );
}

/**
 * Run `work` with the given packages marked private, then restore their manifests byte for byte, even if
 * `work` throws.
 */
export function withPackagesHeldBack(held, work) {
  const originals = held.map(pkg => ({ path: pkg.manifestPath, text: readFileSync(pkg.manifestPath, 'utf8') }));
  try {
    for (const pkg of held) {
      const manifest = JSON.parse(readFileSync(pkg.manifestPath, 'utf8'));
      manifest.private = true;
      writeFileSync(pkg.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return work();
  } finally {
    for (const original of originals) writeFileSync(original.path, original.text);
  }
}
