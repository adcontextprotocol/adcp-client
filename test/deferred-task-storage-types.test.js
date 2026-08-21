const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

test('exported deferred storage types describe the durable runtime contract', () => {
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
      'test/fixtures/types/deferred-task-storage.ts',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );

  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
