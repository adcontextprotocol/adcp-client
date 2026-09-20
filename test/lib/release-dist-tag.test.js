const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('release workflow publishes 13.x under the real adcp-3.1 dist-tag', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /^\s+- 13\.x$/m);
  assert.match(workflow, /ADCP_NPM_TAG:\s*\$\{\{ github\.ref_name == '13\.x' && 'adcp-3\.1' \|\| '' \}\}/);
  assert.doesNotMatch(workflow, /ADCP_NPM_TAG:.*\|\| 'latest'/);
});

test('an empty non-13.x override preserves the Changesets prerelease tag', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-release-tag-'));
  fs.mkdirSync(path.join(tempDir, '.changeset'));
  fs.writeFileSync(
    path.join(tempDir, '.changeset/pre.json'),
    `${JSON.stringify({ mode: 'pre', tag: 'beta' }, null, 2)}\n`
  );

  try {
    const output = execFileSync(
      path.join(__dirname, '../../node_modules/.bin/tsx'),
      [path.join(__dirname, '../../scripts/publish-adcp-release.ts'), '--dry-run'],
      {
        cwd: tempDir,
        encoding: 'utf8',
        env: { ...process.env, ADCP_NPM_TAG: '' },
      }
    );
    assert.match(output, /npm dist-tag beta/);
    assert.doesNotMatch(output, /npm dist-tag latest/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('post-publish policy promotes latest only while 13 is the current stable major', async () => {
  const { applyLatestPolicy, resolveLatestPolicy } = await import('../../scripts/report-dist-tag-policy.mjs');
  assert.deepStrictEqual(resolveLatestPolicy({ publishedVersion: '13.1.0', latestVersion: '13.0.4' }), {
    action: 'promote-latest-with-credential',
    command: 'npm dist-tag add @adcp/sdk@13.1.0 latest',
    message:
      'npm latest is still on major 13 (13.0.4). Promote this maintenance release to latest with a maintainer credential; GitHub trusted-publishing OIDC cannot mutate a second dist-tag.',
  });
  assert.deepStrictEqual(resolveLatestPolicy({ publishedVersion: '13.1.0', latestVersion: '14.0.0' }), {
    action: 'preserve-latest',
    message:
      'Keep npm latest at 14.0.0; the 13.1.0 maintenance release is available only through `adcp-3.1` and exact versions.',
  });

  const calls = [];
  const promotion = resolveLatestPolicy({ publishedVersion: '13.1.0', latestVersion: '13.0.4' });
  assert.strictEqual(
    applyLatestPolicy(promotion, { apply: true, publishedVersion: '13.1.0' }).action,
    'promotion-required-no-token'
  );
  assert.strictEqual(
    applyLatestPolicy(promotion, {
      apply: true,
      npmToken: 'present',
      publishedVersion: '13.1.0',
      run: (command, args) => calls.push([command, args]),
    }).action,
    'promoted-latest'
  );
  assert.deepStrictEqual(calls, [['npm', ['dist-tag', 'add', '@adcp/sdk@13.1.0', 'latest']]]);

  const preserve = resolveLatestPolicy({ publishedVersion: '13.1.0', latestVersion: '14.0.0' });
  assert.strictEqual(
    applyLatestPolicy(preserve, {
      apply: true,
      npmToken: 'present',
      publishedVersion: '13.1.0',
      run: () => calls.push(['must-not-run']),
    }).action,
    'preserve-latest'
  );
  assert.strictEqual(calls.length, 1, 'latest 14+ must never trigger a dist-tag mutation');
});

test('release workflow enables guarded latest promotion without replacing OIDC publish', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /report-dist-tag-policy\.mjs --apply/);
  assert.match(workflow, /NPM_TOKEN:\s*\$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(workflow, /NPM_CONFIG_PROVENANCE:\s*true/);
});

test('official A2A 1.x alias is a pinned runtime dependency while the 0.3 peer remains intact', () => {
  const manifest = require('../../package.json');
  assert.strictEqual(manifest.dependencies['@a2a-js/sdk-v1'], 'npm:@a2a-js/sdk@1.0.1');
  assert.strictEqual(manifest.peerDependencies['@a2a-js/sdk'], '^0.3.13');
});
