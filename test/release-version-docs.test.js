const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { test } = require('node:test');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');

test('release job serializes package-global npm mutations across branches', () => {
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const parsed = YAML.parse(workflow);

  assert.equal(parsed.concurrency, undefined, 'the interop prerequisite must not hold the npm mutation lock');
  assert.deepEqual(parsed.jobs.release.concurrency, {
    group: 'npm-release-dist-tags',
    'cancel-in-progress': false,
  });
});

test('the changeset gate accepts GA release metadata and still requires changesets for runtime code', () => {
  const workflow = YAML.parse(readFileSync(path.join(ROOT, '.github', 'workflows', 'changeset-check.yml'), 'utf8'));
  const script = workflow.jobs.check.steps.find(step => step.id === 'release-metadata').run;
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'release-metadata-gate-'));
  const run = (command, args, env) =>
    execFileSync(command, args, { cwd: temporaryRoot, encoding: 'utf8', env: env ?? process.env });
  const write = (file, content) => {
    const target = path.join(temporaryRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const commit = message => {
    run('git', ['add', '.']);
    run('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.com', 'commit', '-m', message]);
  };
  const gateOutput = () => {
    const output = path.join(temporaryRoot, '.git', 'gate-output');
    writeFileSync(output, '');
    run('bash', ['-e', '-c', script], { ...process.env, GITHUB_OUTPUT: output });
    return readFileSync(output, 'utf8').trim();
  };

  try {
    run('git', ['init', '-b', 'main']);
    write('.changeset/pre.json', '{"mode":"pre","tag":"beta"}\n');
    write('.changeset/pre/release-note.md', '---\n"@adcp/sdk": major\n---\n\nRelease notes.\n');
    write('package.json', '{"name":"@adcp/sdk","version":"16.0.0-beta.9"}\n');
    write('src/lib/version.ts', "export const LIBRARY_VERSION = '16.0.0-beta.9';\n");
    commit('chore: prerelease base');
    run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    rmSync(path.join(temporaryRoot, '.changeset'), { recursive: true });
    write('package.json', '{"name":"@adcp/sdk","version":"16.0.0"}\n');
    write(
      'src/lib/version.ts',
      "export const LIBRARY_VERSION = '16.0.0';\nexport const VERSION_INFO = { library: '16.0.0' };\n"
    );
    write('README.md', 'Install the stable SDK.\n');
    write('docs/releases/16.0.0.md', 'SDK 16 release notes.\n');
    write('test/release-version-docs.test.js', '// Release workflow verification.\n');
    commit('chore: promote release');
    assert.equal(gateOutput(), 'skip=true');

    write('src/lib/core/AdCPClient.ts', 'export const changedRuntime = true;\n');
    commit('feat: runtime change');
    assert.equal(gateOutput(), 'skip=false');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('Changesets release versioning regenerates agent docs after the package version changes', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const commands = pkg.scripts.version.split(/\s*&&\s*/);
  const bumpIndex = commands.indexOf('changeset version');
  const lockfileIndex = commands.indexOf('npm install --package-lock-only --ignore-scripts');
  const syncIndex = commands.indexOf('npm run sync-version');
  const docsIndex = commands.indexOf('npm run generate-agent-docs');
  const worksheetIndex = commands.indexOf('npm run generate-release-worksheet');

  assert.notEqual(bumpIndex, -1, 'release versioning must invoke Changesets');
  assert.ok(lockfileIndex > bumpIndex && lockfileIndex < syncIndex, 'lockfile resolution must follow the version bump');
  assert.ok(syncIndex > bumpIndex, 'runtime version metadata must update after the package version bump');
  assert.ok(docsIndex > syncIndex, 'agent docs must regenerate from the updated runtime version metadata');
  assert.ok(worksheetIndex > docsIndex, 'the release worksheet must regenerate after agent docs');

  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /^\s+version-script:\s*['"]?npm run version['"]?\s*$/m);

  const docsCheck = pkg.scripts['ci:docs-check'];
  assert.match(docsCheck, /^npm run generate-agent-docs && /);
});

test('the release version workflow leaves generated agent docs current', { timeout: 120_000 }, () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'release-version-docs-'));
  const worktree = path.join(temporaryRoot, 'worktree');
  let worktreeCreated = false;

  const run = (command, args, cwd = worktree) =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  try {
    run('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], ROOT);
    worktreeCreated = true;

    // Keep this test isolated from the caller's checkout. The release script's
    // lockfile install may contact the registry and is unrelated to these docs.
    // Its presence and order are checked above; run the other steps here.
    copyFileSync(path.join(ROOT, 'package.json'), path.join(worktree, 'package.json'));
    copyFileSync(path.join(ROOT, 'ADCP_VERSION'), path.join(worktree, 'ADCP_VERSION'));
    writeFileSync(
      path.join(worktree, '.changeset', 'release-version-docs-test.md'),
      "---\n'@adcp/sdk': patch\n---\n\nExercise release version documentation regeneration.\n"
    );
    // This test checks version-derived docs, not CHANGELOG text. Changelog
    // generation looks up the commit that added every pending changeset and,
    // in a shallow CI checkout, keeps running `git fetch --deepen` until it
    // finds one. A regenerated PR merge ref leaves the checked-out merge commit
    // unreachable, so the deepen never advances and the test hangs until timeout.
    const changesetConfigPath = path.join(worktree, '.changeset', 'config.json');
    const changesetConfig = JSON.parse(readFileSync(changesetConfigPath, 'utf8'));
    writeFileSync(changesetConfigPath, `${JSON.stringify({ ...changesetConfig, changelog: false }, null, 2)}\n`);
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(worktree, 'node_modules'), 'dir');
    mkdirSync(path.join(worktree, 'schemas'), { recursive: true });
    symlinkSync(path.join(ROOT, 'schemas', 'cache'), path.join(worktree, 'schemas', 'cache'), 'dir');
    mkdirSync(path.join(worktree, 'compliance'), { recursive: true });
    symlinkSync(path.join(ROOT, 'compliance', 'cache'), path.join(worktree, 'compliance', 'cache'), 'dir');

    const originalVersion = JSON.parse(readFileSync(path.join(worktree, 'package.json'), 'utf8')).version;
    run(path.join(worktree, 'node_modules', '.bin', 'changeset'), ['version']);
    run('npm', ['run', 'sync-version']);
    run('npm', ['run', 'generate-agent-docs']);
    run('npm', ['run', 'generate-release-worksheet']);
    const releasedVersion = JSON.parse(readFileSync(path.join(worktree, 'package.json'), 'utf8')).version;

    assert.notEqual(releasedVersion, originalVersion, 'Changesets must produce a release version');
    assert.match(
      readFileSync(path.join(worktree, 'docs', 'llms.txt'), 'utf8'),
      new RegExp(`^> Library: @adcp/sdk v${releasedVersion.replaceAll('.', '\\.')}$`, 'm')
    );
    assert.match(
      readFileSync(path.join(worktree, 'docs', 'TYPE-SUMMARY.md'), 'utf8'),
      new RegExp(`^> @adcp/sdk v${releasedVersion.replaceAll('.', '\\.')}$`, 'm')
    );
    const worksheet = readFileSync(path.join(worktree, 'docs', 'migration-14.x-rc-worksheet.md'), 'utf8');
    assert.ok(worksheet.includes(`@adcp/sdk@${releasedVersion}`), 'worksheet must identify the Changesets release');
    assert.ok(!worksheet.includes(`@adcp/sdk@${originalVersion}`), 'worksheet must not retain the previous SDK pin');

    // Changesets stages the release-PR output before CI checks it. Staging the
    // generated docs makes ci:docs-check report only regeneration drift.
    run('git', ['add', 'docs/llms.txt', 'docs/TYPE-SUMMARY.md', 'docs/migration-14.x-rc-worksheet.md']);
    run('npm', ['run', 'ci:docs-check']);
  } finally {
    if (worktreeCreated) {
      run('git', ['worktree', 'remove', '--force', worktree], ROOT);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
