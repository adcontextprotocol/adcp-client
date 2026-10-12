const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('resolveAccount keeps existing wire-reference types and infers detailed results', () => {
  const compiled = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      'test/fixtures/types/buyer-account-resolution.ts',
    ],
    { cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
});
