const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');

test('reads logical bundled schema paths from the published archive shape', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'bundled-schema-store-'));
  const harness = path.join(tempDir, 'harness.ts');
  writeFileSync(
    harness,
    `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import {
  hasBundledSchemaStore,
  listBundledSchemaFiles,
  loadBundledSchemaFile,
} from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'lib', 'validation', 'bundled-schema-store.ts'))};

// A parent directory also named "bundled" verifies path lookup selects the
// schema-store segment nearest the logical file.
const versionRoot = ${JSON.stringify(path.join(tempDir, 'bundled', 'consumer', '3.2'))};
const bundledRoot = path.join(versionRoot, 'bundled');
mkdirSync(versionRoot, { recursive: true });
const expandedSchema = {
  $id: '/schemas/3.2/media-buy/get-products-request.json',
  type: 'object',
  properties: { account: { $id: '/schemas/3.2/core/account.json', type: 'string' } },
};
const schema = {
  $id: expandedSchema.$id,
  type: 'object',
  properties: { account: { $ref: '#/$defs/__adcp_shared_0' } },
  $defs: { __adcp_shared_0: expandedSchema.properties.account },
  'x-adcp-compact-definitions': ['__adcp_shared_0'],
};
writeFileSync(
  path.join(versionRoot, 'bundled.schemas.br'),
  brotliCompressSync(Buffer.from(JSON.stringify({ 'media-buy/get-products-request.json': schema })))
);

assert.equal(hasBundledSchemaStore(bundledRoot), true);
assert.deepEqual(listBundledSchemaFiles(bundledRoot), [
  path.join(bundledRoot, 'media-buy/get-products-request.json'),
]);
assert.deepEqual(loadBundledSchemaFile(path.join(bundledRoot, 'media-buy/get-products-request.json')), expandedSchema);

const unsafeVersionRoot = ${JSON.stringify(path.join(tempDir, 'unsafe'))};
const unsafeBundledRoot = path.join(unsafeVersionRoot, 'bundled');
mkdirSync(unsafeVersionRoot, { recursive: true });
writeFileSync(
  path.join(unsafeVersionRoot, 'bundled.schemas.br'),
  brotliCompressSync(Buffer.from(JSON.stringify({ '../escape.json': schema })))
);
assert.throws(() => listBundledSchemaFiles(unsafeBundledRoot), /invalid entry/);
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
