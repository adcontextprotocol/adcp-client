const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { runInNewContext } = require('node:vm');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { gzipSync } = require('node:zlib');
const pkg = require('../../package.json');

const portableValidators = [
  'GetProductsRequestSchema',
  'LegacyGetProductsRequestSchema',
  'BiddingPolicySchema',
  'CanonicalBudgetAllocationSchema',
  'SyncCreativesItemSchema',
  'SyncCreativesSuccessStrictSchema',
  'SyncCreativesResponseStrictSchema',
  'SyncCreativesActionSchema',
];

test('browser schemas expose generated schemas and portable validators through ESM and CommonJS', async () => {
  const cjs = require('@adcp/sdk/schemas/browser');
  const esm = await import('@adcp/sdk/schemas/browser');
  const nodeSchemas = require('@adcp/sdk/schemas');
  const nodeEsmSchemas = await import('@adcp/sdk/schemas');
  const generated = require('../../dist/lib/types/schemas.generated.js');

  assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
  for (const name of Object.keys(generated)) {
    assert.equal(cjs[name], nodeSchemas[name], name);
    assert.equal(esm[name], nodeEsmSchemas[name], name);
  }
  for (const name of portableValidators) {
    assert.equal(cjs[name], nodeSchemas[name], name);
    assert.equal(esm[name], nodeEsmSchemas[name], name);
  }
  assert.equal(typeof nodeSchemas.getCanonicalToolValidator, 'function');
  assert.equal(typeof nodeSchemas.getToolInputSchema, 'function');
  assert.equal(cjs.getCanonicalToolValidator, undefined);
  assert.equal(cjs.getToolInputSchema, undefined);
});

test('browser schemas publish declaration paths for modern and legacy TypeScript resolution', () => {
  assert.deepEqual(pkg.typesVersions['*']['schemas/browser'], ['dist/lib/schemas/browser.d.ts']);
  for (const condition of ['import', 'require']) {
    const entry = pkg.exports['./schemas/browser'][condition];
    assert.ok(existsSync(resolve(entry.types)), entry.types);
    assert.ok(existsSync(resolve(entry.default)), entry.default);
  }
});

