const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const modulePromise = import(pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'check-package-size.mjs')).href);

test('parses clean npm pack JSON output', async () => {
  const { parseNpmPackOutput } = await modulePromise;
  assert.deepEqual(parseNpmPackOutput('[{"size": 42}]\n'), [{ size: 42 }]);
});

test('ignores ANSI-colored prepare output before npm pack JSON', async () => {
  const { parseNpmPackOutput } = await modulePromise;
  const output = '\x1b[32m✅ Git hooks are already configured\x1b[0m\n[prepare] done\n[{"size": 42}]\n';
  assert.deepEqual(parseNpmPackOutput(output), [{ size: 42 }]);
});

test('fails closed when npm pack returns no JSON array', async () => {
  const { parseNpmPackOutput } = await modulePromise;
  assert.throws(() => parseNpmPackOutput('\x1b[31mpack failed\x1b[0m\n'), /valid JSON array/);
});
