// AdCP Core Types - Main exports for external consumers
export * from './adcp';

// Re-export key types for easier importing
export type {
  AgentConfig,
  TestResult,
  TestRequest,
  ApiResponse,
  CreativeFormat,
  AdvertisingProduct,
  MediaBuy,
  Targeting,
  ManageCreativeAssetsRequest,
  ManageCreativeAssetsResponse,
  CreateMediaBuyAsyncResponseData,
  UpdateMediaBuyAsyncResponseData,
  GetProductsAsyncResponseData,
  SyncCreativesAsyncResponseData,
} from './adcp';

// Re-export the structured format identifier from generated core types.
// AdCP 3.0.1 renamed the schema title from "Format ID" to "Format Reference
// (Structured Object)" — purely a doc change, the wire shape is identical.
// We expose the new canonical name AND keep the historical `FormatID` alias
// so SDK consumers don't break across the version bump.
export type { FormatReferenceStructuredObject } from './core.generated';
import type { FormatReferenceStructuredObject } from './core.generated';
/**
 * @deprecated AdCP 3.0.1 renamed this type to `FormatReferenceStructuredObject`
 * (the wire shape is identical — pure documentation rename per the spec). This
 * alias is preserved for one minor cycle so existing imports keep compiling;
 * editor tooling will surface the rename so downstream code can migrate at its
 * own pace. Slated for removal in the next major.
 */
export type FormatID = FormatReferenceStructuredObject;

// Re-export wire request/response types adopters need when building a
// DecisioningPlatform or calling AdCP agents. Source of truth is
// `tools.generated.ts`; this curated block is the public surface so
// adopters never reach into generated files.
//
// Intentionally excluded — name conflicts with legacy adcp.ts shapes:
//   SyncCreativesRequest, ListCreativesRequest, ListCreativesResponse,
//   ManageCreativeAssetsRequest, ManageCreativeAssetsResponse (adcp.ts versions
//   already public via `export * from './adcp'` above; use those).
// Intentionally excluded — comply-runner internals, not specialism surface:
//   ComplyTestControllerRequest/Response, SeedSuccess, SimulationSuccess,
//   ControllerError, ForcedDirectiveSuccess, StateTransitionSuccess,
//   ListScenariosSuccess.
// Intentionally excluded — internal pagination/packaging sub-shapes, not
// part of the top-level tool request/response surface:
//   PaginationRequest, PaginationResponse, PackageRequest,
//   TMPResponseType, WebhookResponseType.

// Account model + account operations
export type {
  AccountReference,
  ListAccountsRequest,
  ListAccountsResponse,
  SyncAccountsRequest,
  SyncAccountsResponse,
  SyncAccountsSuccess,
  SyncAccountsError,
  GetAccountFinancialsRequest,
  GetAccountFinancialsResponse,
  GetAccountFinancialsSuccess,
  GetAccountFinancialsError,
} from './tools.generated';

// Capabilities
export type { AdCPSpecialism, GetAdCPCapabilitiesRequest, GetAdCPCapabilitiesResponse } from './tools.generated';

// Sales — media buy
export type {
  GetProductsRequest,
  GetProductsResponse,
  GetProductsAsyncSubmitted,
  CreateMediaBuyRequest,
  CreateMediaBuyResponse,
  CreateMediaBuySuccess,
  CreateMediaBuyError,
  CreateMediaBuySubmitted,
  CreateMediaBuyAsyncSubmitted,
  UpdateMediaBuyRequest,
  UpdateMediaBuyResponse,
  UpdateMediaBuySuccess,
  UpdateMediaBuyError,
  UpdateMediaBuyAsyncSubmitted,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  GetMediaBuyArtifactsRequest,
  GetMediaBuyArtifactsResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  ProvidePerformanceFeedbackSuccess,
  ProvidePerformanceFeedbackError,
  SyncPlansRequest,
  SyncPlansResponse,
  ReportUsageRequest,
  ReportUsageResponse,
  ReportPlanOutcomeRequest,
  ReportPlanOutcomeResponse,
  GetPlanAuditLogsRequest,
  GetPlanAuditLogsResponse,
} from './tools.generated';

// Pricing models (discriminated union across pricing types)
export type { PricingOption, CPMPricingOption, CPCPricingOption, CPVPricingOption } from './tools.generated';

// Media-channel + status enums; publisher property + reporting shapes
export type {
  MediaChannel,
  AudienceStatus,
  MediaBuyStatus,
  CreativeStatus,
  PublisherPropertySelector,
  ReportingCapabilities,
} from './tools.generated';

// Audiences, catalogs, event sources, and events (audience-sync + retail media)
export type {
  SyncAudiencesRequest,
  SyncAudiencesResponse,
  SyncAudiencesSuccess,
  SyncAudiencesError,
  SyncCatalogsRequest,
  SyncCatalogsResponse,
  SyncCatalogsSuccess,
  SyncCatalogsError,
  SyncCatalogsAsyncSubmitted,
  SyncEventSourcesRequest,
  SyncEventSourcesResponse,
  SyncEventSourcesSuccess,
  SyncEventSourcesError,
  LogEventRequest,
  LogEventResponse,
  LogEventSuccess,
  LogEventError,
} from './tools.generated';

