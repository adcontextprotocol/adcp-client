const { describe, test } = require('node:test');
const assert = require('node:assert');

// Tests for hand-authored Zod schemas in format-asset-slot-schemas.ts.
// Validates runtime parsing of Format.assets[] slot shapes from listCreativeFormats().

describe('format-asset-slot-schemas', async () => {
  let schemas;

  test('FormatAssetSlotSchema is importable from lib index', async () => {
    schemas = await import('../../dist/lib/index.js');
    assert.ok(schemas.FormatAssetSlotSchema, 'FormatAssetSlotSchema should be exported');
    assert.ok(typeof schemas.FormatAssetSlotSchema.safeParse === 'function');
  });

  test('IndividualAssetSlotSchema parses image slot', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    const slot = {
      item_type: 'individual',
      asset_id: 'hero_image',
      required: true,
      asset_type: 'image',
      requirements: { aspect_ratio: '16:9', formats: ['jpg', 'png'] },
    };
    const result = schemas.IndividualAssetSlotSchema.safeParse(slot);
    assert.ok(
      result.success,
      `IndividualAssetSlotSchema should parse image slot: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('IndividualAssetSlotSchema parses text slot', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    const slot = {
      item_type: 'individual',
      asset_id: 'headline',
      required: true,
      asset_type: 'text',
      requirements: { max_length: 90 },
    };
    const result = schemas.IndividualAssetSlotSchema.safeParse(slot);
    assert.ok(
      result.success,
      `IndividualAssetSlotSchema should parse text slot: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('IndividualAssetSlotSchema parses brief slot (no requirements)', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    const slot = {
      item_type: 'individual',
      asset_id: 'creative_brief',
      required: false,
      asset_type: 'brief',
    };
    const result = schemas.IndividualAssetSlotSchema.safeParse(slot);
    assert.ok(
      result.success,
      `IndividualAssetSlotSchema should parse brief slot: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('RepeatableGroupSlotSchema parses carousel slot', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    const group = {
      item_type: 'repeatable_group',
      asset_group_id: 'product',
      required: true,
      min_count: 3,
      max_count: 10,
      selection_mode: 'sequential',
      assets: [
        { asset_id: 'product_image', asset_type: 'image', required: true },
        { asset_id: 'product_name', asset_type: 'text', required: true },
      ],
    };
    const result = schemas.RepeatableGroupSlotSchema.safeParse(group);
    assert.ok(
      result.success,
      `RepeatableGroupSlotSchema should parse carousel: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('FormatAssetSlotSchema accepts both individual and group slots', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');

    const individual = { item_type: 'individual', asset_id: 'logo', required: true, asset_type: 'image' };
    const group = {
      item_type: 'repeatable_group',
      asset_group_id: 'card',
      required: false,
      min_count: 1,
      max_count: 5,
      assets: [],
    };

    const r1 = schemas.FormatAssetSlotSchema.safeParse(individual);
    const r2 = schemas.FormatAssetSlotSchema.safeParse(group);

    assert.ok(r1.success, `FormatAssetSlotSchema should accept individual slot: ${JSON.stringify(r1.error?.issues)}`);
    assert.ok(r2.success, `FormatAssetSlotSchema should accept group slot: ${JSON.stringify(r2.error?.issues)}`);
  });

  test('IndividualAssetSlotSchema rejects invalid asset_type', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    const slot = {
      item_type: 'individual',
      asset_id: 'x',
      required: true,
      asset_type: 'unknown_type',
    };
    const result = schemas.IndividualAssetSlotSchema.safeParse(slot);
    assert.ok(!result.success, 'IndividualAssetSlotSchema should reject unknown asset_type');
  });

  test('BaseIndividualAssetSlotSchema is exported', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    assert.ok(schemas.BaseIndividualAssetSlotSchema, 'BaseIndividualAssetSlotSchema should be exported');
  });

  test('all 14 per-type individual slot schemas are exported', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    const expectedSchemas = [
      'IndividualImageAssetSlotSchema',
      'IndividualVideoAssetSlotSchema',
      'IndividualAudioAssetSlotSchema',
      'IndividualTextAssetSlotSchema',
      'IndividualMarkdownAssetSlotSchema',
      'IndividualHtmlAssetSlotSchema',
      'IndividualCssAssetSlotSchema',
      'IndividualJavascriptAssetSlotSchema',
      'IndividualVastAssetSlotSchema',
      'IndividualDaastAssetSlotSchema',
      'IndividualUrlAssetSlotSchema',
      'IndividualWebhookAssetSlotSchema',
      'IndividualBriefAssetSlotSchema',
      'IndividualCatalogAssetSlotSchema',
    ];
    for (const name of expectedSchemas) {
      assert.ok(schemas[name], `${name} should be exported`);
    }
  });

  test('GroupAssetSlotSchema and RepeatableGroupSlotSchema are exported', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    assert.ok(schemas.GroupAssetSlotSchema, 'GroupAssetSlotSchema should be exported');
    assert.ok(schemas.RepeatableGroupSlotSchema, 'RepeatableGroupSlotSchema should be exported');
  });

  test('RepeatableGroupSlotSchema rejects group with invalid inner asset_type', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    const badGroup = {
      item_type: 'repeatable_group',
      asset_group_id: 'product',
      required: true,
      min_count: 1,
      max_count: 5,
      assets: [{ asset_id: 'item', asset_type: 'unknown_type', required: true }],
    };
    const result = schemas.RepeatableGroupSlotSchema.safeParse(badGroup);
    assert.ok(!result.success, 'RepeatableGroupSlotSchema should reject group with invalid inner asset_type');
  });

  test('GroupAssetSlotSchema rejects brief and catalog (metadata types not valid in groups)', async () => {
    if (!schemas) schemas = await import('../../dist/lib/index.js');
    const briefSlot = { asset_id: 'b', asset_type: 'brief', required: false };
    const catalogSlot = { asset_id: 'c', asset_type: 'catalog', required: false };
    assert.ok(!schemas.GroupAssetSlotSchema.safeParse(briefSlot).success, 'GroupAssetSlotSchema should reject brief');
    assert.ok(
      !schemas.GroupAssetSlotSchema.safeParse(catalogSlot).success,
      'GroupAssetSlotSchema should reject catalog'
    );
  });
});
