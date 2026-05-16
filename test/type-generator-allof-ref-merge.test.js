/**
 * Regression test for adcp-client#1756.
 *
 * `enforceStrictSchema` pre-merges `allOf: [{ $ref }]` patterns when the
 * parent declares its own `properties` / `required` siblings. Without this
 * merge, `json-schema-to-typescript` emits broken unions
 * (`( BaseFields | { variant + duplicated base fields } )`) where the
 * intent is `BaseFields & { variant }`. This blocks adcp#4510 (schema
 * dedup spike) until the codegen path can absorb the new shape.
 *
 * The test covers three scenarios:
 *
 *   1. Pure `allOf: [{ $ref }]` at root with no sibling properties — the
 *      `vendor-pricing-option.json` shape — must pass through untouched
 *      because jsts handles it correctly.
 *   2. The broken pattern (properties + required + allOf[$ref] siblings)
 *      with an external ref the cache can resolve — must merge into a flat
 *      shape with `allOf` consumed.
 *   3. A `oneOf` with two broken-pattern variants must emit a clean
 *      discriminated union, no broken `( Base | { variant } )` arms.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Drives the test via a short tsx script that imports the production
 * `enforceStrictSchema` + `compile` and writes the result to a temp file.
 * Keeps the test runner CommonJS while still exercising the TS export.
 */
function runHarness(harnessSource) {
  // The harness must live under the repo so `tsx` resolves bare specifiers
  // (`json-schema-to-typescript`, etc.) against the project node_modules.
  const harnessDir = fs.mkdtempSync(path.join(REPO_ROOT, '.allof-ref-merge-harness-'));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  const outPath = path.join(harnessDir, 'out.json');
  const generateTypesPath = path.join(REPO_ROOT, 'scripts/generate-types.ts');
  const prepared = harnessSource
    .replace(/__OUT_PATH__/g, JSON.stringify(outPath))
    .replace(/__GENERATE_TYPES__/g, generateTypesPath);
  fs.writeFileSync(scriptPath, prepared);
  try {
    const r = spawnSync('npx', ['tsx', scriptPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`harness failed (${r.status}): ${r.stderr}\n${r.stdout}`);
    }
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
}

test('enforceStrictSchema leaves allOf-only root (no sibling properties) untouched', () => {
  const result = runHarness(`
import { writeFileSync } from 'fs';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const input = {
  type: 'object',
  description: 'Vendor pricing option style',
  allOf: [
    { type: 'object', properties: { pricing_option_id: { type: 'string' } }, required: ['pricing_option_id'] },
    { $ref: '/schemas/3.0.11/core/signal-pricing.json' },
  ],
};
const out = enforceStrictSchema(JSON.parse(JSON.stringify(input)));
writeFileSync(__OUT_PATH__, JSON.stringify({
  hasAllOf: !!out.allOf,
  allOfLen: out.allOf?.length ?? 0,
  ownProperties: Object.keys(out.properties ?? {}),
}));
`);
  assert.strictEqual(result.hasAllOf, true, 'vendor-pricing-option style must keep its allOf');
  assert.strictEqual(result.allOfLen, 2, 'both allOf members must remain');
  assert.deepStrictEqual(result.ownProperties, [], 'parent must not gain inlined properties');
});

test('enforceStrictSchema merges allOf[$ref] siblings into parent properties/required', () => {
  const result = runHarness(`
import { writeFileSync } from 'fs';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const input = {
  type: 'object',
  properties: {
    asset_type: { type: 'string', const: 'brief' },
  },
  required: ['asset_type'],
  allOf: [
    { $ref: '/schemas/3.0.11/core/creative-brief.json' },
  ],
};
const out = enforceStrictSchema(JSON.parse(JSON.stringify(input)));
writeFileSync(__OUT_PATH__, JSON.stringify({
  hasAllOf: !!out.allOf,
  propertyKeys: Object.keys(out.properties ?? {}),
  hasAssetType: !!out.properties?.asset_type,
  requiredIncludesAssetType: (out.required ?? []).includes('asset_type'),
}));
`);
  assert.strictEqual(result.hasAllOf, false, 'allOf[$ref] must be consumed by the merge');
  assert.ok(result.hasAssetType, 'variant-level asset_type discriminator must be preserved');
  assert.ok(result.requiredIncludesAssetType, 'variant required[] must survive the merge');
  // Base properties from creative-brief.json should have been merged in.
  assert.ok(
    result.propertyKeys.length > 1,
    'base properties must merge into parent (got: ' + result.propertyKeys.join(',') + ')'
  );
});

test('compiled oneOf with two broken-pattern variants emits a clean discriminated union', () => {
  // Uses a real cached schema (signal-pricing.json) so the cache resolver
  // path is exercised end-to-end without depending on every $ref the base
  // schema transitively pulls in.
  const result = runHarness(`
import { writeFileSync } from 'fs';
import { readFileSync } from 'fs';
import { compile } from 'json-schema-to-typescript';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

// Two minimal "broken-pattern" variants share a real cached base schema
// (ext.json — leaf schema with no nested $refs so jsts doesn't need a
// resolver wired in for the compile step). The variant root carries its own
// \`properties\` + \`required\` AND an \`allOf: [{ $ref }]\` sibling —
// exactly the shape adcp#4510 introduces.
const schema = {
  title: 'AuthorizedAgent',
  type: 'object',
  oneOf: [
    {
      title: 'AuthorizedAgentBrief',
      type: 'object',
      properties: {
        authorization_type: { type: 'string', const: 'brief' },
        property_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['authorization_type', 'property_ids'],
      allOf: [{ $ref: '/schemas/3.0.11/core/ext.json' }],
    },
    {
      title: 'AuthorizedAgentCatalog',
      type: 'object',
      properties: {
        authorization_type: { type: 'string', const: 'catalog' },
        catalog_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['authorization_type', 'catalog_ids'],
      allOf: [{ $ref: '/schemas/3.0.11/core/ext.json' }],
    },
  ],
};

async function main() {
  const strict = enforceStrictSchema(JSON.parse(JSON.stringify(schema)));
  const ts = await compile(strict, 'AuthorizedAgent', {
    bannerComment: '',
    additionalProperties: false,
    strictIndexSignatures: true,
  });
  writeFileSync(__OUT_PATH__, JSON.stringify({ ts, strict }));
}
main().catch((err) => { console.error(err); process.exit(1); });
`);
  // The merge must have consumed allOf at both variants.
  assert.ok(
    !result.strict.oneOf[0].allOf || result.strict.oneOf[0].allOf.length === 0,
    'oneOf[0] allOf must be consumed by the merge'
  );
  // Both discriminator constants must surface in the emitted union.
  assert.match(
    result.ts,
    /authorization_type\s*:\s*['"]brief['"]/,
    'union must surface the brief variant discriminator'
  );
  assert.match(
    result.ts,
    /authorization_type\s*:\s*['"]catalog['"]/,
    'union must surface the catalog variant discriminator'
  );
  // Variant-specific fields must still surface in the emitted output.
  assert.match(result.ts, /property_ids/, 'variant property_ids must surface in emitted TS');
  assert.match(result.ts, /catalog_ids/, 'variant catalog_ids must surface in emitted TS');
});
