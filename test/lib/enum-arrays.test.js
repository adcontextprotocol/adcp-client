const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Enum value arrays (enums.generated)', () => {
  let enums;
  let schemas;

  it('exports are importable from the public surface', async () => {
    enums = await import('../../dist/lib/types/enums.generated.js');
    assert.ok(enums.MediaChannelValues, 'MediaChannelValues should be exported');
    assert.ok(enums.PacingValues, 'PacingValues should be exported');
    assert.ok(enums.MediaBuyStatusValues, 'MediaBuyStatusValues should be exported');
    assert.ok(enums.DeliveryTypeValues, 'DeliveryTypeValues should be exported');
  });

  it('values are non-empty const arrays of strings', async () => {
    if (!enums) enums = await import('../../dist/lib/types/enums.generated.js');
    for (const [name, value] of Object.entries(enums)) {
      if (!name.endsWith('Values')) continue;
      assert.ok(Array.isArray(value), `${name} should be an array`);
      assert.ok(value.length > 0, `${name} should be non-empty`);
      for (const v of value) {
        assert.equal(typeof v, 'string', `${name}: every element must be a string, got ${typeof v}`);
      }
    }
  });

  it('PacingValues matches the AdCP spec set', async () => {
    if (!enums) enums = await import('../../dist/lib/types/enums.generated.js');
    assert.deepEqual([...enums.PacingValues], ['even', 'asap', 'front_loaded']);
  });

  it('MediaBuyStatusValues matches the AdCP spec set', async () => {
    if (!enums) enums = await import('../../dist/lib/types/enums.generated.js');
    assert.deepEqual(
      [...enums.MediaBuyStatusValues],
      ['pending_creatives', 'pending_start', 'active', 'paused', 'completed', 'rejected', 'canceled']
    );
  });

  it("matches the corresponding Zod schema's literals (Pacing)", async () => {
    if (!enums) enums = await import('../../dist/lib/types/enums.generated.js');
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');
    // Drift guard: PacingValues must accept everything PacingSchema accepts,
    // and PacingSchema must accept every value in PacingValues. If the
    // codegen for one drifts, this fails fast.
    for (const v of enums.PacingValues) {
      const r = schemas.PacingSchema.safeParse(v);
      assert.ok(r.success, `PacingSchema should accept ${v}`);
    }
    const reject = schemas.PacingSchema.safeParse('not_a_valid_pacing');
    assert.equal(reject.success, false, 'PacingSchema must reject unknown values');
  });

  it('every Values export accepts its own elements via the matching Schema', async () => {
    if (!enums) enums = await import('../../dist/lib/types/enums.generated.js');
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');
    let checked = 0;
    let mismatches = [];
    for (const [name, values] of Object.entries(enums)) {
      if (!name.endsWith('Values')) continue;
      const schemaName = name.replace(/Values$/, 'Schema');
      const schema = schemas[schemaName];
      if (!schema || typeof schema.safeParse !== 'function') continue;
      for (const v of values) {
        const r = schema.safeParse(v);
        if (!r.success) mismatches.push(`${schemaName} rejected ${JSON.stringify(v)}`);
      }
      checked++;
    }
    // Sanity: we should be checking at least a few dozen pairs.
    assert.ok(checked >= 30, `expected to cross-check at least 30 enum/schema pairs, got ${checked}`);
    assert.deepEqual(mismatches, [], 'every Values element must validate against the matching Schema');
  });
});
