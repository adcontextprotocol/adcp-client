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

// Strict format asset slot types (hand-authored — the codegen drops the
// discriminated per-asset-type branches of Format.assets[]).
export * from './format-asset-slots';

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
