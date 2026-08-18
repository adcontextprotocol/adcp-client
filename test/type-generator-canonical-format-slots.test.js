const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

test('all derived canonical format slots accept the base array contract', () => {
  const result = spawnSync(
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'),
    [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'test/fixtures/types/canonical-format-slots.ts',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );

  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
