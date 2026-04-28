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

// Re-export FormatID from generated core types
export type { FormatID } from './core.generated';

// Re-export wire request/response types adopters need when building a
// DecisioningPlatform. Source of truth is `tools.generated.ts`; this
// curated subset is the public surface so adopters never reach into
// generated files. Add new entries as new specialism platforms land.
export type {
  // Account model
  AccountReference,
  // Creative
  BuildCreativeRequest,
  CreativeManifest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  CreativeAsset,
  CreativeQuality,
  // Sales — media buy
  GetProductsRequest,
  GetProductsResponse,
  CreateMediaBuyRequest,
  CreateMediaBuySuccess,
  UpdateMediaBuyRequest,
  UpdateMediaBuySuccess,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  // Pricing models (discriminated union across pricing types)
  PricingOption,
  CPMPricingOption,
  CPCPricingOption,
  CPVPricingOption,
  // Media-channel + status enums adopters need when implementing a platform
  MediaChannel,
  AudienceStatus,
  MediaBuyStatus,
  CreativeStatus,
  // Publisher property selection (for product publisher_properties[])
  PublisherPropertySelector,
  // Reporting capability shape (per-product)
  ReportingCapabilities,
  // Audiences
  SyncAudiencesRequest,
  SyncAudiencesResponse,
  // Signals
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  ActivateSignalSuccess,
  SignalID,
  SignalValueType,
  SignalCatalogType,
  Destination,
  Deployment,
  ActivationKey,
  VendorPricingOption,
  // Capability declaration
  AdCPSpecialism,
  // Property lists — full CRUD surface for governance adopters
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
  // Collection lists — full CRUD surface for governance adopters
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
  Format,
} from './tools.generated';

// Strict format asset slot types (hand-authored — the codegen drops the
// discriminated per-asset-type branches of Format.assets[]).
export * from './format-asset-slots';

// Discriminated union of creative asset INSTANCES (what a buyer delivers
// inside `creative_manifest.assets`). Companion to format-asset-slots.ts
// (which describes what a publisher SELLS in `Format.assets[]`). The
// individual ImageAsset / VideoAsset / etc. interfaces are generated; this
// file is the missing canonical union over them.
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
