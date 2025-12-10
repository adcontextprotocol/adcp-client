/**
 * Type guard utilities for webhook status handlers
 * Provides automatic TypeScript type narrowing based on webhook status
 */

import type { WebhookMetadata } from '../core/AsyncHandler';
import type {
  GetProductsResponse,
  GetProductsAsyncWorking,
  GetProductsAsyncInputRequired,
  GetProductsAsyncSubmitted,
  CreateMediaBuyResponse,
  CreateMediaBuyAsyncWorking,
  CreateMediaBuyAsyncInputRequired,
  CreateMediaBuyAsyncSubmitted,
  UpdateMediaBuyResponse,
  UpdateMediaBuyAsyncWorking,
  UpdateMediaBuyAsyncInputRequired,
  UpdateMediaBuyAsyncSubmitted,
  SyncCreativesResponse,
  SyncCreativesAsyncWorking,
  SyncCreativesAsyncInputRequired,
  SyncCreativesAsyncSubmitted,
} from '../types/core.generated';

// ============================================================================
// Generic Status Check Helpers
// ============================================================================

/**
 * Check if webhook status is 'completed'
 */
export function isStatusCompleted(metadata: WebhookMetadata): boolean {
  return metadata.status === 'completed';
}

/**
 * Check if webhook status is 'working'
 */
export function isStatusWorking(metadata: WebhookMetadata): boolean {
  return metadata.status === 'working';
}

/**
 * Check if webhook status is 'input-required'
 */
export function isStatusInputRequired(metadata: WebhookMetadata): boolean {
  return metadata.status === 'input-required';
}

/**
 * Check if webhook status is 'submitted'
 */
export function isStatusSubmitted(metadata: WebhookMetadata): boolean {
  return metadata.status === 'submitted';
}

/**
 * Check if webhook status is 'failed'
 */
export function isStatusFailed(metadata: WebhookMetadata): boolean {
  return metadata.status === 'failed';
}

/**
 * Check if webhook status is 'rejected'
 */
export function isStatusRejected(metadata: WebhookMetadata): boolean {
  return metadata.status === 'rejected';
}

// ============================================================================
// GetProducts Type Guards
// ============================================================================

/**
 * Type guard to check if GetProducts response is completed.
 * Automatically narrows response type to GetProductsResponse.
 *
 * @example
 * ```typescript
 * onGetProductsStatusChange: (response, metadata) => {
 *   if (isGetProductsCompleted(metadata, response)) {
 *     console.log(response.products); // ✅ TypeScript knows products exists
 *   }
 * }
 * ```
 */
export function isGetProductsCompleted(
  metadata: WebhookMetadata,
  response: any
): response is GetProductsResponse {
  return metadata.status === 'completed';
}

/**
 * Type guard to check if GetProducts response is working.
 * Automatically narrows response type to GetProductsAsyncWorking.
 *
 * @example
 * ```typescript
 * if (isGetProductsWorking(metadata, response)) {
 *   console.log(`Progress: ${response.percentage}%`);
 * }
 * ```
 */
export function isGetProductsWorking(
  metadata: WebhookMetadata,
  response: any
): response is GetProductsAsyncWorking {
  return metadata.status === 'working';
}

/**
 * Type guard to check if GetProducts response requires input.
 * Automatically narrows response type to GetProductsAsyncInputRequired.
 */
export function isGetProductsInputRequired(
  metadata: WebhookMetadata,
  response: any
): response is GetProductsAsyncInputRequired {
  return metadata.status === 'input-required';
}

/**
 * Type guard to check if GetProducts response is submitted.
 * Automatically narrows response type to GetProductsAsyncSubmitted.
 */
export function isGetProductsSubmitted(
  metadata: WebhookMetadata,
  response: any
): response is GetProductsAsyncSubmitted {
  return metadata.status === 'submitted';
}

/**
 * Type guard to check if GetProducts response failed.
 * Automatically narrows response type to GetProductsResponse.
 */
export function isGetProductsFailed(
  metadata: WebhookMetadata,
  response: any
): response is GetProductsResponse {
  return metadata.status === 'failed';
}

// ============================================================================
// CreateMediaBuy Type Guards
// ============================================================================

/**
 * Type guard to check if CreateMediaBuy response is completed.
 * Automatically narrows response type to CreateMediaBuyResponse.
 */
export function isCreateMediaBuyCompleted(
  metadata: WebhookMetadata,
  response: any
): response is CreateMediaBuyResponse {
  return metadata.status === 'completed';
}

/**
 * Type guard to check if CreateMediaBuy response is working.
 * Automatically narrows response type to CreateMediaBuyAsyncWorking.
 */
export function isCreateMediaBuyWorking(
  metadata: WebhookMetadata,
  response: any
): response is CreateMediaBuyAsyncWorking {
  return metadata.status === 'working';
}

