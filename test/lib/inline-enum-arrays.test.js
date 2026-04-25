/**
 * Tests for inline-union value arrays (#932).
 *
 * Cross-validates every emitted `${Parent}_${Property}Values` array against
 * the parent Zod schema — if either side drifts from the spec, the test
 * fails fast. Mirror of `enum-arrays.test.js` for inline anonymous unions.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Inline-union value arrays (inline-enums.generated)', () => {
  let inlineEnums;
  let schemas;

  it('user-flagged exports are present (image/video/audio formats, video containers)', async () => {
    inlineEnums = await import('../../dist/lib/types/inline-enums.generated.js');
    assert.ok(inlineEnums.ImageAssetRequirements_FormatsValues, 'ImageAssetRequirements_FormatsValues exported');
    assert.ok(inlineEnums.VideoAssetRequirements_ContainersValues, 'VideoAssetRequirements_ContainersValues exported');
    assert.ok(inlineEnums.VideoAssetRequirements_CodecsValues, 'VideoAssetRequirements_CodecsValues exported');
    assert.ok(inlineEnums.AudioAssetRequirements_FormatsValues, 'AudioAssetRequirements_FormatsValues exported');
  });

  it('user-flagged values match the AdCP spec (image-asset-requirements.json formats enum)', async () => {
    if (!inlineEnums) inlineEnums = await import('../../dist/lib/types/inline-enums.generated.js');
    // Pinned to the spec's `properties.formats.items.enum` in
    // schemas/cache/3.0.0/core/requirements/image-asset-requirements.json.
    // If the spec adds a new format, this test breaks and the codegen
    // catches up — exactly the drift signal we want.
    assert.deepEqual(
      [...inlineEnums.ImageAssetRequirements_FormatsValues],
      ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'tiff', 'pdf', 'eps']
    );
  });

  it('user-flagged values match the AdCP spec (video-asset-requirements.json containers enum)', async () => {
    if (!inlineEnums) inlineEnums = await import('../../dist/lib/types/inline-enums.generated.js');
    assert.deepEqual([...inlineEnums.VideoAssetRequirements_ContainersValues], ['mp4', 'webm', 'mov', 'avi', 'mkv']);
  });

  it('values are non-empty const arrays of strings (every export)', async () => {
    if (!inlineEnums) inlineEnums = await import('../../dist/lib/types/inline-enums.generated.js');
    let count = 0;
    for (const [name, value] of Object.entries(inlineEnums)) {
      if (!name.endsWith('Values')) continue;
      assert.ok(Array.isArray(value), `${name} should be an array`);
      assert.ok(value.length > 0, `${name} should be non-empty`);
      for (const v of value) {
        assert.equal(typeof v, 'string', `${name}: every element must be a string`);
      }
      count++;
    }
    // Sanity check: the codegen emits ~100 inline-union arrays; if we've
    // collapsed to a handful something broke between codegen and dist.
    assert.ok(count >= 50, `expected ≥50 inline-union arrays in dist, got ${count}`);
  });

  it('every Values element is accepted by the parent Zod schema for that property', async () => {
    if (!inlineEnums) inlineEnums = await import('../../dist/lib/types/inline-enums.generated.js');
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');

    // Parse `${Parent}_${Property}Values` into the parent schema name +
    // property path, then submit each literal value through the parent
    // schema (with all other required fields stubbed) and assert the
    // schema accepts it. If the codegen extracted a literal the spec
    // doesn't accept, this fails — which is the drift signal we want.
    let checked = 0;
    let mismatches = [];
    for (const [exportName, values] of Object.entries(inlineEnums)) {
      if (!exportName.endsWith('Values')) continue;
      const parsed = /^([A-Z][A-Za-z0-9]+)_([A-Z][A-Za-z0-9]+)Values$/.exec(exportName);
      if (!parsed) continue; // skip exports that don't match the inline pattern
      const parentName = parsed[1];
      const propPascal = parsed[2];
      const schemaName = `${parentName}Schema`;
      const schema = schemas[schemaName];
      if (!schema?.shape) continue;

      // Find the snake_case property on the schema shape that PascalCases to propPascal.
      const propKey = Object.keys(schema.shape).find(k => {
        const camel = k
          .split('_')
          .map(s => s.charAt(0).toUpperCase() + s.slice(1))
          .join('');
        return camel === propPascal;
      });
      if (!propKey) continue;

      const propSchema = schema.shape[propKey];
      // The codegen tags whether the union is wrapped in z.array(...).
      // Detect by trying first as a single value, falling back to an
      // array of one — whichever the schema accepts.
      for (const v of values) {
        const single = propSchema.safeParse(v);
        const wrapped = propSchema.safeParse([v]);
        if (!single.success && !wrapped.success) {
          mismatches.push(`${exportName}: ${schemaName}.${propKey} rejected ${JSON.stringify(v)}`);
        }
      }
      checked++;
    }

    assert.ok(checked >= 30, `expected to cross-check ≥30 inline-union/schema pairs, got ${checked}`);
    assert.deepEqual(mismatches, [], 'every Values element must validate against the parent schema property');
  });

  it('does not duplicate named-enum values (e.g., DimensionUnitValues appears once, not as ImageAssetRequirements_UnitValues)', async () => {
    if (!inlineEnums) inlineEnums = await import('../../dist/lib/types/inline-enums.generated.js');
    // Properties that reference named enums (e.g. `unit:
    // DimensionUnitSchema.optional()`) must NOT generate a duplicate
    // inline-union export — those values already live in
    // enums.generated.ts as `DimensionUnitValues`. Catches a regression
    // in `buildNamedEnumSchemaSet` / the dedup gate.
    assert.equal(
      inlineEnums.ImageAssetRequirements_UnitValues,
      undefined,
      'named-enum references must not be re-emitted as inline-union exports'
    );
  });

  it('exports are accessible via the public surface @adcp/client/types', async () => {
    const typesEntry = await import('../../dist/lib/types/index.js');
    assert.ok(typesEntry.ImageAssetRequirements_FormatsValues, 'inline-enum reachable via /types entrypoint');
  });
});
