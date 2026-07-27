const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { inlineCreativesForPackages, inlineCreativesForPackagesLegacy } = require('../../dist/lib/index.js');
const { preflightUpdateMediaBuy } = require('../../dist/lib/media-buy');

const IMAGE_FORMAT = { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' };
const VIDEO_FORMAT = { agent_url: 'https://creative.adcontextprotocol.org', id: 'video_standard_30s' };

const imageCreative = {
  creative_id: 'cre_image',
  name: 'Image',
  format_kind: 'image',
  assets: { image: { asset_type: 'image', url: 'https://cdn.example.com/image.png' } },
};

const videoCreative = {
  creative_id: 'cre_video',
  name: 'Video',
  format_kind: 'video_hosted',
  assets: { video: { asset_type: 'video', url: 'https://cdn.example.com/video.mp4' } },
};

describe('inlineCreativesForPackages', () => {
  test('projects compatible creatives into create_media_buy package payloads', () => {
    const packages = [
      {
        product_id: 'prod_display',
        pricing_option_id: 'cpm',
        budget: 1000,
        format_ids: [IMAGE_FORMAT],
      },
      {
        product_id: 'prod_video',
        pricing_option_id: 'cpm',
        budget: 2000,
        format_ids: [VIDEO_FORMAT],
      },
    ];

    const result = inlineCreativesForPackagesLegacy(packages, [imageCreative, videoCreative]);

    assert.deepEqual(
      result.map(pkg => pkg.creatives?.map(c => c.creative_id)),
      [['cre_image'], ['cre_video']]
    );
    assert.equal(result[0].creatives[0].format_id.id, IMAGE_FORMAT.id);
    assert.equal(result[0].creatives[0].format_kind, undefined);
    assert.equal(packages[0].creatives, undefined, 'input packages are not mutated');
  });

  test('keeps canonical creatives canonical until the client wire boundary', () => {
    const canonical = {
      creative_id: 'cre_canonical_image',
      name: 'Canonical image',
      format_kind: 'image',
      assets: { image: { asset_type: 'image', url: 'https://cdn.example.com/canonical.png' } },
    };
    const result = inlineCreativesForPackages([{ package_id: 'pkg_1', format_kind: 'image' }], [canonical]);

    assert.equal(result[0].creatives[0].format_id, undefined);
    assert.equal(result[0].creatives[0].format_kind, 'image');
    assert.equal(canonical.format_kind, 'image', 'input remains canonical');
  });

  test('preserves package assignment semantics with weight and placements', () => {
    const packages = [
      { package_id: 'pkg_1', product_id: 'prod_display', pricing_option_id: 'cpm', budget: 1000 },
      { package_id: 'pkg_2', product_id: 'prod_video', pricing_option_id: 'cpm', budget: 2000 },
    ];

    const result = inlineCreativesForPackages(packages, [imageCreative, videoCreative], {
      assignments: [
        { creative_id: 'cre_image', package_id: 'pkg_1', weight: 70, placement_ids: ['home_mrec'] },
        { creative_id: 'cre_video', package_id: 'pkg_2', weight: 30, placement_ids: ['pre_roll'] },
      ],
    });

    assert.deepEqual(result[0].creatives, [
      {
        ...imageCreative,
        weight: 70,
        placement_ids: ['home_mrec'],
      },
    ]);
    assert.deepEqual(result[1].creatives, [
      {
        ...videoCreative,
        weight: 30,
        placement_ids: ['pre_roll'],
      },
    ]);
    assert.equal(imageCreative.weight, undefined, 'input creatives are not mutated');
  });

  test('assignment delivery metadata replaces stale inline-only creative fields', () => {
    const creativeWithStaleRouting = {
      ...imageCreative,
      weight: 25,
      placement_refs: [{ publisher_domain: 'old.example', placement_id: 'old_placement' }],
      placement_ids: ['old_legacy'],
    };

    const result = inlineCreativesForPackages([{ package_id: 'pkg_1' }], [creativeWithStaleRouting], {
      assignments: [{ creative_id: 'cre_image', package_id: 'pkg_1', placement_ids: ['new_legacy'] }],
    });

    assert.deepEqual(result[0].creatives, [
      {
        ...imageCreative,
        placement_ids: ['new_legacy'],
      },
    ]);
    assert.deepEqual(
      creativeWithStaleRouting.placement_refs,
      [{ publisher_domain: 'old.example', placement_id: 'old_placement' }],
      'input creative routing metadata is not mutated'
    );
  });

  test('uses context.buyer_ref as the package assignment key for create payloads', () => {
    const result = inlineCreativesForPackages(
      [
        {
          product_id: 'prod_display',
          pricing_option_id: 'cpm',
          budget: 1000,
          context: { buyer_ref: 'buyer_pkg_1' },
        },
      ],
      [imageCreative],
      {
        assignments: [{ creative_id: 'cre_image', package_id: 'buyer_pkg_1' }],
      }
    );

    assert.deepEqual(
      result[0].creatives?.map(c => c.creative_id),
      ['cre_image']
    );
  });

  test('filters by canonical format kind and format option reference', () => {
    const nativeCreative = {
      creative_id: 'cre_native',
      name: 'Native',
      format_kind: 'native_in_feed',
      format_option_ref: { scope: 'product', format_option_id: 'native_feed' },
      assets: { title: { asset_type: 'text', content: 'Hello' } },
    };
    const imageKindCreative = {
      creative_id: 'cre_image_kind',
      name: 'Image Kind',
      format_kind: 'image',
      assets: { image: { asset_type: 'image', url: 'https://cdn.example.com/image.png' } },
    };

    const result = inlineCreativesForPackages(
      [
        { product_id: 'prod_native', pricing_option_id: 'cpm', budget: 1000, format_kind: 'native_in_feed' },
        {
          product_id: 'prod_native_feed',
          pricing_option_id: 'cpm',
          budget: 1000,
          format_option_refs: [{ format_option_id: 'native_feed', scope: 'product' }],
        },
        { product_id: 'prod_image', pricing_option_id: 'cpm', budget: 1000, format_kind: 'image' },
      ],
      [nativeCreative, imageKindCreative]
    );

    assert.deepEqual(
      result.map(pkg => pkg.creatives?.map(c => c.creative_id)),
      [['cre_native'], ['cre_native'], ['cre_image_kind']]
    );
  });

  test('does not treat format_kind alone as enough when package params conflict', () => {
    const largeImageCreative = {
      creative_id: 'cre_image_728x90',
      name: 'Image Leaderboard',
      format_kind: 'image',
      assets: {
        image: { asset_type: 'image', url: 'https://cdn.example.com/leaderboard.png', width: 728, height: 90 },
      },
    };

    const result = inlineCreativesForPackages(
      [
        {
          product_id: 'prod_mrec',
          pricing_option_id: 'cpm',
          budget: 1000,
          format_kind: 'image',
          params: { width: 300, height: 250 },
        },
      ],
      [largeImageCreative]
    );

    assert.equal(result[0].creatives, undefined);
  });

  test('does not match a conflicting canonical format option reference', () => {
    const nativeStoryCreative = {
      creative_id: 'cre_native_story',
      name: 'Native Story',
      format_kind: 'image',
      format_option_ref: { scope: 'product', format_option_id: 'native_story' },
      assets: { title: { asset_type: 'text', content: 'Hello' } },
    };

    const result = inlineCreativesForPackages(
      [
        {
          product_id: 'prod_native_feed',
          pricing_option_id: 'cpm',
          budget: 1000,
          format_option_refs: [{ scope: 'product', format_option_id: 'native_feed' }],
        },
      ],
      [nativeStoryCreative]
    );

    assert.equal(result[0].creatives, undefined);
  });

  test('honors open-ended duration range package params', () => {
    const sixtySecondVideo = {
      creative_id: 'cre_video_60s',
      name: 'Video 60s',
      format_kind: 'video_hosted',
      assets: {
        video: {
          asset_type: 'video',
          url: 'https://cdn.example.com/video-60s.mp4',
          width: 1920,
          height: 1080,
          duration_ms: 60000,
        },
      },
    };

    const result = inlineCreativesForPackages(
      [
        {
          product_id: 'prod_video_max_30s',
          pricing_option_id: 'cpm',
          budget: 1000,
          format_kind: 'video_hosted',
          params: { duration_ms_range: [null, 30000] },
        },
      ],
      [sixtySecondVideo]
    );

    assert.equal(result[0].creatives, undefined);
  });

  test('throws on assignment references that cannot be represented inline', () => {
    assert.throws(
      () =>
        inlineCreativesForPackages([{ package_id: 'pkg_1' }], [imageCreative], {
          assignments: [{ creative_id: 'missing', package_id: 'pkg_1' }],
        }),
      /unknown creative_id "missing"/
    );

    assert.throws(
      () =>
        inlineCreativesForPackages([{ package_id: 'pkg_1' }], [imageCreative], {
          assignments: [{ creative_id: 'cre_image', package_id: 'pkg_missing' }],
        }),
      /unknown package_id "pkg_missing"/
    );
  });

  test('throws when explicit assignments do not match package format selectors', () => {
    assert.throws(
      () =>
        inlineCreativesForPackagesLegacy([{ package_id: 'pkg_1', format_ids: [VIDEO_FORMAT] }], [imageCreative], {
          assignments: [{ creative_id: 'cre_image', package_id: 'pkg_1' }],
        }),
      /creative_id "cre_image" does not match package_id "pkg_1" format selectors/
    );

    const ignored = inlineCreativesForPackagesLegacy(
      [{ package_id: 'pkg_1', format_ids: [VIDEO_FORMAT] }],
      [imageCreative],
      {
        assignments: [{ creative_id: 'cre_image', package_id: 'pkg_1' }],
        onIncompatibleAssignment: 'ignore',
      }
    );
    assert.equal(ignored[0].creatives, undefined);
  });

  test('rejects legacy inputs and wire overrides on the canonical helper', () => {
    assert.throws(
      () => inlineCreativesForPackages([{ package_id: 'pkg_1', format_ids: [IMAGE_FORMAT] }], [imageCreative]),
      /does not accept legacy package format_ids/
    );
    assert.throws(
      () =>
        inlineCreativesForPackages(
          [{ package_id: 'pkg_1' }],
          [{ creative_id: 'cre_legacy', name: 'Legacy', format_id: IMAGE_FORMAT, assets: {} }]
        ),
      /does not accept legacy creative format_id/
    );
    assert.throws(
      () =>
        inlineCreativesForPackages([{ package_id: 'pkg_1' }], [imageCreative], { creativeFormatWireMode: 'legacy' }),
      /canonical-only/
    );
  });

  test('builds update_media_buy patches that preflight against replace_creative', () => {
    const patch = {
      packages: inlineCreativesForPackages([{ package_id: 'pkg_1' }], [imageCreative], {
        assignments: [{ creative_id: 'cre_image', package_id: 'pkg_1' }],
      }),
    };
    const allowed = preflightUpdateMediaBuy(
      {
        media_buy_id: 'mb_1',
        packages: [{ package_id: 'pkg_1' }],
        available_actions: [{ action: 'replace_creative', mode: 'self_serve' }],
      },
      patch
    );
    const denied = preflightUpdateMediaBuy(
      {
        media_buy_id: 'mb_1',
        packages: [{ package_id: 'pkg_1' }],
        available_actions: [{ action: 'pause', mode: 'self_serve' }],
      },
      patch
    );

    assert.equal(allowed.ok, true);
    assert.equal(allowed.actions[0].action, 'replace_creative');
    assert.equal(denied.ok, false);
    assert.equal(denied.denials[0].action, 'replace_creative');
  });
});
