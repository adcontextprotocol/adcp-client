// Unit tests for the conformance-fuzzer schema → fast-check arbitrary.
// Verifies that generated samples validate against their source schemas
// at a rate high enough to meaningfully exercise the accepted-response path.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const fc = require('fast-check');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const { schemaToArbitrary } = require('../../dist/lib/conformance/schemaArbitrary.js');
const { loadRequestSchema } = require('../../dist/lib/conformance/schemaLoader.js');
const { STATELESS_TIER_TOOLS } = require('../../dist/lib/conformance/types.js');

function makeAjv() {
  const ajv = new Ajv({ allErrors: false, strict: false });
  addFormats(ajv);
  return ajv;
}

describe('conformance: schemaToArbitrary', () => {
  // Tools whose schemas the generator can satisfy almost all the time. The
  // remaining tools lean on constructs (not, allOf+not, deep oneOf) that are
  // out of scope — their imperfect validity is compensated by the two-path
  // oracle (validly-rejected counts as a pass).
  const RELIABLE = new Set([
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

  for (const tool of STATELESS_TIER_TOOLS) {
    if (!RELIABLE.has(tool)) continue;
    test(`${tool}: ≥90% of generated samples are schema-valid`, () => {
      const schema = loadRequestSchema(tool);
      const validate = makeAjv().compile(schema);
      const arb = schemaToArbitrary(schema);
      const samples = fc.sample(arb, { numRuns: 100, seed: 42 });
      const invalid = samples.filter(s => !validate(s));
      const validity = (samples.length - invalid.length) / samples.length;
      assert.ok(validity >= 0.9, `${tool}: validity ${validity.toFixed(2)} below 0.9`);
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
