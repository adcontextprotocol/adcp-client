// Optional storage interfaces for caching and persistence
// These are completely optional - everything works in-memory by default

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
  /** Unique token for this deferred task */
  token: string;
  /** Task ID */
  taskId: string;
  /** Task name */
  taskName: string;
  /** Agent ID */
  agentId: string;
  /** Task parameters */
  params: any;
  /** Message history up to deferral point */
  messages: Array<{
    id: string;
    role: 'user' | 'agent' | 'system';
    content: any;
    timestamp: string;
    metadata?: Record<string, any>;
  }>;
  /** Pending input request that caused deferral */
  pendingInput?: {
    question: string;
    field?: string;
    expectedType?: string;
    suggestions?: any[];
    validation?: Record<string, any>;
  };
  /** When task was deferred */
  deferredAt: string;
  /** When token expires */
  expiresAt: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
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
  tokens?: Storage<DeferredTaskState>;

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
   * Create a storage instance for a specific data type
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
