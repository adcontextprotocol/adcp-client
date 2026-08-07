const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  BUILD_ASSETS_FROM_FORMAT_DIRECTIVE,
  expandCreativeAssetDirectives,
  findUnresolvedCreativeAssetDirectives,
} = require('../../dist/lib/testing/storyboard/creative-assets');
const { injectContext } = require('../../dist/lib/testing/storyboard/context');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

const TEST_KIT = {
  assets: {
    images: [
      {
        id: 'hero_300x250',
        url: 'https://assets.example/300x250.jpg',
        width: 300,
        height: 250,
        mime_type: 'image/jpeg',
      },
      { id: 'hero_320x50', url: 'https://assets.example/320x50.jpg', width: 320, height: 50, mime_type: 'image/jpeg' },
    ],
    text: { headlines: ['Built for the Trail'], descriptions: ['Adventure starts here'], cta: ['Shop Now'] },
    click_url: 'https://acmeoutdoor.example/summer-sale',
  },
};

describe('$build_assets_from_format', () => {
  test('uses canonical required slots and selects the exact declared dimensions', () => {
    const request = {
      creatives: [
        {
          assets: {
            [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
              width: 320,
              height: 50,
              slots: [{ asset_group_id: 'image_main', asset_type: 'image', required: true }],
            },
          },
        },
      ],
    };

    const expanded = expandCreativeAssetDirectives(request, {}, TEST_KIT);
    assert.deepStrictEqual(expanded.creatives[0].assets, {
      image_main: {
        asset_type: 'image',
        url: 'https://assets.example/320x50.jpg',
        width: 320,
        height: 50,
        mime_type: 'image/jpeg',
      },
    });
  });

  test('resolves a legacy FormatId and builds every required seller asset', () => {
    const formatRef = { agent_url: 'https://creative.example/', id: 'display_320x50' };
    const context = {
      formats: [
        {
          format_id: formatRef,
          assets: [
            { asset_id: 'banner_image', asset_type: 'image', required: true },
            { asset_id: 'click_url', asset_type: 'url', required: true },
            { asset_id: 'tracking_pixel', asset_type: 'url', required: false },
          ],
        },
      ],
    };

    const expanded = expandCreativeAssetDirectives(
      { assets: { [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: formatRef } },
      context,
      TEST_KIT
    );
    assert.deepStrictEqual(expanded.assets, {
      banner_image: {
        asset_type: 'image',
        url: 'https://assets.example/320x50.jpg',
        width: 320,
        height: 50,
        mime_type: 'image/jpeg',
      },
      click_url: { asset_type: 'url', url: 'https://acmeoutdoor.example/summer-sale' },
    });
  });

  test('preserves sibling assets when expanding the directive', () => {
    const trackingPixel = { asset_type: 'url', url: 'https://metrics.example/pixel' };
    const expanded = expandCreativeAssetDirectives(
      {
        assets: {
          tracking_pixel: trackingPixel,
          [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
            width: 320,
            height: 50,
            slots: [{ asset_group_id: 'image_main', asset_type: 'image', required: true }],
          },
        },
      },
      {},
      TEST_KIT
    );

    assert.deepStrictEqual(expanded.assets.tracking_pixel, trackingPixel);
    assert.strictEqual(expanded.assets.image_main.url, 'https://assets.example/320x50.jpg');
    assert.strictEqual(BUILD_ASSETS_FROM_FORMAT_DIRECTIVE in expanded.assets, false);
  });

  test('leaves an unfulfillable directive detectable so it cannot reach transport', () => {
    const request = {
      creatives: [
        {
          assets: {
            [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
              slots: [{ asset_group_id: 'video_main', asset_type: 'video', required: true }],
            },
          },
        },
      ],
    };
    const expanded = expandCreativeAssetDirectives(request, {}, TEST_KIT);
    assert.deepStrictEqual(findUnresolvedCreativeAssetDirectives(expanded), [
      '$.creatives[0].assets.$build_assets_from_format',
    ]);
  });

  test('runner expands the directive before dispatching sync_creatives', async () => {
    const calls = [];
    const storyboard = {
      id: 'creative_asset_expansion',
      version: '1.0.0',
      title: 'Creative asset expansion',
      category: 'compliance',
      summary: '',
      narrative: '',
      agent: { interaction_model: '*', capabilities: [] },
      caller: { role: 'buyer_agent' },
      context: {
        format_params: {
          width: 320,
          height: 50,
          slots: [{ asset_group_id: 'image_main', asset_type: 'image', required: true }],
        },
      },
      phases: [
        {
          id: 'creative',
          title: 'Creative',
          steps: [
            {
              id: 'sync',
              title: 'Sync creative',
              task: 'sync_creatives',
              sample_request: {
                account: { operator: 'seller.example' },
                creatives: [
                  {
                    creative_id: 'creative-1',
                    format_kind: 'image',
                    assets: { [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: '$context.format_params' },
                  },
                ],
              },
              validations: [],
            },
          ],
        },
      ],
    };
    const client = {
      async executeTask(name, params) {
        calls.push({ name, params });
        return { success: true, data: { creatives: [{ creative_id: 'creative-1', status: 'approved' }] } };
      },
      async getAgentInfo() {
        return { name: 'Test', tools: [{ name: 'sync_creatives' }] };
      },
    };

    await runStoryboard('https://seller.example/mcp', storyboard, {
      protocol: 'mcp',
      agentTools: ['sync_creatives'],
      _profile: { name: 'Test', tools: ['sync_creatives'] },
      _client: client,
      test_kit: TEST_KIT,
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'sync_creatives');
    assert.strictEqual(calls[0].params.creatives[0].assets.image_main.url, 'https://assets.example/320x50.jpg');
    assert.strictEqual(BUILD_ASSETS_FROM_FORMAT_DIRECTIVE in calls[0].params.creatives[0].assets, false);
  });

  test('runner fails pre-wire when a required seller asset cannot be populated', async () => {
    const calls = [];
    const storyboard = {
      id: 'creative_asset_preflight_failure',
      version: '1.0.0',
      title: 'Creative asset preflight failure',
      category: 'compliance',
      summary: '',
      narrative: '',
      agent: { interaction_model: '*', capabilities: [] },
      caller: { role: 'buyer_agent' },
      context: {
        format_params: {
          slots: [{ asset_group_id: 'video_main', asset_type: 'video', required: true }],
        },
      },
      phases: [
        {
          id: 'creative',
          title: 'Creative',
          steps: [
            {
              id: 'sync',
              title: 'Sync creative',
              task: 'sync_creatives',
              expect_error: true,
              sample_request: {
                account: { operator: 'seller.example' },
                creatives: [
                  {
                    creative_id: 'creative-1',
                    format_kind: 'video',
                    assets: { [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: '$context.format_params' },
                  },
                ],
              },
              validations: [],
            },
          ],
        },
      ],
    };
    const result = await runStoryboard('https://seller.example/mcp', storyboard, {
      protocol: 'mcp',
      agentTools: ['sync_creatives'],
      _profile: { name: 'Test', tools: ['sync_creatives'] },
      _client: {
        async executeTask(name, params) {
          calls.push({ name, params });
          return { success: true, data: {} };
        },
        async getAgentInfo() {
          return { name: 'Test', tools: [{ name: 'sync_creatives' }] };
        },
      },
      test_kit: TEST_KIT,
    });

    assert.strictEqual(calls.length, 0);
    const step = result.phases[0].steps[0];
    assert.strictEqual(step.skipped, true);
    assert.strictEqual(step.validations[0].check, 'unresolved_substitution');
    assert.strictEqual(step.validations[0].expected, BUILD_ASSETS_FROM_FORMAT_DIRECTIVE);
  });
});

describe('nested $context substitution', () => {
  test('resolves create_media_buy.packages[0].product_id inside an object array', () => {
    const request = injectContext(
      {
        packages: [{ product_id: '$context.product_id', nested: { pricing_option_id: '$context.pricing_option_id' } }],
      },
      { product_id: 'seller-product-123', pricing_option_id: 'seller-pricing-456' }
    );
    assert.deepStrictEqual(request, {
      packages: [
        {
          product_id: 'seller-product-123',
          nested: { pricing_option_id: 'seller-pricing-456' },
        },
      ],
    });
  });
});
