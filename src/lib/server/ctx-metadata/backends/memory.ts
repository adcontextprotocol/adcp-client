/**
 * In-process memory backend for `CtxMetadataStore`.
 *
 * Useful for tests and single-process training agents. **Not suitable
 * for production across multiple replicas** — silent ctx_metadata
 * loss after rolling restart produces "package not found" errors
 * that look like publisher bugs and run for weeks. Use
 * `pgCtxMetadataStore(pool)` when horizontal scaling matters.
 *
 * Returns deep-cloned entries on read so callers can't mutate stored
 * values via the returned reference.
 */

import type { CtxMetadataBackend, CtxMetadataEntry } from '../store';

export interface MemoryCtxMetadataStoreOptions {
  /**
   * How often (in ms) to sweep entries with `expiresAt` past the
   * current time. Defaults to 60_000 (60s). Set to 0 to disable —
   * expired entries will still be filtered on read by the store
   * layer; only memory reclamation is affected.
   *
   * Note: most callers don't set `expiresAt`, so the sweep is a
   * no-op in the default flow.
   */
  sweepIntervalMs?: number;
}

export function memoryCtxMetadataStore(options: MemoryCtxMetadataStoreOptions = {}): CtxMetadataBackend {
  const store = new Map<string, CtxMetadataEntry>();
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;

  let sweeper: NodeJS.Timeout | undefined;
  if (sweepIntervalMs > 0) {
    sweeper = setInterval(() => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const [k, entry] of store) {
        if (entry.expiresAt != null && entry.expiresAt < nowSeconds) store.delete(k);
      }
    }, sweepIntervalMs);
    if (typeof sweeper.unref === 'function') sweeper.unref();
  }

  return {
    async get(scopedKey) {
      const entry = store.get(scopedKey);
      if (!entry) return null;
      return cloneEntry(entry);
    },

    async bulkGet(scopedKeys) {
      const result = new Map<string, CtxMetadataEntry>();
      for (const key of scopedKeys) {
        const entry = store.get(key);
        if (entry) result.set(key, cloneEntry(entry));
      }
      return result;
    },

    async put(scopedKey, entry) {
      store.set(scopedKey, cloneEntry(entry));
    },

    async delete(scopedKey) {
      store.delete(scopedKey);
    },

    async close() {
      if (sweeper) clearInterval(sweeper);
      store.clear();
    },

    async clearAll() {
      store.clear();
    },
  };
}

function cloneEntry(entry: CtxMetadataEntry): CtxMetadataEntry {
  return {
    value: entry.value == null ? entry.value : structuredClone(entry.value),
    ...(entry.resource !== undefined && {
      resource: entry.resource == null ? entry.resource : structuredClone(entry.resource),
    }),
    ...(entry.expiresAt !== undefined && { expiresAt: entry.expiresAt }),
  };
}
