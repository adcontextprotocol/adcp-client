// AdCP Core Types - Main exports for external consumers
export * from './adcp';

// Re-export key types for easier importing
export type {
  AgentConfig,
  TestResult,
  TestRequest,
  ApiResponse,
  CreativeAsset,
  CreativeFormat,
  AdvertisingProduct,
  MediaBuy,
  Targeting,
  ManageCreativeAssetsRequest,
  ManageCreativeAssetsResponse,
  SyncCreativesRequest,
  SyncCreativesResponse,
  ListCreativesRequest,
  ListCreativesResponse
} from './adcp';