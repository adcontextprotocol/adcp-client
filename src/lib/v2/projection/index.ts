/**
 * v1 ↔ v2 Product projection layer (AdCP 3.1).
 *
 * Public surfaces:
 *
 *   - `projectV1ProductToV2` / `projectV2ProductToV1` — the symmetric
 *     core projections. Read a Product on one side, return a Product
 *     on the other plus structured diagnostics (`source: 'sdk'`,
 *     normative spec codes + SDK-local codes).
 *
 *   - `resolveCanonicalFormatKind` / `canonicalDeclarationFromBareId` —
 *     resolve a single bare format-id string (no surrounding Product,
 *     no `agent_url`) to its canonical `format_kind` or full declaration.
 *     Registry- and catalog-backed; fails closed to `null`.
 *
 *   - `withFormatOptions` / `augmentProductWithFormatOptions` —
 *     buyer-side response augmentation. Adds `format_options[]` to a
 *     v1-shaped get_products response so canonical-format-aware buyers
 *     can read the canonical model regardless of the seller's wire
 *     version. Additive — `format_ids[]` is preserved.
 *
 *   - `toAdditiveCanonicalProduct` — additive projection with URL-free
 *     `format_options[]`, preserved top-level `format_ids[]`, and explicit
 *     serializable legacy-route sidecars for later forwarding.
 *     `withAdditiveCanonicalFormatOptions` is the response-level companion.
 *     `toCanonicalFormatOptionsWithRoutes` provides the same safe route-first
 *     concealment for callers that hold only a declaration array.
 *
 *   - `toCanonicalOnlyProduct` / `toCanonicalOnlyResponse` — the
 *     read-side narrowing for a fully-migrated consumer. Returns
 *     `format_options[]` with `format_ids[]` dropped, surfacing a
 *     diagnostic for any ref that couldn't be carried over.
 *
 *   - Catalog + registry primitives (`lookupV1Format`,
 *     `findCatalogEntryByCanonicalAndSize`, registry exports) for
 *     callers wiring projection into their own code paths.
 *
 * Legacy-preserving and raw wire projection helpers are exposed only from
 * `@adcp/sdk/v2/projection`. The package root exports the canonical authoring
 * surface so ordinary buyers do not accidentally retain legacy identities.
 */

export { projectV1ProductToV2, canonicalDeclarationFromBareId, resolveCanonicalFormatKind } from './v1-to-v2';
export type {
  V1ToV2Result,
  V1ToV2ProjectionOptions,
  BareFormatIdResolveOptions,
  LegacyFormatConversionContext,
  LegacyFormatConverter,
} from './v1-to-v2';

export { projectV2ProductToV1 } from './v2-to-v1';
export type {
  V2ToV1Result,
  V2ToV1ProjectionOptions,
  CanonicalFormatLegacyResolver,
  CanonicalFormatLegacyResolutionContext,
  CanonicalProductFormatLegacyResolutionContext,
  CanonicalCreativeFormatLegacyResolutionContext,
  CanonicalSelectorFormatLegacyResolutionContext,
} from './v2-to-v1';

export {
  canonicalFormatLegacyResolverFromRoutes,
  legacyRoutesForProduct,
  type CanonicalFormatLegacyRoute,
} from './legacy-routes';

export {
  augmentProductWithFormatOptions,
  withFormatOptions,
  toCanonicalFormatOptionsWithRoutes,
  toAdditiveCanonicalProduct,
  withAdditiveCanonicalFormatOptions,
  toCanonicalOnlyProduct,
  toCanonicalOnlyResponse,
  type V2AugmentedProduct,
  type AdditiveCanonicalProduct,
  type CanonicalOnlyProduct,
} from './augment-response';

