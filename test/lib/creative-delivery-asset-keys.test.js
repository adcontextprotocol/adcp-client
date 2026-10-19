const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  lookupV1Format,
  projectCreativeForDelivery,
  projectMediaBuyCreativesForDelivery,
  projectSyncCreativesForDelivery,
} = require('../../dist/lib/v2/projection/index.js');

const formatId = { agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250_image' };

function product(ref = formatId) {
  return {
    product_id: 'display',
    format_options: [{ format_kind: 'image', params: { width: 300, height: 250 }, format_option_id: 'mrec' }],
    format_ids: [ref],
  };
}

function creative() {
  return {
    creative_id: 'c1',
    name: 'Display image',
    format_kind: 'image',
    params: { width: 300, height: 250 },
    format_option_ref: { scope: 'product', format_option_id: 'mrec' },
    assets: {
      image: { asset_type: 'image', url: 'https://cdn.example/banner.png', width: 300, height: 250 },
      landing_page_url: { asset_type: 'url', url_type: 'clickthrough', url: 'https://example.com' },
    },
  };
}

function project(input, definition) {
  return projectCreativeForDelivery(
    input,
    product(definition?.format_id),
    'legacy',
    'sync_creatives',
    undefined,
    undefined,
    definition ? [definition] : undefined
  );
}

describe('legacy creative asset keys (#3347)', () => {
  for (const wireMode of ['legacy', 'unknown']) {
    test(`${wireMode} wire uses reference-format asset IDs without mutating the creative or catalog`, () => {
      const input = creative();
      const selected = product();
      const definition = lookupV1Format(formatId);
      const original = structuredClone({ input, selected, definition });
      const result = projectCreativeForDelivery(input, selected, wireMode, 'sync_creatives');
      assert.deepEqual(result.format_id, formatId);
      assert.equal(result.format_kind, undefined);
      assert.equal(result.format_option_ref, undefined);
      assert.deepEqual(result.assets, { banner_image: input.assets.image, click_url: input.assets.landing_page_url });
      assert.equal(result.assets.banner_image, input.assets.image);
      assert.equal(result.assets.click_url, input.assets.landing_page_url);
      assert.deepEqual({ input, selected, definition }, original);
    });
  }

  test('URL roles and tracker events select their respective slots', () => {
    const input = creative();
    Object.assign(input.assets, {
      impression: { asset_type: 'pixel_tracker', event: 'impression', url: 'https://track.example/impression' },
      viewable: { asset_type: 'pixel_tracker', event: 'viewable_mrc_50', url: 'https://track.example/viewable' },
      click: { asset_type: 'pixel_tracker', event: 'click', url: 'https://track.example/click' },
      other_url: { asset_type: 'url', url_type: 'privacy_policy', url: 'https://example.com/privacy' },
      other_tracker: { asset_type: 'pixel_tracker', event: 'complete', url: 'https://track.example/complete' },
      unknown_event: { asset_type: 'pixel_tracker', url: 'https://track.example/unknown' },
    });
    assert.deepEqual(project(input).assets, {
      banner_image: input.assets.image,
      click_url: input.assets.landing_page_url,
      impression_tracker: input.assets.impression,
      viewability_tracker: input.assets.viewable,
      click_tracker: input.assets.click,
      other_url: input.assets.other_url,
      other_tracker: input.assets.other_tracker,
      unknown_event: input.assets.unknown_event,
    });
  });

  test('declared keys take precedence even when they appear after canonical keys', () => {
    const input = creative();
    input.assets.banner_image = { ...input.assets.image, url: 'https://cdn.example/explicit.png' };
    input.assets.click_url = { ...input.assets.landing_page_url, url: 'https://example.com/explicit' };
    assert.equal(project(input).assets, input.assets);
  });

  test('already projected creatives keep their asset keys on repeated delivery', () => {
    const legacy = project(creative());
    const again = projectCreativeForDelivery(legacy, product(), 'legacy');
    assert.deepEqual(again, legacy);
    assert.equal(again.assets, legacy.assets);
  });

  test('stored legacy identities and explicit resolver routes also project canonical asset keys', () => {
    const input = creative();
    const { format_kind, format_option_ref, ...stored } = input;
    const expected = { banner_image: input.assets.image, click_url: input.assets.landing_page_url };
    assert.deepEqual(projectCreativeForDelivery({ ...stored, format_id: formatId }, {}, 'legacy').assets, expected);
    assert.deepEqual(
      projectCreativeForDelivery({ ...stored, format_kind }, {}, 'legacy', 'sync_creatives', undefined, () => formatId)
        .assets,
      expected
    );
  });

  test('multiple assets competing for one slot are all retained regardless of order', () => {
    for (const reverse of [false, true]) {
      const input = creative();
      delete input.assets.landing_page_url;
      input.assets.another_image = { ...input.assets.image, url: 'https://cdn.example/another.png' };
      if (reverse) input.assets = Object.fromEntries(Object.entries(input.assets).reverse());
      assert.equal(project(input).assets, input.assets);
    }
  });

  test('multiple matching slots remain ambiguous until a declared key occupies one', () => {
    const definition = {
      format_id: { agent_url: 'https://seller.example/formats', id: 'two-images' },
      assets: [
        { asset_id: 'hero', asset_type: 'image' },
        { asset_id: 'logo', asset_type: 'image' },
      ],
    };
    const input = creative();
    assert.equal(project(input, definition).assets, input.assets);
    input.assets.logo = { ...input.assets.image, url: 'https://cdn.example/logo.png' };
    assert.deepEqual(project(input, definition).assets, {
      hero: input.assets.image,
      logo: input.assets.logo,
      landing_page_url: input.assets.landing_page_url,
    });
  });

  test('caller definitions override the catalog and distinguish URL roles', () => {
    const definition = {
      format_id: formatId,
      assets: [
        { asset_id: 'seller_image', asset_type: 'image' },
        { asset_id: 'destination', asset_type: 'url', requirements: { url_type: 'clickthrough' } },
        { asset_id: 'privacy', asset_type: 'url', requirements: { url_type: 'privacy_policy' } },
      ],
    };
    const input = creative();
    input.assets.privacy_policy = { asset_type: 'url', url_type: 'privacy_policy', url: 'https://example.com/privacy' };
    assert.deepEqual(project(input, definition).assets, {
      seller_image: input.assets.image,
      destination: input.assets.landing_page_url,
      privacy: input.assets.privacy_policy,
    });
  });

  test('unknown owners never inherit reference asset IDs from a matching bare format ID', () => {
    const input = creative();
    const selected = product({ ...formatId, agent_url: 'https://seller.example/formats' });
    const result = projectCreativeForDelivery(input, selected, 'legacy');
    assert.equal(result.assets, input.assets);
    assert.deepEqual(result.format_id, selected.format_ids[0]);
  });

  test('unrelated supplied definitions do not rename assets', () => {
    const input = creative();
    const selected = product({ ...formatId, agent_url: 'https://seller.example/formats' });
    const result = projectCreativeForDelivery(input, selected, 'legacy', undefined, undefined, undefined, [
      lookupV1Format(formatId),
    ]);
    assert.equal(result.assets, input.assets);
  });

  test('missing or ambiguous supplied slot definitions preserve asset keys', () => {
    const input = creative();
    assert.equal(project(input, { format_id: formatId }).assets, input.assets);
    assert.equal(project(input, { format_id: formatId, assets: [] }).assets, input.assets);
    assert.equal(
      projectCreativeForDelivery(input, product(), 'legacy', undefined, undefined, undefined, [
        lookupV1Format(formatId),
        { format_id: formatId, assets: [{ asset_id: 'different_image', asset_type: 'image' }] },
      ]).assets,
      input.assets
    );
  });

  test('canonical delivery preserves canonical asset keys', () => {
    const input = creative();
    assert.deepEqual(projectCreativeForDelivery(input, product(), 'canonical'), input);
  });

  test('sync and inline create/update apply the same asset projection', () => {
    const input = creative();
    const expected = { banner_image: input.assets.image, click_url: input.assets.landing_page_url };
    const sync = projectSyncCreativesForDelivery({ creatives: [input] }, [product()], 'legacy');
    assert.deepEqual(sync.creatives[0].assets, expected);
    for (const [key, operation] of [
      ['packages', 'create_media_buy'],
      ['packages', 'update_media_buy'],
      ['new_packages', 'update_media_buy'],
    ]) {
      const request = {
        [key]: [{ ...product(), format_option_refs: [input.format_option_ref], creatives: [input] }],
      };
      const original = structuredClone(request);
      const result = projectMediaBuyCreativesForDelivery(request, 'legacy', operation);
      assert.deepEqual(result[key][0].creatives[0].assets, expected);
      assert.deepEqual(request, original);
    }
  });

  test('sync and inline wrappers forward caller-supplied definitions', () => {
    const definition = {
      format_id: { agent_url: 'https://seller.example/formats', id: 'seller_mrec' },
      assets: [{ asset_id: 'seller_image', asset_type: 'image' }],
    };
    const input = creative();
    const selected = product(definition.format_id);
    const original = structuredClone({ input, selected, definition });
    const expected = { seller_image: input.assets.image, landing_page_url: input.assets.landing_page_url };
    const sync = projectSyncCreativesForDelivery({ creatives: [input] }, [selected], 'legacy', undefined, undefined, [
      definition,
    ]);
    const inline = projectMediaBuyCreativesForDelivery(
      { packages: [{ ...selected, creatives: [input] }] },
      'legacy',
      'create_media_buy',
      undefined,
      undefined,
      [definition]
    );
    assert.deepEqual(sync.creatives[0].assets, expected);
    assert.deepEqual(inline.packages[0].creatives[0].assets, expected);
    assert.deepEqual({ input, selected, definition }, original);
  });
});
