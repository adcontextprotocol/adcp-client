/**
 * Tests for the JSDoc constraint injection that bridges JSON Schema validation
 * keywords (minimum/maximum/pattern/format/etc.) across the lossy
 * JSON Schema → TypeScript → Zod codegen hop. Fixes adcp-client#1745.
 *
 * - Unit slice (via tsx harness): exercises `injectJsdocConstraints` on a
 *   synthetic schema covering all supported tag kinds plus a nested
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
  it('injects supported constraint kinds plus walks into nested objects', () => {
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
    assert.match(ts, /@format int/);
    assert.match(ts, /@minimum 5/, 'nested inner minimum lost — recursion broken');
    assert.match(ts, /@maximum 10/, 'nested inner maximum lost — recursion broken');

    // Zod renders them as validators
    assert.match(zod, /revision: z\.int\(\)\.min\(1\)/);
    assert.match(zod, /score: z\.number\(\)\.min\(0\)\.max\(100\)/);
    assert.match(zod, /slug: z\.string\(\)\.regex\(\/\^\[a-z0-9_\]\+\$\//);
    assert.match(zod, /short: z\.string\(\)\.min\(1\)\.max\(50\)/);
    assert.match(zod, /created_at: z\.iso\.datetime\(\)/);
    assert.match(zod, /inner: z\.int\(\)\.min\(5\)\.max\(10\)/);
  });

  it('emits a safe integer check for nullable numbers without attaching it to a heterogeneous union', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        nullable_count: { type: ['integer', 'null'] },
        revision_or_label: { type: ['integer', 'string'] },
      },
    };
    const { ts, zod, errors } = runCodegenPipeline(schema);
    assert.deepEqual(errors, []);
    assert.match(ts, /@format int[\s\S]*nullable_count/);
    assert.equal((ts.match(/@format int/g) ?? []).length, 1);
    assert.match(zod, /nullable_count: z\.int\(\)\.optional\(\)\.nullable\(\)/);
    assert.match(zod, /revision_or_label: z\.union\(\[z\.number\(\), z\.string\(\)\]\)\.optional\(\)/);
    assert.doesNotMatch(zod, /z\.union\([^\n]+\.int\(\)/);
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
  let PropertyIDSchema;
  let SignalRefSchema;
  let PaginationRequestSchema;
  let DeliveryForecastSchema;
  let PlacementReferenceSchema;
  let LimitedSeriesSchema;
  let DeadlinePolicySchema;
  let CollectionReferenceSchema;
  let AccountChangeSchema;
  let ForecastPointSchema;
  let BrandIDSchema;
  let CreativeRevisionIDSchema;
  let PropertyTagSchema;
  let VendorMetricIDSchema;
  let LanguageTagSchema;
  let VCPMPricingOptionSchema;
  let CPVPricingOptionSchema;
  let DoohParametersSchema;

  try {
    ({
      MediaBuySchema,
      BrandReferenceSchema,
      BusinessEntitySchema,
      PropertyIDSchema,
      SignalRefSchema,
      PaginationRequestSchema,
      DeliveryForecastSchema,
      PlacementReferenceSchema,
      LimitedSeriesSchema,
      DeadlinePolicySchema,
      CollectionReferenceSchema,
      AccountChangeSchema,
      ForecastPointSchema,
      BrandIDSchema,
      CreativeRevisionIDSchema,
      PropertyTagSchema,
      VendorMetricIDSchema,
      LanguageTagSchema,
      VCPMPricingOptionSchema,
      CPVPricingOptionSchema,
      DoohParametersSchema,
    } = require('../dist/lib/types/schemas.generated'));
  } catch (e) {
    // Build hasn't run yet — skip the pinning slice rather than fail the unit slice.
    console.warn(`⏭️  Skipping pinning tests — dist not built: ${e.message}`);
  }

  it('preserves canonical vCPM, CPV, and DOOH pricing constraints', { skip: !VCPMPricingOptionSchema }, () => {
    const vcpm = value =>
      VCPMPricingOptionSchema.safeParse({
        pricing_option_id: 'vcpm-1',
        pricing_model: 'vcpm',
        currency: 'USD',
        ...value,
      }).success;
    assert.equal(vcpm({ fixed_price: 0, floor_price: 0, min_spend_per_package: 0 }), true);
    assert.equal(vcpm({ currency: 'usd' }), false);
    for (const field of ['fixed_price', 'floor_price', 'min_spend_per_package']) {
      assert.equal(vcpm({ [field]: -0.01 }), false, `${field} must be non-negative`);
    }

    const cpv = viewThreshold =>
      CPVPricingOptionSchema.safeParse({
        pricing_option_id: 'cpv-1',
        pricing_model: 'cpv',
        currency: 'USD',
        parameters: { view_threshold: viewThreshold },
      }).success;
    assert.equal(cpv(0), true);
    assert.equal(cpv(1), true);
    assert.equal(cpv(-0.01), false);
    assert.equal(cpv(1.01), false);
    assert.equal(cpv({ duration_seconds: 1 }), true);
    assert.equal(cpv({ duration_seconds: 0 }), false);
    assert.equal(cpv({ duration_seconds: 1.5 }), false);

    const dooh = value => DoohParametersSchema.safeParse({ type: 'dooh', ...value }).success;
    assert.equal(
      dooh({
        sov_percentage: 0,
        loop_duration_seconds: 1,
        min_plays_per_hour: 1,
        duration_hours: 0,
        estimated_impressions: 0,
      }),
      true
    );
    assert.equal(dooh({ sov_percentage: -1 }), false);
    assert.equal(dooh({ sov_percentage: 101 }), false);
    assert.equal(dooh({ loop_duration_seconds: 0 }), false);
    assert.equal(dooh({ loop_duration_seconds: 1.5 }), false);
    assert.equal(dooh({ min_plays_per_hour: 0 }), false);
    assert.equal(dooh({ min_plays_per_hour: 1.5 }), false);
    assert.equal(dooh({ duration_hours: -1 }), false);
    assert.equal(dooh({ estimated_impressions: -1 }), false);
    assert.equal(dooh({ estimated_impressions: 1.5 }), false);
  });

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

  it('preserves canonical property, signal, and publisher-domain patterns', { skip: !PropertyIDSchema }, () => {
    assert.equal(PropertyIDSchema.safeParse('homepage_slot').success, true);
    assert.equal(PropertyIDSchema.safeParse('publisher.example').success, false);
    assert.equal(PropertyIDSchema.safeParse('bad value!').success, false);

    assert.equal(SignalRefSchema.safeParse({ scope: 'product', signal_id: 'sports_fans-1' }).success, true);
    assert.equal(SignalRefSchema.safeParse({ scope: 'product', signal_id: '<script>' }).success, false);
    assert.equal(
      SignalRefSchema.safeParse({
        scope: 'data_provider',
        data_provider_domain: 'data.example',
        signal_id: 'segment_1',
      }).success,
      true
    );
    assert.equal(
      SignalRefSchema.safeParse({
        scope: 'data_provider',
        data_provider_domain: 'NOT A DOMAIN',
        signal_id: 'segment_1',
      }).success,
      false
    );
    assert.equal(
      SignalRefSchema.safeParse({
        scope: 'signal_source',
        signal_source_url: 'http://[v1.fe80::a+en1]/',
        signal_id: 'segment_1',
      }).success,
      true
    );
    assert.equal(
      SignalRefSchema.safeParse({
        scope: 'signal_source',
        signal_source_url: 'https://example.com/%zz',
        signal_id: 'segment_1',
      }).success,
      false
    );
    assert.equal(
      SignalRefSchema.safeParse({
        scope: 'signal_source',
        signal_source_url: 'http://signals.example/\\evil',
        signal_id: 'segment_1',
      }).success,
      false
    );
    assert.equal(PlacementReferenceSchema.shape.publisher_domain.unwrap().safeParse('news.example').success, true);
    assert.equal(
      PlacementReferenceSchema.shape.publisher_domain.unwrap().safeParse('https://news.example').success,
      false
    );
  });

  it('preserves pagination integer bounds without materializing defaults', { skip: !PaginationRequestSchema }, () => {
    for (const value of [-1, 0, 1.5, 101, 1000]) {
      assert.equal(PaginationRequestSchema.safeParse({ max_results: value }).success, false, String(value));
    }
    for (const value of [1, 100]) {
      assert.equal(PaginationRequestSchema.safeParse({ max_results: value }).success, true, String(value));
    }
    assert.deepEqual(PaginationRequestSchema.parse({}), {});
  });

  it('preserves delivery forecast date-time and slug constraints', { skip: !DeliveryForecastSchema }, () => {
    const shape = DeliveryForecastSchema.shape;
    assert.equal(shape.generated_at.unwrap().safeParse('2026-08-24T00:16:57.123456Z').success, true);
    assert.equal(shape.generated_at.unwrap().safeParse('2026-08-24 00:16:57.123456').success, false);
    assert.equal(shape.generated_at.unwrap().safeParse('2026-02-31T00:00:00Z').success, false);
    assert.equal(shape.measurement_source.unwrap().safeParse('nielsen_panel').success, true);
    assert.equal(shape.measurement_source.unwrap().safeParse('Nielsen Panel!').success, false);
  });

  it(
    'reconciles canonical constraints lost through transitive first-definition ownership',
    {
      skip: !LimitedSeriesSchema,
    },
    () => {
      assert.equal(LimitedSeriesSchema.safeParse({ total_installments: 1 }).success, true);
      assert.equal(LimitedSeriesSchema.safeParse({ total_installments: 0 }).success, false);
      assert.equal(LimitedSeriesSchema.safeParse({ total_installments: 1.5 }).success, false);
      assert.equal(LimitedSeriesSchema.safeParse({ total_installments: 1, starts: 'not-a-date' }).success, false);

      assert.equal(DeadlinePolicySchema.safeParse({ booking_lead_days: -1 }).success, false);
      assert.equal(DeadlinePolicySchema.safeParse({ cancellation_lead_days: 1.5 }).success, false);
      assert.equal(
        DeadlinePolicySchema.safeParse({ material_stages: [{ stage: 'draft', lead_days: -1 }] }).success,
        false
      );

      assert.equal(
        CollectionReferenceSchema.safeParse({ publisher_domain: 'NOT A DOMAIN', collection_id: 'collection' }).success,
        false
      );
      assert.equal(
        CollectionReferenceSchema.safeParse({ publisher_domain: 'publisher.example', collection_id: '' }).success,
        false
      );
      assert.equal(AccountChangeSchema.shape.resource_revision.unwrap().safeParse(1.5).success, false);
      assert.equal(AccountChangeSchema.shape.resource_revision.unwrap().safeParse(2).success, true);
      assert.equal(AccountChangeSchema.shape.resource_revision.unwrap().safeParse('revision-two').success, true);
    }
  );

  it('keeps the canonical forecast point constraints on direct and nested use', { skip: !ForecastPointSchema }, () => {
    assert.equal(ForecastPointSchema.safeParse({ metrics: {}, budget: 0 }).success, true);
    assert.equal(ForecastPointSchema.safeParse({ metrics: {}, budget: -1 }).success, false);
    assert.equal(ForecastPointSchema.safeParse({ metrics: {}, label: 'x'.repeat(128) }).success, true);
    assert.equal(ForecastPointSchema.safeParse({ metrics: {}, label: 'x'.repeat(129) }).success, false);
    assert.equal(
      DeliveryForecastSchema.safeParse({
        points: [{ metrics: {}, budget: -1 }],
        method: 'modeled',
        currency: 'USD',
      }).success,
      false,
      'DeliveryForecast must use the canonical constrained ForecastPoint schema'
    );
  });

  it('reconciles constraints on canonical primitive root schemas', { skip: !BrandIDSchema }, () => {
    assert.equal(BrandIDSchema.safeParse('valid_brand').success, true);
    assert.equal(BrandIDSchema.safeParse('NOT_VALID').success, false);
    assert.equal(CreativeRevisionIDSchema.safeParse('').success, false);
    assert.equal(CreativeRevisionIDSchema.safeParse('x'.repeat(256)).success, false);
    assert.equal(PropertyTagSchema.safeParse('bad tag').success, false);
    assert.equal(VendorMetricIDSchema.safeParse('1 BAD').success, false);
    assert.equal(LanguageTagSchema.safeParse('en-US').success, true);
    assert.equal(LanguageTagSchema.safeParse('not a locale').success, false);
  });
});

describe('@deprecated JSDoc — codegen regression lock (adcp-client#1915)', () => {
  // Locks the contract that json-schema-to-typescript v15 emits @deprecated JSDoc
  // for properties whose JSON Schema declares `deprecated: true`. Fires on any
  // toolchain upgrade that silently drops the annotation — which would remove the
  // IDE deprecation signal for buyers of the 3.1 additive-deprecate fields
  // (e.g. CreateMediaBuySuccess.status / UpdateMediaBuySuccess.status, adcp#4904).

  it('emits @deprecated JSDoc on a property with deprecated: true', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        // Mirrors the 3.1 additive-deprecate pattern: a body-level field deprecated
        // in favour of a renamed sibling. The sibling must not carry the tag.
        status: {
          type: 'string',
          deprecated: true,
          description: 'DEPRECATED in 3.1, removed in 3.2. Use `media_buy_status` instead.',
        },
        media_buy_status: { type: 'string' },
      },
    };

    const { ts, errors } = runCodegenPipeline(schema);
    assert.deepEqual(errors, [], `ts-to-zod errors: ${errors.join(', ')}`);

    // The @deprecated tag must appear in the TypeScript output for `status`.
    assert.match(ts, /@deprecated/, 'deprecated: true must produce @deprecated JSDoc');
    // The deprecation description text must be preserved alongside the tag.
    assert.match(ts, /DEPRECATED in 3\.1/, 'description text must be preserved with @deprecated');
  });

  it('does not emit @deprecated on a sibling property without deprecated: true', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        media_buy_status: { type: 'string', description: 'Preferred field.' },
      },
    };

    const { ts, errors } = runCodegenPipeline(schema);
    assert.deepEqual(errors, [], `ts-to-zod errors: ${errors.join(', ')}`);
    assert.doesNotMatch(ts, /@deprecated/, 'non-deprecated property must not carry @deprecated');
  });

  it('preserves description text alongside @deprecated when both are present', () => {
    const schema = {
      title: 'Fixture',
      type: 'object',
      properties: {
        old_field: {
          type: 'integer',
          deprecated: true,
          description: 'Legacy field. Use new_field instead.',
          minimum: 0,
        },
        new_field: { type: 'integer' },
      },
    };

    const { ts, errors } = runCodegenPipeline(schema);
    assert.deepEqual(errors, [], `ts-to-zod errors: ${errors.join(', ')}`);
    // @deprecated tag must appear.
    assert.match(ts, /@deprecated/, 'deprecated: true must produce @deprecated JSDoc');
    // The prose description must survive alongside the tag.
    assert.match(ts, /Legacy field\. Use new_field instead\./, 'description must be preserved');
    // Constraint tags from injectJsdocConstraints must also survive alongside @deprecated.
    assert.match(ts, /@minimum 0/, '@minimum from injectJsdocConstraints must survive with @deprecated');
  });
});
