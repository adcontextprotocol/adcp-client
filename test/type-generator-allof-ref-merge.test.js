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

test('enforceStrictSchema drops resolved-base additionalProperties:true when merging', () => {
  // Regression: creative-brief.json and catalog.json both declare top-level
  // `additionalProperties: true`. Without normalizing the resolved base, that
  // flag propagated into the merged shape and emitted a
  // `[k: string]: unknown | undefined` index signature on `BriefAsset` /
  // `CatalogAsset` — wider than the pre-merge intersection form. The fix
  // applies `enforceStrictSchema` to the resolved base inside
  // `resolveAllOfRefForMerge` so the strip happens before the merge.
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
  additionalProperties: out.additionalProperties,
  hasIndexSignatureFlag: out.additionalProperties === true,
}));
`);
  assert.strictEqual(result.hasAllOf, false, 'allOf must be consumed by the merge');
  assert.notStrictEqual(
    result.additionalProperties,
    true,
    'resolved base additionalProperties:true must not propagate into merged shape'
  );
  assert.strictEqual(
    result.hasIndexSignatureFlag,
    false,
    'merged shape must not carry the index-signature widening flag'
  );
});

test('enforceStrictSchema promotes conditional params properties', () => {
  const result = runHarness(`
import { writeFileSync } from 'fs';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const input = {
  type: 'object',
  properties: {
    params: {
      type: 'object',
      properties: {
        request_type: { type: 'string', enum: ['snapshot', 'incremental'] },
      },
      required: ['request_type'],
    },
  },
  allOf: [
    {
      if: { properties: { params: { properties: { request_type: { const: 'incremental' } } } } },
      then: {
        properties: {
          params: {
            properties: {
              cursor: { type: 'string', description: 'Incremental cursor' },
            },
          },
        },
      },
    },
  ],
};
const out = enforceStrictSchema(JSON.parse(JSON.stringify(input)));
writeFileSync(__OUT_PATH__, JSON.stringify({
  paramKeys: Object.keys(out.properties.params.properties ?? {}),
  cursor: out.properties.params.properties.cursor,
}));
`);
  assert.deepStrictEqual(result.paramKeys.sort(), ['cursor', 'request_type']);
  assert.deepStrictEqual(result.cursor, { type: 'string', description: 'Incremental cursor' });
});

test('enforceStrictSchema allows duplicate identical conditional params properties', () => {
  const result = runHarness(`
import { writeFileSync } from 'fs';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const cursorSchema = { description: 'Incremental cursor', type: 'string' };
const input = {
  type: 'object',
  properties: {
    params: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Incremental cursor' },
      },
    },
  },
  allOf: [
    {
      then: {
        properties: {
          params: {
            properties: {
              cursor: cursorSchema,
            },
          },
        },
      },
    },
  ],
};
const out = enforceStrictSchema(JSON.parse(JSON.stringify(input)));
writeFileSync(__OUT_PATH__, JSON.stringify({
  cursor: out.properties.params.properties.cursor,
}));
`);
  assert.deepStrictEqual(result.cursor, { type: 'string', description: 'Incremental cursor' });
});

test('enforceStrictSchema ignores conditional refinements of root params properties', () => {
  const result = runHarness(`
import { writeFileSync } from 'fs';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const input = {
  type: 'object',
  properties: {
    params: {
      type: 'object',
      properties: {
        cursor: { type: 'string' },
      },
    },
  },
  allOf: [
    {
      then: {
        properties: {
          params: {
            properties: {
              cursor: { type: 'number' },
            },
          },
        },
      },
    },
  ],
};
const out = enforceStrictSchema(JSON.parse(JSON.stringify(input)));
writeFileSync(__OUT_PATH__, JSON.stringify({
  cursor: out.properties.params.properties.cursor,
}));
`);
  assert.deepStrictEqual(result.cursor, { type: 'string' });
});

test('enforceStrictSchema ignores conflicting conditional refinements of root params properties', () => {
  const result = runHarness(`
import { writeFileSync } from 'fs';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const input = {
  type: 'object',
  properties: {
    params: {
      type: 'object',
      properties: {
        cursor: { type: 'string' },
      },
    },
  },
  allOf: [
    {
      then: {
        properties: {
          params: {
            properties: {
              cursor: { type: 'number' },
            },
          },
        },
      },
    },
    {
      then: {
        properties: {
          params: {
            properties: {
              cursor: { type: 'boolean' },
            },
          },
        },
      },
    },
  ],
};
const out = enforceStrictSchema(JSON.parse(JSON.stringify(input)));
writeFileSync(__OUT_PATH__, JSON.stringify({
  cursor: out.properties.params.properties.cursor,
}));
`);
  assert.deepStrictEqual(result.cursor, { type: 'string' });
});

test('enforceStrictSchema throws on conflicting conditional params promotions', () => {
  const result = runHarness(`
