import {
  bothRender,
  htmlRender,
  urlRender,
  type CanonicalCreativeAsset,
  type CanonicalPackageRequest,
  type CanonicalSyncCreativesRequest,
} from '../lib';
import type { PreviewRender } from '../lib/types/tools.generated';

const creative = {
  creative_id: 'creative_1',
  name: 'Homepage hero',
  format_kind: 'image',
  assets: {},
} satisfies CanonicalCreativeAsset;

// @ts-expect-error canonical creatives require creative_id.
const missingCreativeId: CanonicalCreativeAsset = { name: 'Missing ID', format_kind: 'image', assets: {} };
// @ts-expect-error canonical creatives require name.
const missingCreativeName: CanonicalCreativeAsset = { creative_id: 'creative_2', format_kind: 'image', assets: {} };
// @ts-expect-error canonical creatives require assets.
const missingCreativeAssets: CanonicalCreativeAsset = {
  creative_id: 'creative_3',
  name: 'Missing assets',
  format_kind: 'image',
};

const syncWithLocalization: CanonicalSyncCreativesRequest = {
  account: { account_id: 'account_1' },
  idempotency_key: '00000000-0000-4000-8000-000000000001',
  creatives: [{ ...creative, localization: null }],
};
const syncMissingCreativeId: CanonicalSyncCreativesRequest = {
  account: { account_id: 'account_1' },
  idempotency_key: '00000000-0000-4000-8000-000000000002',
  creatives: [
    // @ts-expect-error sync creatives still require creative_id.
    { name: 'Missing ID', format_kind: 'image', assets: {}, localization: null },
  ],
};

const packageWithoutLocalization: CanonicalPackageRequest = {
  product_id: 'product_1',
  pricing_option_id: 'pricing_1',
  creatives: [creative],
};
const packageWithLocalization: CanonicalPackageRequest = {
  product_id: 'product_2',
  pricing_option_id: 'pricing_2',
  creatives: [
    {
      ...creative,
      // @ts-expect-error localization is sync-only and forbidden on inline package creatives.
      localization: null,
    },
  ],
};

const urlPreview: PreviewRender = urlRender({
  render_id: 'render_url',
  preview_url: 'https://preview.example/render',
  role: 'primary',
});
const htmlPreview: PreviewRender = htmlRender({
  render_id: 'render_html',
  preview_html: '<div>Preview</div>',
  role: 'primary',
});
const bothPreview: PreviewRender = bothRender({
  render_id: 'render_both',
  preview_url: 'https://preview.example/render',
  preview_html: '<div>Preview</div>',
  role: 'primary',
});

// @ts-expect-error url renders require preview_url.
urlRender({ render_id: 'missing_url', role: 'primary' });
// @ts-expect-error html renders require preview_html.
htmlRender({ render_id: 'missing_html', role: 'primary' });
// @ts-expect-error both renders require both preview_url and preview_html.
bothRender({ render_id: 'missing_html', preview_url: 'https://preview.example/render', role: 'primary' });

void [
  creative,
  missingCreativeId,
  missingCreativeName,
  missingCreativeAssets,
  syncWithLocalization,
  syncMissingCreativeId,
  packageWithoutLocalization,
  packageWithLocalization,
  urlPreview,
  htmlPreview,
  bothPreview,
];
