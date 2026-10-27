const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AssetVariantSchema } = require('../../dist/lib/schemas');
test('stable asset schema rejects empty canonical macro and catalog arrays and retains union options', () => {
  assert.equal(Array.isArray(AssetVariantSchema.options), true);
  const vast = { asset_type: 'vast', delivery_type: 'url', url: 'https://cdn.example/vast.xml' };
  assert.equal(AssetVariantSchema.safeParse(vast).success, true);
  assert.equal(AssetVariantSchema.safeParse({ ...vast, macro_declarations: [] }).success, false);
  assert.equal(AssetVariantSchema.safeParse({ asset_type: 'catalog', type: 'product', items: [] }).success, false);
  assert.equal(AssetVariantSchema.safeParse({ asset_type: 'catalog', type: 'product', items: [{}] }).success, true);
});
test('published stable AssetVariant schema output compiles against canonical and per-tool types', () => {
  const { spawnSync } = require('node:child_process');
  const { resolve } = require('node:path');
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      'test/fixtures/types/asset-variant-stable.mts',
    ],
    { cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(result.status, 0, result.stdout || result.stderr || String(result.error));
});
