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
export { BiddingPolicySchema } from '../validation/bidding-policy';
export { CanonicalBudgetAllocationSchema } from '../validation/budget-allocation';
export {
  SyncCreativesItemSchema,
  SyncCreativesSuccessStrictSchema,
  SyncCreativesResponseStrictSchema,
  SyncCreativesActionSchema,
} from '../validation/sync-creatives';
export type { SyncCreativesItem, SyncCreativesSuccessStrict } from '../validation/sync-creatives';
