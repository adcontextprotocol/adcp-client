import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mountReferencePreview,
  prepareImageCarouselReference,
  prepareImageReference,
  REFERENCE_PRESENTATION_LABEL,
  renderImageCarouselResult,
  renderImageResult,
} from '../index.js';

function imageAsset(url, width = 300, height = 250) {
  return { asset_type: 'image', url, width, height };
}

function card(url, overrides = {}) {
  return {
    asset_type: 'card',
    media: imageAsset(url, 600, 600),
    ...overrides,
  };
}

test('prepares a canonical image with declared preview macros', () => {
  const result = prepareImageReference({
    manifest: {
      format_kind: 'image',
      assets: {
        image_main: imageAsset('https://cdn.example/{CREATIVE_ID}.png'),
        headline: { asset_type: 'text', content: 'Creative {CREATIVE_ID}' },
        landing_page_url: {
          asset_type: 'url',
          url_type: 'clickthrough',
          url: 'https://brand.example/?id=${CREATIVE_ID}',
        },
        impression_tracker: {
          asset_type: 'url',
          url_type: 'tracker_pixel',
          url: 'https://tracking.example/pixel',
        },
      },
    },
    declaration: {
      format_kind: 'image',
      params: {
        width: 300,
        height: 250,
        headline_max_chars: 40,
        supported_macros: ['CREATIVE_ID'],
      },
    },
    macros: { CREATIVE_ID: 'preview-1' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.presentation.image.url, 'https://cdn.example/preview-1.png');
  assert.deepEqual(result.presentation.network, {
    eager_assets: ['https://cdn.example/preview-1.png'],
    user_navigations: ['https://brand.example/?id=preview-1'],
  });
  assert.doesNotMatch(JSON.stringify(result), /tracking\.example/);
});

test('fails closed for undeclared macros and canonical dimension mismatches', () => {
  const macroResult = prepareImageReference({
    manifest: {
      format_kind: 'image',
      assets: { image_main: imageAsset('https://cdn.example/{ACCOUNT_ID}.png') },
    },
  });
  assert.equal(macroResult.ok, false);
  assert.equal(macroResult.issues[0].code, 'UNSUPPORTED_MACRO');

  const dimensionsResult = prepareImageReference({
    manifest: {
      format_kind: 'image',
      assets: { image_main: imageAsset('https://cdn.example/image.png', 728, 90) },
    },
    declaration: {
      format_kind: 'image',
      params: { width: 300, height: 250 },
    },
  });
  assert.equal(dimensionsResult.ok, false);
  assert.ok(dimensionsResult.issues.some(entry => entry.code === 'CONSTRAINT_VIOLATION'));
});

test('accepts declared Retina image density without changing logical size', () => {
  const result = prepareImageReference({
    manifest: {
      format_kind: 'image',
      assets: {
        image_main: {
          ...imageAsset('https://cdn.example/retina.png', 600, 500),
          pixel_ratio: 2,
        },
      },
    },
    declaration: {
      format_kind: 'image',
      params: { width: 300, height: 250, pixel_ratios: [1, 2] },
    },
  });
  assert.equal(result.ok, true);
});

test('prepares and renders canonical image carousel cards', () => {
  const input = {
    manifest: {
      name: 'Seasonal products',
      format_kind: 'image_carousel',
      assets: {
        cards: [
          card('https://cdn.example/one.png', {
            headline: 'One',
            landing_page_url: {
              asset_type: 'url',
              url_type: 'clickthrough',
              url: 'https://brand.example/one',
            },
          }),
          card('https://cdn.example/two.png', { headline: 'Two' }),
        ],
        primary_text: { asset_type: 'text', content: 'Choose a product' },
      },
    },
    declaration: {
      format_kind: 'image_carousel',
      params: {
        min_cards: 2,
        max_cards: 4,
        card_aspect_ratio: '1:1',
        allowed_card_media_asset_types: ['image'],
        card_headline_max_chars: 20,
      },
    },
  };

  const prepared = prepareImageCarouselReference(input);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.presentation.cards.length, 2);
  assert.deepEqual(prepared.presentation.network.eager_assets, [
    'https://cdn.example/one.png',
    'https://cdn.example/two.png',
  ]);

  const rendered = renderImageCarouselResult(input);
  assert.equal(rendered.ok, true);
  assert.match(rendered.html, /Community reference presentation — non-authoritative/);
  assert.match(rendered.html, /https:\/\/cdn\.example\/one\.png/);
  assert.doesNotMatch(rendered.html, /<script/i);
});

test('rejects carousel count, aspect ratio, and media-type violations', () => {
  const result = prepareImageCarouselReference({
    manifest: {
      format_kind: 'image_carousel',
      assets: {
        cards: [card('https://cdn.example/wide.png', { media: imageAsset('https://cdn.example/wide.png', 600, 300) })],
      },
    },
    declaration: {
      format_kind: 'image_carousel',
      params: {
        min_cards: 2,
        max_cards: 3,
        card_aspect_ratio: '1:1',
        allowed_card_media_asset_types: ['video'],
      },
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some(entry => entry.path === 'manifest.assets.cards'));
  assert.ok(result.issues.some(entry => entry.path.endsWith('media.asset_type')));

  const aspectResult = prepareImageCarouselReference({
    manifest: {
      format_kind: 'image_carousel',
      assets: {
        cards: ['one', 'two'].map(id =>
          card(`https://cdn.example/${id}.png`, {
            media: imageAsset(`https://cdn.example/${id}.png`, 600, 300),
          })
        ),
      },
    },
    declaration: {
      format_kind: 'image_carousel',
      params: {
        card_aspect_ratio: '1:1',
        allowed_card_media_asset_types: ['image'],
      },
    },
  });

  assert.equal(aspectResult.ok, false);
  assert.ok(aspectResult.issues.some(entry => entry.message.includes('card_aspect_ratio')));
});

test('structured image rendering exposes issues instead of a placeholder', () => {
  const result = renderImageResult({
    manifest: {
      format_kind: 'image',
      assets: { image_main: imageAsset('javascript:alert(1)') },
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(entry => entry.code === 'INVALID_ASSET'));
});

test('mounts complete documents into a capability-minimal iframe', () => {
  const attributes = new Map();
  const iframe = {
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    remove() {
      this.removed = true;
    },
  };
  const container = {
    ownerDocument: { createElement: () => iframe },
    append() {},
    replaceChildren(child) {
      this.child = child;
    },
  };
  const mounted = mountReferencePreview(container, '<!DOCTYPE html><html><body>safe</body></html>');

  assert.equal(container.child, iframe);
  assert.equal(attributes.get('sandbox'), '');
  assert.equal(attributes.get('referrerpolicy'), 'no-referrer');
  assert.equal(attributes.get('title'), REFERENCE_PRESENTATION_LABEL);
  assert.equal(iframe.srcdoc, '<!DOCTYPE html><html><body>safe</body></html>');
  mounted.destroy();
  assert.equal(iframe.removed, true);
});
