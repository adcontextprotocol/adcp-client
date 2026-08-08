const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  BUILD_ASSETS_FROM_FORMAT_DIRECTIVE,
  expandCreativeAssetDirectivesWithDiagnostics,
} = require('../../dist/lib/testing/storyboard/creative-assets');
const { expandCreativeAssetDirectives, findUnresolvedCreativeAssetDirectives } = require('../../dist/lib/testing');
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

function buildCreativeSyncStoryboard({ context, directive, formatKind = 'image' }) {
  return {
    id: 'creative_asset_preflight',
    version: '1.0.0',
    title: 'Creative asset preflight',
    category: 'compliance',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    context,
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
                  format_kind: formatKind,
                  assets: { [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: directive },
                },
              ],
            },
            validations: [],
          },
        ],
      },
    ],
  };
}

function runnerOptions(calls) {
  return {
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
  };
}

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

  test('preserves parameterized FormatId dimensions when resolving a template format', () => {
    const formatRef = {
      agent_url: 'https://creative.example',
      id: 'display_template',
      width: 970,
      height: 250,
    };
    const result = expandCreativeAssetDirectivesWithDiagnostics(
      { assets: { [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: formatRef } },
      {
        formats: [
          {
            format_id: { agent_url: 'https://creative.example', id: 'display_template' },
            assets: [
              {
                asset_id: 'banner_image',
                asset_type: 'image',
                required: true,
                requirements: { parameters_from_format_id: true },
              },
            ],
          },
        ],
      },
      TEST_KIT
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failure.reason, 'fixture_unavailable');
    assert.match(result.failure.constraint, /exact 970x250/);
  });

  test('reads parameterized dimensions from an inline format_id', () => {
    const result = expandCreativeAssetDirectivesWithDiagnostics(
      {
        assets: {
          [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
            format_id: {
              agent_url: 'https://creative.example',
              id: 'display_template',
              width: 970,
              height: 250,
            },
            assets: [
              {
                asset_id: 'banner_image',
                asset_type: 'image',
                required: true,
                requirements: { parameters_from_format_id: true },
              },
            ],
          },
        },
      },
      {},
      TEST_KIT
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failure.reason, 'fixture_unavailable');
    assert.match(result.failure.constraint, /exact 970x250/);
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

  test('builds recognized image, URL, headline, description, and CTA slots', () => {
    const expanded = expandCreativeAssetDirectives(
      {
        assets: {
          [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
            width: 300,
            height: 250,
            slots: [
              { asset_group_id: 'image_main', asset_type: 'image', required: true },
              { asset_group_id: 'landing_url', asset_type: 'url', required: true },
              { asset_group_id: 'headline', asset_type: 'text', required: true },
              { asset_group_id: 'title', asset_type: 'text', required: true },
              { asset_group_id: 'description', asset_type: 'text', required: true },
              { asset_group_id: 'body', asset_type: 'text', required: true },
              { asset_group_id: 'body_text', asset_type: 'text', required: true },
              { asset_group_id: 'primary_text', asset_type: 'text', required: true },
              { asset_group_id: 'cta', asset_type: 'text', required: true },
              { asset_group_id: 'cta_text', asset_type: 'text', required: true },
              { asset_group_id: 'call_to_action', asset_type: 'text', required: true },
            ],
          },
        },
      },
      {},
      TEST_KIT
    );

    assert.strictEqual(expanded.assets.image_main.url, 'https://assets.example/300x250.jpg');
    assert.deepStrictEqual(expanded.assets.landing_url, {
      asset_type: 'url',
      url: 'https://acmeoutdoor.example/summer-sale',
    });
    for (const slotId of ['headline', 'title']) {
      assert.deepStrictEqual(expanded.assets[slotId], {
        asset_type: 'text',
        content: 'Built for the Trail',
      });
    }
    for (const slotId of ['description', 'body', 'body_text', 'primary_text']) {
      assert.deepStrictEqual(expanded.assets[slotId], {
        asset_type: 'text',
        content: 'Adventure starts here',
      });
    }
    for (const slotId of ['cta', 'cta_text', 'call_to_action']) {
      assert.deepStrictEqual(expanded.assets[slotId], { asset_type: 'text', content: 'Shop Now' });
    }
  });

  test('reports unsupported asset types with a slot-level fixture diagnostic', () => {
    for (const assetType of ['video', 'audio', 'html', 'javascript', 'vast_tag']) {
      const result = expandCreativeAssetDirectivesWithDiagnostics(
        {
          assets: {
            [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
              slots: [{ asset_group_id: `${assetType}_main`, asset_type: assetType, required: true }],
            },
          },
        },
        {},
        TEST_KIT
      );

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.failure.reason, 'fixture_unavailable');
      assert.strictEqual(result.failure.slotId, `${assetType}_main`);
      assert.strictEqual(result.failure.assetType, assetType);
      assert.match(result.failure.constraint, new RegExp(`asset type "${assetType}"`));
    }
  });

  test('reports a required repeatable group instead of silently dropping it', () => {
    for (const container of ['slots', 'assets']) {
      const result = expandCreativeAssetDirectivesWithDiagnostics(
        {
          assets: {
            [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
              [container]: [
                {
                  asset_group_id: 'carousel',
                  item_type: 'repeatable_group',
                  required: true,
                  min_count: 2,
                  assets: [
                    {
                      asset_id: 'card_image',
                      asset_type: 'image',
                      required: true,
                    },
                  ],
                },
              ],
            },
          },
        },
        {},
        TEST_KIT
      );

      assert.strictEqual(result.ok, false, container);
      assert.strictEqual(result.failure.reason, 'fixture_unavailable', container);
      assert.strictEqual(result.failure.slotId, 'carousel', container);
      assert.strictEqual(result.failure.assetType, 'repeatable_group', container);
    }
  });

  test('reports an unavailable exact image dimension', () => {
    const result = expandCreativeAssetDirectivesWithDiagnostics(
      {
        assets: {
          [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
            width: 970,
            height: 250,
            slots: [{ asset_group_id: 'billboard', asset_type: 'image', required: true }],
          },
        },
      },
      {},
      TEST_KIT
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failure.reason, 'fixture_unavailable');
    assert.strictEqual(result.failure.slotId, 'billboard');
    assert.strictEqual(result.failure.assetType, 'image');
    assert.match(result.failure.constraint, /exact 970x250/);
  });

  test('reports text fixtures that violate declared slot constraints', () => {
    const result = expandCreativeAssetDirectivesWithDiagnostics(
      {
        assets: {
          [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
            slots: [
              {
                asset_group_id: 'headline',
                asset_type: 'text',
                required: true,
                requirements: { max_length: 5 },
              },
            ],
          },
        },
      },
      {},
      TEST_KIT
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failure.reason, 'fixture_unavailable');
    assert.match(result.failure.constraint, /maximum length 5/);
  });

  test('reports image requirements the fixture metadata cannot prove', () => {
    const result = expandCreativeAssetDirectivesWithDiagnostics(
      {
        assets: {
          [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
            width: 300,
            height: 250,
            slots: [
              {
                asset_group_id: 'image_main',
                asset_type: 'image',
                required: true,
                requirements: { max_file_size_kb: 25 },
              },
            ],
          },
        },
      },
      {},
      TEST_KIT
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failure.reason, 'fixture_unavailable');
    assert.match(result.failure.constraint, /max_file_size_kb/);
  });

  test('does not infer text semantics from unknown or substring-lookalike slot ids', () => {
    for (const slotId of ['legal_disclaimer', 'marketing_headline']) {
      const result = expandCreativeAssetDirectivesWithDiagnostics(
        {
          assets: {
            [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
              slots: [{ asset_group_id: slotId, asset_type: 'text', required: true }],
            },
          },
        },
        {},
        TEST_KIT
      );

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.failure.reason, 'fixture_unavailable');
      assert.strictEqual(result.failure.slotId, slotId);
      assert.strictEqual(result.failure.assetType, 'text');
      assert.match(result.failure.constraint, /no exact runner mapping/);
    }
  });

  test('expands a valid format with no required slots to an empty asset map', () => {
    const result = expandCreativeAssetDirectivesWithDiagnostics(
      {
        assets: {
          [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
            slots: [{ asset_group_id: 'optional_image', asset_type: 'image', required: false }],
          },
        },
      },
      {},
      TEST_KIT
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value.assets, {});
  });

  test('distinguishes missing format context and malformed directives from fixture gaps', () => {
    const missingFormat = expandCreativeAssetDirectivesWithDiagnostics(
      { assets: { [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: { id: 'missing_format' } } },
      {},
      TEST_KIT
    );
    assert.strictEqual(missingFormat.ok, false);
    assert.strictEqual(missingFormat.failure.reason, 'format_not_found');

    const malformed = expandCreativeAssetDirectivesWithDiagnostics(
      { assets: { [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: 'not-a-format' } },
      {},
      TEST_KIT
    );
    assert.strictEqual(malformed.ok, false);
    assert.strictEqual(malformed.failure.reason, 'malformed_directive');
  });

  test('preserves unvisited sibling data when a nested directive cannot expand', () => {
    const result = expandCreativeAssetDirectivesWithDiagnostics(
      {
        assets: {
          [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
            width: 300,
            height: 250,
            slots: [{ asset_group_id: 'image_main', asset_type: 'image', required: true }],
          },
          nested: {
            [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
              slots: [{ asset_group_id: 'video_main', asset_type: 'video', required: true }],
            },
          },
          metadata: { authored: true },
        },
      },
      {},
      TEST_KIT
    );

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.value.assets.metadata, { authored: true });
    assert.strictEqual(result.value.assets.image_main.url, 'https://assets.example/300x250.jpg');
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

  test('runner grades an unavailable seller asset not_applicable before transport', async () => {
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
    assert.strictEqual(step.passed, true);
    assert.strictEqual(step.skip_reason, 'fixture_unavailable');
    assert.strictEqual(step.skip.reason, 'fixture_unavailable');
    assert.match(step.skip.detail, /^creative_asset_fixture_unavailable:/);
    assert.match(step.skip.detail, /slot "video_main"/);
    assert.match(step.skip.detail, /asset type "video"/);
    assert.match(step.skip.detail, /constraint:/);
    assert.deepStrictEqual(step.validations, []);
    assert.strictEqual(result.failed_count, 0);
    assert.strictEqual(result.skipped_count, 1);
    assert.strictEqual(result.overall_passed, true);
  });

  test('missing format context remains a prerequisite failure', async () => {
    const calls = [];
    const storyboard = buildCreativeSyncStoryboard({
      context: {},
      directive: { agent_url: 'https://seller.example', id: 'missing_format' },
    });

    const result = await runStoryboard('https://seller.example/mcp', storyboard, runnerOptions(calls));

    assert.strictEqual(calls.length, 0);
    const step = result.phases[0].steps[0];
    assert.strictEqual(step.skipped, true);
    assert.strictEqual(step.passed, false);
    assert.strictEqual(step.skip_reason, 'prerequisite_failed');
    assert.strictEqual(step.skip.reason, 'prerequisite_failed');
    assert.strictEqual(step.validations[0].check, 'unresolved_substitution');
  });

  test('failed format producer leaves its consumer on the prerequisite-failure cascade', async () => {
    const calls = [];
    const storyboard = {
      id: 'creative_asset_failed_producer',
      version: '1.0.0',
      title: 'Creative asset failed producer',
      category: 'compliance',
      summary: '',
      narrative: '',
      agent: { interaction_model: '*', capabilities: [] },
      caller: { role: 'buyer_agent' },
      phases: [
        {
          id: 'discovery',
          title: 'Discovery',
          steps: [
            {
              id: 'formats',
              title: 'Discover formats',
              task: 'list_creative_formats',
              sample_request: {},
              context_outputs: [{ key: 'format_params', path: '$.formats[0]' }],
              validations: [],
            },
          ],
        },
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
    const options = runnerOptions(calls);
    options.agentTools = ['list_creative_formats', 'sync_creatives'];
    options._profile.tools = options.agentTools;
    options._client.executeTask = async name => {
      calls.push({ name });
      return { success: false, error: 'producer failed', data: {} };
    };

    const result = await runStoryboard('https://seller.example/mcp', storyboard, options);

    assert.deepStrictEqual(
      calls.map(call => call.name),
      ['list_creative_formats']
    );
    const consumer = result.phases[1].steps[0];
    assert.strictEqual(consumer.skipped, true);
    assert.strictEqual(consumer.skip_reason, 'prerequisite_failed');
    assert.strictEqual(consumer.skip.reason, 'prerequisite_failed');
  });

  test('preflights a captured format before intervening side effects and terminates without cascades', async () => {
    const calls = [];
    const storyboard = {
      id: 'creative_asset_early_preflight',
      version: '1.0.0',
      title: 'Creative asset early preflight',
      category: 'compliance',
      summary: '',
      narrative: '',
      agent: { interaction_model: '*', capabilities: [] },
      caller: { role: 'buyer_agent' },
      phases: [
        {
          id: 'setup',
          title: 'Setup',
          steps: [
            {
              id: 'formats',
              title: 'Discover a format',
              task: 'get_products',
              sample_request: {},
              context_outputs: [{ key: 'format_params', path: 'products[0].format_options[0].params' }],
              validations: [],
            },
            {
              id: 'create_buy',
              title: 'Create buy',
              task: 'create_media_buy',
              stateful: true,
              sample_request: {},
              validations: [],
            },
            {
              id: 'sync',
              title: 'Sync creative',
              task: 'sync_creatives',
              stateful: true,
              sample_request: {
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
        {
          id: 'cleanup',
          title: 'Cleanup',
          steps: [
            {
              id: 'cancel_buy',
              title: 'Cancel buy',
              task: 'update_media_buy',
              stateful: true,
              sample_request: {},
              validations: [],
            },
          ],
        },
      ],
    };
    const options = runnerOptions(calls);
    options.agentTools = ['get_products', 'create_media_buy', 'sync_creatives', 'update_media_buy'];
    options._profile.tools = options.agentTools;
    options._client.executeTask = async (name, params) => {
      calls.push({ name, params });
      if (name === 'get_products') {
        return {
          success: true,
          data: {
            products: [
              {
                format_options: [
                  {
                    params: {
                      slots: [{ asset_group_id: 'video_main', asset_type: 'video', required: true }],
                    },
                  },
                ],
              },
            ],
          },
        };
      }
      return { success: true, data: {} };
    };

    const result = await runStoryboard('https://seller.example/mcp', storyboard, options);

    assert.deepStrictEqual(
      calls.map(call => call.name),
      ['get_products']
    );
    assert.deepStrictEqual(
      result.phases[0].steps.map(step => step.step_id),
      ['formats', 'sync']
    );
    assert.strictEqual(result.phases[0].steps[1].skip.reason, 'fixture_unavailable');
    assert.deepStrictEqual(result.phases[1].steps, []);
    assert.strictEqual(
      result.phases.flatMap(phase => phase.steps).some(step => step.skip_reason === 'prerequisite_failed'),
      false
    );
    assert.strictEqual(result.passed_count, 1);
    assert.strictEqual(result.failed_count, 0);
    assert.strictEqual(result.skipped_count, 1);
    assert.strictEqual(result.overall_passed, true);
  });

  test('does not preflight directives in skip_if phases or steps gated by requires_tool', async () => {
    const calls = [];
    const unavailableRequest = {
      creatives: [
        {
          creative_id: 'creative-1',
          assets: {
            [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
              slots: [{ asset_group_id: 'video_main', asset_type: 'video', required: true }],
            },
          },
        },
      ],
    };
    const storyboard = {
      id: 'creative_asset_ineligible_preflight',
      version: '1.0.0',
      title: 'Creative asset ineligible preflight',
      category: 'compliance',
      summary: '',
      narrative: '',
      agent: { interaction_model: '*', capabilities: [] },
      caller: { role: 'buyer_agent' },
      phases: [
        {
          id: 'test_kit_skipped',
          title: 'Test-kit skipped',
          skip_if: 'test_kit.skip_creative',
          steps: [
            {
              id: 'skipped_sync',
              title: 'Skipped sync',
              task: 'sync_creatives',
              sample_request: unavailableRequest,
              validations: [],
            },
          ],
        },
        {
          id: 'tool_gated',
          title: 'Tool gated',
          steps: [
            {
              id: 'gated_sync',
              title: 'Gated sync',
              task: 'sync_creatives',
              requires_tool: 'creative_video_transformer',
              sample_request: unavailableRequest,
              validations: [],
            },
          ],
        },
        {
          id: 'runnable',
          title: 'Runnable',
          steps: [
            {
              id: 'list',
              title: 'List creatives',
              task: 'list_creatives',
              sample_request: {},
              validations: [],
            },
          ],
        },
      ],
    };
    const options = runnerOptions(calls);
    options.test_kit = { ...TEST_KIT, skip_creative: true };
    options.agentTools = ['sync_creatives', 'list_creatives'];
    options._profile.tools = options.agentTools;

    const result = await runStoryboard('https://seller.example/mcp', storyboard, options);

    assert.deepStrictEqual(
      calls.map(call => call.name),
      ['list_creatives']
    );
    assert.deepStrictEqual(result.phases[0].steps, []);
    assert.strictEqual(result.phases[1].steps[0].skip_reason, 'missing_tool');
    assert.strictEqual(
      result.phases.flatMap(phase => phase.steps).some(step => step.skip_reason === 'fixture_unavailable'),
      false
    );
  });

  test('does not let a missing requires_contract probe become fixture_unavailable', async () => {
    const calls = [];
    const storyboard = {
      id: 'creative_asset_contract_gate',
      version: '1.0.0',
      title: 'Creative asset contract gate',
      category: 'compliance',
      summary: '',
      narrative: '',
      agent: { interaction_model: '*', capabilities: [] },
      caller: { role: 'buyer_agent' },
      phases: [
        {
          id: 'rate_limit',
          title: 'Rate limit',
          steps: [
            {
              id: 'trip',
              title: 'Trip rate limit',
              task: 'expect_rate_limit_not_replayed',
              requires_contract: 'rate-abuse',
              rate_limit_trip: {
                trip_target_task: 'sync_creatives',
                trip_target_sample_request: {
                  creatives: [
                    {
                      creative_id: 'creative-1',
                      assets: {
                        [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: {
                          slots: [{ asset_group_id: 'video_main', asset_type: 'video', required: true }],
                        },
                      },
                    },
                  ],
                },
                max_attempts: 2,
                replay_max_wait_seconds: 1,
              },
              validations: [],
            },
          ],
        },
      ],
    };

    const result = await runStoryboard('https://seller.example/mcp', storyboard, runnerOptions(calls));

    assert.strictEqual(calls.length, 0);
    assert.strictEqual(result.phases[0].steps[0].skip_reason, 'missing_test_kit_contract');
    assert.strictEqual(result.phases[0].steps[0].skip.reason, 'unsatisfied_contract');
  });

  test('rate-limit trip target also grades an unavailable fixture pre-wire', async () => {
    const calls = [];
    const storyboard = {
      id: 'creative_asset_rate_limit_preflight',
      version: '1.0.0',
      title: 'Creative asset rate-limit preflight',
      category: 'compliance',
      summary: '',
      narrative: '',
      agent: { interaction_model: '*', capabilities: [] },
      caller: { role: 'buyer_agent' },
      context: {
        format_params: {
          slots: [{ asset_group_id: 'vast_main', asset_type: 'vast_tag', required: true }],
        },
      },
      phases: [
        {
          id: 'creative',
          title: 'Creative',
          steps: [
            {
              id: 'trip',
              title: 'Trip sync creatives rate limit',
              task: 'expect_rate_limit_not_replayed',
              rate_limit_trip: {
                trip_target_task: 'sync_creatives',
                trip_target_sample_request: {
                  account: { operator: 'seller.example' },
                  creatives: [
                    {
                      creative_id: 'creative-1',
                      format_kind: 'video',
                      assets: { [BUILD_ASSETS_FROM_FORMAT_DIRECTIVE]: '$context.format_params' },
                    },
                  ],
                },
                max_attempts: 50,
                replay_max_wait_seconds: 1,
              },
              validations: [],
            },
          ],
        },
      ],
    };

    const result = await runStoryboard('https://seller.example/mcp', storyboard, runnerOptions(calls));

    assert.strictEqual(calls.length, 0);
    const step = result.phases[0].steps[0];
    assert.strictEqual(step.passed, true);
    assert.strictEqual(step.skipped, true);
    assert.strictEqual(step.skip_reason, 'fixture_unavailable');
    assert.strictEqual(step.skip.reason, 'fixture_unavailable');
    assert.match(step.skip.detail, /slot "vast_main"/);
    assert.match(step.skip.detail, /asset type "vast_tag"/);
    assert.strictEqual(result.failed_count, 0);
    assert.strictEqual(result.skipped_count, 1);
    assert.strictEqual(result.overall_passed, true);
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
