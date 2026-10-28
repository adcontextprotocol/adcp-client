const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const path = require('node:path');
const ts = require('typescript');
const { z } = require('zod');

function restore(input) {
  return execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const fs = require('node:fs');
    const { __test__ } = require('./scripts/generate-zod-from-ts.ts');
    process.stdout.write(__test__.postProcessLegacyPurchaseContinuationResponse(fs.readFileSync(0, 'utf8')));
  `,
    ],
    { cwd: path.resolve(__dirname, '..'), input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

const legacy = `z.object({
  kind: z.literal('legacy_create'),
  continuation_token: z.string().min(16),
  continuation_expires_at: z.string(),
  source_adcp_version: z.enum(['2.5', '3.0', '3.1']),
  product_ids: z.array(z.string()),
  losses: z.array(z.enum(['feed_version_not_atomic', 'pricing_version_not_atomic', 'mutation_idempotency_not_guaranteed'])),
  requires_explicit_acceptance: z.literal(true)
}).passthrough()`;
const listed = `z.object({kind: z.literal('listed_purchase'), product_ids: z.array(z.string()), feed_version: z.string()}).passthrough()`;
const payload = continuation => `z.object({
  outcome: z.enum(['proposed', 'products_available', 'rejected']),
  products: z.array(z.object({product_id: z.string(), pricing_options: z.array(z.string()).optional()})).optional(),
  proposals: z.array(z.string()).optional(),
  reason: z.string().optional(), suggestions: z.array(z.string()).optional(),
  incomplete: z.array(z.object({scope: z.string()})).optional(),
  purchase_continuation: ${continuation}.optional()
}).passthrough()`;
function compile(output) {
  const js = ts.transpile(output.replaceAll('export const ', 'const '), { target: ts.ScriptTarget.ES2022 });
  return new Function('z', `${js}; return RequestProposalsResponseSchema;`)(z);
}
function valid() {
  return {
    status: 'completed',
    outcome: 'products_available',
    products: [{ product_id: 'product' }],
    purchase_continuation: {
      kind: 'legacy_create',
      continuation_token: 'a-valid-continuation-token',
      continuation_expires_at: '2026-10-29T00:00:00Z',
      source_adcp_version: '3.1',
      product_ids: ['product'],
      losses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
      requires_explicit_acceptance: true,
    },
  };
}

for (const layout of ['inline', 'envelope and aliases', 'intersection']) {
  test(`${layout} retains continuation membership and root outcome checks (#3490)`, () => {
    const union = `z.union([${listed}, ${legacy}])`;
    const prelude = `const EnvelopeSchema = z.object({status: z.literal('completed')}).passthrough();
      const LegacySchema = ${legacy};
      const LegacyAliasSchema = LegacySchema;
      const ContinuationSchema = z.union([${listed}, LegacyAliasSchema]);
      const PayloadSchema = ${payload('ContinuationSchema')};`;
    const root =
      layout === 'inline'
        ? payload(union)
        : layout === 'intersection'
          ? 'z.intersection(EnvelopeSchema, PayloadSchema)'
          : 'EnvelopeSchema.and(PayloadSchema)';
    const schema = compile(restore(`${prelude}\nexport const RequestProposalsResponseSchema = ${root};`));
    assert.equal(schema.safeParse(valid()).success, true);
    for (const source of ['3.0', '3.1', '2.5']) {
      const value = valid();
      value.purchase_continuation.source_adcp_version = source;
      assert.equal(schema.safeParse(value).success, source !== '2.5');
      value.purchase_continuation.losses.push('mutation_idempotency_not_guaranteed');
      assert.equal(schema.safeParse(value).success, true);
    }
    for (const [field, invalid] of [
      ['product_ids', []],
      ['product_ids', ['']],
      ['product_ids', ['product', 'product']],
      ['losses', []],
      ['losses', ['feed_version_not_atomic']],
      ['losses', ['feed_version_not_atomic', 'feed_version_not_atomic']],
      ['losses', ['feed_version_not_atomic', 'mutation_idempotency_not_guaranteed']],
      ['losses', ['pricing_version_not_atomic', 'mutation_idempotency_not_guaranteed']],
    ]) {
      const value = valid();
      value.purchase_continuation[field] = invalid;
      assert.equal(schema.safeParse(value).success, false, `${field}: ${JSON.stringify(invalid)}`);
    }
    for (const patch of [
      { products: [] },
      { proposals: ['proposal'] },
      { task_id: 'task' },
      { pagination: {} },
      { suggestions: ['try again'] },
      { incomplete: [] },
      { purchase_continuation: undefined },
      { outcome: 'proposed', proposals: [] },
      { outcome: 'rejected' },
    ])
      assert.equal(schema.safeParse({ ...valid(), ...patch }).success, false, JSON.stringify(patch));
    assert.equal(
      schema.safeParse({ status: 'completed', outcome: 'proposed', proposals: ['p'], products: [{ product_id: 'p' }] })
        .success,
      true
    );
    assert.equal(schema.safeParse({ status: 'completed', outcome: 'rejected', reason: 'No match' }).success, true);
    assert.equal(
      schema.safeParse({ status: 'completed', outcome: 'rejected', reason: 'No match', suggestions: [''] }).success,
      false
    );
    const purchase = valid();
    purchase.products[0].pricing_options = ['price'];
    purchase.purchase_continuation = { kind: 'listed_purchase', product_ids: ['product'], feed_version: 'v1' };
    assert.equal(schema.safeParse(purchase).success, true);
    purchase.purchase_continuation.product_ids = ['another'];
    assert.equal(schema.safeParse(purchase).success, false);
    purchase.purchase_continuation.product_ids = ['product'];
    delete purchase.products[0].pricing_options;
    assert.equal(schema.safeParse(purchase).success, false);
    if (layout !== 'inline') assert.equal(schema.safeParse({ ...valid(), status: 'submitted' }).success, false);
  });
}

