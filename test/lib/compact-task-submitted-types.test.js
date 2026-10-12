const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
test('compact submitted envelope stays source-compatible for 3.2.3-shaped callers', () => {
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      path.resolve('test/fixtures/types/compact-task-submitted.ts'),
    ],
    { stdio: 'pipe', timeout: 60000 }
  );
});
