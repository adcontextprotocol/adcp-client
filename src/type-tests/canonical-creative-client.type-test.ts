import {
  canonicalFormatDeclaration,
  batchPreviewFormatsLegacy,
  LEGACY_STANDARD_FORMATS,
  LegacyContentStandardsAdapter,
  legacyDefaultContentStandardsAdapter,
  FormatAsset,
  getFormatAssets,
  getRequiredAssets,
  getOptionalAssets,
  packageRefsForFormatOptions,
  type AgentClient,
  type ADCPMultiAgentClient,
  type AdcpTaskName,
  type CanonicalCreateMediaBuyRequest,
  type CanonicalCreativeResponse,
  type CanonicalFormatKind,
  type CanonicalFormatAssetSlot,
  type CanonicalFormatLegacyResolver,
  type CanonicalGetProductsRequest,
  type CanonicalPackageRequest,
  type CanonicalProduct,
  type CanonicalSyncCreativesRequest,
  type CanonicalUpdateMediaBuyRequest,
  type GetCreativeDeliveryRequest,
  type LegacyBuildCreativeRequest,
  type LegacyCreateMediaBuyRequest,
  type LegacyListContentStandardsRequest,
  type LegacyGetProductsRequest,
  type LegacyPackage,
  type LegacyFormatID,
  type LegacyIContentStandardsAdapter,
  type FormatAssetsInput,
  type LegacyPreviewCreativeRequest,
  type LegacySyncCreativesRequest,
  type LegacyUpdateMediaBuyRequest,
  type CreativeAgentClient,
  type MutatingRequestInput,
  type Product as RootProduct,
  type Package as RootPackage,
  type FormatID as RootFormatID,
  type ListContentStandardsRequest as RootListContentStandardsRequest,
  SingleAgentClient,
  type TaskRequestFor,
} from '../lib';
import * as sdk from '../lib';
import * as serverSdk from '../lib/server';
import type { LegacyAdcpServerConfig, LegacyMediaBuyHandlers } from '../lib/server';
import {
  productsResponse as v5ProductsResponse,
  type AdcpServerConfig as V5AdcpServerConfig,
  type MediaBuyHandlers as V5MediaBuyHandlers,
} from '../lib/server/legacy/v5';
import type { ListTransformersRequest, SyncPlansRequest } from '../lib/types/tools.generated';
import type { FormatReferenceStructuredObject } from '../lib/types/core.generated';

declare const client: CreativeAgentClient;
declare const agent: AgentClient;
declare const single: SingleAgentClient;
declare const multi: ADCPMultiAgentClient;
declare const canonicalCreate: MutatingRequestInput<CanonicalCreateMediaBuyRequest>;
declare const legacyCreate: MutatingRequestInput<LegacyCreateMediaBuyRequest>;
declare const canonicalUpdate: MutatingRequestInput<CanonicalUpdateMediaBuyRequest>;
declare const legacyUpdate: MutatingRequestInput<LegacyUpdateMediaBuyRequest>;
declare const canonicalSync: MutatingRequestInput<CanonicalSyncCreativesRequest>;
declare const legacySync: MutatingRequestInput<LegacySyncCreativesRequest>;
declare const previewRequest: LegacyPreviewCreativeRequest;
declare const buildRequest: MutatingRequestInput<LegacyBuildCreativeRequest>;
declare const standardTaskName: AdcpTaskName;
declare const standardTaskParams: TaskRequestFor<typeof standardTaskName>;
declare const syncPlansRequest: SyncPlansRequest;
declare const listTransformersRequest: ListTransformersRequest;
declare const product: CanonicalProduct;
declare const rootProduct: RootProduct;
declare const getCreativeDeliveryRequest: GetCreativeDeliveryRequest;
declare const legacyListContentStandardsRequest: LegacyListContentStandardsRequest;
declare const legacyPackage: LegacyPackage;
declare const rootPackage: RootPackage;
declare const legacyFormatId: LegacyFormatID;
declare const collection: ReturnType<ADCPMultiAgentClient['allAgents']>;
declare const recursivelyCanonical: CanonicalCreativeResponse<{
  product_card: { format_id: FormatReferenceStructuredObject; label: string };
  creative_manifest: { target_format_ids: FormatReferenceStructuredObject[]; label: string };
}>;
declare const canonicalFormatLegacyResolver: CanonicalFormatLegacyResolver;

