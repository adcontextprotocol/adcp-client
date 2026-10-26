// A canonical inline-markup display_tag projected onto an HTML-markup legacy
// format must not carry AdCP 3.3 rendered dimensions (adcp-client#3436).
// Cases follow the AdCP HTML-markup projection vectors
// (adcontextprotocol/adcp static/test-vectors/html-markup-legacy-projection.json,
// adcontextprotocol/adcp#8339).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CreativeFormatProjectionError,
  projectCreativeForDelivery,
  projectMediaBuyCreativesForDelivery,
  projectSyncCreativesForDelivery,
} = require('../../dist/lib/v2/projection/index.js');

const AAO = 'https://creative.adcontextprotocol.org/';
const MARKUP =
  '<ins class="dcmads" style="display:inline-block;width:300px;height:250px" data-dcm-placement="N0000.0000ACME/B0000000.000000000" data-dcm-rendering-mode="script"><script src="https://ads.acme.example/dcmads.js"></script></ins>';
const SIZED_REFS = ['display_300x250_html', 'display_300x600_html', 'display_320x50_html'];

function refs(...ids) {
  return { format_ids: ids.map(id => ({ agent_url: AAO, id })) };
}

function inlineMarkup(extra = {}, creativeExtra = {}) {
  return {
    creative_id: 'c1',
    name: 'Banner',
    format_kind: 'display_tag',
    assets: {
      html_creative: {
        asset_type: 'display_tag',
        delivery_type: 'inline_markup',
        markup_type: 'standard',
        markup: MARKUP,
        ...extra,
      },
    },
    ...creativeExtra,
  };
}

describe('legacy HTML projection omits AdCP 3.3 rendered dimensions (#3436)', () => {
  test('vector inline-markup-selects-the-exact-sized-legacy-ref', () => {
    const creative = inlineMarkup({ width: 300, height: 250 });
    const before = structuredClone(creative);
    const projected = projectCreativeForDelivery(creative, refs(...SIZED_REFS), 'legacy');
    assert.deepEqual(projected, {
      creative_id: 'c1',
      name: 'Banner',
      format_id: { agent_url: AAO, id: 'display_300x250_html' },
      assets: { html_creative: { asset_type: 'html', content: MARKUP } },
    });
    assert.deepEqual(creative, before, 'the caller creative is not mutated');
  });

  test('vector unsized-inline-markup-selects-the-unsized-legacy-ref is unchanged', () => {
    const projected = projectCreativeForDelivery(inlineMarkup(), refs('display_html'), 'legacy');
    assert.deepEqual(projected.format_id, { agent_url: AAO, id: 'display_html' });
    assert.deepEqual(projected.assets, { html_creative: { asset_type: 'html', content: MARKUP } });
  });

  test('responsive sizes are dropped as well', () => {
    const projected = projectCreativeForDelivery(
      inlineMarkup({ sizes: [{ width: 320, height: 50 }] }),
      refs(...SIZED_REFS),
      'legacy'
    );
    assert.equal(projected.format_id.id, 'display_320x50_html');
    assert.deepEqual(projected.assets, { html_creative: { asset_type: 'html', content: MARKUP } });
  });

  test('a sized creative on the unsized display_html ref carries no dimensions', () => {
    const projected = projectCreativeForDelivery(
      inlineMarkup({ width: 300, height: 250 }),
      refs('display_html'),
      'legacy'
    );
    assert.equal(projected.format_id.id, 'display_html');
    assert.deepEqual(projected.assets, { html_creative: { asset_type: 'html', content: MARKUP } });
  });

  test('provenance, other assets and creative fields are carried unchanged', () => {
    const provenance = { digital_source_type: 'digital_capture', declared_by: { role: 'agency' } };
    const creative = inlineMarkup(
      { width: 300, height: 600, provenance },
      { weight: 40, placement_ids: ['atf'], tags: ['spring'], provenance }
    );
    creative.assets.click_tracker = { asset_type: 'url', url_type: 'tracker_pixel', url: 'https://t.example/c' };
    const projected = projectCreativeForDelivery(creative, refs(...SIZED_REFS), 'legacy');
    assert.deepEqual(projected, {
      creative_id: 'c1',
      name: 'Banner',
      weight: 40,
      placement_ids: ['atf'],
      tags: ['spring'],
      provenance,
      format_id: { agent_url: AAO, id: 'display_300x600_html' },
      assets: {
        html_creative: { asset_type: 'html', content: MARKUP, provenance },
        click_tracker: creative.assets.click_tracker,
      },
    });
  });

  test('sync_creatives and media-buy projections emit the same legacy asset', () => {
    const creative = inlineMarkup({ width: 320, height: 50 });
    const expected = { html_creative: { asset_type: 'html', content: MARKUP } };
    const synced = projectSyncCreativesForDelivery({ creatives: [creative] }, [refs(...SIZED_REFS)], 'legacy')
      .creatives[0];
    assert.equal(synced.format_id.id, 'display_320x50_html');
    assert.deepEqual(synced.assets, expected);
    for (const operation of ['create_media_buy', 'update_media_buy']) {
      const inline = projectMediaBuyCreativesForDelivery(
        { packages: [{ package_id: 'p1', product_id: 'html-sizes', ...refs(...SIZED_REFS), creatives: [creative] }] },
        'legacy',
        operation
      ).packages[0].creatives[0];
      assert.equal(inline.format_id.id, 'display_320x50_html');
      assert.deepEqual(inline.assets, expected);
    }
  });
});

