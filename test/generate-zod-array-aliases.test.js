const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { z } = require('zod');

function restoreBounds(types, schemas) {
  return execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
const assert = require('node:assert/strict');
const { __test__ } = require('./scripts/generate-zod-from-ts.ts');
const types = ${JSON.stringify(types)};
let schemas = ${JSON.stringify(schemas)};
for (const method of ['max', 'min']) {
  schemas = __test__.postProcessArrayMaxItems(schemas, types, method);
  assert.equal(__test__.postProcessArrayMaxItems(schemas, types, method), schemas);
}
process.stdout.write(schemas);
`,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

test('array aliases retain use-site bounds without constraining other uses', () => {
  // beta.1 can emit a named array reference even when the source property
  // carries its own cardinality metadata (adcp-client#3485).
  const output = restoreBounds(
    `export interface TargetingOverlay {
      /** @minItems 1 @maxItems 2 */
      geo_countries?: string[] | null;
      unbounded?: string[];
    }`,
    `const GeoCountriesSchema = z.array(z.string()).min(0).max(5).describe('Countries').meta({ title: 'Countries' });
     const CountryAliasSchema = GeoCountriesSchema;
     const TargetingOverlaySchema = z.object({
       geo_countries: CountryAliasSchema.nullable().optional(),
       unbounded: GeoCountriesSchema.optional()
     });`
  );
  const schema = new Function('z', `${output}\nreturn TargetingOverlaySchema;`)(z);
  for (const value of [undefined, null, ['US'], ['US', 'GB']]) {
    assert.equal(schema.safeParse({ geo_countries: value }).success, true);
  }
  for (const value of [[], ['US', 'GB', 'DE'], 'US']) {
    assert.equal(schema.safeParse({ geo_countries: value }).success, false);
  }
  assert.equal(schema.safeParse({ unbounded: [] }).success, true);
  assert.equal(schema.safeParse({ unbounded: ['US', 'GB', 'DE'] }).success, true);
  assert.equal(schema.safeParse({ unbounded: ['US', 'GB', 'DE', 'FR', 'CA', 'AU'] }).success, false);

  const json = z.toJSONSchema(schema, { target: 'draft-7' });
  const array = json.properties.geo_countries.anyOf.find(branch => branch.type === 'array');
  assert.equal(array.minItems, 1);
  assert.equal(array.maxItems, 2);
  assert.equal(json.properties.unbounded.minItems, 0);
  assert.equal(json.properties.unbounded.maxItems, 5);
});

test('nested array bounds follow aliases only when the shared declaration owns the same bound', () => {
  const nested = `{
    /** @minItems 1 */
    values: string[];
  }[]`;
  const schemas = `const GeoMetrosExcludeSchema = z.array(z.object({ values: z.array(z.string()) }));
    const TargetingOverlaySchema = z.object({ geo_metros_exclude: GeoMetrosExcludeSchema.optional() });`;
  const output = restoreBounds(
    `export type GeoMetrosExclude = ${nested};
     export interface TargetingOverlay { geo_metros_exclude?: ${nested}; }`,
    schemas
  );
  const schema = new Function('z', `${output}\nreturn TargetingOverlaySchema;`)(z);
  assert.equal(schema.safeParse({ geo_metros_exclude: [{ values: ['501'] }] }).success, true);
  assert.equal(schema.safeParse({ geo_metros_exclude: [{ values: [] }] }).success, false);
  const json = z.toJSONSchema(schema, { target: 'draft-7' });
  assert.equal(json.properties.geo_metros_exclude.items.properties.values.minItems, 1);

  // Without matching metadata on the alias, a use-specific nested constraint
  // must not be silently applied to every other user of that shared schema.
  assert.throws(
    () => restoreBounds(`export interface TargetingOverlay { geo_metros_exclude?: ${nested}; }`, schemas),
    /Unable to restore @minItems for TargetingOverlay.geo_metros_exclude.values/
  );
});

test('unresolvable and cyclic array aliases fail closed', () => {
  const types = `export interface Bounded {
    /** @minItems 1 */
    values: string[];
  }`;
  for (const aliases of [
    '',
    'const FirstSchema = SecondSchema; const SecondSchema = FirstSchema;',
    'const FirstSchema = z.string();',
    'const FirstSchema = z.array(z.string()).nullable();',
  ]) {
    assert.throws(
      () => restoreBounds(types, `${aliases}\nconst BoundedSchema = z.object({ values: FirstSchema });`),
      /Unable to restore @minItems for Bounded.values/
    );
  }
});
