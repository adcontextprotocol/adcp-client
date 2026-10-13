const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CreativeFormatProjectionError,
  projectMediaBuyCreativesForDelivery,
  projectSyncCreativesForDelivery,
} = require('../../dist/lib/v2/projection/index.js');
const { migratedFormatOptionId } = require('../../dist/lib/v2/projection/v1-to-v2.js');

const AGENT_URL = 'https://creative.adcontextprotocol.org';

function sized(id, width, height) {
  return { agent_url: AGENT_URL, id, width, height };
}

function html5Creative(width, height) {
  return {
    creative_id: `creative_${width}x${height}`,
    name: `Banner ${width}x${height}`,
    format_kind: 'html5',
    format_parameters: { width, height },
    assets: { html: { asset_type: 'html', snippet: '<div>ad</div>' } },
  };
}

function projectLegacy(request) {
  return projectMediaBuyCreativesForDelivery(request, 'legacy', 'create_media_buy');
}

function bare(id, agent_url = AGENT_URL) {
  return { agent_url, id };
}

function syncLegacy(creative, format_ids) {
  return projectSyncCreativesForDelivery(
    {
      creatives: [creative],
      assignments: [{ creative_id: creative.creative_id, package_id: 'package_1' }],
    },
    [{ package_id: 'package_1', format_ids }],
    'legacy'
  ).creatives[0];
}

describe('creative delivery picks the most constrained legacy ref', () => {
  test('prefers the fixed-size legacy id when the seller also lists the generic id at the same size', () => {
    const projected = projectLegacy({
      packages: [
        {
          product_id: 'seller-product',
          format_ids: [sized('display_html', 300, 250), sized('display_300x250_html', 300, 250)],
          creatives: [html5Creative(300, 250)],
        },
      ],
    });

    const creative = projected.packages[0].creatives[0];
    assert.deepEqual(creative.format_id, sized('display_300x250_html', 300, 250));
    assert.equal(creative.format_kind, undefined);
  });

  test('narrows a multi-size product to the size the creative declares', () => {
    const sizes = [
      [160, 600],
      [300, 250],
      [300, 600],
      [728, 90],
      [970, 250],
    ];
    const projected = projectLegacy({
      packages: [
        {
          product_id: 'multi-size',
          format_ids: sizes.flatMap(([w, h]) => [sized('display_html', w, h), sized(`display_${w}x${h}_html`, w, h)]),
          creatives: [html5Creative(728, 90)],
        },
      ],
    });

    assert.deepEqual(projected.packages[0].creatives[0].format_id, sized('display_728x90_html', 728, 90));
  });

  test('prefers a ref that pins the creative size over a dimensionless generic ref', () => {
    const projected = projectLegacy({
      packages: [
        {
          product_id: 'generic-plus-sized',
          format_ids: [{ agent_url: AGENT_URL, id: 'display_html' }, sized('display_300x250_html', 300, 250)],
          creatives: [html5Creative(300, 250)],
        },
      ],
    });

    assert.deepEqual(projected.packages[0].creatives[0].format_id, sized('display_300x250_html', 300, 250));
  });

  test('still fails closed when the creative declares no size and the refs differ in size', () => {
    const creative = html5Creative(300, 250);
    delete creative.format_parameters;
    assert.throws(
      () =>
        projectLegacy({
          packages: [
            {
              product_id: 'two-sizes',
              format_ids: [sized('display_300x250_html', 300, 250), sized('display_728x90_html', 728, 90)],
              creatives: [creative],
            },
          ],
        }),
      CreativeFormatProjectionError
    );
  });

  test('matches a creative pinned to a synthetic option id against the legacy ref it was minted from', () => {
    const sizedRef = sized('display_300x250_html', 300, 250);
    const sizes = [
      [160, 600],
      [300, 250],
      [300, 600],
      [320, 50],
      [728, 90],
      [970, 250],
    ];
    const creative = {
      ...html5Creative(300, 250),
      creative_id: 'pinned_300x250',
      format_option_ref: { scope: 'product', format_option_id: migratedFormatOptionId(sizedRef) },
    };
    const projected = projectLegacy({
      packages: [
        {
          product_id: 'legacy-only-with-pin',
          format_ids: [
            { agent_url: AGENT_URL, id: 'display_html' },
            ...sizes.map(([w, h]) => sized(`display_${w}x${h}_html`, w, h)),
          ],
          creatives: [creative],
        },
      ],
    });

    const out = projected.packages[0].creatives[0];
    assert.deepEqual(out.format_id, sizedRef);
    assert.equal(out.format_option_ref, undefined);
  });

  test('fails closed when a pinned creative names no legacy ref the product advertises', () => {
    const creative = {
      ...html5Creative(300, 250),
      creative_id: 'pinned_elsewhere',
      format_option_ref: { scope: 'product', format_option_id: 'seller_authored_option' },
    };
    assert.throws(
      () =>
        projectLegacy({
          packages: [
            {
              product_id: 'legacy-only',
              format_ids: [sized('display_html', 300, 250), sized('display_300x250_html', 300, 250)],
              creatives: [creative],
            },
          ],
        }),
      err => err instanceof CreativeFormatProjectionError && /pinned to a format option/.test(err.message)
    );
  });

  test('leaves canonical wire mode untouched', () => {
    const request = {
      packages: [{ product_id: 'canonical-seller', creatives: [html5Creative(300, 250)] }],
    };
    const projected = projectMediaBuyCreativesForDelivery(request, 'canonical', 'create_media_buy');
    assert.equal(projected.packages[0].creatives[0].format_kind, 'html5');
    assert.equal(projected.packages[0].creatives[0].format_id, undefined);
  });
});

