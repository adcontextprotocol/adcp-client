const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');

test('compacts shared schema nodes without turning annotation data into refs', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'compact-schema-bundle-'));
  const harness = path.join(tempDir, 'harness.ts');
  writeFileSync(
    harness,
    `
import assert from 'node:assert/strict';
import Ajv from ${JSON.stringify(path.join(REPO_ROOT, 'node_modules', 'ajv', 'dist', 'ajv.js'))};
import { compactBundledSchema } from ${JSON.stringify(path.join(REPO_ROOT, 'scripts', 'compact-schema-bundle.ts'))};

const first = {
  $id: '/nested/shared.json',
  type: 'string',
  enum: ['active', 'paused'],
  description: 'x'.repeat(300),
};
const second = { ...first };
const annotation = { source: 'fixture' };
const root = {
  $id: '/root.json',
  type: 'object',
  properties: { first, second },
  required: ['first', 'second'],
  examples: [annotation, annotation],
};

const compacted = compactBundledSchema(root);
assert.equal(compacted.$id, '/root.json');
assert.equal(JSON.stringify(compacted).includes('/nested/shared.json'), true);
assert.deepEqual(compacted.examples, [{ source: 'fixture' }, { source: 'fixture' }]);
assert.deepEqual(compacted.properties.first, { $ref: '#/$defs/__adcp_shared_0' });
assert.deepEqual(compacted.properties.second, { $ref: '#/$defs/__adcp_shared_0' });
assert.deepEqual(compacted['x-adcp-compact-definitions'], ['__adcp_shared_0']);

const validate = new Ajv({ strict: false }).compile(compacted);
assert.equal(validate({ first: 'active', second: 'paused' }), true);
assert.equal(validate({ first: 'invalid', second: 'active' }), false);

const itemSchema = { type: 'string', description: 'y'.repeat(300) };
const itemForms = compactBundledSchema({
  type: 'object',
  properties: {
    all: { type: 'array', items: { ...itemSchema } },
    tuple: { type: 'array', items: [{ ...itemSchema }] },
  },
  required: ['all', 'tuple'],
});
const validateItemForms = new Ajv({ strict: false }).compile(itemForms);
assert.equal(validateItemForms({ all: ['ok'], tuple: ['ok', 42] }), true);
`
  );

  try {
    const result = spawnSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), [harness], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
