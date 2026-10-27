const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { z } = require('zod');
const { nonemptyArray } = require('../dist/lib/validation/nonempty-array.js');
const source = `export const S = z.object({
  segments: z.array(z.object({ prompts: z.array(z.string()).min(1) })).min(1).max(2),
  fixed: z.tuple([z.string(), z.string()]),
  emptyOk: z.array(z.string())
});`;

test('nonempty arrays preserve nested cardinality and maximum bounds', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
const { __test__ } = require('./scripts/generate-zod-from-ts.ts');
const source = ${JSON.stringify(source)};
const output = __test__.postProcessNonemptyArrays(source);
require('node:assert/strict').equal(__test__.postProcessNonemptyArrays(output), output);
process.stdout.write(output);
`,
    ],
    { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' }
  );
  const schema = new Function('z', 'nonemptyArray', output.replace('export const', 'const') + '\nreturn S;')(
    z,
    nonemptyArray
  );
  const valid = { segments: [{ prompts: ['a'] }], fixed: ['a', 'b'], emptyOk: [] };
  assert.deepEqual(schema.parse(valid), valid);
  for (const invalid of [
    { ...valid, segments: [] },
    { ...valid, segments: [{ prompts: [] }] },
    { ...valid, segments: [...valid.segments, ...valid.segments, ...valid.segments] },
    { ...valid, fixed: ['1', '2', '3'] },
  ])
    assert.equal(schema.safeParse(invalid).success, false);
  const json = z.toJSONSchema(schema, { target: 'draft-7' });
  assert.equal(json.properties.segments.minItems, 1);
  assert.equal(json.properties.segments.maxItems, 2);
  assert.equal(json.properties.segments.prefixItems, undefined);
  assert.equal(json.properties.segments.items.type, 'object');
});

test('source minItems metadata is restored before nonempty tuple emission', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
const { __test__ } = require('./scripts/generate-zod-from-ts.ts');
const types = ['export interface VideoBrief {', '/** @minItems 1 */', 'segments: string[];', '}'].join('\\n');
const schemas = 'export const VideoBriefSchema = z.object({ segments: z.array(z.string()) });';
const bounded = __test__.postProcessArrayMaxItems(schemas, types, 'min');
process.stdout.write(__test__.postProcessNonemptyArrays(bounded));
`,
    ],
    { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' }
  );
  const schema = new Function(
    'z',
    'nonemptyArray',
    output.replace('export const', 'const') + '\nreturn VideoBriefSchema;'
  )(z, nonemptyArray);
  assert.equal(schema.safeParse({ segments: [] }).success, false);
  assert.deepEqual(schema.parse({ segments: ['prompt'] }), { segments: ['prompt'] });
});
