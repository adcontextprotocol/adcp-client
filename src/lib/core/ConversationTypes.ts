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
  | 'working'
  | 'needs_input'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'deferred'
  | 'aborted'
  | 'submitted'
  | 'governance-denied';

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
  /**
   * Idempotency key for this task, when the tool is mutating. Tracked on
   * state so internal retries reuse the same key (the whole point of the
   * envelope — a re-generated key defeats retry safety).
   */
  idempotencyKey?: string;
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
 * Structured AdCP error information extracted from a failed task response.
 * Present on `TaskResult.adcpError` when the agent returns a recognized error.
 */
export interface AdcpErrorInfo {
  /** AdCP error code (e.g., 'RATE_LIMITED', 'PRODUCT_NOT_FOUND') */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Recovery classification: retry, fix the request, or give up */
  recovery?: 'transient' | 'correctable' | 'terminal';
  /** Field that caused the error */
  field?: string;
  /** Suggested fix from the agent. Untrusted — sanitize before rendering in HTML. */
  suggestion?: string;
  /** Seconds to wait before retrying (transient errors). See also `retryAfterMs`. */
  retry_after?: number;
  /** Milliseconds to wait before retrying — convenience conversion of `retry_after * 1000`. */
  retryAfterMs?: number;
  /** Additional error details. Untrusted agent-controlled content — sanitize before rendering. */
  details?: Record<string, unknown>;
  /** True when the SDK inferred this error from unstructured text (L1 compliance) */
  synthetic?: boolean;
}

/**
 * Task execution metadata, shared across all result variants.
 */
export interface TaskResultMetadata {
  taskId: string;
  taskName: string;
  agent: { id: string; name: string; protocol: 'mcp' | 'a2a' };
  /** Total execution time in milliseconds */
  responseTimeMs: number;
  /** ISO timestamp of completion */
  timestamp: string;
  /** Number of clarification rounds */
  clarificationRounds: number;
  /** Final status */
  status: TaskStatus;
  /** Input request details (for input-required status) */
  inputRequest?: InputRequest;
  /**
   * Idempotency key used for this request, when the tool is mutating. Auto-
   * generated by the SDK when the caller doesn't supply one. Surfaced for
   * logging, correlation, and BYOK flows where the caller persists the key
   * alongside the resource it creates.
   */
  idempotency_key?: string;
  /**
   * True when the response was a cached replay from the seller's idempotency
   * store (i.e., an earlier request with the same key already succeeded).
   *
   * Callers with side effects on response — "campaign created!" notifications,
   * LLM memory writes, downstream tool calls — MUST check this flag before
   * acting, or retries will re-fire side effects.
   */
  replayed?: boolean;
}

/** Fields shared across all TaskResult variants. */
interface TaskResultBase {
  metadata: TaskResultMetadata;
  /** Governance check result (present when governance is configured) */
  governance?: import('./GovernanceTypes').GovernanceCheckResult;
  /** Governance outcome (present after successful execution with governance) */
  governanceOutcome?: import('./GovernanceTypes').GovernanceOutcome;
  /** Error message when governance outcome reporting failed */
  governanceOutcomeError?: string;
  /** Full conversation history */
  conversation?: Message[];
  /** Debug logs (if debug enabled) */
  debug_logs?: any[];
}

/** Successful completion — `data` is always present. */
export interface TaskResultCompleted<T> extends TaskResultBase {
  success: true;
  status: 'completed';
  data: T;
  error?: undefined;
  adcpError?: undefined;
  errorInstance?: undefined;
  correlationId?: undefined;
  deferred?: undefined;
  submitted?: undefined;
}

/** Task is still progressing (working, submitted, input-required, deferred). */
export interface TaskResultIntermediate<T> extends TaskResultBase {
  success: true;
  status: 'working' | 'submitted' | 'input-required' | 'deferred';
  data?: T;
  error?: undefined;
  adcpError?: undefined;
  errorInstance?: undefined;
  correlationId?: undefined;
  /** Deferred continuation (client needs time for input) */
  deferred?: DeferredContinuation<T>;
  /** Submitted continuation (server needs time for processing) */
  submitted?: SubmittedContinuation<T>;
}

/** Task failed — `error` is always present. */
export interface TaskResultFailure<T> extends TaskResultBase {
  success: false;
  status: 'failed' | 'governance-denied';
  /** Response payload with structured error details (adcp_error, context, ext) */
  data?: T;
  /** Human-readable error message */
  error: string;
  /** Structured AdCP error (code, recovery, suggestion, retryAfterMs) */
  adcpError?: AdcpErrorInfo;
  /**
   * Typed `ADCPError` subclass instance when the seller's error code has a
   * dedicated class — currently `IdempotencyConflictError` and
   * `IdempotencyExpiredError`. Lets callers write
   * `if (result.errorInstance instanceof IdempotencyConflictError)` instead of
   * switching on `adcpError.code` strings. Absent for codes without a typed
   * mapping.
   */
  errorInstance?: import('../errors').ADCPError;
  /** Correlation ID from the error response context, for tracing across agents */
  correlationId?: string;
  deferred?: undefined;
  submitted?: undefined;
}

/**
 * Result of a task execution.
 *
 * Discriminated union on `success`:
 * - `success: true` + `status: 'completed'` → `data` is `T`
 * - `success: true` + intermediate status → task is progressing, `data` may be partial
 * - `success: false` → `error` is always a string, `adcpError` has structured details
 */
export type TaskResult<T = any> = TaskResultCompleted<T> | TaskResultIntermediate<T> | TaskResultFailure<T>;

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
