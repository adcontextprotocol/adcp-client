/**
 * Structured async handler for AdCP webhook responses
 * Provides type-safe callbacks for each AdCP tool completion
 */

import { createHash, randomUUID } from 'node:crypto';

import type { IdempotencyBackend, IdempotencyCacheEntry } from '../server/idempotency/store';
import { canonicalize } from '../utils/jcs';
import type {
  ListCreativeFormatsResponse,
  ListCreativesResponse,
  PreviewCreativeResponse,
  BuildCreativeResponse,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryResponse,
  GetCreativeDeliveryResponse,
  ProvidePerformanceFeedbackResponse,
  GetSignalsResponse,
  ActivateSignalResponse,
  ListAccountsResponse,
  SyncAccountsResponse,
  SyncAudiencesResponse,
  CreatePropertyListResponse,
  GetPropertyListResponse,
  UpdatePropertyListResponse,
  ListPropertyListsResponse,
  DeletePropertyListResponse,
  ListContentStandardsResponse,
  GetContentStandardsResponse,
  CalibrateContentResponse,
  ValidateContentDeliveryResponse,
  SIGetOfferingResponse,
  SIInitiateSessionResponse,
  SISendMessageResponse,
  SITerminateSessionResponse,
  CreateMediaBuyResponse,
  GetProductsResponse,
  UpdateMediaBuyResponse,
  SyncCreativesResponse,
} from '../types/tools.generated';

import type {
  AdCPAsyncResponseData,
  CreateMediaBuyAsyncInputRequired,
  CreateMediaBuyAsyncSubmitted,
  CreateMediaBuyAsyncWorking,
  GetProductsAsyncInputRequired,
  GetProductsAsyncSubmitted,
  GetProductsAsyncWorking,
  SyncCreativesAsyncInputRequired,
  SyncCreativesAsyncSubmitted,
  SyncCreativesAsyncWorking,
  TaskType,
  UpdateMediaBuyAsyncInputRequired,
  UpdateMediaBuyAsyncSubmitted,
  UpdateMediaBuyAsyncWorking,
} from '../types/core.generated';
import type { TaskResultMetadata } from './ConversationTypes';
import {
  CreateMediaBuyAsyncResponseData,
  GetProductsAsyncResponseData,
  SyncCreativesAsyncResponseData,
  UpdateMediaBuyAsyncResponseData,
} from '../types';
import type {
  CanonicalCreativeResponse,
  CanonicalGetProductsResponse,
  CanonicalListCreativesResponse,
} from '../v2/projection/creative-delivery';

/**
 * Metadata provided with webhook responses
 */
export interface WebhookMetadata {
  /** Client-provided operation ID */
  operation_id: string;
  /** Server's task ID */
  task_id: string;
  /** Agent ID */
  agent_id: string;
  /** Task type/tool name */
  task_type: string;
  /** Task status (completed, failed, needs_input, working, etc) */
  status: TaskResultMetadata['status'] | 'unknown';
  /** Server's context ID */
  context_id?: string;
  /** Human-readable context about the status change */
  message?: string;
  /** Timestamp */
  timestamp: string;
  /** raw HTTP payload */
  rawHTTPPayload?: any;
  /**
   * Wire protocol that delivered this webhook. Useful for handler code that
   * needs to treat MCP and A2A transports differently.
   */
  protocol?: 'mcp' | 'a2a';
  /**
   * Sender-generated key stable across retries of the same webhook event
   * (top-level for MCP, structured DataPart for A2A). Use this as the
   * canonical dedup key; see `AsyncHandlerConfig.webhookDedup`.
   */
  idempotency_key?: string;
  /**
   * Buyer-side product property policy evaluation for completed get_products
   * webhooks. Present when the client filters, audits, or rejects a webhook
   * result before dispatching it to handlers.
   */
  productPropertyPolicy?: TaskResultMetadata['productPropertyPolicy'];
  /**
   * Buyer-side pricing-options enforcement summary for completed get_products
   * webhooks. Present when the client drops products that arrived without a
   * usable `pricing_options[]` array before dispatching to handlers.
   */
  productPricingPolicy?: TaskResultMetadata['productPricingPolicy'];
}

