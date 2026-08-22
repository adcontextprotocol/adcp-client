// Optional storage interfaces for caching and persistence
// These are completely optional - everything works in-memory by default

import type { Message } from '../core/ConversationTypes';

/**
 * Generic storage interface for caching and persistence
 *
 * Users can provide their own implementations (Redis, database, etc.)
 * The library provides a default in-memory implementation
 */
export interface Storage<T> {
  /**
   * Get a value by key
   * @param key - Storage key
   * @returns Value or undefined if not found
   */
  get(key: string): Promise<T | undefined>;

  /**
   * Set a value with optional TTL
   * @param key - Storage key
   * @param value - Value to store
   * @param ttl - Time to live in seconds (optional)
   */
  set(key: string, value: T, ttl?: number): Promise<void>;

  /**
   * Delete a value by key
   * @param key - Storage key
   */
  delete(key: string): Promise<void>;

  /**
   * Check if a key exists
   * @param key - Storage key
   */
  has(key: string): Promise<boolean>;

  /**
   * Clear all stored values (optional)
   */
  clear?(): Promise<void>;

  /**
   * Get all keys (optional, for debugging)
   */
  keys?(): Promise<string[]>;

  /**
   * Get storage size/count (optional, for monitoring)
   */
  size?(): Promise<number>;
}

/**
 * Storage that can atomically consume a value.
 *
 * `take()` MUST read and delete the value as one indivisible operation. A
 * `get()` followed by `delete()` is not equivalent: two replicas could both
 * read the same continuation and advance one seller task twice.
 */
export interface AtomicTakeStorage<T> extends Storage<T> {
  /** Atomically create a value only when the key is absent or expired. */
  putIfAbsent(key: string, value: T, ttl?: number): Promise<boolean>;
  take(key: string): Promise<T | undefined>;
}

/**
 * Agent capabilities for caching
 */
export interface AgentCapabilities {
  /** Agent ID */
  agentId: string;
  /** Supported task names */
  supportedTasks: string[];
  /** Task schemas/definitions */
  taskSchemas?: Record<string, any>;
  /** Agent metadata */
  metadata?: {
    version?: string;
    description?: string;
    lastUpdated?: string;
    [key: string]: any;
  };
  /** When capabilities were cached */
  cachedAt: string;
  /** Cache expiration time */
  expiresAt?: string;
}

/**
 * Conversation state for persistence
 */
