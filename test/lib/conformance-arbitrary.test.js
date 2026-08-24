// Unit tests for the conformance-fuzzer schema → fast-check arbitrary.
// Verifies that generated samples validate against their source schemas
// at a rate high enough to meaningfully exercise the accepted-response path.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const fc = require('fast-check');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const { schemaToArbitrary } = require('../../dist/lib/conformance/schemaArbitrary.js');
const { hasSchemas, loadRequestSchema } = require('../../dist/lib/conformance/schemaLoader.js');
const { prepareConformanceProbeRequest } = require('../../dist/lib/conformance/runners.js');
const { toolHasConformanceFixtures } = require('../../dist/lib/conformance/runConformance.js');
const {
  COMPACT_LIFECYCLE_TOOLS,
  COMPACT_STATELESS_TIER_TOOLS,
  COMPACT_UPDATE_TIER_TOOLS,
  STATELESS_TIER_TOOLS,
  UPDATE_TIER_TOOLS,
} = require('../../dist/lib/conformance/types.js');

function makeAjv() {
  const ajv = new Ajv({ allErrors: false, strict: false });
  addFormats(ajv);
  return ajv;
}

describe('conformance: schemaToArbitrary', { concurrency: false }, () => {
  // Tools whose schemas the generator can satisfy almost all the time. The
  // remaining tools lean on constructs (not, allOf+not, deep oneOf) that are
  // out of scope — their imperfect validity is compensated by the two-path
  // oracle (validly-rejected counts as a pass).
  const RELIABLE = new Set([
    'list_products',
    'list_creative_formats',
    'list_creatives',
    'get_media_buys',
    'get_signals',
    'si_get_offering',
    'get_adcp_capabilities',
    'tasks_list',
    'list_property_lists',
    'list_content_standards',
    'get_creative_features',
  ]);

  test('the complete compact 3.2 lifecycle is wired to bundled conformance schemas', () => {
    const compactTools = [
      'list_products',
      'request_proposals',
      'refine_proposals',
      'decline_proposals',
      'buy_products',
      'accept_proposal',
      'control_media_buy',
    ];
    assert.deepEqual(COMPACT_LIFECYCLE_TOOLS, compactTools);
    assert.deepEqual(COMPACT_STATELESS_TIER_TOOLS, ['list_products']);
    assert.deepEqual(COMPACT_UPDATE_TIER_TOOLS, compactTools.slice(1));
    assert.ok(!STATELESS_TIER_TOOLS.includes('list_products'), 'legacy stateless defaults stay unchanged');
    for (const tool of compactTools.slice(1)) {
      assert.ok(!UPDATE_TIER_TOOLS.includes(tool), `${tool} is not forced into legacy defaults`);
    }
    for (const tool of compactTools) {
      assert.equal(hasSchemas(tool, { version: '3.2.0-beta.5' }), true, `${tool} 3.2 schemas are loadable`);
      assert.equal(hasSchemas(tool, { version: '3.1.18' }), false, `${tool} is gated out of 3.1`);
      assert.equal(hasSchemas(tool, { version: '3.0.25' }), false, `${tool} is gated out of 3.0`);
    }
  });

  test('probe version normalization preserves exact schema field presence', () => {
    const versionOnly = prepareConformanceProbeRequest(
      'list_products',
      { adcp_version: '99.99' },
      { adcpVersion: '3.2.0-beta.5' }
    );
    assert.equal(versionOnly.adcp_version, '3.2-beta.5');
    assert.equal(Object.hasOwn(versionOnly, 'adcp_major_version'), false);

    const majorOnly = prepareConformanceProbeRequest(
      'get_products',
      { adcp_major_version: 99 },
      { adcpVersion: '3.1.18' }
    );
    assert.equal(majorOnly.adcp_major_version, 3);
    assert.equal(Object.hasOwn(majorOnly, 'adcp_version'), false);
  });

  test('compact fixture overlays preserve real reference tuples and exact request schemas', () => {
    const account = { brand: { domain: 'conformance.example' }, operator: 'conformance.example' };
    const digest = 'sha256:' + 'A'.repeat(43);
    const fixtures = {
      products: [
        {
          product_id: 'product-real',
          pricing_option_id: 'price-real',
          feed_version: 'feed-real',
          pricing_version: 'pricing-real',
          account,
        },
      ],
      proposals: [
        { proposal_id: 'proposal-draft-a', terms_digest: digest, proposal_status: 'draft', account },
        { proposal_id: 'proposal-draft-b', terms_digest: digest, proposal_status: 'draft', account },
        { proposal_id: 'proposal-committed', terms_digest: digest, proposal_status: 'committed', account },
      ],
      media_buys: [{ media_buy_id: 'media-buy-real', revision: 7, account }],
    };
    const idempotency_key = '00000000-0000-4000-8000-000000000001';
    const samples = {
      buy_products: {
        idempotency_key,
        account,
        feed_version: 'generated',
        pricing_version: 'generated',
        purchases: [{ product_id: 'generated', pricing_option_id: 'generated' }],
        start_time: '2026-09-01T00:00:00Z',
        end_time: '2026-09-02T00:00:00Z',
      },
      refine_proposals: { idempotency_key, refinements: [{ proposal_id: 'generated' }] },
      decline_proposals: {
        idempotency_key,
        declines: [{ proposal_id: 'generated', reason: 'price' }],
      },
      accept_proposal: {
        idempotency_key,
        account,
        proposal_id: 'generated',
        proposal_terms_digest: digest,
      },
      control_media_buy: {
        idempotency_key,
        account,
        media_buy_id: 'generated',
        revision: 1,
        paused: true,
      },
    };

    for (const [tool, sample] of Object.entries(samples)) {
      const probe = prepareConformanceProbeRequest(tool, sample, { fixtures, adcpVersion: '3.2.0-beta.5' });
      const validate = makeAjv().compile(loadRequestSchema(tool, { version: '3.2.0-beta.5' }));
      assert.equal(validate(probe), true, `${tool}: ${JSON.stringify(validate.errors)}`);
    }

    assert.deepEqual(prepareConformanceProbeRequest('buy_products', samples.buy_products, { fixtures }).purchases, [
      { product_id: 'product-real', pricing_option_id: 'price-real' },
    ]);
    assert.equal(
      prepareConformanceProbeRequest('decline_proposals', samples.decline_proposals, { fixtures }).declines[0]
        .proposal_id,
      'proposal-draft-b'
    );
    assert.equal(
      prepareConformanceProbeRequest('accept_proposal', samples.accept_proposal, { fixtures }).proposal_terms_digest,
      digest
    );
  });

  test('stateful defaults use tool-specific fixture readiness', () => {
    assert.equal(toolHasConformanceFixtures('update_property_list', { list_ids: ['list-real'] }), true);
    assert.equal(toolHasConformanceFixtures('update_media_buy', { list_ids: ['list-real'] }), false);
    assert.equal(toolHasConformanceFixtures('buy_products', { list_ids: ['list-real'] }, true), false);
    assert.equal(toolHasConformanceFixtures('request_proposals', {}, true), true);
    assert.equal(
      toolHasConformanceFixtures(
        'accept_proposal',
        {
          proposals: [
            {
              proposal_id: 'proposal-draft',
              terms_digest: 'sha256:' + 'A'.repeat(43),
              proposal_status: 'draft',
              account: {},
            },
          ],
        },
        true
      ),
      false
    );
  });

  // Threshold splits by whether the tool's request schema permits extras.
  // Tools with `additionalProperties: true` at the root are subject to the
  // ~15% unknown-field injector; a 0.9 floor is too tight. Tools with
  // `additionalProperties: false` don't get injected and keep the 0.9
  // floor — a regression in those would surface without the permissive
  // tools masking it.
  const STRICT_SCHEMA = new Set(['list_property_lists']);

  for (const tool of STATELESS_TIER_TOOLS) {
    if (!RELIABLE.has(tool)) continue;
    const floor = STRICT_SCHEMA.has(tool) ? 0.9 : 0.8;
    test(`${tool}: ≥${(floor * 100).toFixed(0)}% of generated samples are schema-valid`, () => {
      const schema = loadRequestSchema(tool);
      const validate = makeAjv().compile(schema);
      const arb = schemaToArbitrary(schema);
      const samples = fc.sample(arb, { numRuns: 100, seed: 42 });
      const invalid = samples.filter(s => !validate(s));
      const validity = (samples.length - invalid.length) / samples.length;
      assert.ok(validity >= floor, `${tool}: validity ${validity.toFixed(2)} below ${floor}`);
    });
  }

  test('seed determinism: same seed produces identical sample sequence', () => {
    const schema = loadRequestSchema('get_signals');
    const arb = schemaToArbitrary(schema);
    const a = fc.sample(arb, { numRuns: 25, seed: 99 });
    const b = fc.sample(arb, { numRuns: 25, seed: 99 });
    assert.deepStrictEqual(a, b);
  });

  test('enum: only enum values are produced', () => {
    const arb = schemaToArbitrary({ enum: ['a', 'b', 'c'] });
    const values = new Set(fc.sample(arb, { numRuns: 50 }));
    for (const v of values) assert.ok(['a', 'b', 'c'].includes(v));
  });

  test('pattern: generated strings satisfy the regex', () => {
    const arb = schemaToArbitrary({ type: 'string', pattern: '^[A-Z]{2}$' });
    for (const v of fc.sample(arb, { numRuns: 50 })) {
      assert.match(v, /^[A-Z]{2}$/);
    }
  });

  // ── 3.0.1: $ref resolution against root schema ───────────
  // adcp#3170's bundler hoist emits `#/$defs/Name` pointers in bundled
  // requests. Without root resolution the generator falls through to
  // fc.anything() and produces samples that fail validation.

  test('$ref: pointer to $defs resolves and produces enum values', () => {
    const schema = {
      $defs: { Status: { type: 'string', enum: ['active', 'paused'] } },
      type: 'object',
      properties: { status: { $ref: '#/$defs/Status' } },
      required: ['status'],
    };
    for (const v of fc.sample(schemaToArbitrary(schema), { numRuns: 50, seed: 11 })) {
      assert.ok(['active', 'paused'].includes(v.status), `${v.status} not in enum`);
    }
  });

  test('$ref: pointer to definitions (legacy keyword) resolves the same way', () => {
    const schema = {
      definitions: { Color: { type: 'string', enum: ['red', 'green', 'blue'] } },
      type: 'object',
      properties: { color: { $ref: '#/definitions/Color' } },
      required: ['color'],
    };
    for (const v of fc.sample(schemaToArbitrary(schema), { numRuns: 30, seed: 12 })) {
      assert.ok(['red', 'green', 'blue'].includes(v.color));
    }
  });

  test('$ref: cycle short-circuits to fc.anything() instead of stack-overflowing', () => {
    // A future spec might emit a self-referential def. The seenRefs guard
    // returns fc.anything() on revisit so generation terminates.
    const schema = {
      $defs: { Self: { $ref: '#/$defs/Self' } },
      $ref: '#/$defs/Self',
    };
    // Just exercising the path — no assertion on values, the win is that
    // fc.sample doesn't throw / hang.
    fc.sample(schemaToArbitrary(schema), { numRuns: 5, seed: 13 });
  });

  test('$ref: unresolvable pointer falls through to fc.anything() (no crash)', () => {
    const schema = { $ref: '#/$defs/Missing' };
    fc.sample(schemaToArbitrary(schema), { numRuns: 5, seed: 14 });
  });

  test('anyOf-required: satisfies at least one required branch', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      anyOf: [{ required: ['a'] }, { required: ['b'] }],
    };
    const arb = schemaToArbitrary(schema);
    for (const v of fc.sample(arb, { numRuns: 50, seed: 1 })) {
      assert.ok('a' in v || 'b' in v, `neither a nor b in ${JSON.stringify(v)}`);
    }
  });

  test('if/else discriminator removes fields forbidden outside the matching branch', () => {
    const schema = {
      type: 'object',
      properties: {
        format_kind: { enum: ['image', 'coordinated_placements'] },
        component_assets: { type: 'object' },
      },
      allOf: [
        {
          if: {
            properties: { format_kind: { const: 'coordinated_placements' } },
            required: ['format_kind'],
          },
          then: { required: ['component_assets'] },
          else: { not: { required: ['component_assets'] } },
        },
      ],
    };
    const validate = makeAjv().compile(schema);
    const samples = fc.sample(schemaToArbitrary(schema), { numRuns: 100, seed: 42 });
    assert.equal(
      samples.every(sample => validate(sample)),
      true,
      JSON.stringify(validate.errors)
    );
  });

  test('fixtures: scalar creative_id draws from the pool', () => {
    const pool = ['cre_abc', 'cre_def', 'cre_ghi'];
    const schema = {
      type: 'object',
      properties: { creative_id: { type: 'string' } },
      required: ['creative_id'],
    };
    const arb = schemaToArbitrary(schema, { fixtures: { creative_ids: pool } });
    for (const v of fc.sample(arb, { numRuns: 30, seed: 5 })) {
      assert.ok(pool.includes(v.creative_id), `${v.creative_id} not in pool`);
    }
  });

  test('fixtures: plural creative_ids array draws items from the pool', () => {
    const pool = ['cre_1', 'cre_2'];
    const schema = {
      type: 'object',
      properties: {
        creative_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
      },
      required: ['creative_ids'],
    };
    const arb = schemaToArbitrary(schema, { fixtures: { creative_ids: pool } });
    for (const v of fc.sample(arb, { numRuns: 30, seed: 6 })) {
      assert.ok(Array.isArray(v.creative_ids));
      for (const id of v.creative_ids) assert.ok(pool.includes(id), `${id} not in pool`);
    }
  });

  test('fixtures: unknown property falls through to schema arbitrary', () => {
    const arb = schemaToArbitrary(
      {
        type: 'object',
        properties: { plain_string: { type: 'string', pattern: '^[A-Z]{2}$' } },
        required: ['plain_string'],
      },
      { fixtures: { creative_ids: ['cre_x'] } }
    );
    for (const v of fc.sample(arb, { numRuns: 20, seed: 7 })) {
      assert.match(v.plain_string, /^[A-Z]{2}$/);
    }
  });

  test('fixtures: empty pool falls through (does not throw)', () => {
    const arb = schemaToArbitrary(
      {
        type: 'object',
        properties: { creative_id: { type: 'string' } },
        required: ['creative_id'],
      },
      { fixtures: { creative_ids: [] } }
    );
    for (const v of fc.sample(arb, { numRuns: 10, seed: 8 })) {
      assert.equal(typeof v.creative_id, 'string');
    }
  });

  test('fixtures: pool values that violate schema pattern are filtered out', () => {
    // Intent: a user sets up creative_ids = [cre_a, BAD]. Only cre_a matches
    // the pattern. The pool is filtered, leaving cre_a as the only option.
    const arb = schemaToArbitrary(
      {
        type: 'object',
        properties: { creative_id: { type: 'string', pattern: '^cre_[a-z]+$' } },
        required: ['creative_id'],
      },
      { fixtures: { creative_ids: ['cre_a', 'BAD'] } }
    );
    const seen = new Set();
    for (const v of fc.sample(arb, { numRuns: 30, seed: 11 })) {
      seen.add(v.creative_id);
      assert.match(v.creative_id, /^cre_[a-z]+$/);
    }
    assert.ok(seen.has('cre_a'));
    assert.ok(!seen.has('BAD'));
  });

  test('fixtures: falls through when no pool values satisfy the schema', () => {
    // The collision-resolution case: same property name in a nested
    // context with a tighter pattern. Foreign IDs drop out, generator
    // falls back to schema-derived strings.
    const arb = schemaToArbitrary(
      {
        type: 'object',
        properties: { creative_id: { type: 'string', pattern: '^mb_[a-z]+$' } },
        required: ['creative_id'],
      },
      { fixtures: { creative_ids: ['cre_a', 'cre_b'] } }
    );
    for (const v of fc.sample(arb, { numRuns: 30, seed: 12 })) {
      assert.match(v.creative_id, /^mb_[a-z]+$/, `${v.creative_id} leaked a foreign ID past the filter`);
    }
  });

  test('fixtures: minLength/maxLength also gate pool values', () => {
    const arb = schemaToArbitrary(
      {
        type: 'object',
        properties: { task_id: { type: 'string', minLength: 5, maxLength: 10 } },
        required: ['task_id'],
      },
      { fixtures: { task_ids: ['abc', 'valid_id', 'way_too_long_to_fit'] } }
    );
    for (const v of fc.sample(arb, { numRuns: 30, seed: 13 })) {
      assert.ok(v.task_id.length >= 5 && v.task_id.length <= 10, `${v.task_id} violates length constraint`);
    }
  });

  test('additionalProperties: true → occasionally injects unknown key', () => {
    // 15% injection rate over 200 runs should produce enough extra
    // properties to detect reliably. The key name space is small and
    // known.
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: true,
    };
    const samples = fc.sample(schemaToArbitrary(schema), { numRuns: 200, seed: 42 });
    const hasExtras = samples.filter(v => Object.keys(v).some(k => k !== 'a'));
    assert.ok(hasExtras.length > 0, 'expected at least one sample with an extra key');
    // All extra keys come from the fixed vocabulary.
    const extraKeys = new Set();
    for (const v of hasExtras) {
      for (const k of Object.keys(v)) if (k !== 'a') extraKeys.add(k);
    }
    for (const k of extraKeys) {
      assert.match(
        k,
        /^(x_conformance_probe|_debug_trace|probe_key|unknown_field|test_vendor_ext)$/,
        `unexpected extra key: ${k}`
      );
    }
  });

  test('additionalProperties: false → never injects unknown key', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    };
    const samples = fc.sample(schemaToArbitrary(schema), { numRuns: 100, seed: 42 });
    for (const v of samples) {
      assert.deepEqual(Object.keys(v), ['a'], `leaked extra key in strict schema: ${JSON.stringify(v)}`);
    }
  });

  test('fixtures: array items also gated by schema constraints', () => {
    const arb = schemaToArbitrary(
      {
        type: 'object',
        properties: {
          creative_ids: {
            type: 'array',
            items: { type: 'string', pattern: '^cre_' },
            minItems: 1,
            maxItems: 3,
          },
        },
        required: ['creative_ids'],
      },
      { fixtures: { creative_ids: ['cre_a', 'cre_b', 'BAD'] } }
    );
    for (const v of fc.sample(arb, { numRuns: 30, seed: 14 })) {
      for (const id of v.creative_ids) {
        assert.match(id, /^cre_/);
      }
    }
  });
});
