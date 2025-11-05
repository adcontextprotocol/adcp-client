// Default in-memory storage implementation
// Works out of the box without any external dependencies

import type { Storage, BatchStorage, PatternStorage } from './interfaces';

/**
 * Stored item with optional expiration
 */
interface StoredItem<T> {
  value: T;
  expiresAt?: number;
  createdAt: number;
}

/**
 * In-memory storage implementation with TTL support
 *
 * This is the default storage used when no external storage is configured.
 * Features:
 * - TTL support with automatic cleanup
 * - Pattern matching
 * - Batch operations
 * - Memory-efficient (garbage collection of expired items)
 *
 * @example
 * ```typescript
 * const storage = new MemoryStorage<string>();
 * await storage.set('key', 'value', 60); // TTL of 60 seconds
 * const value = await storage.get('key');
 * ```
 */
export class MemoryStorage<T> implements Storage<T>, BatchStorage<T>, PatternStorage<T> {
  private store = new Map<string, StoredItem<T>>();
  private cleanupInterval?: NodeJS.Timeout;
  private lastCleanup = 0;

  constructor(
    private options: {
      /** How often to clean up expired items (ms), default 5 minutes */
      cleanupIntervalMs?: number;
      /** Maximum items to store before forcing cleanup, default 10000 */
      maxItems?: number;
      /** Whether to enable automatic cleanup, default true */
      autoCleanup?: boolean;
    } = {}
  ) {
    const {
      cleanupIntervalMs = 5 * 60 * 1000, // 5 minutes
      autoCleanup = true,
    } = options;

    if (autoCleanup) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpired();
      }, cleanupIntervalMs);
    }
  }

  async get(key: string): Promise<T | undefined> {
    const item = this.store.get(key);

    if (!item) {
      return undefined;
    }

    // Check if expired
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return item.value;
  }

  async set(key: string, value: T, ttl?: number): Promise<void> {
    const now = Date.now();
    const expiresAt = ttl ? now + ttl * 1000 : undefined;

    this.store.set(key, {
      value,
      expiresAt,
      createdAt: now,
    });

    // Force cleanup if we're approaching max items
    const maxItems = this.options.maxItems || 10000;
    if (this.store.size > maxItems) {
      this.cleanupExpired();
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== undefined;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async keys(): Promise<string[]> {
    // Return only non-expired keys
    const keys: string[] = [];
    const now = Date.now();

    for (const [key, item] of this.store) {
      if (!item.expiresAt || now <= item.expiresAt) {
        keys.push(key);
      }
    }

    return keys;
  }

  async size(): Promise<number> {
    // Count only non-expired items
    const keys = await this.keys();
    return keys.length;
  }

  // ====== BATCH OPERATIONS ======

  async mget(keys: string[]): Promise<(T | undefined)[]> {
    const promises = keys.map(key => this.get(key));
    return Promise.all(promises);
  }

  async mset(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
    const promises = entries.map(({ key, value, ttl }) => this.set(key, value, ttl));
    await Promise.all(promises);
  }

  async mdel(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.has(key)) {
        this.store.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  // ====== PATTERN OPERATIONS ======

  async scan(pattern: string): Promise<string[]> {
    const regex = this.patternToRegex(pattern);
    const allKeys = await this.keys();
    return allKeys.filter(key => regex.test(key));
  }

  async deletePattern(pattern: string): Promise<number> {
    const keys = await this.scan(pattern);
    return this.mdel(keys);
  }

  // ====== UTILITY METHODS ======

  /**
   * Manually trigger cleanup of expired items
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, item] of this.store) {
      if (item.expiresAt && now > item.expiresAt) {
        this.store.delete(key);
        cleaned++;
      }
    }

    this.lastCleanup = now;
    return cleaned;
  }

  /**
   * Get storage statistics
   */
  getStats(): {
    totalItems: number;
    expiredItems: number;
    memoryUsage: number;
    lastCleanup: number;
    oldestItem?: number;
    newestItem?: number;
  } {
    const now = Date.now();
    let expiredItems = 0;
    let oldestItem: number | undefined;
    let newestItem: number | undefined;

    for (const [, item] of this.store) {
      if (item.expiresAt && now > item.expiresAt) {
        expiredItems++;
      }

      if (!oldestItem || item.createdAt < oldestItem) {
        oldestItem = item.createdAt;
      }

      if (!newestItem || item.createdAt > newestItem) {
        newestItem = item.createdAt;
      }
    }

    return {
      totalItems: this.store.size,
      expiredItems,
      memoryUsage: this.estimateMemoryUsage(),
      lastCleanup: this.lastCleanup,
      oldestItem,
      newestItem,
    };
  }

  /**
   * Estimate memory usage (rough approximation)
   */
  private estimateMemoryUsage(): number {
    let bytes = 0;

    for (const [key, item] of this.store) {
      // Rough estimate: string length * 2 (UTF-16) + object overhead
      bytes += key.length * 2;
      bytes += JSON.stringify(item.value).length * 2;
      bytes += 64; // Overhead for object and metadata
    }

    return bytes;
  }

  /**
   * Convert glob-style pattern to regex
   */
  private patternToRegex(pattern: string): RegExp {
    // Escape special regex characters except * and ?
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

    // Convert glob wildcards to regex
    const regexPattern = escaped
      .replace(/\*/g, '.*') // * matches any sequence
      .replace(/\?/g, '.'); // ? matches any single character

    return new RegExp(`^${regexPattern}$`);
  }

  /**
   * Destroy the storage and cleanup resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.store.clear();
  }
}

/**
 * Factory function to create a memory storage instance
 */
export function createMemoryStorage<T>(options?: {
  cleanupIntervalMs?: number;
  maxItems?: number;
  autoCleanup?: boolean;
}): MemoryStorage<T> {
  return new MemoryStorage<T>(options);
}

/**
 * Create a complete storage configuration using memory storage
 */
export function createMemoryStorageConfig(): {
  capabilities: MemoryStorage<any>;
  conversations: MemoryStorage<any>;
  tokens: MemoryStorage<any>;
  debugLogs: MemoryStorage<any>;
} {
  return {
    capabilities: createMemoryStorage({ maxItems: 1000 }),
    conversations: createMemoryStorage({ maxItems: 5000 }),
    tokens: createMemoryStorage({ maxItems: 10000 }),
    debugLogs: createMemoryStorage({ maxItems: 50000 }),
  };
}