const legacyContentStandardsAdapter: LegacyIContentStandardsAdapter = new LegacyContentStandardsAdapter();
declare const legacyServerConfig: LegacyAdcpServerConfig;
declare const legacyMediaBuyHandlers: LegacyMediaBuyHandlers;
declare const v5ServerConfig: V5AdcpServerConfig;
declare const v5MediaBuyHandlers: V5MediaBuyHandlers;
void legacyContentStandardsAdapter;
void legacyDefaultContentStandardsAdapter;
void legacyServerConfig;
void legacyMediaBuyHandlers;
void v5ServerConfig;
void v5MediaBuyHandlers;
void v5ProductsResponse;

const structuralAssetInput: FormatAssetsInput = {
  assets: [FormatAsset.image({ asset_id: 'hero', required: true })],
};
const structuralAssets: CanonicalFormatAssetSlot[] = getFormatAssets(structuralAssetInput);
void getRequiredAssets(structuralAssetInput);
void getOptionalAssets({ assets: [] });
void structuralAssets;
// @ts-expect-error Asset inspection inputs deliberately expose no legacy creative identity.
void structuralAssetInput.format_id;
// @ts-expect-error Asset slot results deliberately expose no legacy creative identity.
void structuralAssets[0]?.format_id;
getFormatAssets({
  assets: [],
  // @ts-expect-error Raw format identity is not part of the primary helper input.
  format_id: legacyFormatId,
});
void LEGACY_STANDARD_FORMATS;
void batchPreviewFormatsLegacy;
// @ts-expect-error Raw named-format fixtures are explicit Legacy constants.
void sdk.STANDARD_FORMATS;
// @ts-expect-error Raw named-format previewing is explicit migration tooling.
void sdk.batchPreviewFormats;
// @ts-expect-error Raw content-standard adapters use explicit Legacy names.
void sdk.ContentStandardsAdapter;
// @ts-expect-error Raw response builders use explicit legacy aliases.
void sdk.productsResponse;
// @ts-expect-error V5 handler-bag config is explicit Legacy surface area.
type _NoPrimaryAdcpServerConfig = serverSdk.AdcpServerConfig;
// @ts-expect-error V5 handler bags are explicit Legacy surface area.
type _NoPrimaryMediaBuyHandlers = serverSdk.MediaBuyHandlers;

const assembledCanonicalProduct = serverSdk.buildProduct({
  id: 'canonical-helper-product',
  name: 'Canonical helper product',
  format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
  delivery_type: 'non_guaranteed',
  publisher_domain: 'publisher.example',
});
void assembledCanonicalProduct.format_options;
// @ts-expect-error The primary assembly helper never emits legacy product identity.
assembledCanonicalProduct.format_ids = [];
serverSdk.buildProduct({
  id: 'legacy-helper-product',
  name: 'Legacy helper product',
  // @ts-expect-error Legacy format assembly requires the explicit buildProductLegacy helper.
  formats: ['display_300x250'],
  delivery_type: 'non_guaranteed',
  publisher_domain: 'publisher.example',
});
serverSdk.getAsset({ assets: {} }, 'hero', 'image');
serverSdk.getAssetSlot({ assets: {} }, 'gallery', 'image');
serverSdk.getAsset(
  {
    assets: {},
    // @ts-expect-error Canonical asset helpers accept an identity-free assets container.
    format_id: legacyFormatId,
  },
  'hero',
  'image'
);

const rootProductIsCanonical: CanonicalProduct = rootProduct;
void rootProductIsCanonical;
void rootProduct.format_options;
// @ts-expect-error The primary Product alias recursively removes nested legacy card identity.
void rootProduct.product_card?.format_id;
void recursivelyCanonical.product_card.label;
void recursivelyCanonical.creative_manifest.label;
// @ts-expect-error Recursive canonicalization removes nested product-card identity.
void recursivelyCanonical.product_card.format_id;
// @ts-expect-error Recursive canonicalization removes nested creative-manifest identity.
void recursivelyCanonical.creative_manifest.target_format_ids;
// @ts-expect-error Raw content-standard artifact shapes are unavailable under unqualified root names.
const primaryContentStandardsRequest: RootListContentStandardsRequest = legacyListContentStandardsRequest;
void primaryContentStandardsRequest;
void rootPackage.format_option_refs;
// @ts-expect-error Primary Package exposes no typed legacy format IDs (passthrough keys remain unknown).
const rootPackageFormatIds: FormatReferenceStructuredObject[] = rootPackage.format_ids;
void rootPackageFormatIds;
void legacyPackage.format_ids;
// @ts-expect-error The unqualified root FormatID is intentionally unusable.
const rootFormatId: RootFormatID = legacyFormatId;
void rootFormatId;