import { writeFileSync } from 'fs';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const input = {
  type: 'object',
  properties: {
    params: {
      type: 'object',
      properties: {},
    },
  },
  allOf: [
    {
      then: {
        properties: {
          params: {
            properties: {
              cursor: { type: 'string' },
            },
          },
        },
      },
    },
    {
      then: {
        properties: {
          params: {
            properties: {
              cursor: { type: 'number' },
            },
          },
        },
      },
    },
  ],
};
let message = null;
try {
  enforceStrictSchema(JSON.parse(JSON.stringify(input)));
} catch (err) {
  message = err instanceof Error ? err.message : String(err);
}
writeFileSync(__OUT_PATH__, JSON.stringify({ message }));
`);
  assert.match(result.message, /Conflicting conditional params property "cursor"/);
  assert.match(result.message, /allOf\[1\]\.then\.properties\.params\.properties\.cursor/);
  assert.match(result.message, /first promoted from allOf\[0\]\.then\.properties\.params\.properties\.cursor/);
});

test('enforceStrictSchema accepts reordered enum conditional params promotions', () => {
  const result = runHarness(`
import { writeFileSync } from 'fs';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const input = {
  type: 'object',
  properties: {
    params: {
      type: 'object',
      properties: {},
    },
  },
  allOf: [
    {
      then: {
        properties: {
          params: {
            properties: {
              mode: { type: 'string', enum: ['programmatic', 'managed'] },
              mixed: { enum: [1, '1', true, 'true'] },
            },
          },
        },
      },
    },
    {
      then: {
        properties: {
          params: {
            properties: {
              mode: { enum: ['managed', 'programmatic'], type: 'string' },
              mixed: { enum: ['true', true, '1', 1] },
            },
          },
        },
      },
    },
  ],
};
let ok = false;
let message = null;
try {
  enforceStrictSchema(JSON.parse(JSON.stringify(input)));
  ok = true;
} catch (err) {
  message = err instanceof Error ? err.message : String(err);
}
writeFileSync(__OUT_PATH__, JSON.stringify({ ok, message }));
`);
  assert.equal(result.ok, true, result.message);
});

test('enforceStrictSchema accepts cached 3.1 comply controller conditionals', () => {
  const result = runHarness(`
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const schemaPath = join(process.cwd(), 'schemas/cache/3.1.0-beta.7/compliance/comply-test-controller-request.json');
const input = JSON.parse(readFileSync(schemaPath, 'utf8'));
let ok = false;
let message = null;
try {
  enforceStrictSchema(JSON.parse(JSON.stringify(input)));
  ok = true;
} catch (err) {
  message = err instanceof Error ? err.message : String(err);
}
writeFileSync(__OUT_PATH__, JSON.stringify({ ok, message }));
`);
  assert.equal(result.ok, true, result.message);
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

test('compiled oneOf with not.anyOf exclusions preserves attestation branch fields', () => {
  const result = runHarness(`
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { compile } from 'json-schema-to-typescript';
import { enforceStrictSchema } from '__GENERATE_TYPES__';

const schemaPath = join(process.cwd(), 'schemas/cache/3.1.0-beta.7/compliance/comply-test-controller-response.json');
const root = JSON.parse(readFileSync(schemaPath, 'utf8'));
const recordedCallSchema = root.oneOf
  .find((branch) => branch.title === 'UpstreamTrafficSuccess')
  .properties.recorded_calls.items;

async function main() {
  const strict = enforceStrictSchema(JSON.parse(JSON.stringify(recordedCallSchema)));
  const ts = await compile(strict, 'RecordedCall', {
    bannerComment: '',
    additionalProperties: false,
    strictIndexSignatures: true,
  });
  writeFileSync(__OUT_PATH__, JSON.stringify({ ts, strict }));
}
main().catch((err) => { console.error(err); process.exit(1); });
`);

  assert.match(result.ts, /export interface RawAttestation/, 'raw branch interface must be emitted');
  assert.match(result.ts, /payload\s*:/, 'raw branch payload field must surface');
  assert.match(result.ts, /payload_length\s*:/, 'shared payload_length field must surface');
  assert.match(result.ts, /export interface DigestAttestation/, 'digest branch interface must be emitted');
  assert.match(result.ts, /payload_digest_sha256\s*:/, 'digest branch payload_digest_sha256 field must surface');
  assert.match(result.ts, /identifier_match_proofs\??\s*:/, 'digest branch optional proofs field must surface');
  assert.ok(
    result.strict.oneOf.every(branch => branch.type === 'object' && branch.properties?.payload_length),
    'parent properties must be inlined into every attestation branch'
  );
});