/** Sender-controlled webhook input that must map to a stable 4xx response. */
export class WebhookDedupInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDedupInputError';
  }
}

/** A valid sender key was reused for a different authenticated callback value. */
export class WebhookDedupConflictError extends Error {
  constructor(message = 'Webhook idempotency key was reused for a different callback payload.') {
    super(message);
    this.name = 'WebhookDedupConflictError';
  }
}

/**
 * Metadata for agent-initiated notifications
 * Same as WebhookMetadata but includes notification-specific fields
 */
export interface NotificationMetadata extends WebhookMetadata {
  /** Notification type */
  notification_type: 'scheduled' | 'final' | 'delayed';
  /** Sequence number of this notification */
  sequence_number?: number;
  /** When next notification is expected (not present for 'final') */
  next_expected_at?: string;
}

// Simple union-typed handlers for webhook status changes
export type GetProductsStatusChangeHandler = (
  response:
    | CanonicalGetProductsResponse
    | GetProductsAsyncSubmitted
    | GetProductsAsyncWorking
    | GetProductsAsyncInputRequired,
  metadata: WebhookMetadata
) => void | Promise<void>;

export type CreateMediaBuyStatusChangeHandler = (
  response: CanonicalCreativeResponse<
    | CreateMediaBuyResponse
    | CreateMediaBuyAsyncSubmitted
    | CreateMediaBuyAsyncWorking
    | CreateMediaBuyAsyncInputRequired
  >,
  metadata: WebhookMetadata
) => void | Promise<void>;

export type UpdateMediaBuyStatusChangeHandler = (
  response: CanonicalCreativeResponse<
    | UpdateMediaBuyResponse
    | UpdateMediaBuyAsyncSubmitted
    | UpdateMediaBuyAsyncWorking
    | UpdateMediaBuyAsyncInputRequired
  >,
  metadata: WebhookMetadata
) => void | Promise<void>;

export type SyncCreativesStatusChangeHandler = (
  response: CanonicalCreativeResponse<
    SyncCreativesResponse | SyncCreativesAsyncSubmitted | SyncCreativesAsyncWorking | SyncCreativesAsyncInputRequired
  >,
  metadata: WebhookMetadata
) => void | Promise<void>;

/**
 * Media buy delivery notification payload (PR #81)
 * Agent-initiated periodic reporting, not tied to any client operation
 */
export interface MediaBuyDeliveryNotification {
  /** Type of notification */
  notification_type: 'scheduled' | 'final' | 'delayed';
  /** Sequential notification number (starts at 1) */
  sequence_number?: number;
  /** When next notification is expected (omitted for 'final') */
  next_expected_at?: string;
  /** Reporting period for this notification */
  reporting_period?: {
    start: string;
    end: string;
  };
  /** Currency used for financial metrics */
  currency?: string;
  /** Array of media buy deliveries being reported */
  media_buy_deliveries?: Array<{
    media_buy_id: string;
    impressions?: number;
    clicks?: number;
    spend?: number;
    conversions?: number;
    [key: string]: any;
  }>;
}

/**
 * Activity event for logging/observability
 */
export interface Activity {
  type:
    | 'protocol_request'
    | 'protocol_response'
    | 'status_change'
    | 'webhook_received'
    | 'webhook_duplicate'
    | 'governance_check'
    | 'governance_outcome';
  operation_id: string;
  agent_id: string;
  context_id?: string;
  task_id?: string;
  task_type: string;
  status?: string;
  /**
   * Full AdCP response payload. Populated on `webhook_received` and
   * protocol/status events. INTENTIONALLY omitted on `webhook_duplicate`
   * to avoid re-logging potentially-sensitive data on every retry — the
   * originating `webhook_received` event already carries it. Correlate
   * the two via `idempotency_key`.
   */
  payload?: any;
  /**
   * Webhook idempotency key when available. Present on `webhook_received`
   * and `webhook_duplicate` events from MCP envelopes, enabling
   * correlation between a first delivery and its retry echoes.
   */
  idempotency_key?: string;
  timestamp: string;
}