test('a single browser schema drops unrelated validators and stays within its size budget', async t => {
  const result = await build({
    stdin: {
      contents:
        "import { EventSourceHealthSchema } from '@adcp/sdk/schemas/browser'; globalThis.healthSchema = EventSourceHealthSchema;",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const { contents, text } = result.outputFiles[0];
  const output = Object.values(result.metafile.outputs)[0];
  const generatedInput = output.inputs['dist/lib/types/schemas.generated.mjs'];
  assert.ok(generatedInput, `expected generated schemas in bundle inputs: ${Object.keys(output.inputs).join(', ')}`);
  const generatedBytes = generatedInput.bytesInOutput;
  const gzipBytes = gzipSync(contents).length;
  t.diagnostic(`single schema: ${contents.length} B minified, ${gzipBytes} B gzip, ${generatedBytes} B generated`);

  // Includes Zod and ajv-formats. See docs/ZOD-SCHEMAS.md for the measured
  // baseline and flags; the generated-code budget catches over-retention even
  // if a dependency update makes the total bundle smaller.
  assert.ok(contents.length <= 375000, `minified browser schema bundle is ${contents.length} B`);
  assert.ok(gzipBytes <= 75000, `gzipped browser schema bundle is ${gzipBytes} B`);
  assert.ok(generatedBytes <= 2048, `single schema retains ${generatedBytes} B of generated validators`);
  for (const unrelatedField of ['product_id', 'media_buy_id', 'reporting_obligation_id']) {
    assert.ok(!text.includes(unrelatedField), `unused ${unrelatedField} validator survived tree-shaking`);
  }
  assert.equal(output.imports.length, 0);
  const context = { URL };
  runInNewContext(text, context, { timeout: 10000 });
  const health = { status: 'good', match_rate: 0.8, last_event_at: '2026-10-09T12:00:00Z' };
  assert.equal(context.healthSchema.safeParse(health).success, true);
  assert.equal(context.healthSchema.safeParse({ ...health, match_rate: 2 }).success, false);
  assert.equal(context.healthSchema.safeParse({ ...health, last_event_at: 'invalid' }).success, false);
});

test('a portable action validator drops the other sync-creatives validators', async () => {
  const result = await build({
    stdin: {
      contents:
        "import { SyncCreativesActionSchema } from '@adcp/sdk/schemas/browser'; globalThis.actionSchema = SyncCreativesActionSchema;",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  for (const unrelated of ['SyncCreativesItemSchema', 'SyncCreativesSuccessStrictSchema', 'AccountSchema']) {
    assert.ok(!code.includes(unrelated), `${unrelated} survived an action-only import`);
  }
  const context = {};
  runInNewContext(code, context, { timeout: 10000 });
  assert.equal(context.actionSchema.safeParse('deleted').success, true);
  assert.equal(context.actionSchema.safeParse('invalid').success, false);
});

for (const format of ['esm', 'cjs']) {
  test(`all ${format} browser schema exports bundle and execute without Node globals`, async () => {
    const contents =
      format === 'esm'
        ? "import * as schemas from '@adcp/sdk/schemas/browser'; globalThis.browserSchemas = schemas;"
        : "globalThis.browserSchemas = require('@adcp/sdk/schemas/browser');";
    const result = await build({
      stdin: { contents, resolveDir: process.cwd() },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.ok(inputs.some(path => path.endsWith(`schemas/browser.${format === 'esm' ? 'mjs' : 'js'}`)));
    assert.ok(inputs.some(path => path.includes('ajv-formats/dist/formats.js')));
    assert.ok(
      inputs.every(path => !/schema-loader|bundled-schema-store|protocols\//.test(path)),
      inputs.join('\n')
    );
    assert.ok(Object.values(result.metafile.outputs).every(output => output.imports.length === 0));

    // Exercise the bundled code with no require, process, Buffer, or other Node globals.
    const context = { URL };
    runInNewContext(result.outputFiles[0].text, context, { timeout: 10000 });
    const schemas = context.browserSchemas;
    const legacyRequest = { buying_mode: 'brief', brief: 'Campaign brief', fields: ['format_ids'] };
    assert.equal(schemas.GetProductsRequestSchema.safeParse(legacyRequest).success, false);
    assert.equal(schemas.LegacyGetProductsRequestSchema.safeParse(legacyRequest).success, true);
    assert.equal(
      schemas.GetProductsRequestSchema.safeParse({ ...legacyRequest, fields: ['pricing_options'] }).success,
      true
    );
    for (const name of ['EventSourceHealthSchema', 'SyncAudiencesResponseSchema', 'SyncEventSourcesResponseSchema']) {
      assert.equal(typeof schemas[name].safeParse, 'function', name);
      assert.equal(schemas[name].safeParse(null).success, false, name);
    }
    const health = { status: 'good', match_rate: 0.8, last_event_at: '2026-10-09T12:00:00Z' };
    assert.equal(schemas.EventSourceHealthSchema.safeParse(health).success, true);
    assert.equal(schemas.EventSourceHealthSchema.safeParse({ ...health, match_rate: 2 }).success, false);
    assert.equal(schemas.EventSourceHealthSchema.safeParse({ ...health, last_event_at: 'invalid' }).success, false);
    assert.equal(
      schemas.SyncAudiencesResponseSchema.safeParse({
        status: 'completed',
        audiences: [{ audience_id: 'audience-1', action: 'created' }],
      }).success,
      true
    );
    assert.equal(
      schemas.SyncAudiencesResponseSchema.safeParse({
        status: 'completed',
        audiences: [{ audience_id: 'audience-1', action: 'invalid' }],
      }).success,
      false
    );
    assert.equal(
      schemas.SyncEventSourcesResponseSchema.safeParse({
        status: 'completed',
        event_sources: [{ event_source_id: 'source-1', action: 'updated', health }],
      }).success,
      true
    );
    assert.equal(
      schemas.SyncEventSourcesResponseSchema.safeParse({
        status: 'completed',
        event_sources: [{ event_source_id: 'source-1', action: 'updated', health: { status: 'invalid' } }],
      }).success,
      false
    );
    assert.equal(schemas.BiddingPolicySchema.safeParse({ automatic: true }).success, true);
    assert.equal(schemas.BiddingPolicySchema.safeParse({ automatic: true, max_bid: 1 }).success, false);
    assert.equal(
      schemas.CanonicalBudgetAllocationSchema.safeParse({ mode: 'seller_optimized', optimization_goals: [] }).success,
      false
    );
    assert.equal(
      schemas.SyncCreativesItemSchema.safeParse({ creative_id: 'creative-1', action: 'deleted' }).success,
      true
    );
    assert.equal(
      schemas.SyncCreativesItemSchema.safeParse({ creative_id: 'creative-1', action: 'deleted', status: 'approved' })
        .success,
      false
    );
  });
}
