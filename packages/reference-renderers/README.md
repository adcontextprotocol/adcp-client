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

The renderers do not fetch resources while rendering, use ambient credentials, fire trackers, resolve remote VAST tags or wrappers, expand macros, or execute creative-provided code. Returned documents may reference HTTPS creative media and landing pages declared by the manifest. Consumers should still run the package and returned presentation in an isolated, credential-free sandbox.

`renderVast` only extracts an HTTPS `<MediaFile>` from inline VAST XML. For a remote VAST URL it returns a placeholder; use an authorized `preview_creative` provider for platform behavior.
