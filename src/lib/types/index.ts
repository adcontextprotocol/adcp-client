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

// Re-export Zod schemas for runtime validation
export * from './schemas.generated';