/**
 * Type guard to check if CreateMediaBuy response requires input.
 * Automatically narrows response type to CreateMediaBuyAsyncInputRequired.
 */
export function isCreateMediaBuyInputRequired(
  metadata: WebhookMetadata,
  response: any
): response is CreateMediaBuyAsyncInputRequired {
  return metadata.status === 'input-required';
}

/**
 * Type guard to check if CreateMediaBuy response is submitted.
 * Automatically narrows response type to CreateMediaBuyAsyncSubmitted.
 */
export function isCreateMediaBuySubmitted(
  metadata: WebhookMetadata,
  response: any
): response is CreateMediaBuyAsyncSubmitted {
  return metadata.status === 'submitted';
}

/**
 * Type guard to check if CreateMediaBuy response failed.
 * Automatically narrows response type to CreateMediaBuyResponse.
 */
export function isCreateMediaBuyFailed(
  metadata: WebhookMetadata,
  response: any
): response is CreateMediaBuyResponse {
  return metadata.status === 'failed';
}

// ============================================================================
// UpdateMediaBuy Type Guards
// ============================================================================

/**
 * Type guard to check if UpdateMediaBuy response is completed.
 * Automatically narrows response type to UpdateMediaBuyResponse.
 */
export function isUpdateMediaBuyCompleted(
  metadata: WebhookMetadata,
  response: any
): response is UpdateMediaBuyResponse {
  return metadata.status === 'completed';
}

/**
 * Type guard to check if UpdateMediaBuy response is working.
 * Automatically narrows response type to UpdateMediaBuyAsyncWorking.
 */
export function isUpdateMediaBuyWorking(
  metadata: WebhookMetadata,
  response: any
): response is UpdateMediaBuyAsyncWorking {
  return metadata.status === 'working';
}

/**
 * Type guard to check if UpdateMediaBuy response requires input.
 * Automatically narrows response type to UpdateMediaBuyAsyncInputRequired.
 */
export function isUpdateMediaBuyInputRequired(
  metadata: WebhookMetadata,
  response: any
): response is UpdateMediaBuyAsyncInputRequired {
  return metadata.status === 'input-required';
}

/**
 * Type guard to check if UpdateMediaBuy response is submitted.
 * Automatically narrows response type to UpdateMediaBuyAsyncSubmitted.
 */
export function isUpdateMediaBuySubmitted(
  metadata: WebhookMetadata,
  response: any
): response is UpdateMediaBuyAsyncSubmitted {
  return metadata.status === 'submitted';
}

/**
 * Type guard to check if UpdateMediaBuy response failed.
 * Automatically narrows response type to UpdateMediaBuyResponse.
 */
export function isUpdateMediaBuyFailed(
  metadata: WebhookMetadata,
  response: any
): response is UpdateMediaBuyResponse {
  return metadata.status === 'failed';
}

// ============================================================================
// SyncCreatives Type Guards
// ============================================================================

/**
 * Type guard to check if SyncCreatives response is completed.
 * Automatically narrows response type to SyncCreativesResponse.
 */
export function isSyncCreativesCompleted(
  metadata: WebhookMetadata,
  response: any
): response is SyncCreativesResponse {
  return metadata.status === 'completed';
}

/**
 * Type guard to check if SyncCreatives response is working.
 * Automatically narrows response type to SyncCreativesAsyncWorking.
 */
export function isSyncCreativesWorking(
  metadata: WebhookMetadata,
  response: any
): response is SyncCreativesAsyncWorking {
  return metadata.status === 'working';
}

/**
 * Type guard to check if SyncCreatives response requires input.
 * Automatically narrows response type to SyncCreativesAsyncInputRequired.
 */
export function isSyncCreativesInputRequired(
  metadata: WebhookMetadata,
  response: any
): response is SyncCreativesAsyncInputRequired {
  return metadata.status === 'input-required';
}

/**
 * Type guard to check if SyncCreatives response is submitted.
 * Automatically narrows response type to SyncCreativesAsyncSubmitted.
 */
export function isSyncCreativesSubmitted(
  metadata: WebhookMetadata,
  response: any
): response is SyncCreativesAsyncSubmitted {
  return metadata.status === 'submitted';
}

/**
 * Type guard to check if SyncCreatives response failed.
 * Automatically narrows response type to SyncCreativesResponse.
 */
export function isSyncCreativesFailed(
  metadata: WebhookMetadata,
  response: any
): response is SyncCreativesResponse {
  return metadata.status === 'failed';
}
/**
 * Type guard to check if SyncCreatives response failed.
 * Automatically narrows response type to SyncCreativesResponse.
 */
export function isSyncCreativesRejected(
  metadata: WebhookMetadata,
  response: any
): response is SyncCreativesResponse {
  return metadata.status === 'rejected';
}
