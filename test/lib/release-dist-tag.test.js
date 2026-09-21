const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse: parseYaml } = require('yaml');

test('release workflow publishes 13.x under the real adcp-3.1 dist-tag', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /^\s+- 13\.x$/m);
  assert.match(workflow, /ADCP_NPM_TAG:\s*\$\{\{ github\.ref_name == '13\.x' && 'adcp-3\.1' \|\| '' \}\}/);
  assert.doesNotMatch(workflow, /ADCP_NPM_TAG:.*\|\| 'latest'/);
  const parsed = parseYaml(workflow);
  assert.strictEqual(parsed.concurrency, undefined, 'interop must not hold the shared npm release lock');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(parsed.on, 'workflow_dispatch'),
    false,
    'release credentials must not be exposed through manual dispatch from arbitrary refs'
  );
  assert.deepStrictEqual(parsed.jobs.release.concurrency, {
    group: 'npm-release-dist-tags',
    'cancel-in-progress': false,
  });
  assert.strictEqual(parsed.jobs.release.if, "github.ref == 'refs/heads/main' || github.ref == 'refs/heads/13.x'");
  assert.strictEqual(parsed.jobs['reference-seller-interop'].concurrency, undefined);
  assert.match(workflow, /ADCP_PUBLISHED_PACKAGES:\s*\$\{\{ steps\.changesets\.outputs\.publishedPackages \}\}/);
  assert.match(workflow, /if:\s*steps\.changesets\.outcome == 'success' && github\.ref_name == '13\.x'/);
  assert.doesNotMatch(workflow, /if:\s*steps\.changesets\.outputs\.published == 'true'/);
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

