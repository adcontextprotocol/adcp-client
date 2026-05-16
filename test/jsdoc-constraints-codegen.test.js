/**
 * Tests for the JSDoc constraint injection that bridges JSON Schema validation
 * keywords (minimum/maximum/pattern/format/etc.) across the lossy
 * JSON Schema → TypeScript → Zod codegen hop. Fixes adcp-client#1745.
 *
 * - Unit slice (via tsx harness): exercises `injectJsdocConstraints` on a
 *   synthetic schema covering all six supported tag kinds plus a nested
 *   object, then runs the actual `json-schema-to-typescript` + `ts-to-zod`
 *   pipeline on the result to confirm the chain end-to-end.
 *
 * - Pinning slice (reads schemas.generated.ts): checks that real generated
 *   Zod schemas (`MediaBuySchema.revision`, `MediaBuySchema.total_budget`)
 *   reject constraint-violating inputs they previously accepted. If a
 *   future codegen regression strips constraints again, this fails.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Run a tsx harness that pipes the JSON Schema fixture through the real
 * codegen pipeline and emits {ts, zod} as JSON on stdout. Mirrors the
 * sequence in scripts/generate-types.ts + scripts/generate-zod-from-ts.ts
 * — same `compile()` options, same `generate()` options.
 */
function runCodegenPipeline(schema, typeName = 'Fixture') {
  const harness = `
const { compile } = require('json-schema-to-typescript');
const { generate } = require('ts-to-zod');
const { injectJsdocConstraints } = require(${JSON.stringify(path.resolve(REPO_ROOT, 'scripts/schema-utils.ts'))});

(async () => {
  const schema = ${JSON.stringify(schema)};
  const annotated = injectJsdocConstraints(schema);
  const ts = await compile(annotated, ${JSON.stringify(typeName)}, {
    bannerComment: '',
    style: { semi: true, singleQuote: true },
    additionalProperties: false,
  });
  const zResult = generate({
    sourceText: ts,
    skipParseJSDoc: false,
    getSchemaName: name => name + 'Schema',
  });
  process.stdout.write(JSON.stringify({ ts, zod: zResult.getZodSchemasFile(), errors: zResult.errors }));
})().catch(e => {
  process.stderr.write(String(e && e.stack || e));
  process.exit(1);
});
`;
  // Write the harness inside the repo so Node resolves node_modules from
  // the project root. tsx + `cwd` alone is not enough — module resolution
  // walks up from the script's own directory.
  const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-jsdoc-constraints-'));
  const harnessPath = path.join(tmpDir, 'harness.cjs');
  fs.writeFileSync(harnessPath, harness);
  try {
    const r = spawnSync('npx', ['tsx', harnessPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`harness exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('injectJsdocConstraints — synthetic end-to-end', () => {
  it('injects all six supported constraint kinds plus walks into nested objects', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        revision: { type: 'integer', minimum: 1, description: 'revision' },
        score: { type: 'number', minimum: 0, maximum: 100 },
        slug: { type: 'string', pattern: '^[a-z0-9_]+$' },
        short: { type: 'string', minLength: 1, maxLength: 50 },
        created_at: { type: 'string', format: 'date-time' },
        nested: {
          type: 'object',
          properties: {
            inner: { type: 'integer', minimum: 5, maximum: 10 },
          },
        },
      },
      required: ['revision'],
    };

    const { ts, zod, errors } = runCodegenPipeline(schema);
    assert.deepEqual(errors, [], `ts-to-zod errors: ${errors.join(', ')}`);

    // TypeScript carries the JSDoc tags
    assert.match(ts, /@minimum 1/);
    assert.match(ts, /@minimum 0/);
    assert.match(ts, /@maximum 100/);
    assert.match(ts, /@pattern \^\[a-z0-9_\]\+\$/);
    assert.match(ts, /@minLength 1/);
    assert.match(ts, /@maxLength 50/);
    assert.match(ts, /@format date-time/);
    assert.match(ts, /@minimum 5/, 'nested inner minimum lost — recursion broken');
    assert.match(ts, /@maximum 10/, 'nested inner maximum lost — recursion broken');

    // Zod renders them as validators
    assert.match(zod, /revision: z\.number\(\)\.min\(1\)/);
    assert.match(zod, /score: z\.number\(\)\.min\(0\)\.max\(100\)/);
    assert.match(zod, /slug: z\.string\(\)\.regex\(\/\^\[a-z0-9_\]\+\$\//);
    assert.match(zod, /short: z\.string\(\)\.min\(1\)\.max\(50\)/);
    assert.match(zod, /created_at: z\.iso\.datetime\(\)/);
    assert.match(zod, /inner: z\.number\(\)\.min\(5\)\.max\(10\)/);
  });

  it('skips unsupported format values (Ajv enforces them at runtime)', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        weird: { type: 'string', format: 'iri-reference' },
      },
    };
    const { ts, zod } = runCodegenPipeline(schema);
    assert.doesNotMatch(ts, /@format iri-reference/);
    assert.match(zod, /weird: z\.string\(\)\.optional\(\)/);
  });

  it('escapes forward slashes inside @pattern so the regex literal stays valid', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        link: { type: 'string', pattern: '^/schemas/' },
      },
    };
    const { ts, zod, errors } = runCodegenPipeline(schema);
    assert.deepEqual(errors, []);
    // The pattern in the JSDoc has escaped slashes
    assert.match(ts, /@pattern \^\\\/schemas\\\//);
    // Zod regex literal is well-formed
    assert.match(zod, /\.regex\(\/\^\\\/schemas\\\//);
  });

  it('preserves regex escape sequences inside @pattern (no double-escape of `\\`)', () => {
    // JSON Schema pattern `\d+\.\d+` — `\d` is the digit class, `\.` is an
    // escaped dot. Naive `\\` escaping would turn `\d` into `\\d` (literal
    // backslash then `d`), breaking validation. ts-to-zod must see the
    // single-backslash form so the emitted regex still means "digits".
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        version: { type: 'string', pattern: '^\\d+\\.\\d+$' },
      },
    };
    const { ts, zod, errors } = runCodegenPipeline(schema);
    assert.deepEqual(errors, []);
    // JSDoc keeps single backslashes (regex-source form).
    assert.match(ts, /@pattern \^\\d\+\\\.\\d\+\$/);
    // Emitted Zod regex literal still has single backslashes too.
    assert.match(zod, /\.regex\(\/\^\\d\+\\\.\\d\+\$\//);
  });

  it('skips a pattern with an unpaired trailing backslash (would break /PATTERN/ delimiter)', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        weird: { type: 'string', pattern: 'abc\\' },
      },
    };
    const { ts, zod } = runCodegenPipeline(schema);
    assert.doesNotMatch(ts, /@pattern abc/);
    // Zod still emits a string type, just without the .regex() chain.
    assert.match(zod, /weird: z\.string\(\)\.optional\(\)/);
  });

  it('preserves the existing description when appending tags', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        n: { type: 'integer', description: 'existing prose', minimum: 1 },
      },
    };
    const { ts } = runCodegenPipeline(schema);
    assert.match(ts, /existing prose/);
    assert.match(ts, /@minimum 1/);
  });

  it('is idempotent — running twice does not duplicate tags', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 1 },
      },
    };
    // First pass on raw schema; second pass on the already-annotated schema.
    const harness = `
const { injectJsdocConstraints } = require(${JSON.stringify(path.resolve(REPO_ROOT, 'scripts/schema-utils.ts'))});
const schema = ${JSON.stringify(schema)};
const once = injectJsdocConstraints(schema);
const twice = injectJsdocConstraints(once);
process.stdout.write(JSON.stringify({ once: once.properties.n.description, twice: twice.properties.n.description }));
`;
    const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-jsdoc-constraints-'));
    const harnessPath = path.join(tmpDir, 'idempotent.cjs');
    fs.writeFileSync(harnessPath, harness);
    try {
      const r = spawnSync('npx', ['tsx', harnessPath], { cwd: REPO_ROOT, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.once, out.twice, 'second pass mutated annotated description');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('generated Zod schemas — constraint pinning', () => {
  let MediaBuySchema;
  let BrandReferenceSchema;
  let BusinessEntitySchema;

  try {
    ({ MediaBuySchema, BrandReferenceSchema, BusinessEntitySchema } = require('../dist/lib/types/schemas.generated'));
  } catch (e) {
    // Build hasn't run yet — skip the pinning slice rather than fail the unit slice.
    console.warn(`⏭️  Skipping pinning tests — dist not built: ${e.message}`);
  }

  it('MediaBuySchema.revision rejects 0 (minimum: 1)', { skip: !MediaBuySchema }, () => {
    const r = MediaBuySchema.shape.revision.safeParse(0);
    assert.strictEqual(r.success, false, 'revision=0 should fail min(1)');
  });

  it('MediaBuySchema.revision accepts 1', { skip: !MediaBuySchema }, () => {
    const r = MediaBuySchema.shape.revision.safeParse(1);
    assert.strictEqual(r.success, true, JSON.stringify(r.error));
  });

  it('MediaBuySchema.total_budget rejects -1 (minimum: 0)', { skip: !MediaBuySchema }, () => {
    const r = MediaBuySchema.shape.total_budget.safeParse(-1);
    assert.strictEqual(r.success, false, 'total_budget=-1 should fail min(0)');
  });

  it('BrandReferenceSchema.domain rejects an invalid domain (pattern)', { skip: !BrandReferenceSchema }, () => {
    const r = BrandReferenceSchema.shape.domain.safeParse('NOT A DOMAIN');
    assert.strictEqual(r.success, false, 'invalid domain should fail pattern');
  });

  it('BusinessEntitySchema.address.country accepts a valid ISO-2 (pattern)', { skip: !BusinessEntitySchema }, () => {
    const r = BusinessEntitySchema.shape.address.unwrap().shape.country.safeParse('US');
    assert.strictEqual(r.success, true, JSON.stringify(r.error));
  });

  it(
    'BusinessEntitySchema.address.country rejects lowercase (pattern requires ^[A-Z]{2}$)',
    {
      skip: !BusinessEntitySchema,
    },
    () => {
      const r = BusinessEntitySchema.shape.address.unwrap().shape.country.safeParse('us');
      assert.strictEqual(r.success, false, 'lowercase country should fail pattern');
    }
  );
});