const canonicalGetProductsRequest: CanonicalGetProductsRequest = {
  buying_mode: 'wholesale',
  fields: ['product_id', 'format_options'],
};
agent.getProducts(canonicalGetProductsRequest);
single.getProducts(canonicalGetProductsRequest);

// Keep the SingleAgentClient.getProducts JSDoc example schema-valid and show
// that advertiser brand context is optional for brief-based discovery.
const getProductsJSDocExample = {
  buying_mode: 'brief',
  brief: 'Find podcast and streaming audio placements for an eco-friendly bike subscription launch',
} satisfies CanonicalGetProductsRequest;
single.getProducts(getProductsJSDocExample);
single.getProducts({
  ...getProductsJSDocExample,
  brand: { domain: 'pedal-forward.example' },
});
// @ts-expect-error Primary product discovery cannot request legacy format_ids.
agent.getProducts({ buying_mode: 'wholesale', fields: ['format_ids'] });
// @ts-expect-error Generic primary execution enforces the same request boundary.
single.executeTask('get_products', { buying_mode: 'wholesale', fields: ['format_ids'] });
declare const legacyGetProductsRequest: LegacyGetProductsRequest;
agent.getProductsLegacy(legacyGetProductsRequest);

client.listCreatives().then(response => {
  const kind: CanonicalFormatKind = response.creatives[0]!.format_kind;
  void kind;

  // @ts-expect-error Canonical reads cannot be consumed as legacy named-format references.
  const legacyRef: FormatReferenceStructuredObject = response.creatives[0]!.format_id;
  void legacyRef;
});

client.listCreativesLegacy().then(response => {
  const creative = response.creatives[0]!;
  if ('format_id' in creative) {
    const legacyRef: FormatReferenceStructuredObject = creative.format_id;
    void legacyRef;
  } else {
    const kind: CanonicalFormatKind = creative.format_kind;
    void kind;
  }
});

agent.createMediaBuy(canonicalCreate);
single.createMediaBuy(canonicalCreate);
single.createMediaBuy(canonicalCreate, undefined, { canonicalFormatLegacyResolver });
agent.executeTask('create_media_buy', canonicalCreate);
agent.executeCustomTask<{ ok: true }>('vendor_extension', {});
single.executeCustomTask<{ ok: true }>('vendor_extension', {});
// @ts-expect-error Extension task names must use executeCustomTask().
agent.executeTask('vendor_extension', {});
// @ts-expect-error Extension task names must use executeCustomTask().
single.executeTask('vendor_extension', {});
single.executeTask(standardTaskName, standardTaskParams);
single.executeTask('sync_plans', syncPlansRequest).then(result => {
  if (result.success && result.status === 'completed') {
    // @ts-expect-error Typed standard-task responses are not `any`.
    const impossible: string = result.data.not_a_real_sync_plans_field;
    void impossible;
  }
});
// @ts-expect-error Every protected primary task has its exact request type.
single.executeTask('sync_plans', { not_a_sync_plans_field: true });
single.executeCustomTask('sync_catalogs', {});
// @ts-expect-error Less-common raw tasks use executeCustomTask explicitly.
single.executeTask('sync_catalogs', {});

agent.updateMediaBuy(canonicalUpdate);
single.updateMediaBuy(canonicalUpdate);
agent.executeTask('update_media_buy', canonicalUpdate);
agent.syncCreatives(canonicalSync);
single.syncCreatives(canonicalSync);
agent.executeTask('sync_creatives', canonicalSync);
collection.updateMediaBuy(canonicalUpdate);
collection.syncCreatives(canonicalSync);
agent.getCreativeDelivery(getCreativeDeliveryRequest);
single.getCreativeDelivery(getCreativeDeliveryRequest);
agent.executeTask('get_creative_delivery', getCreativeDeliveryRequest);
single.executeTask('get_creative_delivery', getCreativeDeliveryRequest);
collection.getCreativeDelivery(getCreativeDeliveryRequest);

// @ts-expect-error Artifact-bearing content-standard methods are explicitly legacy-only.
agent.listContentStandards(legacyListContentStandardsRequest);
agent.listContentStandardsLegacy(legacyListContentStandardsRequest);
// @ts-expect-error Legacy-bearing standard tasks are excluded from the primary typed task map.
agent.executeTask('list_content_standards', legacyListContentStandardsRequest);

