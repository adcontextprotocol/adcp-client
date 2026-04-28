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

// Back-compat aliases for inline-enum exports collapsed in AdCP 3.0.1
// (adcp#3148 / #3174 hoisted byte-identical literal sets into shared
// `enums/*.json` files). Each alias is `@deprecated` so editor tooling
// surfaces the canonical replacement; slated for removal in the next major.
export * from './inline-enums.aliases';
