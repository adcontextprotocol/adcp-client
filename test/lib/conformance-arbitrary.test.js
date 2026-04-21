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
});
