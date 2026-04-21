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
  /**
   * A2A `contextId` that binds this call to a server-side conversation.
   * When set, the client sends it on the A2A Message envelope so the server
   * can route to the existing session instead of starting a new one.
   * Retained automatically across calls on the same `AgentClient`.
   */
  contextId?: string;
  /**
   * A2A `taskId` of a non-terminal task to resume (HITL / approval flows).
   * When set, the client sends it on the A2A Message envelope so the server
   * continues the same task rather than opening a new one.
   */
  taskId?: string;
  /** Enable debug logging for this task */
  debug?: boolean;
  /** Additional metadata to include */
  metadata?: Record<string, any>;
  /**
   * INTERNAL — compliance-test-only escape hatch.
   *
   * Suppresses the client's automatic `idempotency_key` generation on
   * mutating requests. The sole caller is the storyboard runner, which
   * needs to exercise servers' missing-key validation. Auto-injection
   * is the retry-safety contract for every real buyer — bypassing it
   * in production breaks at-most-once semantics on network retries.
   *
   * @internal Do not set in production buyer code.
   */
  skipIdempotencyAutoInject?: boolean;
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
  /**
   * Client-minted correlation id for this specific request attempt. Used
   * for internal tracking (activeTasks map, webhook URL macros, debug
   * logs) and retried/refired across attempts — NOT the A2A task id the
   * server is tracking. For the server-side id, use {@link serverTaskId}.
   */
  taskId: string;
  /**
   * Server-returned A2A `contextId` / AdCP `context_id` that binds this
   * response to a server-side conversation. Present when the server surfaced
   * one; `undefined` otherwise (e.g., fire-and-forget MCP completions).
   *
   * Buyers who persist conversation across process restarts should save this
   * and seed it into `AgentClient.resetContext(id)` on rehydration.
   */
  contextId?: string;
  /**
   * A2A `taskId` of the server-tracked task for this response. Populated
   * from A2A Task / Message responses; `undefined` for MCP and for A2A
   * responses that carry no task binding. Distinct from {@link taskId},
   * which is the client-minted correlation id.
   */
  serverTaskId?: string;
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
interface TaskResultBase<T = any> {
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
  /**
   * Exhaustive pattern match on the result's `status`. Prefer this method
   * form — it autocompletes alongside the other `TaskResult` accessors.
   *
   * The free function {@link import('./match').match} is also exported for
   * compositional use (e.g., point-free style or when the result type is
   * not yet narrowed).
   *
   * Attached non-enumerably by the client when the result is returned
   * from `executeTask`. Results constructed by hand (e.g., in test
   * fixtures or custom middleware) will not have this method — use the
   * free function, or call `attachMatch(result)` first.
   */
  match?: <R>(handlers: import('./match').MatchHandlers<T, R> | import('./match').PartialMatchHandlers<T, R>) => R;
}

/** Successful completion — `data` is always present. */
export interface TaskResultCompleted<T> extends TaskResultBase<T> {
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
export interface TaskResultIntermediate<T> extends TaskResultBase<T> {
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
export interface TaskResultFailure<T> extends TaskResultBase<T> {
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