export {
  CanonicalFormat,
  audioDaastFormatDeclaration,
  audioHostedFormatDeclaration,
  agentPlacementFormatDeclaration,
  canonicalFormatDeclaration,
  customFormatDeclaration,
  displayTagFormatDeclaration,
  legacyFormatRef,
  legacyFormatRefs,
  html5FormatDeclaration,
  imageCarouselFormatDeclaration,
  imageFormatDeclaration,
  nativeInFeedFormatDeclaration,
  productCard,
  productCardDetailed,
  responsiveCreativeFormatDeclaration,
  sponsoredPlacementFormatDeclaration,
  videoHostedFormatDeclaration,
  videoVastFormatDeclaration,
  type CanonicalFormatDeclaration,
  type CanonicalFormatDeclarationFields,
  type CanonicalFormatKind,
  type CanonicalFormatParams,
  type FormatReferenceInput,
  type ProductCardDetailedFields,
  type ProductCardFields,
} from './builders';

export {
  packageRefsForFormatOptions,
  packageRefsForCapabilities,
  legacyFormatIdsFromOptions,
  tryLegacyFormatIdsFromOptions,
  legacyFormatIdsForFormatOption,
  legacyFormatIdsForCapability,
  FormatOptionRefsLookupError,
  CapabilityIdsLookupError,
  type PackageFormatRefs,
  type PackageCapabilityRefs,
  type FormatOptionRef,
  type FormatOptionSelector,
  type FormatOptionRefsLookupErrorCode,
  type CapabilityIdsLookupErrorCode,
} from './write-side';

export type { V1FormatId, V2ProductFormatDeclaration, V2Product, V1Product, ProjectionDiagnostic } from './types';
export {
  legacyFormatConverterFromCatalogSnapshots,
  canonicalFormatLegacyResolverFromCatalogSnapshots,
  projectionAdaptersFromCatalogSnapshots,
  type ProjectionCatalogAdapters,
  type ProjectionCatalogSnapshot,
  type ProjectionCatalogSource,
} from './catalog-snapshot';

export {
  loadCatalog,
  lookupV1Format,
  findCatalogEntryByCanonicalAndSize,
  parseSizedIdTemplate,
  _resetCatalogCache,
  type V1FormatDefinition,
  type CanonicalProjectionRef,
} from './catalog';

export { isCanonicalV1Translatable } from './canonical-properties';

export {
  CreativeFormatProjectionError,
  CreativeFormatCapabilityError,
  projectCreativeForDelivery,
  projectMediaBuyCreativesForDelivery,
  projectSyncCreativesForDelivery,
  stripLegacyCreativeIdentity,
  resolveCreativeFormatWireMode,
  type CreativeFormatSelectorContainer,
  type CanonicalCreativeFormatSelectorContainer,
  type CreativeFormatWireMode,
  type CanonicalCreativeAsset,
  type CanonicalCreativeResponse,
  type CanonicalGetProductsResponse,
  type CanonicalGetProductsRequest,
  type CanonicalCreateMediaBuyRequest,
  type CanonicalCreateMediaBuyResponse,
  type CanonicalCreativeFilters,
  type CanonicalListCreativesRequest,
  type CanonicalListCreativesResponse,
  type CanonicalGetCreativeDeliveryResponse,
  type CanonicalGetMediaBuyDeliveryResponse,
  type CanonicalGetMediaBuysResponse,
  type CanonicalListedCreative,
  type CanonicalPackageRequest,
  type CanonicalPackageUpdate,
  type CanonicalPackage,
  type CanonicalPlacement,
  type CanonicalProduct,
  type CanonicalProjectedCreative,
  type CanonicalSyncCreativesRequest,
  type CanonicalSyncCreativesResponse,
  type CanonicalUpdateMediaBuyRequest,
  type CanonicalUpdateMediaBuyResponse,
  type LegacyCreativeAsset,
  type LegacyProjectedCreative,
  type ProjectedMediaBuyCreativeRequest,
  type ProjectedSyncCreativeRequest,
  type SyncCreativeFormatProjection,
} from './creative-delivery';
