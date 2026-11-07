/**
 * Browser-safe Zod schemas for validating AdCP objects in widgets and UIs.
 *
 * Import from `@adcp/sdk/schemas/browser`. This entry exposes the generated
 * schemas and portable cross-field validators without loading the Node-only
 * JSON Schema loader or bundled schema store.
 */
export * from '../types/schemas.generated';
export { GetProductsRequestSchema, LegacyGetProductsRequestSchema } from '../validation/get-products-request';
export type { LooseObjectSchemaFor } from '../validation/get-products-request';
// Exported so adopter declaration emit can name these types through this
// entry: `GetProductsRequestSchema.extend(...)` and schemas with non-empty arrays.
export type { CanonicalGetProductsRequest } from '../v2/projection/types';
export type { NonemptyArraySchema } from '../validation/nonempty-array';
export { BiddingPolicySchema } from '../validation/bidding-policy';
export { CanonicalBudgetAllocationSchema } from '../validation/budget-allocation';
export {
  SyncCreativesItemSchema,
  SyncCreativesSuccessStrictSchema,
  SyncCreativesResponseStrictSchema,
  SyncCreativesActionSchema,
} from '../validation/sync-creatives';
export type { SyncCreativesItem, SyncCreativesSuccessStrict } from '../validation/sync-creatives';

export { MediaBuyDeliveryReportSchema } from '../validation/media-buy-delivery-report';
export type { MediaBuyDeliveryReport } from '../types/media-buy-delivery-report';
