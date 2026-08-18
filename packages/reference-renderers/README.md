# `@adcp/reference-renderers`

Dependency-free browser ESM reference presentations for AdCP canonical creative formats.

```js
import { renderImage } from '@adcp/reference-renderers';

const html = renderImage({
  format_kind: 'image',
  params: { width: 300, height: 250 },
  assets: {
    image_main: { asset_type: 'image', url: 'https://cdn.example/creative.png' },
    landing_page_url: { asset_type: 'url', url: 'https://brand.example/' },
  },
});
```

The named exports `renderImage`, `renderNativeInFeed`, and `renderVast` return complete HTML documents. They are non-authoritative reference presentations: they demonstrate the canonical asset contract but do not reproduce publisher chrome or a serving platform's output.

`renderImageCarousel` adds the canonical `image_carousel` family. For clients
that must fail closed instead of receiving a placeholder, the structured APIs
validate raw manifests and format declarations before producing HTML:

```js
import { mountReferencePreview, renderImageCarouselResult } from '@adcp/reference-renderers';

const result = renderImageCarouselResult({
  manifest,
  declaration: {
    format_kind: 'image_carousel',
    supported_macros: ['CLICK_ID'],
    params: {
      min_cards: 2,
      max_cards: 6,
      card_aspect_ratio: '1:1',
      allowed_card_media_asset_types: ['image'],
    },
  },
  macros: { CLICK_ID: 'preview-click' },
});

if (result.ok) {
  const mounted = mountReferencePreview(container, result.html);
  // mounted.destroy() when the host unmounts
} else {
  console.error(result.issues);
}
```

`prepareImageReference` and `prepareImageCarouselReference` return the validated
presentation and its explicit network plan without generating HTML.

The renderers do not fetch resources while rendering, use ambient credentials,
fire trackers, resolve remote VAST tags or wrappers, or execute
creative-provided code. Structured rendering expands only macros declared by
the format and supplied explicitly for that preview; undeclared or unresolved
macros fail closed. Returned documents may reference only HTTPS creative media
and landing pages declared by the manifest.

Consumers should still run the package and returned presentation in an
isolated, credential-free sandbox. `mountReferencePreview` creates an iframe
with an empty `sandbox` capability set and `referrerpolicy="no-referrer"`; it
never injects the returned HTML into the host document.

`renderVast` only extracts an HTTPS `<MediaFile>` from inline VAST XML. For a remote VAST URL it returns a placeholder; use an authorized `preview_creative` provider for platform behavior.
