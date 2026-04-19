/**
 * In-process memory backend for the idempotency store.
 *
 * Useful for tests and single-process training agents. Not suitable for
 * production across multiple replicas — use `pgBackend` or a similar
 * shared store when horizontal scaling matters.
 *
 * Returns deep-cloned entries on read so middleware mutations (e.g.,
 * injecting `replayed: true` or echo-back `context`) don't leak back
 * into the cache and poison subsequent replays.
 */

import type { IdempotencyBackend, IdempotencyCacheEntry } from '../store';

export interface MemoryBackendOptions {
  /**
   * How often (in ms) to sweep expired entries from the map. Defaults to
   * 60_000 (60s). Set to 0 to disable — entries will still be rejected on
   * lookup, but memory won't be reclaimed until the process restarts.
   */
  sweepIntervalMs?: number;
}

export function memoryBackend(options: MemoryBackendOptions = {}): IdempotencyBackend {
  const store = new Map<string, IdempotencyCacheEntry>();
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;

  let sweeper: NodeJS.Timeout | undefined;
  if (sweepIntervalMs > 0) {
    sweeper = setInterval(() => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const [k, entry] of store) {
        if (entry.expiresAt < nowSeconds) store.delete(k);
      }
    }, sweepIntervalMs);
    // Don't hold the event loop open for this timer.
    if (typeof sweeper.unref === 'function') sweeper.unref();
  }

  return {
    async get(scopedKey: string): Promise<IdempotencyCacheEntry | null> {
      const entry = store.get(scopedKey);
      if (!entry) return null;
      // Clone on read: the middleware mutates the returned envelope to set
      // `replayed: true` and echo-back `context`. Sharing the reference
      // would bake the first caller's context into the cache and leak it
      // to every subsequent replay.
      return cloneEntry(entry);
    },
    async put(scopedKey: string, entry: IdempotencyCacheEntry): Promise<void> {
      // Clone on write so the caller can't mutate their local copy later
      // and retroactively change what's cached.
      store.set(scopedKey, cloneEntry(entry));
    },
    async putIfAbsent(scopedKey: string, entry: IdempotencyCacheEntry): Promise<boolean> {
      const existing = store.get(scopedKey);
      if (existing) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (existing.expiresAt >= nowSeconds) return false;
        // Expired entry — replace it (lets a stale claim be reclaimed).
      }
      store.set(scopedKey, cloneEntry(entry));
      return true;
    },
    async delete(scopedKey: string): Promise<void> {
      store.delete(scopedKey);
    },
    async close(): Promise<void> {
      if (sweeper) clearInterval(sweeper);
      store.clear();
    },
  };
}

function cloneEntry(entry: IdempotencyCacheEntry): IdempotencyCacheEntry {
  return {
    payloadHash: entry.payloadHash,
    response: entry.response == null ? entry.response : structuredClone(entry.response),
    expiresAt: entry.expiresAt,
  };
}