export interface ConversationState {
  /** Conversation ID */
  conversationId: string;
  /** Agent ID */
  agentId: string;
  /** Message history */
  messages: Array<{
    id: string;
    role: 'user' | 'agent' | 'system';
    content: any;
    timestamp: string;
    metadata?: Record<string, any>;
  }>;
  /** Current task information */
  currentTask?: {
    taskId: string;
    taskName: string;
    status: string;
    params: any;
  };
  /** When conversation was created */
  createdAt: string;
  /** When conversation was last updated */
  updatedAt: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Deferred task state for resumption
 */
export interface DeferredTaskState {
  /** Opaque record generation used for atomic claim/replace fencing. */
  continuationVersion: string;
  /** True after the human continuation has been claimed for seller dispatch. */
  continuationClaimed?: boolean;
  /**
   * Renewable owner fence for a committed continuation between human-input
   * admission and the seller protocol call. Only an expired `admission` phase
   * may be reclaimed; `dispatch-committed` is an uncertain-dispatch fence and
   * must never permit the input to be sent again.
   */
  settlementResumeDispatchLease?: {
    ownerId: string;
    phase: 'admission' | 'dispatch-committed';
    expiresAt: number;
  };
  /** Client-minted correlation ID for the original request. */
  taskId: string;
  /** Seller-issued A2A conversation identity, when one was supplied. */
  contextId?: string;
  /** Live A2A transport Task.id used to resume the exact seller task. */
  a2aTaskId: string;
  /** Seller wire generation used for the original task and every continuation. */
  serverVersion: 'v2' | 'v3';
  /** Trusted agent identifier resolved through current client configuration. */
  agentId: string;
  /** Task/tool name. */
  taskName: string;
  /** Snapshotted original task parameters. */
  params: any;
  /** Message history through the response that caused the pause. */
  messages: Message[];
  /** Exact resumable pause status retained for crash-safe route discovery. */
  pauseStatus?: 'input-required' | 'auth-required' | 'deferred';
  /** Human-facing prompt retained for crash-safe route discovery. */
  pauseQuestion?: string;
  /** Opaque, serializable owner context. Storage adapters must round-trip it unchanged. */
  clientContext?: unknown;
  /** Trusted committed-mutation route that must durably settle any terminal resume. */
  settlementOperationId?: string;
  /** New-format records whose operation index must fence every state transition. */
  settlementOperationRouteRequired?: true;
  /** Require the owning durable coordinator to authorize this token before sending seller continuation input. */
  settlementResumeAuthorizationRequired?: boolean;
  /** Seller work handle bound by the durable mutation owner before the pause. */
  settlementServerTaskId?: string;
  /** Seller work handle retained while a committed resume remains nonterminal. */
  settlementPendingTaskId?: string;
  /**
   * Opaque terminal observation retained when seller continuation succeeded but
   * committed-mutation settlement has not yet been acknowledged. Storage
   * adapters must round-trip it unchanged so retry never redispatches the
   * seller mutation.
   */
  settlementTerminalResult?: unknown;
  /** Internal renewable active-owner lease for settlement finalization. */
  settlementFinalizationLease?: {
    ownerId: string;
    expiresAt: number;
  };
  /** Exact public result after settlement and completion handlers succeeded. */
  settlementFinalizedResult?: unknown;
  /** Internal fence proving callback publication already invoked the configured completion handler. */
  settlementCompletionHandlerPublished?: boolean;
  /** Epoch milliseconds when this resumable state was stored. */
  createdAt: number;
  /** Epoch milliseconds after which this token must not be resumed. */
  expiresAt: number;
}

/** Durable deferred-task storage must generation-fence claim and cleanup. */
export interface DeferredTaskStorage extends Storage<DeferredTaskState> {
  /** Atomically create a value only when the key is absent or expired. */
  putIfAbsent(key: string, value: DeferredTaskState, ttl?: number): Promise<boolean>;
  /** Atomically replace only the exact record generation currently stored. */
  replaceIfVersion(key: string, expectedVersion: string, value: DeferredTaskState, ttl?: number): Promise<boolean>;
  /** Atomically return and remove only the exact record generation currently stored. */
  takeIfVersion(key: string, expectedVersion: string): Promise<DeferredTaskState | undefined>;
  /**
   * Atomically create a committed continuation and its operation route. The
   * route is the crash-recovery source of truth when the owning coordinator
   * has not yet recorded the opaque token.
   */
  putForSettlementOperationIfAbsent(
    operationId: string,
    key: string,
    value: DeferredTaskState,
    ttl?: number
  ): Promise<boolean>;
  /** Atomically resolve the current committed continuation generation. */
  getBySettlementOperationId(operationId: string): Promise<{ token: string; state: DeferredTaskState } | undefined>;
  /**
   * Atomically replace the exact routed generation. With a distinct
   * replacement key this installs a nested generation and moves the route,
   * retaining the predecessor as a dispatch fence. With the same key it
   * performs an in-place route-fenced state transition (for example, terminal
   * callback checkpointing).
   */
  replaceForSettlementOperationIfVersion(
    operationId: string,
    currentKey: string,
    expectedVersion: string,
    replacementKey: string,
    replacementValue: DeferredTaskState,
    ttl?: number
  ): Promise<boolean>;
}

/**
 * Storage configuration for different data types
 */
export interface StorageConfig {
  /** Storage for agent capabilities caching */
  capabilities?: Storage<AgentCapabilities>;

  /** Storage for conversation state persistence */
  conversations?: Storage<ConversationState>;

  /** Storage for deferred task tokens */
  tokens?: DeferredTaskStorage;

  /** Storage for debug logs (optional) */
  debugLogs?: Storage<any>;

  /** Custom storage instances */
  custom?: Record<string, Storage<any>>;
}

/**
 * Storage factory interface for creating storage instances
 */
export interface StorageFactory {
  /**
   * Create durable token storage with the atomic generation-fencing contract.
   */
  createStorage(type: 'tokens', options?: any): DeferredTaskStorage;
  /**
   * Create a storage instance for another data type.
   */
  createStorage<T>(type: string, options?: any): Storage<T>;
}

/**
 * Utility type for storage middleware/decorators
 */
export type StorageMiddleware<T> = (storage: Storage<T>) => Storage<T>;

/**
 * Helper interface for batch operations
 */
export interface BatchStorage<T> extends Storage<T> {
  /**
   * Get multiple values at once
   */
  mget(keys: string[]): Promise<(T | undefined)[]>;

  /**
   * Set multiple values at once
   */
  mset(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void>;

  /**
   * Delete multiple keys at once
   */
  mdel(keys: string[]): Promise<number>;
}

/**
 * Helper interface for pattern-based operations
 */
export interface PatternStorage<T> extends Storage<T> {
  /**
   * Get keys matching a pattern
   */
  scan(pattern: string): Promise<string[]>;

  /**
   * Delete keys matching a pattern
   */
  deletePattern(pattern: string): Promise<number>;
}
