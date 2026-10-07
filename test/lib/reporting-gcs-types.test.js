const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
test('GCS declarations preserve existing explicit-generic status handler calls', () => {
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
      path.resolve('test/fixtures/types/reporting-gcs.ts'),
    ],
    { stdio: 'pipe', timeout: 60000 }
  );
});
