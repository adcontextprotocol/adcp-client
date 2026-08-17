const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function runHarness(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-schema-ref-'));
  const script = path.join(directory, 'harness.ts');
  const output = path.join(directory, 'output.json');
  fs.writeFileSync(
    script,
    source
      .replaceAll('__HELPER__', JSON.stringify(path.join(REPO_ROOT, 'scripts/schema-cache-ref.ts')))
      .replaceAll('__GENERATOR__', JSON.stringify(path.join(REPO_ROOT, 'scripts/generate-types.ts')))
      .replaceAll('__OUTPUT__', JSON.stringify(output))
  );
  try {
    const result = spawnSync('npx', ['tsx', script], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `harness failed:\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('canonical protocol 3.2 schema URIs resolve to signed-cache relative paths', () => {
  const result = runHarness(`
import { writeFileSync } from 'node:fs';
import { schemaRefToCacheRelativePath } from __HELPER__;

const refs = [
  'https://adcontextprotocol.org/schemas/3.2.0-beta.0/core/product.json',
  '/schemas/3.2.0-beta.0/core/product.json',
  '/schemas/v1/core/product.json',
  'core/product.json',
];
writeFileSync(__OUTPUT__, JSON.stringify({
  resolved: refs.map(schemaRefToCacheRelativePath),
  rejected: [
    'https://example.com/schemas/3.2.0-beta.0/core/product.json',
    'https://adcontextprotocol.org/schemas/3.2.0-beta.0/../../secret',
    '../../secret',
    '#/$defs/Product',
  ].map(schemaRefToCacheRelativePath),
}));
`);

  assert.deepEqual(result.resolved, Array(4).fill('core/product.json'));
  assert.deepEqual(result.rejected, Array(4).fill(null));
});

test('emit-only preprocessing coalesces disjoint definitions and rewrites pointers', () => {
  const result = runHarness(`
import { writeFileSync } from 'node:fs';
import { coalesceDefinitionKeywords } from __GENERATOR__;

const schema = {
  definitions: { Legacy: { type: 'string' } },
  $defs: { Modern: { type: 'integer' } },
  properties: {
    legacy: { $ref: '#/definitions/Legacy' },
    modern: { $ref: '#/$defs/Modern' },
  },
};
const transformed = coalesceDefinitionKeywords(schema);
writeFileSync(__OUTPUT__, JSON.stringify(transformed));
`);

  assert.equal(result.definitions, undefined);
  assert.deepEqual(Object.keys(result.$defs).sort(), ['Legacy', 'Modern']);
  assert.equal(result.properties.legacy.$ref, '#/$defs/Legacy');
  assert.equal(result.properties.modern.$ref, '#/$defs/Modern');
});