/**
 * Configuration for async handler with typed callbacks
 */
export interface AsyncHandlerConfig {
  // AdCP tool status change handlers - called for ALL status changes (completed, failed, working, input-required, submitted)
  onGetProductsStatusChange?: GetProductsStatusChangeHandler;
  onListCreativeFormatsLegacyStatusChange?: (
    data: ListCreativeFormatsResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onCreateMediaBuyStatusChange?: CreateMediaBuyStatusChangeHandler;
  onUpdateMediaBuyStatusChange?: UpdateMediaBuyStatusChangeHandler;
  onSyncCreativesStatusChange?: SyncCreativesStatusChangeHandler;
  onListCreativesStatusChange?: (
    response: CanonicalListCreativesResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onPreviewCreativeStatusChange?: (
    response: CanonicalCreativeResponse<PreviewCreativeResponse>,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  /** @deprecated Use `onPreviewCreativeStatusChange`. */
  onPreviewCreativeLegacyStatusChange?: (
    response: PreviewCreativeResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onGetMediaBuysStatusChange?: (
    response: CanonicalCreativeResponse<GetMediaBuysResponse>,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onGetMediaBuyDeliveryStatusChange?: (
    response: CanonicalCreativeResponse<GetMediaBuyDeliveryResponse>,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onGetCreativeDeliveryStatusChange?: (
    response: CanonicalCreativeResponse<GetCreativeDeliveryResponse>,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onProvidePerformanceFeedbackStatusChange?: (
    response: ProvidePerformanceFeedbackResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onGetSignalsStatusChange?: (response: GetSignalsResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onActivateSignalStatusChange?: (response: ActivateSignalResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onBuildCreativeLegacyStatusChange?: (
    response: BuildCreativeResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onListAccountsStatusChange?: (response: ListAccountsResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onSyncAccountsStatusChange?: (response: SyncAccountsResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onSyncAudiencesStatusChange?: (response: SyncAudiencesResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onCreatePropertyListStatusChange?: (
    response: CreatePropertyListResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onGetPropertyListStatusChange?: (
    response: GetPropertyListResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onUpdatePropertyListStatusChange?: (
    response: UpdatePropertyListResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onListPropertyListsStatusChange?: (
    response: ListPropertyListsResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onDeletePropertyListStatusChange?: (
    response: DeletePropertyListResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onListContentStandardsLegacyStatusChange?: (
    response: ListContentStandardsResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onGetContentStandardsLegacyStatusChange?: (
    response: GetContentStandardsResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onCalibrateContentLegacyStatusChange?: (
    response: CalibrateContentResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onValidateContentDeliveryLegacyStatusChange?: (
    response: ValidateContentDeliveryResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onSIGetOfferingStatusChange?: (response: SIGetOfferingResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onSIInitiateSessionStatusChange?: (
    response: SIInitiateSessionResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onSISendMessageStatusChange?: (response: SISendMessageResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onSITerminateSessionStatusChange?: (
    response: SITerminateSessionResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;

  // Fallback handler for any task status change
  onTaskStatusChange?: (response: any, metadata: WebhookMetadata) => void | Promise<void>;

  // Activity logging (low-level protocol events)
  onActivity?: (activity: Activity) => void | Promise<void>;

  /**
   * Receiver-side deduplication of webhook payloads by `idempotency_key`.
   *
   * AdCP webhooks use at-least-once delivery — publishers retry until they
   * see a 2xx, so the same event may arrive more than once. When configured,
   * the first delivery for a given `(agent_id, idempotency_key)` tuple
   * dispatches to handlers; subsequent deliveries are dropped and surface
   * as a `webhook_duplicate` activity.
   *
   * Reuses `IdempotencyBackend` from `@adcp/sdk/server` — you can share
   * the same backend across request-side and webhook-side dedup, or use a
   * dedicated one. Scope is per-agent so keys from different senders are
   * independent, matching the spec's "scoped to authenticated sender
   * identity" rule.
   *
   * Every delivery without `idempotency_key`, and every malformed present
   * key, fails before handler dispatch. Older A2A senders that cannot emit
   * the field must leave dedup disabled rather than silently bypassing it.
   */
  webhookDedup?: {
    backend: IdempotencyBackend;
    /** Retention for dedup keys. Defaults to 86_400 (24h). */
    ttlSeconds?: number;
    /**
     * Optional renewable processing-claim lease.
     *
     * By default, an in-progress claim uses the full `ttlSeconds` retention
     * window. That durable fence prioritizes duplicate-side-effect safety if
     * a backend renewal fails while an unconstrained application handler is
     * still running. Setting a shorter value explicitly opts into automatic
     * crash recovery after that lease. Because generic handlers cannot be
     * cancelled or transactionally fenced by this SDK, handlers used with a
     * shorter lease MUST make their own side effects idempotent.
     */
    inFlightTtlSeconds?: number;
  };

  // Notification handlers (agent-initiated, no operation_id)
  onMediaBuyDeliveryNotification?: (
    notification: MediaBuyDeliveryNotification,
    metadata: NotificationMetadata
  ) => void | Promise<void>;
}

/**
 * Async handler class
 */
export class AsyncHandler {
  constructor(private config: AsyncHandlerConfig) {
    const dedup = config.webhookDedup;
    const backend = dedup?.backend;
    if (
      backend &&
      (typeof backend.replaceIfPayloadHash !== 'function' || typeof backend.deleteIfPayloadHash !== 'function')
    ) {
      throw new Error(
        'handlers.webhookDedup.backend must implement atomic replaceIfPayloadHash() and deleteIfPayloadHash().'
      );
    }
    if (dedup?.ttlSeconds !== undefined && (!Number.isSafeInteger(dedup.ttlSeconds) || dedup.ttlSeconds <= 0)) {
      throw new Error('handlers.webhookDedup.ttlSeconds must be a positive safe integer.');
    }
    if (
      dedup?.inFlightTtlSeconds !== undefined &&
      (!Number.isSafeInteger(dedup.inFlightTtlSeconds) || dedup.inFlightTtlSeconds <= 0)
    ) {
      throw new Error('handlers.webhookDedup.inFlightTtlSeconds must be a positive safe integer.');
    }
  }

  /** Emit duplicate observability without re-running public result handlers. */
  async handleDurableSettlementDuplicate(metadata: WebhookMetadata): Promise<void> {
    await this.emitActivity({
      type: 'webhook_duplicate',
      operation_id: metadata.operation_id,
      agent_id: metadata.agent_id,
      context_id: metadata.context_id,
      task_id: metadata.task_id,
      task_type: metadata.task_type,
      status: metadata.status,
      idempotency_key: metadata.idempotency_key,
      timestamp: metadata.timestamp,
    });
  }

  /**
   * Publish a result whose single-winner ownership is already enforced by an
   * SDK durable outbox. This is not a sender webhook event, so it must not
   * enter sender-key webhook deduplication or require an `idempotency_key`.
   * @internal
   */
  async handleDurablySettledResult({
    result,
    metadata,
    previewHandler,
  }: {
    result: AdCPAsyncResponseData | undefined;
    metadata: WebhookMetadata;
    previewHandler?: 'canonical' | 'legacy';
  }): Promise<void> {
    await this.handleCompletion(metadata.task_type, result, metadata, previewHandler);
  }

  /**
   * Validate sender-controlled dedup identity before callers mutate durable
   * settlement state. `handleWebhook()` repeats this check for direct users;
   * `SingleAgentClient` invokes it earlier because durable recovery must run
   * before the public result handler.
   */
  assertWebhookDedupInput(metadata: WebhookMetadata): void {
    if (!this.config.webhookDedup) return;
    if (typeof metadata.agent_id !== 'string' || metadata.agent_id.length === 0 || metadata.agent_id.length > 2048) {
      throw new WebhookDedupInputError('Webhook agent_id must be a non-empty string of at most 2048 characters.');
    }
    const key = metadata.idempotency_key;
    if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new WebhookDedupInputError(
        `Webhook idempotency_key is ${key ? 'invalid' : 'required'} when webhookDedup is enabled. ` +
          `Expected format: ${IDEMPOTENCY_KEY_PATTERN.source}.`
      );
    }
  }

  /**
   * Handle incoming webhook payload (both task completions and notifications)
   */
  async handleWebhook({
    result,
    metadata,
    previewHandler,
  }: {
    result: AdCPAsyncResponseData | undefined;
    metadata: WebhookMetadata;
    /** Preserves the originating preview API across async completion. */
    previewHandler?: 'canonical' | 'legacy';
  }): Promise<'handled' | 'already_handled' | 'in_progress'> {
    const dedupClaim = await this.claimWebhook(metadata, result);
    if (dedupClaim.outcome !== 'claimed') {
      await this.emitActivity({
        type: 'webhook_duplicate',
        operation_id: metadata.operation_id,
        agent_id: metadata.agent_id,
        context_id: metadata.context_id,
        task_id: metadata.task_id,
        task_type: metadata.task_type,
        status: metadata.status,
        idempotency_key: metadata.idempotency_key,
        timestamp: metadata.timestamp,
      });
      return dedupClaim.outcome;
    }

    const stopClaimRenewal = this.startWebhookClaimRenewal(dedupClaim);
    let handlerCompleted = false;
    let renewalStopped = false;
    try {
      // Emit activity
      await this.emitActivity({
        type: 'webhook_received',
        idempotency_key: metadata.idempotency_key,
        operation_id: metadata.operation_id,
        agent_id: metadata.agent_id,
        context_id: metadata.context_id,
        task_id: metadata.task_id,
        task_type: metadata.task_type,
        status: metadata.status,
        payload: result,
        timestamp: metadata.timestamp,
      });

      // Check if this is a notification (media_buy_delivery with notification_type)
      // Notifications are treated like status updates for an ongoing "get delivery report" operation
      // The operation_id (from URL) groups all reports for the same agent + month
      if (
        metadata.task_type === 'media_buy_delivery' &&
        result &&
        typeof result === 'object' &&
        'notification_type' in result
      ) {
        const notificationPayload = result as unknown as MediaBuyDeliveryNotification;

        // Build notification metadata
        // operation_id comes from webhook URL and was lazily generated from agent + month
        const notificationMetadata: NotificationMetadata = {
          ...metadata,
          notification_type: notificationPayload.notification_type,
          sequence_number: notificationPayload.sequence_number,
          next_expected_at: notificationPayload.next_expected_at,
        };

        await this.config.onMediaBuyDeliveryNotification?.(notificationPayload, notificationMetadata);
      } else {
        // All status changes go through the specific handler
        // The handler receives metadata with status and can act accordingly
        await this.handleCompletion(metadata.task_type, result, metadata, previewHandler);
      }

      handlerCompleted = true;
      await stopClaimRenewal();
      renewalStopped = true;

      if (dedupClaim.claimKey && dedupClaim.claimToken && this.config.webhookDedup) {
        const handledMarker: WebhookDedupHandledMarker = {
          state: WEBHOOK_DEDUP_HANDLED,
          eventFingerprint: dedupClaim.eventFingerprint ?? '',
        };
        const handledExpiresAt = Math.floor(Date.now() / 1000) + dedupClaim.ttlSeconds!;
        const published = await this.config.webhookDedup.backend.replaceIfPayloadHash(
          dedupClaim.claimKey,
          dedupClaim.claimToken,
          {
            // A unique publication generation prevents an expired-marker
            // ABA: a stale taker cannot match a later receiver's handled
            // marker even when both callbacks have the same fingerprint.
            payloadHash: `${WEBHOOK_DEDUP_HANDLED}:${randomUUID()}`,
            response: handledMarker,
            // Retention starts when processing completes, not when it was
            // claimed. Long-running handlers therefore receive the full
            // configured duplicate fence after their side effects finish.
            expiresAt: handledExpiresAt,
            retainUntil: handledExpiresAt,
          }
        );
        if (!published) {
          throw new Error('Webhook processing claim was lost before handler publication completed.');
        }
      }
      return 'handled';
    } catch (error) {
      if (!handlerCompleted && dedupClaim.claimKey && dedupClaim.claimToken && this.config.webhookDedup) {
        try {
          await this.config.webhookDedup.backend.deleteIfPayloadHash(dedupClaim.claimKey, dedupClaim.claimToken);
        } catch (rollbackError) {
          console.error(
            `Error rolling back webhook dedup claim for task ${metadata.task_type}:`,
            rollbackError instanceof Error ? rollbackError.message : 'unknown error'
          );
        }
      }
      throw error;
    } finally {
      if (!renewalStopped) await stopClaimRenewal();
    }
  }

  private startWebhookClaimRenewal(claim: WebhookDedupClaim): () => Promise<void> {
    const dedup = this.config.webhookDedup;
    if (!dedup || !claim.claimKey || !claim.claimToken || !claim.claimTtlSeconds) return async () => undefined;
    let stopped = false;
    let renewalPending: Promise<void> | undefined;
    const intervalMs = Math.max(250, Math.floor((claim.claimTtlSeconds * 1000) / 3));
    const timer = setInterval(() => {
      if (stopped || renewalPending) return;
      renewalPending = (async () => {
        try {
          const nowSeconds = Math.floor(Date.now() / 1000);
          const currentToken = claim.claimToken!;
          const renewed = await dedup.backend.replaceIfPayloadHash(claim.claimKey!, currentToken, {
            // Keep the owner token stable. If the backend commits and the
            // response is lost, the receiver can safely retry renewal or
            // publish with the same token. Atomic expiry-aware putIfAbsent
            // prevents stale readers from taking over a renewed live claim.
            payloadHash: currentToken,
            response: { claimToken: currentToken, eventFingerprint: claim.eventFingerprint },
            expiresAt: nowSeconds + claim.claimTtlSeconds!,
            retainUntil: nowSeconds + claim.claimTtlSeconds!,
          });
          if (!renewed) {
            stopped = true;
            clearInterval(timer);
          }
        } catch {
          // A transient backend error is not proof that ownership was lost.
          // Keep retrying while this process is active; stopping forever on
          // one failed renewal would guarantee expiry and permit a second
          // receiver to enter while this handler is still running.
        } finally {
          renewalPending = undefined;
        }
      })();
    }, intervalMs);
    timer.unref?.();
    return async () => {
      stopped = true;
      clearInterval(timer);
      if (renewalPending) await renewalPending;
    };
  }

  /**
   * Handle task completion - route to specific handler
   */
  private async handleCompletion(
    taskType: string,
    result: AdCPAsyncResponseData | undefined,
    metadata: WebhookMetadata,
    previewHandler?: 'canonical' | 'legacy'
  ): Promise<void> {
    let handler: ((result: any, metadata: any) => void | Promise<void>) | undefined;

    // Route to specific handler based on task type
    switch (taskType) {
      case 'get_products':
        handler = this.config.onGetProductsStatusChange;
        break;

      case 'list_creative_formats':
        handler = this.config.onListCreativeFormatsLegacyStatusChange;
        break;

      case 'preview_creative':
        handler =
          previewHandler === 'legacy'
            ? (this.config.onPreviewCreativeLegacyStatusChange ?? this.config.onPreviewCreativeStatusChange)
            : (this.config.onPreviewCreativeStatusChange ?? this.config.onPreviewCreativeLegacyStatusChange);
        break;

      case 'build_creative':
        handler = this.config.onBuildCreativeLegacyStatusChange;
        break;

      case 'create_media_buy':
        handler = this.config.onCreateMediaBuyStatusChange;
        break;

      case 'update_media_buy':
        handler = this.config.onUpdateMediaBuyStatusChange;
        break;

      case 'sync_creatives':
        handler = this.config.onSyncCreativesStatusChange;
        break;

      case 'list_creatives':
        handler = this.config.onListCreativesStatusChange;
        break;

      case 'get_media_buys':
        handler = this.config.onGetMediaBuysStatusChange;
        break;

      case 'get_media_buy_delivery':
        handler = this.config.onGetMediaBuyDeliveryStatusChange;
        break;

      case 'get_creative_delivery':
        handler = this.config.onGetCreativeDeliveryStatusChange;
        break;

      case 'provide_performance_feedback':
        handler = this.config.onProvidePerformanceFeedbackStatusChange;
        break;

      case 'get_signals':
        handler = this.config.onGetSignalsStatusChange;
        break;

      case 'activate_signal':
        handler = this.config.onActivateSignalStatusChange;
        break;

      case 'list_content_standards':
        handler = this.config.onListContentStandardsLegacyStatusChange;
        break;

      case 'get_content_standards':
        handler = this.config.onGetContentStandardsLegacyStatusChange;
        break;

      case 'calibrate_content':
        handler = this.config.onCalibrateContentLegacyStatusChange;
        break;

      case 'validate_content_delivery':
        handler = this.config.onValidateContentDeliveryLegacyStatusChange;
        break;
    }

    // Call specific handler if configured, otherwise fallback to generic handler
    const handlerToCall = handler || this.config.onTaskStatusChange;

    if (handlerToCall) {
      try {
        await handlerToCall(result, metadata);
      } catch (error) {
        console.error(
          `Error in handler for task ${taskType}:`,
          error instanceof Error ? error.message : 'unknown error'
        );
        throw error;
      }
    }
  }

  /**
   * Emit activity event
   */
  private async emitActivity(activity: Activity): Promise<void> {
    await this.config.onActivity?.(activity);
  }

  /**
   * Claim the webhook for processing. A failed dispatch rolls this claim
   * back so the sender can retry the same event; successful dispatch keeps it.
   *
   * Uses `IdempotencyBackend.putIfAbsent` so concurrent retries race on a
   * single claim: exactly one caller gets `true` and proceeds, the rest
   * observe the existing entry and return.
   */
  private async claimWebhook(
    metadata: WebhookMetadata,
    result: AdCPAsyncResponseData | undefined
  ): Promise<WebhookDedupClaim> {
    const dedup = this.config.webhookDedup;
    if (!dedup) return { outcome: 'claimed' };

    this.assertWebhookDedupInput(metadata);
    const key = metadata.idempotency_key!;

    const ttlSeconds = dedup.ttlSeconds ?? 86_400;
    const claimTtlSeconds = Math.min(ttlSeconds, dedup.inFlightTtlSeconds ?? ttlSeconds);
    // Reserved prefix `adcp\u001fwebhook\u001fv1\u001f...` namespaces the
    // claim so webhook dedup entries can coexist with request-side
    // idempotency entries in a shared backend — a request-side principal
    // can never produce a scoped key with this prefix because the
    // principal regex excludes U+001F.
    const agentScope = createHash('sha256').update(metadata.agent_id).digest('base64url');
    const completedKey = `adcp\u001fwebhook\u001fv1\u001f${agentScope}\u001f${key}`;
    // One record transitions atomically from owner token to handled marker.
    // A separate completion key would create a check-then-put publication
    // race where a stale owner could publish after losing its lease.
    const claimKey = completedKey;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claimExpiresAt = nowSeconds + claimTtlSeconds;
    const eventFingerprint = createHash('sha256')
      .update(
        canonicalize({
          operationId: metadata.operation_id,
          taskId: metadata.task_id,
          taskType: metadata.task_type,
          status: metadata.status,
          contextId: metadata.context_id ?? null,
          message: metadata.message ?? null,
          result: result ?? null,
        })
      )
      .digest('base64url');
    const completed = await dedup.backend.get(completedKey);
    const completedFingerprint = webhookHandledFingerprint(completed);
    if (completedFingerprint !== undefined && completed!.expiresAt >= nowSeconds) {
      if (completedFingerprint !== eventFingerprint) {
        throw new WebhookDedupConflictError();
      }
      return { outcome: 'already_handled' };
    }

    const claimToken = randomUUID();
    const claimEntry = {
      payloadHash: claimToken,
      response: { claimToken, eventFingerprint },
      expiresAt: claimExpiresAt,
      retainUntil: claimExpiresAt,
    };
    // Atomic logical-expiry takeover belongs in putIfAbsent. A read-derived
    // CAS can overwrite a claim renewed after this receiver's stale read, or
    // a newly published handled marker whose fingerprint matches an older
    // generation (ABA).
    const claimed = await dedup.backend.putIfAbsent(claimKey, claimEntry);
    if (claimed) {
      const fenced = await dedup.backend.replaceIfPayloadHash(claimKey, claimToken, {
        payloadHash: claimToken,
        response: { claimToken, eventFingerprint },
        expiresAt: claimExpiresAt,
        retainUntil: claimExpiresAt,
      });
      if (!fenced) throw new Error('Webhook processing claim could not establish atomic ownership.');
      return {
        outcome: 'claimed',
        completedKey,
        claimKey,
        claimToken,
        claimTtlSeconds,
        ttlSeconds,
        eventFingerprint,
      };
    }
    const completedAfterRace = await dedup.backend.get(completedKey);
    const racedFingerprint = webhookHandledFingerprint(completedAfterRace);
    if (racedFingerprint !== undefined && completedAfterRace!.expiresAt >= nowSeconds) {
      if (racedFingerprint !== eventFingerprint) {
        throw new WebhookDedupConflictError();
      }
      return { outcome: 'already_handled' };
    }
    const activeFingerprint = webhookActiveClaimFingerprint(completedAfterRace);
    if (
      activeFingerprint !== undefined &&
      completedAfterRace!.expiresAt >= nowSeconds &&
      activeFingerprint !== eventFingerprint
    ) {
      throw new WebhookDedupConflictError();
    }
    return { outcome: 'in_progress' };
  }
}

interface WebhookDedupClaim {
  outcome: 'claimed' | 'already_handled' | 'in_progress';
  completedKey?: string;
  claimKey?: string;
  claimToken?: string;
  claimTtlSeconds?: number;
  ttlSeconds?: number;
  eventFingerprint?: string;
}

// AdCP spec: `^[A-Za-z0-9_.:-]{16,255}$`. Any key not matching this
// pattern is malformed and fails closed before a scoped key or handler
// dispatch can be formed from arbitrary sender-supplied bytes.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;
const WEBHOOK_DEDUP_HANDLED = 'adcp_webhook_handled_v1';

interface WebhookDedupHandledMarker {
  state: typeof WEBHOOK_DEDUP_HANDLED;
  eventFingerprint: string;
}

interface WebhookDedupActiveClaimMarker {
  claimToken: string;
  eventFingerprint: string;
}

function webhookActiveClaimFingerprint(entry: IdempotencyCacheEntry | null): string | undefined {
  if (!entry?.response || typeof entry.response !== 'object') return undefined;
  const response = entry.response as Partial<WebhookDedupActiveClaimMarker>;
  if (
    typeof response.claimToken === 'string' &&
    response.claimToken === entry.payloadHash &&
    typeof response.eventFingerprint === 'string'
  ) {
    return response.eventFingerprint;
  }
  return undefined;
}

function webhookHandledFingerprint(entry: IdempotencyCacheEntry | null): string | undefined {
  if (!entry) return undefined;
  // Accept markers written by the first webhook-dedup implementation so an
  // in-place SDK upgrade retains its existing duplicate fence.
  if (entry.response === WEBHOOK_DEDUP_HANDLED) return entry.payloadHash;
  if (
    entry.response &&
    typeof entry.response === 'object' &&
    (entry.response as Partial<WebhookDedupHandledMarker>).state === WEBHOOK_DEDUP_HANDLED &&
    typeof (entry.response as Partial<WebhookDedupHandledMarker>).eventFingerprint === 'string'
  ) {
    return (entry.response as WebhookDedupHandledMarker).eventFingerprint;
  }
  return undefined;
}

/**
 * Factory function to create async handler
 */
export function createAsyncHandler(config: AsyncHandlerConfig): AsyncHandler {
  return new AsyncHandler(config);
}