describe('legacy HTML ref selection by size is unchanged (#3436)', () => {
  for (const id of SIZED_REFS) {
    const [, width, height] = /_(\d+)x(\d+)_/.exec(id).map(Number);
    test(`asset size ${width}x${height} selects ${id}`, () => {
      assert.equal(
        projectCreativeForDelivery(inlineMarkup({ width, height }), refs(...SIZED_REFS), 'legacy').format_id.id,
        id
      );
    });
    test(`format_parameters ${width}x${height} select ${id}`, () => {
      const projected = projectCreativeForDelivery(
        inlineMarkup({}, { format_parameters: { width, height } }),
        refs(...SIZED_REFS),
        'legacy'
      );
      assert.equal(projected.format_id.id, id);
      assert.deepEqual(projected.format_parameters, { width, height });
    });
  }

  test('format_parameters take precedence over the asset size', () => {
    const projected = projectCreativeForDelivery(
      inlineMarkup({ width: 300, height: 250 }, { format_parameters: { width: 300, height: 600 } }),
      refs(...SIZED_REFS),
      'legacy'
    );
    assert.equal(projected.format_id.id, 'display_300x600_html');
  });

  for (const [name, extra] of [
    ['unsized-inline-markup-does-not-prove-a-fixed-size', {}],
    ['size-without-a-legacy-candidate-fails-closed', { width: 728, height: 90 }],
  ]) {
    test(`vector ${name} still fails closed`, () => {
      assert.throws(
        () =>
          projectCreativeForDelivery(
            inlineMarkup(extra),
            refs('display_300x250_html', 'display_300x600_html'),
            'legacy'
          ),
        CreativeFormatProjectionError
      );
    });
  }
});

describe('canonical delivery keeps AdCP 3.3 rendered dimensions (#3436)', () => {
  test('a canonical inline-markup creative is unchanged on the canonical wire', () => {
    const creative = inlineMarkup({ width: 300, height: 250 });
    const projected = projectCreativeForDelivery(creative, refs(...SIZED_REFS), 'canonical');
    assert.deepEqual(projected.assets, creative.assets);
    assert.equal(projected.format_kind, 'display_tag');
  });

  test('the canonical read of a legacy html_creative carries its own size and invents none', () => {
    const legacy = size => ({
      creative_id: 'legacy_html',
      name: 'Legacy HTML',
      format_id: { agent_url: AAO, id: 'display_300x250_html' },
      assets: { html_creative: { asset_type: 'html', content: MARKUP, ...size } },
    });
    const read = size => projectCreativeForDelivery(legacy(size), {}, 'canonical', 'list_creatives').assets;
    const markup = {
      asset_type: 'display_tag',
      delivery_type: 'inline_markup',
      markup_type: 'standard',
      markup: MARKUP,
    };
    // The size the format ref implies is not copied onto the asset.
    assert.deepEqual(read({}), { html_creative: markup });
    // Rendered dimensions the asset carries move to the same 3.3 fields on display_tag.
    assert.deepEqual(read({ width: 300, height: 250 }), { html_creative: { ...markup, width: 300, height: 250 } });
  });
});
