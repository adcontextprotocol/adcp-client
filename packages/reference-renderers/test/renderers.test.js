import assert from 'node:assert/strict';
import test from 'node:test';

import { renderImage, renderNativeInFeed, renderVast } from '../index.js';

test('renders canonical image assets and escapes markup', () => {
  const html = renderImage({
    name: '<unsafe>',
    format_kind: 'image',
    params: { width: 320, height: 180 },
    assets: {
      image_main: { asset_type: 'image', url: 'https://cdn.example/image.jpg' },
      landing_page_url: { asset_type: 'url', url: 'https://brand.example/landing' },
    },
  });

  assert.match(html, /width:320px;height:180px/);
  assert.match(html, /https:\/\/cdn\.example\/image\.jpg/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(html, /<title><unsafe><\/title>/);
});

test('rejects executable and credential-bearing URLs', () => {
  const html = renderImage({
    format_kind: 'image',
    assets: {
      image_main: { asset_type: 'image', url: 'javascript:alert(1)' },
      landing_page_url: { asset_type: 'url', url: 'https://user:secret@brand.example/' },
    },
  });

  assert.match(html, /Image creative/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /secret/);
});

test('renders native text without emitting tracker assets', () => {
  const html = renderNativeInFeed({
    format_kind: 'native_in_feed',
    assets: {
      title: { asset_type: 'text', content: '<strong>Headline</strong>' },
      advertiser_name: { asset_type: 'text', content: 'Nova Motors' },
      impression_tracker: { asset_type: 'pixel_tracker', url: 'https://tracking.example/pixel' },
      landing_page_url: { asset_type: 'url', url: 'https://nova.example/' },
    },
  });

  assert.match(html, /&lt;strong&gt;Headline&lt;\/strong&gt;/);
  assert.match(html, /Sponsored by Nova Motors/);
  assert.doesNotMatch(html, /tracking\.example/);
});

test('renders only inline HTTPS VAST media and suppresses tracking', () => {
  const html = renderVast(
    {
      format_kind: 'video_vast',
      assets: {
        vast_tag: {
          asset_type: 'vast',
          content:
            '<VAST><Ad><InLine><Impression>https://tracking.example/i</Impression><Creatives><Creative><Linear><MediaFiles><MediaFile><![CDATA[https://cdn.example/video.mp4]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>',
        },
      },
    },
    { width: 640, height: 360 }
  );

  assert.match(html, /https:\/\/cdn\.example\/video\.mp4/);
  assert.doesNotMatch(html, /tracking\.example/);
});

test('does not resolve a remote VAST tag', () => {
  const html = renderVast({
    format_kind: 'video_vast',
    assets: {
      vast_tag: { asset_type: 'vast', url: 'https://ads.example/vast.xml' },
    },
  });

  assert.match(html, /Remote VAST tag not fetched/);
  assert.doesNotMatch(html, /src="https:\/\/ads\.example/);
});