test('does not modify unrelated aliases, arms or nested lookalikes', () => {
  const unrelated = `const UnrelatedSchema = ${legacy};`;
  const nested = `const NestedSchema = z.object({metadata: ${legacy}});`;
  const output = restore(
    `${unrelated}\n${nested}\nexport const RequestProposalsResponseSchema = ${payload(`z.union([${listed}, ${legacy}])`)};`
  );
  assert.ok(output.includes(unrelated));
  assert.ok(output.includes(nested));
  assert.ok(output.includes(listed));
  assert.equal((output.match(/product_ids must be unique/g) ?? []).length, 2); // arm and listed root check
});

test('missing, malformed, ambiguous and cyclic targets fail closed', () => {
  const candidates = [
    'z.any()',
    'MissingSchema',
    'LoopSchema',
    `z.object({metadata: ${legacy}})`,
    payload(`z.union([${legacy}, ${legacy}])`),
    payload(legacy.replace('product_ids: z.array(z.string()),', '')),
    payload(legacy.replace('product_ids: z.array(z.string())', 'product_ids: z.string()')),
    payload(legacy.replace('product_ids: z.array(z.string())', 'product_ids: z.array(z.number())')),
    payload(legacy.replace('losses: z.array', 'losses: z.string().optional(), other: z.array')),
    payload(
      legacy.replace('requires_explicit_acceptance: z.literal(true)', 'requires_explicit_acceptance: z.boolean()')
    ),
    payload(
      legacy.replace(
        'requires_explicit_acceptance: z.literal(true)',
        'requires_explicit_acceptance: z.literal(true).optional()'
      )
    ),
  ];
  for (const candidate of candidates) {
    assert.throws(
      () => restore(`const LoopSchema = LoopSchema; export const RequestProposalsResponseSchema = ${candidate};`),
      /Could not locate the legacy_create/
    );
  }
  assert.throws(
    () =>
      restore(
        `export const RequestProposalsResponseSchema = ${payload(legacy)}; export const RequestProposalsResponseSchema = ${payload(legacy)};`
      ),
    /ambiguous/
  );
});

test('type generation preserves payload outcomes beside a composed protocol envelope', () => {
  const result = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const { compile } = require('json-schema-to-typescript');
    const { generate } = require('ts-to-zod');
    const { applyCodegenSchemaWorkarounds, enforceStrictSchema } = require('./scripts/generate-types.ts');
    const { __test__ } = require('./scripts/generate-zod-from-ts.ts');
    (async () => {
      const source = {
        title: 'Request Proposals Response', type: 'object',
        allOf: [{title: 'Protocol Envelope', type: 'object', properties: {status: {const: 'completed'}}, required: ['status']}],
        properties: {
          products: {type: 'array', items: {type: 'object', properties: {product_id: {type: 'string'}}}},
          purchase_continuation: {
            type: 'object', properties: {
              kind: {const: 'legacy_create'}, continuation_token: {type: 'string'}, continuation_expires_at: {type: 'string'},
              source_adcp_version: {enum: ['2.5', '3.0', '3.1']}, product_ids: {type: 'array', items: {type: 'string'}},
              losses: {type: 'array', items: {enum: ['feed_version_not_atomic', 'pricing_version_not_atomic', 'mutation_idempotency_not_guaranteed']}},
              requires_explicit_acceptance: {const: true},
            }, required: ['kind', 'continuation_token', 'continuation_expires_at', 'source_adcp_version', 'product_ids', 'losses', 'requires_explicit_acceptance'],
          },
        },
        anyOf: [
          {properties: {outcome: {const: 'products_available'}}, required: ['outcome', 'products', 'purchase_continuation']},
          {properties: {outcome: {const: 'rejected'}, reason: {type: 'string'}}, required: ['outcome', 'reason'], not: {anyOf: [{required: ['purchase_continuation']}, {required: ['products']}] }},
        ],
      };
      const original = JSON.stringify(source);
      const types = await compile(enforceStrictSchema(applyCodegenSchemaWorkarounds(source, 'RequestProposalsResponse')), 'RequestProposalsResponse', {bannerComment: ''});
      if (JSON.stringify(source) !== original) throw new Error('Source schema was mutated');
      const generated = generate({sourceText: types, getSchemaName: name => name + "Schema"}).getZodSchemasFile('./types').replace(/import[^;]+;/g, '');
      process.stdout.write(__test__.postProcessLegacyPurchaseContinuationResponse(__test__.postProcessForPassthrough(__test__.postProcessRecordIntersections(generated))));
    })();
  `,
    ],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const schema = compile(result);
  assert.equal(schema.safeParse(valid()).success, true);
  const invalid = valid();
  invalid.purchase_continuation.product_ids = [];
  assert.equal(schema.safeParse(invalid).success, false);
  assert.equal(schema.safeParse({ ...valid(), status: 'submitted' }).success, false);
  assert.equal(schema.safeParse({ status: 'completed', outcome: 'rejected', reason: 'No match' }).success, true);
});

test('root submitted arm retains the task-id condition from the composed envelope', () => {
  const schema = compile(
    restore(`export const RequestProposalsResponseSchema = z.union([
    z.object({status: z.literal('submitted'), task_id: z.string().optional()}).passthrough(),
    ${payload(legacy)}
  ]);`)
  );
  assert.equal(schema.safeParse({ status: 'submitted', task_id: 'task' }).success, true);
  for (const task_id of [undefined, '', null, 123]) {
    assert.equal(schema.safeParse({ status: 'submitted', task_id }).success, false);
  }
});
