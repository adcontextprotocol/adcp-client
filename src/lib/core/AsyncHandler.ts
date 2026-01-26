/**
 * Structured async handler for AdCP webhook responses
 * Provides type-safe callbacks for each AdCP tool completion
 */

import type {
  ListCreativeFormatsResponse,
  ListCreativesResponse,
  PreviewCreativeResponse,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackResponse,
  GetSignalsResponse,
  ActivateSignalResponse,
} from '../types/tools.generated';

import type {
  AdCPAsyncResponseData,
  CreateMediaBuyAsyncInputRequired,
  CreateMediaBuyAsyncSubmitted,
  CreateMediaBuyAsyncWorking,
  CreateMediaBuyResponse,
  GetProductsAsyncInputRequired,
  GetProductsAsyncSubmitted,
  GetProductsAsyncWorking,
  GetProductsResponse,
  SyncCreativesAsyncInputRequired,
  SyncCreativesAsyncSubmitted,
  SyncCreativesAsyncWorking,
  SyncCreativesResponse,
  TaskStatus,
  TaskType,
  UpdateMediaBuyAsyncInputRequired,
  UpdateMediaBuyAsyncSubmitted,
  UpdateMediaBuyAsyncWorking,
  UpdateMediaBuyResponse,
} from '../types/core.generated';
import {
  CreateMediaBuyAsyncResponseData,
  GetProductsAsyncResponseData,
  SyncCreativesAsyncResponseData,
  UpdateMediaBuyAsyncResponseData,
} from '../types';

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
  status: TaskStatus;
  /** Server's context ID */
  context_id?: string;
  /** Human-readable context about the status change */
  message?: string;
  /** Timestamp */
  timestamp: string;
  /** raw HTTP payload */
  rawHTTPPayload?: any;
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
  response: GetProductsResponse | GetProductsAsyncSubmitted | GetProductsAsyncWorking | GetProductsAsyncInputRequired,
  metadata: WebhookMetadata
) => void | Promise<void>;

export type CreateMediaBuyStatusChangeHandler = (
  response:
    | CreateMediaBuyResponse
    | CreateMediaBuyAsyncSubmitted
    | CreateMediaBuyAsyncWorking
    | CreateMediaBuyAsyncInputRequired,
  metadata: WebhookMetadata
) => void | Promise<void>;

export type UpdateMediaBuyStatusChangeHandler = (
  response:
    | UpdateMediaBuyResponse
    | UpdateMediaBuyAsyncSubmitted
    | UpdateMediaBuyAsyncWorking
    | UpdateMediaBuyAsyncInputRequired,
  metadata: WebhookMetadata
) => void | Promise<void>;

export type SyncCreativesStatusChangeHandler = (
  response:
    | SyncCreativesResponse
    | SyncCreativesAsyncSubmitted
    | SyncCreativesAsyncWorking
    | SyncCreativesAsyncInputRequired,
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
  type: 'protocol_request' | 'protocol_response' | 'status_change' | 'webhook_received';
  operation_id: string;
  agent_id: string;
  context_id?: string;
  task_id?: string;
  task_type: string;
  status?: string;
  payload?: any;
  timestamp: string;
}

/**
 * Configuration for async handler with typed callbacks
 */
export interface AsyncHandlerConfig {
  // AdCP tool status change handlers - called for ALL status changes (completed, failed, working, input-required, submitted)
  onGetProductsStatusChange?: GetProductsStatusChangeHandler;
  onListCreativeFormatsStatusChange?: (
    data: ListCreativeFormatsResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onCreateMediaBuyStatusChange?: CreateMediaBuyStatusChangeHandler;
  onUpdateMediaBuyStatusChange?: UpdateMediaBuyStatusChangeHandler;
  onSyncCreativesStatusChange?: SyncCreativesStatusChangeHandler;
  onListCreativesStatusChange?: (response: ListCreativesResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onPreviewCreativeStatusChange?: (
    response: PreviewCreativeResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onGetMediaBuyDeliveryStatusChange?: (
    response: GetMediaBuyDeliveryResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onProvidePerformanceFeedbackStatusChange?: (
    response: ProvidePerformanceFeedbackResponse,
    metadata: WebhookMetadata
  ) => void | Promise<void>;
  onGetSignalsStatusChange?: (response: GetSignalsResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onActivateSignalStatusChange?: (response: ActivateSignalResponse, metadata: WebhookMetadata) => void | Promise<void>;

  // Fallback handler for any task status change
  onTaskStatusChange?: (response: any, metadata: WebhookMetadata) => void | Promise<void>;

  // Activity logging (low-level protocol events)
  onActivity?: (activity: Activity) => void | Promise<void>;

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
  constructor(private config: AsyncHandlerConfig) {}

  /**
   * Handle incoming webhook payload (both task completions and notifications)
   */
  async handleWebhook({
    result,
    metadata,
  }: {
    result: AdCPAsyncResponseData | undefined;
    metadata: WebhookMetadata;
  }): Promise<void> {
    // Emit activity
    await this.emitActivity({
      type: 'webhook_received',
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
      return;
    }

    // All status changes go through the specific handler
    // The handler receives metadata with status and can act accordingly
    await this.handleCompletion(metadata.task_type, result, metadata);
  }

  /**
   * Handle task completion - route to specific handler
   */
  private async handleCompletion(
    taskType: string,
    result: AdCPAsyncResponseData | undefined,
    metadata: WebhookMetadata
  ): Promise<void> {
    let handler: ((result: any, metadata: any) => void | Promise<void>) | undefined;

    // Route to specific handler based on task type
    switch (taskType) {
      case 'get_products':
        handler = this.config.onGetProductsStatusChange;
        break;

      case 'list_creative_formats':
        handler = this.config.onListCreativeFormatsStatusChange;
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

      case 'get_media_buy_delivery':
        handler = this.config.onGetMediaBuyDeliveryStatusChange;
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
    }

    // Call specific handler if configured, otherwise fallback to generic handler
    const handlerToCall = handler || this.config.onTaskStatusChange;

    if (handlerToCall) {
      try {
        await handlerToCall(result, metadata);
      } catch (error) {
        // Log error but don't crash webhook processing
        console.error(`Error in handler for task ${taskType}:`, error);
      }
    }
  }

  /**
   * Emit activity event
   */
  private async emitActivity(activity: Activity): Promise<void> {
    await this.config.onActivity?.(activity);
  }
}

/**
 * Factory function to create async handler
 */
export function createAsyncHandler(config: AsyncHandlerConfig): AsyncHandler {
  return new AsyncHandler(config);
}
