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

// The AAO `display_html` / `display_WxH_html` formats take HTML markup, which
// canonically is display_tag inline markup, not an html5 zip (adcp#8339).
function markupCreative(width, height) {
  return {
    creative_id: `creative_${width}x${height}`,
    name: `Banner ${width}x${height}`,
    format_kind: 'display_tag',
    format_parameters: { width, height },
    assets: {
      html_creative: {
        asset_type: 'display_tag',
        delivery_type: 'inline_markup',
        markup_type: 'standard',
        markup: '<div>ad</div>',
      },
    },
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
          creatives: [markupCreative(300, 250)],
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
          creatives: [markupCreative(728, 90)],
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
          creatives: [markupCreative(300, 250)],
        },
      ],
    });

    assert.deepEqual(projected.packages[0].creatives[0].format_id, sized('display_300x250_html', 300, 250));
  });

  test('still fails closed when the creative declares no size and the refs differ in size', () => {
    const creative = markupCreative(300, 250);
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
      ...markupCreative(300, 250),
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
      ...markupCreative(300, 250),
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
      packages: [{ product_id: 'canonical-seller', creatives: [markupCreative(300, 250)] }],
    };
    const projected = projectMediaBuyCreativesForDelivery(request, 'canonical', 'create_media_buy');
    assert.equal(projected.packages[0].creatives[0].format_kind, 'display_tag');
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
      const creative = markupCreative(width, height);
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
          packages: [{ product_id: 'multi-size', format_ids: formatIds, creatives: [markupCreative(300, 250)] }],
        },
        'legacy',
        operation
      );
      assert.deepEqual(projected.packages[0].creatives[0].format_id, bare('display_300x250_html'));
    });
  }

  test('compares explicit and catalog dimensions together and prefers the fixed-size ID', () => {
    const projected = syncLegacy(markupCreative(300, 250), [
      sized('display_html', 300, 250),
      bare('display_300x250_html'),
      sized('display_728x90_html', 728, 90),
    ]);
    assert.deepEqual(projected.format_id, bare('display_300x250_html'));
  });

  test('preserves explicit dimensions on parameterized refs', () => {
    const projected = syncLegacy(markupCreative(320, 50), [
      sized('display_html', 320, 50),
      bare('display_300x250_html'),
    ]);
    assert.deepEqual(projected.format_id, sized('display_html', 320, 50));
  });

  for (const sourceKey of ['html_creative', 'serving_tag']) {
    test(`preserves seller-owned alias URLs and converts ${sourceKey} to legacy HTML`, () => {
      const sellerAgentUrl = 'https://creative.example.com';
      const sellerRefs = formatIds.map(ref => bare(ref.id, sellerAgentUrl));
      const creative = markupCreative(300, 250);
      creative.assets = { [sourceKey]: creative.assets.html_creative };
      const original = structuredClone(creative);
      const projected = syncLegacy(creative, sellerRefs);
      assert.deepEqual(projected.format_id, bare('display_300x250_html', sellerAgentUrl));
      assert.deepEqual(projected.assets, { [sourceKey]: { asset_type: 'html', content: '<div>ad</div>' } });
      assert.deepEqual(creative, original);

      for (const operation of ['create_media_buy', 'update_media_buy']) {
        const inline = projectMediaBuyCreativesForDelivery(
          { packages: [{ product_id: 'seller-owned', format_ids: sellerRefs, creatives: [creative] }] },
          'legacy',
          operation
        ).packages[0].creatives[0];
        assert.deepEqual(inline.format_id, projected.format_id);
        assert.deepEqual(inline.assets, projected.assets);
      }
    });
  }

  test('refuses a multi-size catalog without creative dimensions', () => {
    const creative = markupCreative(300, 250);
    delete creative.format_parameters;
    assert.throws(() => syncLegacy(creative, formatIds), CreativeFormatProjectionError);
  });

  test('refuses multiple catalog refs when none matches the creative dimensions', () => {
    assert.throws(() => syncLegacy(markupCreative(320, 50), formatIds), CreativeFormatProjectionError);
  });

  test('refuses even a single catalog ref that contradicts the creative dimensions', () => {
    assert.throws(
      () => syncLegacy(markupCreative(728, 90), [bare('display_300x250_html')]),
      CreativeFormatProjectionError
    );
  });

  test('refuses a single explicitly sized ref that contradicts the creative dimensions', () => {
    assert.throws(
      () => syncLegacy(markupCreative(728, 90), [sized('display_html', 300, 250)]),
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
        syncLegacy(markupCreative(300, 250), [
          bare('display_300x250_html'),
          bare('display_300x250_html', 'https://creative.example.com'),
        ]),
      CreativeFormatProjectionError
    );
  });

  test('refuses partial dimensions that match more than one size', () => {
    const creative = markupCreative(300, 250);
    delete creative.format_parameters.height;
    assert.throws(() => syncLegacy(creative, formatIds), CreativeFormatProjectionError);
  });

  test('does not infer dimensions from uncatalogued IDs that look sized', () => {
    const creative = markupCreative(310, 210);
    assert.throws(
      () =>
        projectSyncCreativesForDelivery(
          { creatives: [creative] },
          [{ format_kind: 'display_tag', format_ids: [bare('display_310x210_html'), bare('display_620x420_html')] }],
          'legacy'
        ),
      CreativeFormatProjectionError
    );
  });
});