// Signals
export type {
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  ActivateSignalSuccess,
  ActivateSignalError,
  SignalID,
  SignalValueType,
  SignalCatalogType,
  Destination,
  Deployment,
  ActivationKey,
  VendorPricingOption,
  SignalFilters, // embedded in GetSignalsRequest.filters
  SignalTargeting, // embedded in ActivateSignalRequest.signal_targeting
} from './tools.generated';

// Creative
export type {
  BuildCreativeRequest,
  BuildCreativeResponse,
  BuildCreativeSuccess,
  BuildCreativeError,
  BuildCreativeMultiSuccess,
  BuildCreativeAsyncSubmitted,
  CreativeManifest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  PreviewCreativeSingleResponse,
  PreviewCreativeVariantResponse,
  PreviewCreativeBatchResponse,
  PreviewBatchResultSuccess,
  PreviewBatchResultError,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  GetCreativeFeaturesRequest,
  GetCreativeFeaturesResponse,
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
  SyncCreativesResponse,
  SyncCreativesSuccess,
  SyncCreativesError,
  SyncCreativesSubmitted,
  SyncCreativesAsyncSubmitted,
  CreativeAsset,
  CreativeQuality,
  Format,
} from './tools.generated';

// Governance — property lists
export type {
  PropertyList,
  CreatePropertyListRequest,
  CreatePropertyListResponse,
  UpdatePropertyListRequest,
  UpdatePropertyListResponse,
  GetPropertyListRequest,
  GetPropertyListResponse,
  ListPropertyListsRequest,
  ListPropertyListsResponse,
  DeletePropertyListRequest,
  DeletePropertyListResponse,
} from './tools.generated';

// Governance — collection lists
export type {
  CollectionList,
  CreateCollectionListRequest,
  CreateCollectionListResponse,
  UpdateCollectionListRequest,
  UpdateCollectionListResponse,
  GetCollectionListRequest,
  GetCollectionListResponse,
  ListCollectionListsRequest,
  ListCollectionListsResponse,
  DeleteCollectionListRequest,
  DeleteCollectionListResponse,
} from './tools.generated';

// Governance — content standards + delivery validation
export type {
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  SyncGovernanceRequest,
  SyncGovernanceResponse,
  SyncGovernanceSuccess,
  SyncGovernanceError,
  CreateContentStandardsRequest,
  CreateContentStandardsResponse,
  UpdateContentStandardsRequest,
  UpdateContentStandardsResponse,
  UpdateContentStandardsSuccess,
  UpdateContentStandardsError,
  ListContentStandardsRequest,
  ListContentStandardsResponse,
  GetContentStandardsRequest,
  GetContentStandardsResponse,
  CalibrateContentRequest,
  CalibrateContentResponse,
  ValidateContentDeliveryRequest,
  ValidateContentDeliveryResponse,
} from './tools.generated';

// Sponsored intelligence
export type {
  SIGetOfferingRequest,
  SIGetOfferingResponse,
  SIInitiateSessionRequest,
  SIInitiateSessionResponse,
  SISendMessageRequest,
  SISendMessageResponse,
  SITerminateSessionRequest,
  SITerminateSessionResponse,
  SICapabilities,
  SIIdentity,
  SISessionStatus,
  SIUIElement,
} from './tools.generated';

// Strict format asset slot types (hand-authored — the codegen drops the
// discriminated per-asset-type branches of Format.assets[]).
export * from './format-asset-slots';

// Discriminated union of creative asset INSTANCES (what a buyer delivers
// inside `creative_manifest.assets`). Companion to format-asset-slots.ts
// (which describes what a publisher SELLS in `Format.assets[]`). The
// individual ImageAsset / VideoAsset / etc. interfaces are generated; this
// file is the missing canonical union over them.
// Note: tools.generated.ts also has `AssetVariant`, a narrower generated union
// that omits AudioAsset. `AssetInstance` (this file) is the curated, complete
// union — prefer it. `AssetVariant` is intentionally not re-exported.
export * from './asset-instances';

// Strict per-row types for sync_* response success arms. The codegen
// leaves these row shapes inline; named types make the discriminators
// (e.g., SyncAccountsResponseRow.action) reachable to handler authors.
export * from './sync-rows';

// Re-export Zod schemas for runtime validation
export * from './schemas.generated';

// Re-export const-array enum values (e.g., MediaChannelValues, PacingValues)
// for consumers that need to enumerate or validate against the spec's
// literal sets without re-deriving them from Zod schemas.
export * from './enums.generated';

// Re-export inline-union value arrays for anonymous string-literal unions
// inside named schemas (e.g., ImageAssetRequirements_FormatsValues,
// VideoAssetRequirements_ContainersValues). Companion to enums.generated;
// see scripts/generate-inline-enum-arrays.ts.
export * from './inline-enums.generated';

// Back-compat aliases for inline-enum exports collapsed in AdCP 3.0.1
// (adcp#3148 / #3174 hoisted byte-identical literal sets into shared
// `enums/*.json` files). Each alias is `@deprecated` so editor tooling
// surfaces the canonical replacement; slated for removal in the next major.
export * from './inline-enums.aliases';

// Back-compat aliases for the 6 error-details schemas renamed in AdCP 3.0.x
// (adcp#3149 / adcp#3566 canonicalized SCREAMING_SNAKE titles into Title Case).
// Each alias is `@deprecated`; slated for removal in the next major.
export * from './error-details.aliases';
