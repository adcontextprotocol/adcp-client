const test = require('node:test');
const assert = require('node:assert');
const {
  FormatAsset,
  imageAssetSlot,
  videoAssetSlot,
  audioAssetSlot,
  textAssetSlot,
  catalogAssetSlot,
  repeatableGroup,
  imageGroupAsset,
  textGroupAsset,
} = require('../../dist/lib/index.js');

// These tests cover the exact shapes that scope3data/agentic-adapters#118
// had to fix post-merge: image/video/audio requirements on Format.assets[],
// and min_count/max_count on a repeatable_group wrapper rather than on
// individual asset slots. TypeScript blocks the wrong shapes at compile time
// (see format-asset-slots.ts). These runtime tests prove the builders emit
// the right wire shape for the right shape.

test('format asset slot builders', async t => {
  await t.test('imageAssetSlot injects item_type and asset_type with nested requirements', () => {
    const slot = imageAssetSlot({
      asset_id: 'hero_image',
      required: true,
      requirements: {
        aspect_ratio: '1:1',
        formats: ['jpg', 'png', 'webp'],
        max_file_size_kb: 5120,
      },
    });

    assert.deepStrictEqual(slot, {
      asset_id: 'hero_image',
      required: true,
      requirements: {
        aspect_ratio: '1:1',
        formats: ['jpg', 'png', 'webp'],
        max_file_size_kb: 5120,
      },
      item_type: 'individual',
      asset_type: 'image',
    });
  });

  await t.test('videoAssetSlot uses containers + min_duration_ms (not file_types, not _seconds)', () => {
    const slot = videoAssetSlot({
      asset_id: 'video_ad',
      required: true,
      requirements: {
        aspect_ratio: '16:9',
        containers: ['mp4', 'webm'],
        min_duration_ms: 6000,
        max_duration_ms: 30000,
      },
    });

    assert.strictEqual(slot.item_type, 'individual');
    assert.strictEqual(slot.asset_type, 'video');
    assert.deepStrictEqual(slot.requirements.containers, ['mp4', 'webm']);
    assert.strictEqual(slot.requirements.min_duration_ms, 6000);
    assert.strictEqual(slot.requirements.max_duration_ms, 30000);
    assert.strictEqual(slot.requirements.file_types, undefined);
    assert.strictEqual(slot.requirements.min_duration_seconds, undefined);
  });

  await t.test('audioAssetSlot accepts duration in milliseconds', () => {
    const slot = audioAssetSlot({
      asset_id: 'audio_ad',
      required: true,
      requirements: { min_duration_ms: 10000, max_duration_ms: 60000, formats: ['mp3', 'aac'] },
    });
    assert.strictEqual(slot.asset_type, 'audio');
    assert.strictEqual(slot.requirements.min_duration_ms, 10000);
  });

  await t.test('textAssetSlot with character_pattern + length limits', () => {
    const slot = textAssetSlot({
      asset_id: 'headline',
      required: true,
      requirements: { max_length: 40, min_lines: 1, max_lines: 1 },
    });
    assert.strictEqual(slot.asset_type, 'text');
    assert.strictEqual(slot.requirements.max_length, 40);
  });

  await t.test('catalogAssetSlot carries CatalogRequirements', () => {
    const slot = catalogAssetSlot({
      asset_id: 'products',
      required: true,
      requirements: {
        catalog_type: 'product',
        min_items: 3,
        max_items: 10,
        feed_formats: ['google_merchant_center'],
      },
    });
    assert.strictEqual(slot.asset_type, 'catalog');
    assert.strictEqual(slot.requirements.catalog_type, 'product');
  });

  await t.test('repeatableGroup places min_count and max_count on the wrapper, not on individual assets', () => {
    // Pinterest carousel: 2-5 images. The counts live on the group, NOT on the
    // image asset inside — that was the spec-violation bug in PR #118.
    const group = repeatableGroup({
      asset_group_id: 'carousel_items',
      required: true,
      min_count: 2,
      max_count: 5,
      selection_mode: 'sequential',
      assets: [
        imageGroupAsset({
          asset_id: 'card_image',
          required: true,
          requirements: { aspect_ratio: '1:1', formats: ['jpg', 'png'] },
        }),
        textGroupAsset({ asset_id: 'card_headline', required: true, requirements: { max_length: 40 } }),
      ],
    });

    assert.strictEqual(group.item_type, 'repeatable_group');
    assert.strictEqual(group.min_count, 2);
    assert.strictEqual(group.max_count, 5);
    assert.strictEqual(group.asset_group_id, 'carousel_items');
    assert.strictEqual(group.assets.length, 2);
    assert.strictEqual(group.assets[0].asset_type, 'image');
    // Group assets don't carry item_type — they sit inside the group wrapper.
    assert.strictEqual(group.assets[0].item_type, undefined);
  });

  await t.test('FormatAsset namespace exposes every slot builder', () => {
    // Sanity: the top-level helpers are reachable under FormatAsset.*.
    assert.strictEqual(FormatAsset.image, imageAssetSlot);
    assert.strictEqual(FormatAsset.video, videoAssetSlot);
    assert.strictEqual(FormatAsset.audio, audioAssetSlot);
    assert.strictEqual(FormatAsset.text, textAssetSlot);
    assert.strictEqual(FormatAsset.catalog, catalogAssetSlot);
    assert.strictEqual(FormatAsset.group, repeatableGroup);
    assert.strictEqual(FormatAsset.groupImage, imageGroupAsset);
  });

  await t.test('discriminator spread order prevents casted input from overriding asset_type', () => {
    const smuggled = {
      asset_id: 'x',
      required: true,
      requirements: {},
      asset_type: 'image', // bypasses TS via cast in a misbehaving caller
      item_type: 'repeatable_group', // also a cast bypass
    };
    const slot = videoAssetSlot(smuggled);
    assert.strictEqual(slot.asset_type, 'video');
    assert.strictEqual(slot.item_type, 'individual');
  });
});
