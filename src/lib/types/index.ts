// AdCP Core Types - Main exports for external consumers
// ONLY export user-facing types, not internal server types

// Re-export key user-facing types
export type {
  // Agent and testing types
  AgentConfig,
  TestResult,
  TestRequest,
  ApiResponse,
  // Server-only types (exported for internal use, marked @internal in adcp.ts)
  TestResponse,
  AgentListResponse,
  // Data model types (public API)
  CreativeAsset,
  CreativeFormat,
  AdvertisingProduct,
  MediaBuy,
  Targeting,
  GeographicTargeting,
  DemographicTargeting,
  BehavioralTargeting,
  ContextualTargeting,
  DeviceTargeting,
  FrequencyCap,
  DeliverySchedule,
  DayParting,
} from './adcp';

// Re-export FormatID from generated core types
export type { FormatID } from './core.generated';

// Re-export Zod schemas for runtime validation
// ONLY export schemas users need for validation - not internal implementation schemas
export {
  // Media Buy Tool Schemas
  GetProductsRequestSchema,
  GetProductsResponseSchema,
  ListCreativeFormatsRequestSchema,
  ListCreativeFormatsResponseSchema,
  CreateMediaBuyRequestSchema,
  CreateMediaBuyResponseSchema,
  UpdateMediaBuyRequestSchema,
  UpdateMediaBuyResponseSchema,
  SyncCreativesRequestSchema,
  SyncCreativesResponseSchema,
  ListCreativesRequestSchema,
  ListCreativesResponseSchema,
  GetMediaBuyDeliveryRequestSchema,
  GetMediaBuyDeliveryResponseSchema,
  ListAuthorizedPropertiesRequestSchema,
  ListAuthorizedPropertiesResponseSchema,
  ProvidePerformanceFeedbackRequestSchema,
  ProvidePerformanceFeedbackResponseSchema,
  // Creative Tool Schemas
  BuildCreativeRequestSchema,
  BuildCreativeResponseSchema,
  PreviewCreativeRequestSchema,
  PreviewCreativeResponseSchema,
  // Signals Tool Schemas
  GetSignalsRequestSchema,
  GetSignalsResponseSchema,
  ActivateSignalRequestSchema,
  ActivateSignalResponseSchema,
  // Core data model schemas (frequently validated)
  FormatIDSchema,
  ProductSchema,
  PackageRequestSchema,
  CreativeAssetSchema,
} from './schemas.generated';
