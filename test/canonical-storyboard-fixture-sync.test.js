const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');

test('canonical storyboard provenance remains valid across an SDK protocol-version update', () => {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-canonical-fixtures-'));
  const harnessScripts = path.join(harnessRoot, 'scripts');
  const harnessFixtures = path.join(harnessRoot, 'src', 'lib', 'compliance-fixtures');
  fs.mkdirSync(harnessScripts, { recursive: true });
  fs.mkdirSync(harnessFixtures, { recursive: true });

  try {
    fs.copyFileSync(
      path.join(REPO_ROOT, 'scripts', 'sync-canonical-storyboard-fixtures.ts'),
      path.join(harnessScripts, 'sync-canonical-storyboard-fixtures.ts')
    );
    for (const file of ['canonical-storyboards-provenance.json', 'principal.yaml', 'reporting-core.yaml']) {
      fs.copyFileSync(
        path.join(REPO_ROOT, 'src', 'lib', 'compliance-fixtures', file),
        path.join(harnessFixtures, file)
      );
    }
    fs.writeFileSync(path.join(harnessRoot, 'ADCP_VERSION'), '99.0.0-candidate\n');

    const result = spawnSync(
      path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      [path.join(harnessScripts, 'sync-canonical-storyboard-fixtures.ts'), '--check'],
      { encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /verified 2 fixtures/);
  } finally {
    fs.rmSync(harnessRoot, { recursive: true, force: true });
  }
});
