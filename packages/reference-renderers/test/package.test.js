import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const sources = await Promise.all(
  ['index.js', 'structured.js'].map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8'))
);

test('package is public browser ESM with no runtime dependencies', () => {
  assert.equal(packageMetadata.name, '@adcp/reference-renderers');
  assert.equal(packageMetadata.type, 'module');
  assert.equal(packageMetadata.private, undefined);
  assert.equal(packageMetadata.publishConfig.access, 'public');
  assert.equal(packageMetadata.publishConfig.provenance, true);
  assert.equal(packageMetadata.dependencies, undefined);
});

test('renderer sources have no ambient or network capabilities', () => {
  for (const forbidden of [
    "from 'node:",
    'require(',
    'process.',
    'fetch(',
    'XMLHttpRequest',
    'document.create',
    'document.write',
    'document.body',
    'localStorage',
  ]) {
    for (const source of sources) {
      assert.equal(
        source.includes(forbidden),
        false,
        `browser renderer contains forbidden runtime capability: ${forbidden}`
      );
    }
  }
});
