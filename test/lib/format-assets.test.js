// Unit tests for format-assets utilities
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import the format-assets utilities
const {
  getFormatAssets,
  normalizeAssetsRequired,
  getRequiredAssets,
  getOptionalAssets,
  getIndividualAssets,
  getRepeatableGroups,
  usesDeprecatedAssetsField,
  getAssetCount,
  hasAssets,
} = require('../../dist/lib/utils/format-assets.js');

// Test fixtures
const createV26Format = (assets = []) => ({
  format_id: { agent_url: 'https://test.agent/', id: 'test_format' },
  name: 'Test Format v2.6',
  type: 'display',
  assets,
});

const createV25Format = (assetsRequired = []) => ({
  format_id: { agent_url: 'https://test.agent/', id: 'test_format' },
  name: 'Test Format v2.5',
  type: 'display',
  assets_required: assetsRequired,
});

const createIndividualAsset = (overrides = {}) => ({
  item_type: 'individual',
  asset_id: 'banner_image',
  asset_type: 'image',
  required: true,
  ...overrides,
});

const createRepeatableGroup = (overrides = {}) => ({
  item_type: 'repeatable_group',
  asset_group_id: 'product_images',
  required: true,
  min_count: 1,
  max_count: 5,
  assets: [{ asset_id: 'image', asset_type: 'image', required: true }],
  ...overrides,
});

