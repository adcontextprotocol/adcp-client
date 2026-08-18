import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('package is public browser ESM with no runtime dependencies', () => {
  assert.equal(packageMetadata.name, '@adcp/reference-renderers');
  assert.equal(packageMetadata.type, 'module');
  assert.equal(packageMetadata.private, undefined);
  assert.equal(packageMetadata.publishConfig.access, 'public');
  assert.equal(packageMetadata.publishConfig.provenance, true);
  assert.equal(packageMetadata.dependencies, undefined);
});

test('renderer source has no ambient or network capabilities', () => {
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
    assert.equal(
      source.includes(forbidden),
      false,
      `browser renderer contains forbidden runtime capability: ${forbidden}`
    );
  }
});