describe('creative delivery matches dimensions from catalog-backed bare IDs (#3230)', () => {
  const sizes = [
    [300, 250],
    [300, 600],
    [728, 90],
    [970, 250],
    [336, 280],
    [160, 600],
  ];
  const formatIds = [
    ...sizes.flatMap(([width, height]) => [
      bare(`display_${width}x${height}_image`),
      bare(`display_${width}x${height}_html`),
    ]),
    bare('display_320x50_image'),
  ];

  for (const [width, height] of sizes) {
    test(`sync_creatives selects only the HTML ref for ${width}x${height}`, () => {
      const creative = html5Creative(width, height);
      const original = structuredClone(creative);
      const projected = syncLegacy(creative, formatIds);

      assert.deepEqual(projected.format_id, bare(`display_${width}x${height}_html`));
      assert.deepEqual(projected.format_parameters, { width, height });
      assert.equal(projected.format_kind, undefined);
      assert.deepEqual(creative, original);
      assert.ok(formatIds.every(ref => ref.width === undefined && ref.height === undefined));
    });
  }

  for (const operation of ['create_media_buy', 'update_media_buy']) {
    test(`${operation} selects the same sized bare ref for inline creatives`, () => {
      const projected = projectMediaBuyCreativesForDelivery(
        {
          packages: [{ product_id: 'multi-size', format_ids: formatIds, creatives: [html5Creative(300, 250)] }],
        },
        'legacy',
        operation
      );
      assert.deepEqual(projected.packages[0].creatives[0].format_id, bare('display_300x250_html'));
    });
  }

  test('compares explicit and catalog dimensions together and prefers the fixed-size ID', () => {
    const projected = syncLegacy(html5Creative(300, 250), [
      sized('display_html', 300, 250),
      bare('display_300x250_html'),
      sized('display_728x90_html', 728, 90),
    ]);
    assert.deepEqual(projected.format_id, bare('display_300x250_html'));
  });

  test('preserves explicit dimensions on parameterized refs', () => {
    const projected = syncLegacy(html5Creative(320, 50), [
      sized('display_html', 320, 50),
      bare('display_300x250_html'),
    ]);
    assert.deepEqual(projected.format_id, sized('display_html', 320, 50));
  });

  test('preserves a seller-owned creative-agent URL when standard IDs are aliases', () => {
    const sellerAgentUrl = 'https://creative.example.com';
    const sellerRefs = formatIds.map(ref => bare(ref.id, sellerAgentUrl));
    const projected = syncLegacy(html5Creative(300, 250), sellerRefs);
    assert.deepEqual(projected.format_id, bare('display_300x250_html', sellerAgentUrl));
  });

  test('refuses a multi-size catalog without creative dimensions', () => {
    const creative = html5Creative(300, 250);
    delete creative.format_parameters;
    assert.throws(() => syncLegacy(creative, formatIds), CreativeFormatProjectionError);
  });

  test('refuses multiple catalog refs when none matches the creative dimensions', () => {
    assert.throws(() => syncLegacy(html5Creative(320, 50), formatIds), CreativeFormatProjectionError);
  });

  test('refuses even a single catalog ref that contradicts the creative dimensions', () => {
    assert.throws(
      () => syncLegacy(html5Creative(728, 90), [bare('display_300x250_html')]),
      CreativeFormatProjectionError
    );
  });

  test('refuses a single explicitly sized ref that contradicts the creative dimensions', () => {
    assert.throws(
      () => syncLegacy(html5Creative(728, 90), [sized('display_html', 300, 250)]),
      CreativeFormatProjectionError
    );
  });

  test('refuses a single ref whose explicit duration contradicts the creative duration', () => {
    const ref = { ...bare('video_standard_30s'), duration_ms: 30000 };
    const creative = {
      creative_id: 'video_30s',
      name: 'Video 30s',
      format_kind: 'video_hosted',
      format_parameters: { duration_ms: 30000 },
      assets: { video: { asset_type: 'video', url: 'https://cdn.example.com/video.mp4' } },
    };
    assert.deepEqual(syncLegacy(creative, [ref]).format_id, ref);
    assert.throws(
      () => syncLegacy({ ...creative, creative_id: 'video_60s', format_parameters: { duration_ms: 60000 } }, [ref]),
      CreativeFormatProjectionError
    );
  });

  test('refuses multiple matching refs routed through different creative agents', () => {
    assert.throws(
      () =>
        syncLegacy(html5Creative(300, 250), [
          bare('display_300x250_html'),
          bare('display_300x250_html', 'https://creative.example.com'),
        ]),
      CreativeFormatProjectionError
    );
  });

  test('refuses partial dimensions that match more than one size', () => {
    const creative = html5Creative(300, 250);
    delete creative.format_parameters.height;
    assert.throws(() => syncLegacy(creative, formatIds), CreativeFormatProjectionError);
  });

  test('does not infer dimensions from uncatalogued IDs that look sized', () => {
    const creative = html5Creative(310, 210);
    assert.throws(
      () =>
        projectSyncCreativesForDelivery(
          { creatives: [creative] },
          [{ format_kind: 'html5', format_ids: [bare('display_310x210_html'), bare('display_620x420_html')] }],
          'legacy'
        ),
      CreativeFormatProjectionError
    );
  });
});