describe('Format Assets Utilities', () => {
  describe('getFormatAssets', () => {
    test('should return assets from v2.6 format', () => {
      const format = createV26Format([
        createIndividualAsset({ asset_id: 'hero', required: true }),
        createIndividualAsset({ asset_id: 'logo', required: false }),
      ]);

      const assets = getFormatAssets(format);

      assert.strictEqual(assets.length, 2);
      assert.strictEqual(assets[0].asset_id, 'hero');
      assert.strictEqual(assets[1].asset_id, 'logo');
    });

    test('should return normalized assets from v2.5 format (assets_required)', () => {
      const format = createV25Format([
        { item_type: 'individual', asset_id: 'banner', asset_type: 'image' },
        { item_type: 'individual', asset_id: 'headline', asset_type: 'text' },
      ]);

      const assets = getFormatAssets(format);

      assert.strictEqual(assets.length, 2);
      // assets_required items should have required: true after normalization
      assert.strictEqual(assets[0].required, true);
      assert.strictEqual(assets[1].required, true);
    });

    test('should prefer v2.6 assets over deprecated assets_required', () => {
      // Format with both fields (v2.6 takes precedence)
      const format = {
        format_id: { agent_url: 'https://test.agent/', id: 'test' },
        assets: [createIndividualAsset({ asset_id: 'new_asset', required: false })],
        assets_required: [{ item_type: 'individual', asset_id: 'old_asset', asset_type: 'image' }],
      };

      const assets = getFormatAssets(format);

      assert.strictEqual(assets.length, 1);
      assert.strictEqual(assets[0].asset_id, 'new_asset');
      assert.strictEqual(assets[0].required, false);
    });

    test('should return empty array for format with no assets', () => {
      const format = createV26Format([]);
      const assets = getFormatAssets(format);
      assert.deepStrictEqual(assets, []);
    });
  });

  describe('normalizeAssetsRequired', () => {
    test('should set required: true for all assets', () => {
      const assetsRequired = [
        { item_type: 'individual', asset_id: 'img1', asset_type: 'image' },
        { item_type: 'individual', asset_id: 'img2', asset_type: 'image' },
      ];

      const normalized = normalizeAssetsRequired(assetsRequired);

      assert.strictEqual(normalized[0].required, true);
      assert.strictEqual(normalized[1].required, true);
    });

    test('should preserve other fields during normalization', () => {
      const assetsRequired = [
        {
          item_type: 'individual',
          asset_id: 'banner',
          asset_type: 'image',
          requirements: { min_width: 300 },
        },
      ];

      const normalized = normalizeAssetsRequired(assetsRequired);

      assert.strictEqual(normalized[0].asset_id, 'banner');
      assert.strictEqual(normalized[0].asset_type, 'image');
      assert.deepStrictEqual(normalized[0].requirements, { min_width: 300 });
    });
  });

  describe('getRequiredAssets', () => {
    test('should return only required assets', () => {
      const format = createV26Format([
        createIndividualAsset({ asset_id: 'required1', required: true }),
        createIndividualAsset({ asset_id: 'optional1', required: false }),
        createIndividualAsset({ asset_id: 'required2', required: true }),
      ]);

      const required = getRequiredAssets(format);

      assert.strictEqual(required.length, 2);
      assert.ok(required.every(a => a.required === true));
    });

    test('should return all assets from v2.5 format (all are required)', () => {
      const format = createV25Format([
        { item_type: 'individual', asset_id: 'img1', asset_type: 'image' },
        { item_type: 'individual', asset_id: 'img2', asset_type: 'image' },
      ]);

      const required = getRequiredAssets(format);

      assert.strictEqual(required.length, 2);
    });
  });

  describe('getOptionalAssets', () => {
    test('should return only optional assets', () => {
      const format = createV26Format([
        createIndividualAsset({ asset_id: 'required1', required: true }),
        createIndividualAsset({ asset_id: 'optional1', required: false }),
        createIndividualAsset({ asset_id: 'optional2', required: false }),
      ]);

      const optional = getOptionalAssets(format);

      assert.strictEqual(optional.length, 2);
      assert.ok(optional.every(a => a.required === false));
    });

    test('should return empty array from v2.5 format (all are required)', () => {
      const format = createV25Format([{ item_type: 'individual', asset_id: 'img1', asset_type: 'image' }]);

      const optional = getOptionalAssets(format);

      assert.strictEqual(optional.length, 0);
    });
  });

  describe('getIndividualAssets', () => {
    test('should return only individual assets', () => {
      const format = createV26Format([
        createIndividualAsset({ asset_id: 'individual1' }),
        createRepeatableGroup({ asset_group_id: 'group1' }),
        createIndividualAsset({ asset_id: 'individual2' }),
      ]);

      const individuals = getIndividualAssets(format);

      assert.strictEqual(individuals.length, 2);
      assert.ok(individuals.every(a => a.item_type === 'individual'));
    });
  });

  describe('getRepeatableGroups', () => {
    test('should return only repeatable groups', () => {
      const format = createV26Format([
        createIndividualAsset({ asset_id: 'individual1' }),
        createRepeatableGroup({ asset_group_id: 'group1' }),
        createRepeatableGroup({ asset_group_id: 'group2' }),
      ]);

      const groups = getRepeatableGroups(format);

      assert.strictEqual(groups.length, 2);
      assert.ok(groups.every(a => a.item_type === 'repeatable_group'));
    });
  });

  describe('usesDeprecatedAssetsField', () => {
    test('should return true for v2.5 format using assets_required', () => {
      const format = createV25Format([{ item_type: 'individual', asset_id: 'img', asset_type: 'image' }]);

      assert.strictEqual(usesDeprecatedAssetsField(format), true);
    });

    test('should return false for v2.6 format using assets', () => {
      const format = createV26Format([createIndividualAsset({ asset_id: 'img' })]);

      assert.strictEqual(usesDeprecatedAssetsField(format), false);
    });

    test('should return false for format with both fields (v2.6 takes precedence)', () => {
      const format = {
        format_id: { agent_url: 'https://test.agent/', id: 'test' },
        assets: [createIndividualAsset()],
        assets_required: [{ item_type: 'individual', asset_id: 'old', asset_type: 'image' }],
      };

      assert.strictEqual(usesDeprecatedAssetsField(format), false);
    });

    test('should return false for format with no assets', () => {
      const format = createV26Format([]);
      assert.strictEqual(usesDeprecatedAssetsField(format), false);
    });
  });

  describe('getAssetCount', () => {
    test('should count total assets', () => {
      const format = createV26Format([
        createIndividualAsset({ asset_id: 'a1' }),
        createIndividualAsset({ asset_id: 'a2' }),
        createRepeatableGroup({ asset_group_id: 'g1' }),
      ]);

      assert.strictEqual(getAssetCount(format), 3);
    });

    test('should return 0 for format with no assets', () => {
      const format = createV26Format([]);
      assert.strictEqual(getAssetCount(format), 0);
    });
  });

  describe('hasAssets', () => {
    test('should return true for format with assets', () => {
      const format = createV26Format([createIndividualAsset()]);
      assert.strictEqual(hasAssets(format), true);
    });

    test('should return false for format with no assets', () => {
      const format = createV26Format([]);
      assert.strictEqual(hasAssets(format), false);
    });

    test('should return true for v2.5 format with assets_required', () => {
      const format = createV25Format([{ item_type: 'individual', asset_id: 'img', asset_type: 'image' }]);
      assert.strictEqual(hasAssets(format), true);
    });
  });
});
