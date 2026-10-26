// Legacy creative projection failures name the constraint that failed (#3437).
// Cases follow the AdCP HTML-markup projection vectors
// (adcontextprotocol/adcp static/test-vectors/html-markup-legacy-projection.json).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { CreativeFormatProjectionError, projectCreativeForDelivery } = require('../../dist/lib/v2/projection/index.js');

const AGENT_URL = 'https://creative.adcontextprotocol.org/';
const MARKUP = '<ins class="acme"><script src="https://ads.acme.example/tag.js"></script></ins>';

function refs(...ids) {
  return { format_ids: ids.map(id => ({ agent_url: AGENT_URL, id })) };
}

function markup(extra = {}) {
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
  };
}

function failure(creative, container) {
  let caught;
  try {
    projectCreativeForDelivery(creative, container, 'legacy');
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof CreativeFormatProjectionError, `expected a projection error, got ${caught}`);
  assert.equal(caught.code, 'ADCP_CREATIVE_FORMAT_PROJECTION_FAILED');
  return caught.message;
}

describe('legacy projection failures name the failed constraint', () => {
  test('an html5 zip offered only HTML-markup refs points at the SDK 17 display_tag migration', () => {
    const message = failure(
      {
        creative_id: 'c1',
        name: 'Zip',
        format_kind: 'html5',
        assets: {
          html5_bundle: { asset_type: 'zip', url: 'https://cdn.acme.example/spring.zip', width: 300, height: 250 },
        },
      },
      refs('display_300x250_html', 'display_300x600_html')
    );
    assert.match(message, /offers legacy refs for canonical kind display_tag, not html5/);
    assert.match(message, /display_tag asset with delivery_type inline_markup/);
    assert.match(message, /migration-16-to-17/);
  });

  test('a tag URL offered only inline-markup refs names the delivery types', () => {
    const message = failure(
      {
        creative_id: 'c1',
        name: 'Tag',
        format_kind: 'display_tag',
        assets: {
          html_creative: {
            asset_type: 'display_tag',
            delivery_type: 'tag_url',
            url: 'https://ads.acme.example/render?sz=300x250',
            width: 300,
            height: 250,
          },
        },
      },
      refs('display_300x250_html')
    );
    assert.match(message, /accepts delivery_type tag_url \(they accept inline_markup\)/);
  });

  test('a rendered size with no matching ref names the size', () => {
    const message = failure(markup({ width: 728, height: 90 }), refs('display_300x250_html', 'display_300x600_html'));
    assert.match(message, /none of the seller's 2 display_tag legacy refs matches the creative's 728x90 size/);
  });

  test('an unsized creative facing several sized refs says how to choose one', () => {
    const message = failure(markup(), refs('display_300x250_html', 'display_300x600_html'));
    assert.match(message, /advertised 2 legacy refs for canonical kind display_tag/);
    assert.match(message, /format_parameters\.width\/height/);
  });

  test('a product with no legacy refs keeps the generic reason', () => {
    const message = failure(markup({ width: 300, height: 250 }), { format_ids: [] });
    assert.match(message, /did not provide one unambiguous legacy format reference/);
  });

  test('selection is unchanged for a creative that matches', () => {
    const projected = projectCreativeForDelivery(
      markup({ width: 300, height: 250 }),
      refs('display_300x250_html', 'display_300x600_html', 'display_320x50_html'),
      'legacy'
    );
    assert.equal(projected.format_id.id, 'display_300x250_html');
    assert.equal(projected.assets.html_creative.content, MARKUP);
  });
});