test('a stable-line override cannot replace the Changesets prerelease tag', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-release-tag-'));
  fs.mkdirSync(path.join(tempDir, '.changeset'));
  fs.writeFileSync(
    path.join(tempDir, '.changeset/pre.json'),
    `${JSON.stringify({ mode: 'pre', tag: 'rc' }, null, 2)}\n`
  );

  try {
    const output = execFileSync(
      path.join(__dirname, '../../node_modules/.bin/tsx'),
      [path.join(__dirname, '../../scripts/publish-adcp-release.ts'), '--dry-run'],
      {
        cwd: tempDir,
        encoding: 'utf8',
        env: { ...process.env, ADCP_NPM_TAG: 'adcp-3.1' },
      }
    );
    assert.match(output, /npm dist-tag rc/);
    assert.doesNotMatch(output, /npm dist-tag adcp-3\.1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a prerelease SDK cannot publish to latest or any stable compatibility tag without pre-mode', () => {
  for (const tag of ['latest', 'adcp-3.0', 'adcp-3.1', 'adcp-14.12']) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-release-tag-'));
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: '@adcp/sdk', version: '13.1.0-rc.1' }));
    try {
      const result = require('node:child_process').spawnSync(
        path.join(__dirname, '../../node_modules/.bin/tsx'),
        [path.join(__dirname, '../../scripts/publish-adcp-release.ts'), '--dry-run'],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: { ...process.env, ADCP_NPM_TAG: tag },
        }
      );
      assert.strictEqual(result.status, 1, tag);
      assert.match(result.stderr, new RegExp(`stable npm dist-tag ${tag.replace('.', '\\.')}[^\\n]*`));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('dist-tag report names the actual Changesets prerelease publish tag', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-release-report-'));
  fs.mkdirSync(path.join(tempDir, '.changeset'));
  fs.writeFileSync(
    path.join(tempDir, '.changeset/pre.json'),
    `${JSON.stringify({ mode: 'pre', tag: 'rc' }, null, 2)}\n`
  );
  try {
    const output = execFileSync(process.execPath, [path.join(__dirname, '../../scripts/report-dist-tag-policy.mjs')], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADCP_NPM_TAG: 'adcp-3.1',
        ADCP_PUBLISHED_PACKAGES: JSON.stringify([{ name: '@adcp/sdk', version: '14.0.0-rc.1' }]),
        ADCP_CURRENT_LATEST: '13.0.4',
      },
    });
    assert.match(output, /@adcp\/sdk@14\.0\.0-rc\.1` under `rc`/);
    assert.doesNotMatch(output, /under `adcp-3\.1`/);
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
      readLatestVersion: () => '13.0.4',
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

test('post-publish policy refuses prereleases and a just-in-time backward move', async () => {
  const { applyLatestPolicy, resolveLatestPolicy } = await import('../../scripts/report-dist-tag-policy.mjs');
  assert.strictEqual(
    resolveLatestPolicy({ publishedVersion: '13.1.0-rc.1', latestVersion: '13.0.4' }).action,
    'preserve-prerelease'
  );
  assert.strictEqual(
    resolveLatestPolicy({ publishedVersion: '13.1.0', latestVersion: '13.2.0' }).action,
    'preserve-newer-latest'
  );

  const calls = [];
  const stalePolicy = resolveLatestPolicy({ publishedVersion: '13.1.0', latestVersion: '13.0.4' });
  const result = applyLatestPolicy(stalePolicy, {
    apply: true,
    npmToken: 'present',
    publishedVersion: '13.1.0',
    readLatestVersion: () => '14.0.0',
    run: (...args) => calls.push(args),
  });
  assert.strictEqual(result.action, 'preserve-latest');
  assert.deepStrictEqual(calls, []);
});

test('dist-tag reconciliation uses the actual Changesets package output', async () => {
  const { applyLatestPolicy, readPublishedSdkVersion, resolveLatestPolicy, resolveReconciliationTarget } =
    await import('../../scripts/report-dist-tag-policy.mjs');
  assert.strictEqual(
    readPublishedSdkVersion(JSON.stringify([{ name: '@adcp/eslint-plugin', version: '0.1.8' }])),
    undefined
  );
  assert.strictEqual(
    readPublishedSdkVersion(
      JSON.stringify([
        { name: '@adcp/eslint-plugin', version: '0.1.8' },
        { name: '@adcp/sdk', version: '13.1.0' },
      ])
    ),
    '13.1.0'
  );
  const changesetConfig = require('../../.changeset/config.json');
  assert.ok(changesetConfig.ignore.includes('@adcp/eslint-plugin'));

  const exactReads = [];
  const recoveryTarget = resolveReconciliationTarget({
    publishedPackages: JSON.stringify([]),
    localVersion: '13.1.0',
    readExactVersion: version => {
      exactReads.push(version);
      return version;
    },
  });
  assert.deepStrictEqual(recoveryTarget, { version: '13.1.0', source: 'registry-recovery' });
  assert.deepStrictEqual(exactReads, ['13.1.0']);
  const recoveryCalls = [];
  const recoveryPolicy = resolveLatestPolicy({
    publishedVersion: recoveryTarget.version,
    latestVersion: '13.0.4',
  });
  assert.strictEqual(
    applyLatestPolicy(recoveryPolicy, {
      apply: true,
      npmToken: 'present',
      publishedVersion: recoveryTarget.version,
      readLatestVersion: () => '13.0.4',
      run: (command, args) => recoveryCalls.push([command, args]),
    }).action,
    'promoted-latest'
  );
  assert.deepStrictEqual(recoveryCalls, [['npm', ['dist-tag', 'add', '@adcp/sdk@13.1.0', 'latest']]]);
  assert.strictEqual(
    resolveReconciliationTarget({
      publishedPackages: JSON.stringify([]),
      localVersion: '13.2.0',
      readExactVersion: () => undefined,
    }),
    undefined,
    'ordinary no-publish runs must not reconcile an unpublished local version'
  );
});

test('workflow rerun reconciles an already-published local SDK when Changesets reports false', () => {
  const script = path.join(__dirname, '../../scripts/report-dist-tag-policy.mjs');
  const output = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADCP_PUBLISHED_PACKAGES: JSON.stringify([]),
      ADCP_LOCAL_SDK_VERSION: '13.1.0',
      ADCP_CURRENT_EXACT_VERSION: '13.1.0',
      ADCP_CURRENT_LATEST: '14.0.0',
      ADCP_NPM_TAG: 'adcp-3.1',
    },
  });
  assert.match(output, /Changesets reported no new SDK publish/);
  assert.match(output, /npm confirms local `@adcp\/sdk@13\.1\.0` exists/);
  assert.match(output, /Keep npm latest at 14\.0\.0/);
});

test('workflow empty publishedPackages output uses exact-version recovery instead of failing', () => {
  const script = path.join(__dirname, '../../scripts/report-dist-tag-policy.mjs');
  const output = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADCP_PUBLISHED_PACKAGES: '',
      ADCP_LOCAL_SDK_VERSION: '13.1.0',
      ADCP_CURRENT_EXACT_VERSION: '13.1.0',
      ADCP_CURRENT_LATEST: '14.0.0',
      ADCP_NPM_TAG: 'adcp-3.1',
    },
  });
  assert.match(output, /Changesets reported no new SDK publish/);
  assert.match(output, /npm confirms local `@adcp\/sdk@13\.1\.0` exists/);
});

test('apply mode without NPM_TOKEN reports recovery and exits nonzero', () => {
  const script = path.join(__dirname, '../../scripts/report-dist-tag-policy.mjs');
  const result = require('node:child_process').spawnSync(process.execPath, [script, '--apply'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADCP_PUBLISHED_PACKAGES: JSON.stringify([{ name: '@adcp/sdk', version: '13.1.0' }]),
      ADCP_CURRENT_LATEST: '13.0.4',
      NPM_TOKEN: '',
    },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /Credential-only follow-up: `npm dist-tag add @adcp\/sdk@13\.1\.0 latest`/);
  assert.match(result.stderr, /npm latest promotion blocked/);
});

test('registry/version failures are actionable and nonzero', () => {
  const script = path.join(__dirname, '../../scripts/report-dist-tag-policy.mjs');
  const result = require('node:child_process').spawnSync(process.execPath, [script, '--apply'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ADCP_PUBLISHED_PACKAGES: JSON.stringify([{ name: '@adcp/sdk', version: '13.1.0' }]),
      ADCP_CURRENT_LATEST: 'not-semver',
      NPM_TOKEN: 'present',
    },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /npm view @adcp\/sdk dist-tags --json/);
  assert.match(result.stdout, /npm dist-tag add @adcp\/sdk@13\.1\.0 latest/);
  assert.match(result.stderr, /npm dist-tag reconciliation failed/);
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