// @ts-expect-error Primary SDK methods do not accept legacy creative request shapes.
agent.createMediaBuy(legacyCreate);
// @ts-expect-error The generic primary path enforces the same canonical boundary.
agent.executeTask('create_media_buy', legacyCreate);
// @ts-expect-error Explicit response generics cannot bypass canonical request typing.
agent.executeTask<{ ok: true }>('create_media_buy', legacyCreate);
// @ts-expect-error SingleAgentClient has the same explicit-generic boundary.
single.executeTask<{ ok: true }>('create_media_buy', legacyCreate);
// @ts-expect-error Primary update methods reject legacy creative identities.
agent.updateMediaBuy(legacyUpdate);
// @ts-expect-error Generic update execution rejects legacy creative identities.
single.executeTask('update_media_buy', legacyUpdate);
// @ts-expect-error Primary sync methods reject legacy creative identities.
single.syncCreatives(legacySync);
// @ts-expect-error Generic sync execution rejects legacy creative identities.
agent.executeTask('sync_creatives', legacySync);
// @ts-expect-error Multi-agent update fan-out is canonical-only.
collection.updateMediaBuy(legacyUpdate);
// @ts-expect-error Multi-agent sync fan-out is canonical-only.
collection.syncCreatives(legacySync);

// @ts-expect-error Legacy format catalogs are available only through explicitly named migration APIs.
agent.listCreativeFormats({});
agent.listCreativeFormatsLegacy({});
// @ts-expect-error Legacy format catalogs are available only through explicitly named migration APIs.
single.listCreativeFormats({});
single.listCreativeFormatsLegacy({});
// @ts-expect-error Raw legacy task names cannot be smuggled through the primary generic task API.
agent.executeTask('list_creative_formats', {});
// @ts-expect-error Raw legacy task names cannot be smuggled through the primary generic task API.
single.executeTask('list_creative_formats', {});

// @ts-expect-error CreativeAgentClient does not expose an unqualified legacy named-format API.
client.listFormats();
client.listFormatsLegacy();

// @ts-expect-error Multi-agent discovery is explicitly legacy-only.
multi.discoverFormats();
multi.discoverFormatsLegacy();
// @ts-expect-error Static legacy discovery has no unqualified alias.
SingleAgentClient.discoverCreativeFormats('https://creative.example/mcp');
SingleAgentClient.discoverCreativeFormatsLegacy('https://creative.example/mcp');

// @ts-expect-error Legacy creative build has no unqualified primary method.
agent.buildCreative(buildRequest);
agent.buildCreativeLegacy(buildRequest);
// @ts-expect-error Legacy creative preview has no unqualified primary method.
single.previewCreative(previewRequest);
single.previewCreativeLegacy(previewRequest);
// @ts-expect-error Raw legacy build is excluded from primary generic execution.
agent.executeTask('build_creative', buildRequest);
// @ts-expect-error Raw legacy preview is excluded from primary generic execution.
single.executeTask('preview_creative', previewRequest);
agent.listTransformersLegacy(listTransformersRequest);
// @ts-expect-error Legacy transformer discovery has no unqualified primary method.
agent.listTransformers(listTransformersRequest);
// @ts-expect-error Legacy transformer discovery is excluded from primary generic execution.
single.executeTask('list_transformers', listTransformersRequest);

// @ts-expect-error Canonical creative reads cannot request the legacy response field.
single.listCreatives({ fields: ['format_id'] });
// @ts-expect-error Canonical creative reads cannot filter by legacy named-format identity.
agent.listCreatives({ filters: { format_ids: [{ agent_url: 'https://legacy.invalid', id: 'legacy' }] } });

// @ts-expect-error Legacy-preserving migration helpers are not exported from the package root.
void sdk.withFormatOptions;
// @ts-expect-error Raw wire projection is available only from the explicit migration subpath.
void sdk.projectMediaBuyCreativesForDelivery;

single.syncCreatives(canonicalSync, undefined, {
  creativeFormatProjection: {
    selectorContainers: [
      {
        // @ts-expect-error Primary sync projection accepts canonical selectors only.
        format_ids: [{ agent_url: 'https://legacy.invalid', id: 'legacy' }],
      },
    ],
  },
});

single.syncCreatives(canonicalSync, undefined, {
  creativeFormatProjection: {
    selectorContainers: [
      {
        format_options: [
          {
            format_kind: 'image',
            params: { width: 300, height: 250 },
            // @ts-expect-error Canonical sync declarations cannot carry visible downgrade refs.
            v1_format_ref: [{ agent_url: 'https://legacy.invalid', id: 'legacy' }],
          },
        ],
      },
    ],
  },
});

