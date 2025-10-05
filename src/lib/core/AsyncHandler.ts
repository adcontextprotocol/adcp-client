/**
 * Structured async handler for AdCP webhook responses
 * Provides type-safe callbacks for each AdCP tool completion
 */

import type {
  GetProductsResponse,
  ListCreativeFormatsResponse,
  CreateMediaBuyResponse,
  UpdateMediaBuyResponse,
  SyncCreativesResponse,
  ListCreativesResponse,
  GetMediaBuyDeliveryResponse,
  ListAuthorizedPropertiesResponse,
  ProvidePerformanceFeedbackResponse,
  GetSignalsResponse,
  ActivateSignalResponse
} from '../types/tools.generated';

/**
 * Metadata provided with webhook responses
 */
export interface WebhookMetadata {
  /** Client-provided operation ID */
  operation_id: string;
  /** Server's context ID */
  context_id?: string;
  /** Server's task ID */
  task_id?: string;
  /** Agent ID */
  agent_id: string;
  /** Task type/tool name */
  task_type: string;
  /** Timestamp */
  timestamp: string;
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
  // AdCP tool completion handlers
  onGetProductsComplete?: (response: GetProductsResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onListCreativeFormatsComplete?: (response: ListCreativeFormatsResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onCreateMediaBuyComplete?: (response: CreateMediaBuyResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onUpdateMediaBuyComplete?: (response: UpdateMediaBuyResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onSyncCreativesComplete?: (response: SyncCreativesResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onListCreativesComplete?: (response: ListCreativesResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onGetMediaBuyDeliveryComplete?: (response: GetMediaBuyDeliveryResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onListAuthorizedPropertiesComplete?: (response: ListAuthorizedPropertiesResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onProvidePerformanceFeedbackComplete?: (response: ProvidePerformanceFeedbackResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onGetSignalsComplete?: (response: GetSignalsResponse, metadata: WebhookMetadata) => void | Promise<void>;
  onActivateSignalComplete?: (response: ActivateSignalResponse, metadata: WebhookMetadata) => void | Promise<void>;

  // Status handlers
  onTaskSubmitted?: (metadata: WebhookMetadata) => void | Promise<void>;
  onTaskWorking?: (metadata: WebhookMetadata, message?: string) => void | Promise<void>;
  onTaskFailed?: (metadata: WebhookMetadata, error: string) => void | Promise<void>;

  // Fallback handler
  onTaskComplete?: (response: any, metadata: WebhookMetadata) => void | Promise<void>;

  // Activity logging
  onActivity?: (activity: Activity) => void | Promise<void>;

  // Notification handlers (agent-initiated, no operation_id)
  onMediaBuyDeliveryNotification?: (notification: MediaBuyDeliveryNotification, metadata: NotificationMetadata) => void | Promise<void>;
}

/**
 * Webhook payload structure
 */
export interface WebhookPayload {
  operation_id: string;
  context_id?: string;
  task_id?: string;
  task_type: string;
  status: string;
  result?: any;
  error?: string;
  message?: string;
  timestamp?: string;
}

/**
 * Async handler class
 */
export class AsyncHandler {
  constructor(private config: AsyncHandlerConfig) {}

  /**
   * Handle incoming webhook payload (both task completions and notifications)
   */
  async handleWebhook(payload: WebhookPayload, agentId?: string): Promise<void> {
    const metadata: WebhookMetadata = {
      operation_id: payload.operation_id,
      context_id: payload.context_id,
      task_id: payload.task_id,
      agent_id: agentId || 'unknown',
      task_type: payload.task_type,
      timestamp: payload.timestamp || new Date().toISOString()
    };

    // Emit activity
    await this.emitActivity({
      type: 'webhook_received',
      operation_id: metadata.operation_id,
      agent_id: metadata.agent_id,
      context_id: metadata.context_id,
      task_id: metadata.task_id,
      task_type: metadata.task_type,
      status: payload.status,
      payload: payload.result,
      timestamp: metadata.timestamp
    });

    // Check if this is a notification (media_buy_delivery with notification_type)
    // Notifications are treated like status updates for an ongoing "get delivery report" operation
    // The operation_id (from URL) groups all reports for the same agent + month
    if (payload.task_type === 'media_buy_delivery' &&
        payload.result &&
        typeof payload.result === 'object' &&
        'notification_type' in payload.result) {
      const notificationPayload = payload.result as MediaBuyDeliveryNotification;

      // Build notification metadata
      // operation_id comes from webhook URL and was lazily generated from agent + month
      const notificationMetadata: NotificationMetadata = {
        ...metadata,
        notification_type: notificationPayload.notification_type,
        sequence_number: notificationPayload.sequence_number,
        next_expected_at: notificationPayload.next_expected_at
      };

      await this.config.onMediaBuyDeliveryNotification?.(notificationPayload, notificationMetadata);
      return;
    }

    // Handle based on status for regular task completions
    switch (payload.status) {
      case 'submitted':
        await this.config.onTaskSubmitted?.(metadata);
        break;

      case 'working':
        await this.config.onTaskWorking?.(metadata, payload.message);
        break;

      case 'completed':
        await this.handleCompletion(payload.task_type, payload.result, metadata);
        break;

      case 'failed':
      case 'rejected':
      case 'canceled':
        await this.config.onTaskFailed?.(metadata, payload.error || `Task ${payload.status}`);
        break;
    }
  }

  /**
   * Handle task completion - route to specific handler
   */
  private async handleCompletion(taskType: string, result: any, metadata: WebhookMetadata): Promise<void> {
    // Route to specific handler based on task type
    switch (taskType) {
      case 'get_products':
        await this.config.onGetProductsComplete?.(result, metadata);
        break;

      case 'list_creative_formats':
        await this.config.onListCreativeFormatsComplete?.(result, metadata);
        break;

      case 'create_media_buy':
        await this.config.onCreateMediaBuyComplete?.(result, metadata);
        break;

      case 'update_media_buy':
        await this.config.onUpdateMediaBuyComplete?.(result, metadata);
        break;

      case 'sync_creatives':
        await this.config.onSyncCreativesComplete?.(result, metadata);
        break;

      case 'list_creatives':
        await this.config.onListCreativesComplete?.(result, metadata);
        break;

      case 'get_media_buy_delivery':
        await this.config.onGetMediaBuyDeliveryComplete?.(result, metadata);
        break;

      case 'list_authorized_properties':
        await this.config.onListAuthorizedPropertiesComplete?.(result, metadata);
        break;

      case 'provide_performance_feedback':
        await this.config.onProvidePerformanceFeedbackComplete?.(result, metadata);
        break;

      case 'get_signals':
        await this.config.onGetSignalsComplete?.(result, metadata);
        break;

      case 'activate_signal':
        await this.config.onActivateSignalComplete?.(result, metadata);
        break;

      default:
        // Fallback to generic handler
        await this.config.onTaskComplete?.(result, metadata);
        break;
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
