const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { test } = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('Changesets release versioning regenerates agent docs after the package version changes', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const commands = pkg.scripts.version.split(/\s*&&\s*/);
  const bumpIndex = commands.indexOf('changeset version');
  const syncIndex = commands.indexOf('npm run sync-version');
  const docsIndex = commands.indexOf('npm run generate-agent-docs');

  assert.notEqual(bumpIndex, -1, 'release versioning must invoke Changesets');
  assert.ok(syncIndex > bumpIndex, 'runtime version metadata must update after the package version bump');
  assert.ok(docsIndex > syncIndex, 'agent docs must regenerate from the updated runtime version metadata');

  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /^\s+version:\s*['"]?npm run version['"]?\s*$/m);

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

    // Use the release script under test while keeping this test isolated from the
    // caller's checkout. Generated inputs and dependencies are intentionally
    // shared read-only; `npm install --package-lock-only` does not alter them.
    copyFileSync(path.join(ROOT, 'package.json'), path.join(worktree, 'package.json'));
    writeFileSync(
      path.join(worktree, '.changeset', 'release-version-docs-test.md'),
      "---\n'@adcp/sdk': patch\n---\n\nExercise release version documentation regeneration.\n"
    );
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(worktree, 'node_modules'), 'dir');
    mkdirSync(path.join(worktree, 'schemas'), { recursive: true });
    symlinkSync(path.join(ROOT, 'schemas', 'cache'), path.join(worktree, 'schemas', 'cache'), 'dir');
    mkdirSync(path.join(worktree, 'compliance'), { recursive: true });
    symlinkSync(path.join(ROOT, 'compliance', 'cache'), path.join(worktree, 'compliance', 'cache'), 'dir');

    const originalVersion = JSON.parse(readFileSync(path.join(worktree, 'package.json'), 'utf8')).version;
    run('npm', ['run', 'version']);
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

    // Changesets stages the release-PR output before CI checks it. Staging the
    // generated docs makes ci:docs-check report only regeneration drift.
    run('git', ['add', 'docs/llms.txt', 'docs/TYPE-SUMMARY.md']);
    run('npm', ['run', 'ci:docs-check']);
  } finally {
    if (worktreeCreated) {
      run('git', ['worktree', 'remove', '--force', worktree], ROOT);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
