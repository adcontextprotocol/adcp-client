const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
test('asset cardinality restoration does not change unrelated array schemas', () => {
  const source = `export interface Catalog {
/** @minItems 1 */
items?: object[];
}
export interface Unrelated {
/** @minItems 1 */
values: string[];
}`;
  const schemas = `export const CatalogSchema = z.object({items: z.array(z.object({})).optional()});
export const AssetVariantSchema = z.union([CatalogSchema, z.string()]);
export const UnrelatedSchema = z.object({values: z.array(z.string())});`;
  const script = `const { __test__ } = require('./scripts/generate-zod-from-ts.ts');
process.stdout.write(__test__.postProcessAssetMinimumItems(${JSON.stringify(schemas)}, ${JSON.stringify(source)}));`;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.match(output, /items: z\.array\(z\.object\(\{\}\)\)\.min\(1\)/);
  assert.match(output, /values: z\.array\(z\.string\(\)\)\}/);
});
