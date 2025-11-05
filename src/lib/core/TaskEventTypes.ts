/**
 * Unified event types for task execution tracking
 * All events are emitted with operation_id for grouping multi-agent operations
 */

/**
 * Base event structure - all events share these fields
 *
 * Key identifiers:
 * - operationId + agentId = YOUR unique identifier for this work
 * - contextId = server's conversation identifier (server creates this)
 * - taskId = server's work identifier (server creates this, only for async)
 */
export interface BaseTaskEvent {
  /** Client-generated operation ID - groups related work across multiple agents */
  operationId: string;
  /** Agent ID - which agent is handling this */
  agentId: string;
  /** Context ID from server - created by agent on first response */
  contextId?: string;
  /** Task ID from server - only present for async operations */
  taskId?: string;
  /** Task/tool name */
  taskType: string;
  /** Event timestamp */
  timestamp: string;
}

/**
 * Protocol request event - emitted when request is sent
 */
export interface ProtocolRequestEvent extends BaseTaskEvent {
  eventType: 'protocol_request';
  protocol: 'a2a' | 'mcp';
  method: string;
  payload: {
    params: Record<string, any>;
    headers?: Record<string, string>;
  };
}

/**
 * Protocol response event - emitted when response is received
 */
export interface ProtocolResponseEvent extends BaseTaskEvent {
  eventType: 'protocol_response';
  protocol: 'a2a' | 'mcp';
  method: string;
  payload: any;
  /** Response status from server */
  status: string;
}

/**
 * Task status update event - emitted on status changes
 */
export interface TaskStatusEvent extends BaseTaskEvent {
  eventType: 'status_update';
  /** New status */
  status: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'rejected' | 'canceled';
  /** Previous status (if applicable) */
  previousStatus?: string;
  /** Result data (for completed) */
  result?: any;
  /** Error details (for failed) */
  error?: string;
}

/**
 * Object tracking event - for tracking individual objects (creatives, products, etc)
 */
export interface ObjectEvent {
  /** Client-generated operation ID */
  operationId: string;
  /** Agent ID */
  agentId: string;
  /** Context ID from server (if applicable) */
  contextId?: string;
  /** Task ID from server (if applicable) */
  taskId?: string;
  /** Type of object */
  objectType: 'product' | 'creative' | 'media_buy' | 'signal' | string;
  /** Object identifier */
  objectId?: string;
  /** Target entity (agent ID, platform, etc) */
  targetEntity: string;
  /** Object status */
  status: string;
  /** Object payload/data */
  payload?: any;
  /** Event timestamp */
  timestamp: string;
}

/**
 * Union type of all task events
 */
export type TaskEvent = ProtocolRequestEvent | ProtocolResponseEvent | TaskStatusEvent;

/**
 * Webhook-compatible task status event
 * This is what you'd receive from a webhook AND from the event emitter
 * Covers ALL status changes (submitted, working, completed, etc)
 *
 * Identifiers:
 * - operationId + agentId = YOUR unique key for this work
 * - contextId = server gave you this (store it for reconciliation)
 * - taskId = server gave you this (store it for async tracking)
 */
export interface TaskStatusUpdateEvent {
  /** Client-generated operation ID */
  operationId: string;
  /** Agent ID */
  agentId: string;
  /** Context ID from server (server creates this on first response) */
  contextId?: string;
  /** Task ID from server (only for async operations) */
  taskId?: string;
  /** Task type/tool name */
  taskType: string;
  /** Current status */
  status: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'rejected' | 'canceled';
  /** Previous status (for tracking transitions) */
  previousStatus?: string;
  /** Result data (if completed) */
  result?: any;
  /** Error message (if failed) */
  error?: string;
  /** Message from server (for working/input-required states) */
  message?: string;
  /** Question for user (if input-required) */
  question?: string;
  /** Expected input type (if input-required) */
  expectedInput?: {
    field?: string;
    type?: string;
    suggestions?: any[];
  };
  /** Webhook URL (if registered) */
  webhookUrl?: string;
  /** Timestamp */
  timestamp: string;
}

/**
 * Webhook-compatible task completion event (convenience type for completed/failed)
 * @deprecated Use TaskStatusUpdateEvent instead
 */
export type TaskCompletionEvent = TaskStatusUpdateEvent & {
  status: 'completed' | 'failed' | 'rejected' | 'canceled';
};

/**
 * Event listener callback signatures
 * For OBSERVABILITY only - not for control flow!
 * Use these to log, record, or update UI - NOT to handle responses
 */
export interface TaskEventCallbacks {
  /**
   * Called for protocol requests (when request is sent to agent)
   * Use for: logging, UI updates, recording to database
   */
  onProtocolRequest?: (event: ProtocolRequestEvent) => void;

  /**
   * Called for protocol responses (when response received from agent)
   * Use for: logging, UI updates, recording to database
   */
  onProtocolResponse?: (event: ProtocolResponseEvent) => void;

  /**
   * Called for ALL status changes (submitted, working, completed, etc)
   * Use for: progress tracking, UI updates, event recording
   * NOTE: This fires during synchronous execution - don't block!
   */
  onStatusChange?: (event: TaskStatusUpdateEvent) => void;

  /**
   * Called for object events (products received, creatives synced, etc)
   * Use for: tracking granular object status
   */
  onObjectEvent?: (event: ObjectEvent) => void;
}

/**
 * Helper to create operation ID
 * Used to group related work across multiple agents
 * Example: "Sync 5 creatives to 3 agents" = 1 operation ID
 */
export function createOperationId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Server identifier tracking (DEPRECATED - use webhook URL path instead)
 *
 * Previously needed to map server IDs back to operation_id.
 * Now superseded by encoding operation_id in webhook URL:
 * /webhook/{agent_id}/{operation_id}
 *
 * @deprecated Use webhook URL path parameters instead
 */
export class ServerIdentifierMapper {
  private contextToKey = new Map<string, { operationId: string; agentId: string }>();
  private taskToKey = new Map<string, { operationId: string; agentId: string }>();

  /**
   * Register server identifiers when you get them from first response
   */
  register(operationId: string, agentId: string, contextId?: string, taskId?: string): void {
    const key = { operationId, agentId };

    if (contextId) {
      this.contextToKey.set(contextId, key);
    }
    if (taskId) {
      this.taskToKey.set(taskId, key);
    }
  }

  /**
   * Look up your operation+agent from webhook context_id
   */
  lookupByContext(contextId: string): { operationId: string; agentId: string } | undefined {
    return this.contextToKey.get(contextId);
  }

  /**
   * Look up your operation+agent from webhook task_id
   */
  lookupByTask(taskId: string): { operationId: string; agentId: string } | undefined {
    return this.taskToKey.get(taskId);
  }

  /**
   * Clean up completed operation
   */
  remove(operationId: string, agentId: string): void {
    // Remove all mappings for this operation+agent
    for (const [contextId, key] of this.contextToKey) {
      if (key.operationId === operationId && key.agentId === agentId) {
        this.contextToKey.delete(contextId);
      }
    }
    for (const [taskId, key] of this.taskToKey) {
      if (key.operationId === operationId && key.agentId === agentId) {
        this.taskToKey.delete(taskId);
      }
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalContexts: number;
    totalTasks: number;
  } {
    return {
      totalContexts: this.contextToKey.size,
      totalTasks: this.taskToKey.size,
    };
  }
}
