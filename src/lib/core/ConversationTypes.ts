// Core conversation types for ADCP client library
// These types support the conversation and clarification pattern

/**
 * Represents a single message in a conversation with an agent
 */
export interface Message {
  /** Unique identifier for this message */
  id: string;
  /** Role of the message sender */
  role: 'user' | 'agent' | 'system';
  /** Message content - can be structured or text */
  content: any;
  /** Timestamp when message was created */
  timestamp: string;
  /** Optional metadata about the message */
  metadata?: {
    /** Tool/task name if this message is tool-related */
    toolName?: string;
    /** Message type (request, response, clarification, etc.) */
    type?: string;
    /** Additional context data */
    [key: string]: any;
  };
}

/**
 * Request for input from the agent - sent when clarification is needed
 */
export interface InputRequest {
  /** Human-readable question or prompt */
  question: string;
  /** Specific field being requested (if applicable) */
  field?: string;
  /** Expected type of response */
  expectedType?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  /** Suggested values or options */
  suggestions?: any[];
  /** Whether this input is required */
  required?: boolean;
  /** Validation rules for the input */
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    enum?: any[];
  };
  /** Additional context about why this input is needed */
  context?: string;
}

/**
 * Different types of responses an input handler can provide
 */
export type InputHandlerResponse =
  | any // Direct answer
  | Promise<any> // Async answer
  | { defer: true; token: string } // Defer to human
  | { abort: true; reason?: string } // Abort task
  | never; // For control flow (abort() helper)

/**
 * Function signature for input handlers
 */
export type InputHandler = (context: ConversationContext) => InputHandlerResponse;

/**
 * Complete conversation context provided to input handlers
 */
export interface ConversationContext {
  /** Full conversation history for this task */
  messages: Message[];
  /** Current input request from the agent */
  inputRequest: InputRequest;
  /** Unique task identifier */
  taskId: string;
  /** Agent configuration */
  agent: {
    id: string;
    name: string;
    protocol: 'mcp' | 'a2a';
  };
  /** Current clarification attempt number (1-based) */
  attempt: number;
  /** Maximum allowed clarification attempts */
  maxAttempts: number;

  /** Helper method to defer task to human */
  deferToHuman(): Promise<{ defer: true; token: string }>;

  /** Helper method to abort the task */
  abort(reason?: string): never;

  /** Get conversation summary for context */
  getSummary(): string;

  /** Check if a field was previously discussed */
  wasFieldDiscussed(field: string): boolean;

  /** Get previous response for a field */
  getPreviousResponse(field: string): any;
}

/**
 * Status of a task execution
 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'needs_input'
  | 'completed'
  | 'failed'
  | 'deferred'
  | 'aborted'
  | 'submitted';

/**
 * Options for task execution
 */
export interface TaskOptions {
  /** Timeout for entire task (ms) */
  timeout?: number;
  /** Maximum clarification rounds before failing */
  maxClarifications?: number;
  /** Context ID to continue existing conversation */
  contextId?: string;
  /** Context object to keep track of the call context. */
  context?: Record<string, any>
  /** Enable debug logging for this task */
  debug?: boolean;
  /** Additional metadata to include */
  metadata?: Record<string, any>;
}

/**
 * Internal task state for tracking execution
 */
export interface TaskState {
  /** Unique task identifier */
  taskId: string;
  /** Task name (tool name) */
  taskName: string;
  /** Original parameters */
  params: any;
  /** Current status */
  status: TaskStatus;
  /** Message history */
  messages: Message[];
  /** Current input request (if waiting for input) */
  pendingInput?: InputRequest;
  /** Start time */
  startTime: number;
  /** Current attempt number */
  attempt: number;
  /** Maximum attempts allowed */
  maxAttempts: number;
  /** Task options */
  options: TaskOptions;
  /** Agent configuration */
  agent: {
    id: string;
    name: string;
    protocol: 'mcp' | 'a2a';
  };
}

/**
 * Task tracking information from tasks/get endpoint (PR #78)
 */
export interface TaskInfo {
  /** Task ID */
  taskId: string;
  /** Current status */
  status: string;
  /** Task type/name */
  taskType: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Task result (if completed) */
  result?: any;
  /** Error message (if failed) */
  error?: string;
  /** Webhook URL (if applicable) */
  webhookUrl?: string;
}

/**
 * Continuation for deferred client tasks (client needs time)
 */
export interface DeferredContinuation<T> {
  /** Token for resuming the task */
  token: string;
  /** Question that triggered the deferral */
  question?: string;
  /** Resume the task with user input */
  resume: (input: any) => Promise<TaskResult<T>>;
}

/**
 * Continuation for submitted server tasks (server needs time)
 */
export interface SubmittedContinuation<T> {
  /** Task ID for tracking */
  taskId: string;
  /** Webhook URL where server will notify completion */
  webhookUrl?: string;
  /** Get current task status */
  track: () => Promise<TaskInfo>;
  /** Wait for completion with polling */
  waitForCompletion: (pollInterval?: number) => Promise<TaskResult<T>>;
}

/**
 * Result of a task execution
 */
export interface TaskResult<T = any> {
  /** Whether the task completed successfully */
  success: boolean;
  /** Task execution status */
  status: 'completed' | 'deferred' | 'submitted';
  /** Task result data (if successful) */
  data?: T;
  /** Error message (if failed) */
  error?: string;
  /** Deferred continuation (client needs time for input) */
  deferred?: DeferredContinuation<T>;
  /** Submitted continuation (server needs time for processing) */
  submitted?: SubmittedContinuation<T>;
  /** Task execution metadata */
  metadata: {
    taskId: string;
    taskName: string;
    agent: {
      id: string;
      name: string;
      protocol: 'mcp' | 'a2a';
    };
    /** Total execution time in milliseconds */
    responseTimeMs: number;
    /** ISO timestamp of completion */
    timestamp: string;
    /** Number of clarification rounds */
    clarificationRounds: number;
    /** Final status */
    status: TaskStatus;
  };
  /** Full conversation history */
  conversation?: Message[];
  /** Debug logs (if debug enabled) */
  debug_logs?: any[];
}

/**
 * Configuration for conversation management
 */
export interface ConversationConfig {
  /** Maximum messages to keep in history */
  maxHistorySize?: number;
  /** Whether to persist conversations */
  persistConversations?: boolean;
  /** Timeout for 'working' status (max 120s per PR #78) */
  workingTimeout?: number;
  /** Default max clarifications */
  defaultMaxClarifications?: number;
}
