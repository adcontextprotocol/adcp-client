const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const runnerUrl = pathToFileURL(path.resolve(__dirname, '../scripts/run-node-tests.mjs')).href;

test('local test concurrency is bounded while CI keeps the Node default', async () => {
  const { resolveTestConcurrency } = await import(runnerUrl);

  assert.equal(resolveTestConcurrency({ env: {}, group: 'fast', parallelism: 16 }), 2);
  assert.equal(resolveTestConcurrency({ env: {}, group: 'slow', parallelism: 16 }), 1);
  assert.equal(resolveTestConcurrency({ env: { CI: 'true' }, group: 'fast', parallelism: 16 }), undefined);
  assert.equal(resolveTestConcurrency({ env: { CI: 'false' }, group: 'fast', parallelism: 16 }), 2);
  assert.equal(resolveTestConcurrency({ env: { TEST_CONCURRENCY: '3' }, group: 'fast', parallelism: 16 }), 3);
});

test('invalid concurrency values fail before starting the suite', async () => {
  const { resolveTestConcurrency } = await import(runnerUrl);

  assert.throws(() => resolveTestConcurrency({ env: { TEST_CONCURRENCY: '0' }, parallelism: 8 }), /positive integer/);
  assert.throws(() => resolveTestConcurrency({ cliValue: 'many', env: {}, parallelism: 8 }), /positive integer/);
});

test('fast and slow selections are complementary and scope-aware', async () => {
  const { discoverNodeTests, selectNodeTests, SLOW_NODE_TESTS } = await import(runnerUrl);
  const all = discoverNodeTests('node');
  const library = discoverNodeTests('lib');
  const fast = selectNodeTests(all, 'fast');
  const slow = selectNodeTests(all, 'slow');

  assert.deepEqual([...fast, ...slow].sort(), all.slice().sort());
  // `test:examples` owns example-adapter execution, but focused `test:file`
  // still uses this set to grant their integration tests the right timeout.
  assert.deepEqual(
    [...SLOW_NODE_TESTS].filter(file => !all.includes(file)),
    ['test/examples/hello-seller-adapter-guaranteed.test.js']
  );
  assert.equal(
    fast.some(file => SLOW_NODE_TESTS.has(file)),
    false
  );
  assert.equal(
    slow.every(file => SLOW_NODE_TESTS.has(file)),
    true
  );
  assert.equal(
    library.every(file => file.startsWith('test/lib/')),
    true
  );
  assert.equal(
    selectNodeTests(library, 'slow').every(file => file.startsWith('test/lib/')),
    true
  );
});

test('runner arguments support CI sharding and focused files', async () => {
  const { buildNodeTestArgs, parseRunnerArgs } = await import(runnerUrl);
  const options = parseRunnerArgs([
    '--group=fast',
    '--scope',
    'lib',
    '--shard',
    '2/3',
    '--concurrency=1',
    'test/lib/pagination.test.js',
  ]);
  const invocation = buildNodeTestArgs(options, {});

  assert.deepEqual(invocation.files, ['test/lib/pagination.test.js']);
  assert.equal(invocation.concurrency, 1);
  assert.equal(invocation.timeoutMs, 60_000);
  assert.equal(invocation.args.includes('--test-shard=2/3'), true);
  assert.equal(invocation.args.includes('--test-concurrency=1'), true);
});

test('focused slow tests retain the extended timeout', async () => {
  const { buildNodeTestArgs, parseRunnerArgs } = await import(runnerUrl);
  const options = parseRunnerArgs(['test/examples/hello-seller-adapter-guaranteed.test.js']);
  const invocation = buildNodeTestArgs(options, {});

  assert.equal(invocation.timeoutMs, 180_000);
});

test('invalid groups, scopes, and shards fail even for focused files', async () => {
  const { buildNodeTestArgs, parseRunnerArgs } = await import(runnerUrl);

  assert.throws(
    () => buildNodeTestArgs(parseRunnerArgs(['--group', 'warm', 'test/lib/pagination.test.js']), {}),
    /Unknown test group/
  );
  assert.throws(
    () => buildNodeTestArgs(parseRunnerArgs(['--scope', 'unit', 'test/lib/pagination.test.js']), {}),
    /Unknown test scope/
  );
  assert.throws(
    () => buildNodeTestArgs(parseRunnerArgs(['--shard', '4/3', 'test/lib/pagination.test.js']), {}),
    /exceeds shard count/
  );
});