agent.getProducts({ buying_mode: 'wholesale' }).then(result => {
  if (result.success && result.status === 'completed') {
    void result.data.products[0]!.format_options;
    // @ts-expect-error Canonical product reads never expose legacy format IDs.
    const legacyIds: FormatReferenceStructuredObject[] = result.data.products[0]!.format_ids;
    void legacyIds;
  }
});

collection.listCreatives({}).then(results => {
  const result = results[0]!;
  if (result.success && result.status === 'completed') {
    void result.data.creatives[0]!.format_kind;
    // @ts-expect-error Multi-agent canonical reads never expose legacy creative format IDs.
    const legacyId: FormatReferenceStructuredObject = result.data.creatives[0]!.format_id;
    void legacyId;
  }
});

new SingleAgentClient(
  { id: 'typed-handlers', name: 'Typed handlers', agent_uri: 'https://example.test/mcp', protocol: 'mcp' },
  {
    handlers: {
      onGetProductsStatusChange(response) {
        if ('products' in response && Array.isArray(response.products)) {
          const products = response.products as CanonicalProduct[];
          void products[0]!.format_options;
          // @ts-expect-error Completion handlers expose canonical products only.
          const legacyIds: FormatReferenceStructuredObject[] = products[0]!.format_ids;
          void legacyIds;
        }
      },
      onListCreativesStatusChange(response) {
        void response.creatives[0]!.format_kind;
        // @ts-expect-error Completion handlers expose canonical creatives only.
        const legacyId: FormatReferenceStructuredObject = response.creatives[0]!.format_id;
        void legacyId;
      },
      onCreateMediaBuyStatusChange(response) {
        // @ts-expect-error Creative-bearing completion handlers are canonical-only.
        const legacyId: FormatReferenceStructuredObject = response.format_id;
        void legacyId;
      },
      onUpdateMediaBuyStatusChange(response) {
        // @ts-expect-error Creative-bearing completion handlers are canonical-only.
        const legacyId: FormatReferenceStructuredObject = response.format_id;
        void legacyId;
      },
      onSyncCreativesStatusChange(response) {
        // @ts-expect-error Creative-bearing completion handlers are canonical-only.
        const legacyId: FormatReferenceStructuredObject = response.format_id;
        void legacyId;
      },
      onGetMediaBuysStatusChange(response) {
        // @ts-expect-error Creative-bearing read handlers are canonical-only.
        const legacyId: FormatReferenceStructuredObject = response.format_id;
        void legacyId;
      },
      onGetMediaBuyDeliveryStatusChange(response) {
        // @ts-expect-error Creative-bearing delivery handlers are canonical-only.
        const legacyId: FormatReferenceStructuredObject = response.format_id;
        void legacyId;
      },
      onGetCreativeDeliveryStatusChange(response) {
        // @ts-expect-error Creative-delivery callbacks recursively remove legacy format identity.
        const legacyId: FormatReferenceStructuredObject = response.format_id;
        void legacyId;
      },
    },
  }
);

new SingleAgentClient(
  { id: 'legacy-resolver', name: 'Legacy resolver', agent_uri: 'https://example.test/mcp', protocol: 'mcp' },
  { canonicalFormatLegacyResolver }
);

new SingleAgentClient(
  { id: 'legacy-handler-name', name: 'Legacy handler name', agent_uri: 'https://example.test/mcp', protocol: 'mcp' },
  {
    handlers: {
      // @ts-expect-error Legacy callbacks are explicitly named on the modern handler config.
      onPreviewCreativeStatusChange() {},
    },
  }
);

agent.createMediaBuyLegacy(legacyCreate);
agent.executeTaskLegacy('create_media_buy', legacyCreate);

const canonicalPackage: CanonicalPackageRequest = {
  product_id: product.product_id,
  pricing_option_id: 'po-type-test',
  budget: 1000,
  ...packageRefsForFormatOptions(product, [product.format_options[0]!.format_option_id!]),
};
void canonicalPackage;

const canonicalDeclaration = canonicalFormatDeclaration('image', { width: 300, height: 250 });
// @ts-expect-error Canonical declaration builders never accept legacy routing references.
canonicalFormatDeclaration('image', { width: 300, height: 250 }, { v1_format_ref: [] });
// @ts-expect-error Canonical declaration results never expose legacy routing references.
canonicalDeclaration.v1_format_ref.push({ agent_url: 'https://legacy.invalid', id: 'legacy' });
