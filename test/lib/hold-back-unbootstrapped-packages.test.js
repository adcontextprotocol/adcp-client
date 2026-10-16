const assert = require('node:assert/strict');
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'hold-back-unbootstrapped-packages.mjs')
);

function workspace(packages) {
  const root = mkdtempSync(path.join(tmpdir(), 'adcp-holdback-'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@scope/root', version: '1.0.0', workspaces: ['.', 'packages/*'] })
  );
  for (const [directory, manifest] of Object.entries(packages)) {
    mkdirSync(path.join(root, 'packages', directory), { recursive: true });
    // Deliberately unusual formatting: a restore must be byte for byte, not a re-serialization.
    writeFileSync(
      path.join(root, 'packages', directory, 'package.json'),
      `{"name":"${manifest.name}",  "version":"${manifest.version}"${manifest.private ? ',"private":true' : ''}}\n`
    );
  }
  return root;
}

describe('holding back a workspace package that was never published', () => {
  test('lists every non-root workspace package with its manifest', async () => {
    const { listWorkspacePackages } = await import(moduleUrl);
    const root = workspace({
      a: { name: '@scope/a', version: '0.0.0' },
      b: { name: '@scope/b', version: '2.0.0', private: true },
    });
    try {
      const packages = listWorkspacePackages(root);
      assert.deepEqual(packages.map(pkg => [pkg.name, pkg.version, pkg.private]).sort(), [
        ['@scope/a', '0.0.0', false],
        ['@scope/b', '2.0.0', true],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('holds back only a publishable package the registry definitely does not have', async () => {
    const { findUnbootstrappedPackages, listWorkspacePackages } = await import(moduleUrl);
    const root = workspace({
      fresh: { name: '@scope/fresh', version: '0.0.0' },
      live: { name: '@scope/live', version: '1.0.0' },
      flaky: { name: '@scope/flaky', version: '1.0.0' },
      internal: { name: '@scope/internal', version: '1.0.0', private: true },
    });
    try {
      const lookups = [];
      const held = findUnbootstrappedPackages(listWorkspacePackages(root), name => {
        lookups.push(name);
        return { '@scope/fresh': 'missing', '@scope/live': 'present', '@scope/flaky': 'unknown' }[name] ?? 'missing';
      });
      assert.deepEqual(
        held.map(pkg => pkg.name),
        ['@scope/fresh']
      );
      assert.equal(lookups.includes('@scope/internal'), false, 'a private package is never looked up');
      assert.equal(lookups.includes('@scope/root'), false, 'the root package is not a workspace package here');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('marks the package private only while the publish runs, and restores its bytes even if it throws', async () => {
    const { listWorkspacePackages, withPackagesHeldBack } = await import(moduleUrl);
    const root = workspace({ fresh: { name: '@scope/fresh', version: '0.0.0' } });
    const manifestPath = path.join(root, 'packages', 'fresh', 'package.json');
    try {
      const before = readFileSync(manifestPath, 'utf8');
      const held = listWorkspacePackages(root);
      const seen = withPackagesHeldBack(held, () => JSON.parse(readFileSync(manifestPath, 'utf8')).private);
      assert.equal(seen, true);
      assert.equal(readFileSync(manifestPath, 'utf8'), before, 'restored byte for byte');

      assert.throws(
        () =>
          withPackagesHeldBack(held, () => {
            throw new Error('publish crashed');
          }),
        /publish crashed/
      );
      assert.equal(readFileSync(manifestPath, 'utf8'), before, 'restored after a throw');

      assert.equal(
        withPackagesHeldBack([], () => 'nothing held'),
        'nothing held'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the message names the package and where the steps are', async () => {
    const { describeHeldBack } = await import(moduleUrl);
    const message = describeHeldBack([{ name: '@adcp/reporting-storage', version: '0.1.0-beta.0' }]);
    assert.match(message, /@adcp\/reporting-storage@0\.1\.0-beta\.0/);
    assert.match(message, /docs\/development\/NPM-DIST-TAGS\.md#first-publish-of-a-new-workspace-package/);
  });

  test(
    'classifies npm view results: present, missing on 404 only, otherwise unknown',
    { skip: process.platform === 'win32' },
    async () => {
      const { npmRegistryLookup } = await import(moduleUrl);
      const bin = mkdtempSync(path.join(tmpdir(), 'adcp-fake-npm-'));
      const fake = path.join(bin, 'npm');
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
        const script = body => {
          writeFileSync(fake, `#!/bin/sh\n${body}\n`);
          chmodSync(fake, 0o755);
        };
        script('echo \'"1.0.0"\'; exit 0');
        assert.equal(npmRegistryLookup('@scope/x'), 'present');
        script('echo \'{"error":{"code":"E404","summary":"Not Found"}}\'; exit 1');
        assert.equal(npmRegistryLookup('@scope/x'), 'missing');
        script('echo "npm error code ECONNRESET" 1>&2; exit 1');
        assert.equal(npmRegistryLookup('@scope/x'), 'unknown');
        script('echo "npm error code E503" 1>&2; exit 1');
        assert.equal(npmRegistryLookup('@scope/x'), 'unknown');
      } finally {
        process.env.PATH = originalPath;
        rmSync(bin, { recursive: true, force: true });
      }
    }
  );
});
