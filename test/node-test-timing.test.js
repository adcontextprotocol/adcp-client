const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const reporterUrl = pathToFileURL(path.resolve(__dirname, '../scripts/node-test-timing-reporter.mjs')).href;
const mergeUrl = pathToFileURL(path.resolve(__dirname, '../scripts/merge-node-test-timings.mjs')).href;
const { parseTimingSnapshot } = require('../scripts/run-test-with-summary.js');

test('timing reporter totals top-level test durations by repository-relative file', async () => {
  const { collectFileTiming } = await import(reporterUrl);
  const timings = new Map();
  const file = path.join(process.cwd(), 'test/example.test.js');

  collectFileTiming(timings, {
    type: 'test:pass',
    data: { file, nesting: 0, details: { duration_ms: 125 } },
  });
  collectFileTiming(timings, {
    type: 'test:fail',
    data: { file, nesting: 0, details: { duration_ms: 75 } },
  });
  collectFileTiming(timings, {
    type: 'test:pass',
    data: { file, nesting: 1, details: { duration_ms: 500 } },
  });

  assert.deepEqual([...timings], [['test/example.test.js', 200]]);
});

test('timing merge is stable and rejects overlapping shard artifacts', async t => {
  const { mergeTimingFiles } = await import(mergeUrl);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-test-timings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'timings-1.json');
  const second = path.join(directory, 'timings-2.json');
  fs.writeFileSync(first, JSON.stringify({ version: 1, tests: { 'test/b.test.js': 200 } }));
  fs.writeFileSync(second, JSON.stringify({ version: 1, tests: { 'test/a.test.js': 100 } }));

  assert.deepEqual(mergeTimingFiles([first, second]), {
    version: 1,
    tests: { 'test/a.test.js': 100, 'test/b.test.js': 200 },
  });

  fs.writeFileSync(second, JSON.stringify({ version: 1, tests: { 'test/b.test.js': 300 } }));
  assert.throws(() => mergeTimingFiles([first, second]), /more than one timing artifact/);
});

test('summary wrapper decodes the final reporter timing snapshot', () => {
  const first = Buffer.from(JSON.stringify({ 'test/a.test.js': 100 })).toString('base64');
  const final = Buffer.from(JSON.stringify({ 'test/a.test.js': 125, 'test/b.test.js': 250 })).toString('base64');
  const output = `# ADCP_TEST_TIMINGS ${first}\nother TAP output\n# ADCP_TEST_TIMINGS ${final}\n`;

  assert.deepEqual(parseTimingSnapshot(output), {
    'test/a.test.js': 125,
    'test/b.test.js': 250,
  });
});
