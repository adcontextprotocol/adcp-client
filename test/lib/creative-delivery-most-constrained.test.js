const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CreativeFormatProjectionError,
  projectMediaBuyCreativesForDelivery,
} = require('../../dist/lib/v2/projection/index.js');

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

  test('leaves canonical wire mode untouched', () => {
    const request = {
      packages: [{ product_id: 'canonical-seller', creatives: [html5Creative(300, 250)] }],
    };
    const projected = projectMediaBuyCreativesForDelivery(request, 'canonical', 'create_media_buy');
    assert.equal(projected.packages[0].creatives[0].format_kind, 'html5');
    assert.equal(projected.packages[0].creatives[0].format_id, undefined);
  });
});