describe('inline-markup display_tag creatives round-trip to the HTML-markup legacy formats (adcp#8339)', () => {
  const MARKUP =
    '<ins class="dcmads" style="display:inline-block;width:300px;height:250px" data-dcm-placement="N0000.0000ACME/B0000000.000000000"><script src="https://ads.acme.example/dcmads.js"></script></ins>';
  const sizedHtmlRefs = [bare('display_300x250_html'), bare('display_300x600_html'), bare('display_320x50_html')];

  function inlineMarkupCreative(size, overrides = {}) {
    return {
      creative_id: 'cm360_tag',
      name: 'Third-party tag',
      format_kind: 'display_tag',
      assets: {
        html_creative: {
          asset_type: 'display_tag',
          delivery_type: 'inline_markup',
          markup_type: 'javascript',
          markup: MARKUP,
          ...size,
        },
      },
      ...overrides,
    };
  }

  test('selects the exact sized ref from the rendered asset size and carries the markup in html_creative', () => {
    const projected = syncLegacy(inlineMarkupCreative({ width: 300, height: 250 }), sizedHtmlRefs);
    assert.deepEqual(projected.format_id, bare('display_300x250_html'));
    assert.equal(projected.format_kind, undefined);
    assert.deepEqual(projected.assets, { html_creative: { asset_type: 'html', content: MARKUP } });
  });

  test('maps a differently named inline-markup slot onto html_creative', () => {
    const creative = inlineMarkupCreative({ width: 320, height: 50 });
    creative.assets = { serving_tag: creative.assets.html_creative };
    const projected = syncLegacy(creative, sizedHtmlRefs);
    assert.deepEqual(projected.format_id, bare('display_320x50_html'));
    assert.deepEqual(projected.assets, { html_creative: { asset_type: 'html', content: MARKUP } });
  });

  test('selects the same ref for inline media-buy creatives', () => {
    const projected = projectLegacy({
      packages: [
        {
          product_id: 'html-sizes',
          format_ids: sizedHtmlRefs,
          creatives: [inlineMarkupCreative({ width: 300, height: 600 })],
        },
      ],
    });
    const creative = projected.packages[0].creatives[0];
    assert.deepEqual(creative.format_id, bare('display_300x600_html'));
    assert.deepEqual(creative.assets.html_creative, { asset_type: 'html', content: MARKUP });
  });

  test('prefers the inline-markup HTML ref over a tag-URL display_js ref of the same kind', () => {
    const projected = syncLegacy(inlineMarkupCreative(), [bare('display_js'), bare('display_html')]);
    assert.deepEqual(projected.format_id, bare('display_html'));
  });

  test('keeps a tag-URL display_tag creative on display_js', () => {
    const creative = {
      creative_id: 'tag_url',
      name: 'Tag URL',
      format_kind: 'display_tag',
      assets: { tag_url: { asset_type: 'url', url_type: 'ad_request', url: 'https://ads.acme.example/render' } },
    };
    assert.deepEqual(syncLegacy(creative, [bare('display_js'), bare('display_html')]).format_id, bare('display_js'));
    assert.throws(() => syncLegacy(creative, sizedHtmlRefs), CreativeFormatProjectionError);
  });

  test('refuses an unsized inline-markup creative against several sized HTML refs', () => {
    assert.throws(() => syncLegacy(inlineMarkupCreative(), sizedHtmlRefs), CreativeFormatProjectionError);
  });

  test('intended: an html5 zip creative no longer matches HTML-markup-only products', () => {
    const zip = {
      creative_id: 'zip_bundle',
      name: 'HTML5 bundle',
      format_kind: 'html5',
      assets: {
        html5_bundle: {
          asset_type: 'zip',
          url: 'https://cdn.acme.example/spring-300x250.zip',
          width: 300,
          height: 250,
        },
      },
    };
    assert.throws(() => syncLegacy(zip, sizedHtmlRefs), CreativeFormatProjectionError);
    assert.throws(() => syncLegacy(zip, [bare('display_html')]), CreativeFormatProjectionError);
  });

  test('reads a legacy html_creative back as inline markup on the canonical wire', () => {
    const legacy = {
      creative_id: 'legacy_html',
      name: 'Legacy HTML',
      format_id: bare('display_300x250_html'),
      assets: { html_creative: { asset_type: 'html', content: MARKUP } },
    };
    const canonical = projectSyncCreativesForDelivery(
      { creatives: [legacy], assignments: [{ creative_id: 'legacy_html', package_id: 'package_1' }] },
      [{ package_id: 'package_1', format_ids: [bare('display_300x250_html')] }],
      'canonical'
    ).creatives[0];
    assert.equal(canonical.format_kind, 'display_tag');
    assert.equal(canonical.format_id, undefined);
    assert.deepEqual(canonical.assets.html_creative, {
      asset_type: 'display_tag',
      delivery_type: 'inline_markup',
      markup_type: 'standard',
      markup: MARKUP,
    });

    // The legacy wire leaves the original asset untouched.
    const legacyWire = syncLegacy(legacy, [bare('display_300x250_html')]);
    assert.deepEqual(legacyWire.assets, legacy.assets);
  });

  for (const [formatKind, params, convertsMarkup] of [
    ['html5', { width: 300, height: 250 }, false],
    ['display_tag', { supported_delivery_types: ['tag_url'] }, false],
    ['display_tag', { supported_delivery_types: ['inline_markup'] }, true],
  ])
    test(`preserves seller-declared ${formatKind} delivery constraints (${params.supported_delivery_types ?? 'bundle'})`, () => {
      const ref = bare('display_300x250_html');
      const legacy = {
        creative_id: 'seller-declared-html5',
        name: 'Seller declaration',
        format_id: ref,
        assets: { html_creative: { asset_type: 'html', content: MARKUP } },
      };
      const canonical = projectSyncCreativesForDelivery(
        { creatives: [legacy], assignments: [{ creative_id: legacy.creative_id, package_id: 'package_1' }] },
        [
          {
            package_id: 'package_1',
            format_options: [{ format_kind: formatKind, params, v1_format_ref: [ref] }],
          },
        ],
        'canonical'
      ).creatives[0];
      assert.equal(canonical.format_kind, formatKind);
      assert.deepEqual(
        canonical.assets,
        convertsMarkup
          ? {
              html_creative: {
                asset_type: 'display_tag',
                delivery_type: 'inline_markup',
                markup_type: 'standard',
                markup: MARKUP,
              },
            }
          : legacy.assets
      );
    });
});
