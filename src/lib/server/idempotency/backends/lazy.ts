import type { IdempotencyBackend, IdempotencyCacheEntry } from '../store';

export type LazyBackendFactory = () => Promise<IdempotencyBackend>;

export interface LazyBackendOptions {
  /**
   * Expose `clearAll()` on the wrapper. Keep this disabled for production
   * backends that intentionally omit `clearAll()` (for example Redis on a
   * shared instance), because `createIdempotencyStore()` uses method
   * presence as the reset-safety contract.
   */
  clearAll?: boolean;
}

/**
 * Lazily resolve an idempotency backend on first use.
 *
 * Use this when the real backend depends on application infrastructure that is
 * resolved asynchronously after SDK server construction, for example:
 *
 * ```ts
 * const store = createIdempotencyStore({
 *   backend: createLazyBackend(async () => redisBackend(await getRedisClient(), { keyPrefix })),
 * });
 * ```
 *
 * Concurrent first calls share a single factory invocation. If the factory
 * fails, the wrapper forgets that failed attempt so a later call can retry.
 *
 * `clearAll()` is not exposed by default because its presence is used by
 * compliance reset code as the backend's explicit "safe to flush" signal. Set
 * `{ clearAll: true }` only when every backend the factory can return supports
 * and safely permits bulk clearing.
 */
export function createLazyBackend(factory: LazyBackendFactory, options: LazyBackendOptions = {}): IdempotencyBackend {
  let backend: IdempotencyBackend | undefined;
  let resolving: Promise<IdempotencyBackend> | undefined;

  async function resolveBackend(): Promise<IdempotencyBackend> {
    if (backend) return backend;
    if (!resolving) {
      resolving = Promise.resolve()
        .then(factory)
        .then(resolved => {
          if (!resolved || typeof resolved !== 'object') {
            throw new Error('createLazyBackend: factory must resolve to an IdempotencyBackend.');
          }
          backend = resolved;
          return resolved;
        })
        .catch(err => {
          resolving = undefined;
          throw new Error('createLazyBackend: failed to resolve idempotency backend.', { cause: err });
        });
    }
    return resolving;
  }

  const lazyBackend: IdempotencyBackend = {
    async get(scopedKey: string): Promise<IdempotencyCacheEntry | null> {
      return (await resolveBackend()).get(scopedKey);
    },

    async putIfAbsent(scopedKey: string, entry: IdempotencyCacheEntry): Promise<boolean> {
      return (await resolveBackend()).putIfAbsent(scopedKey, entry);
    },

    async put(scopedKey: string, entry: IdempotencyCacheEntry): Promise<void> {
      await (await resolveBackend()).put(scopedKey, entry);
    },

    async delete(scopedKey: string): Promise<void> {
      await (await resolveBackend()).delete(scopedKey);
    },

    async probe(): Promise<void> {
      const resolved = await resolveBackend();
      if (resolved.probe) await resolved.probe();
    },

    async close(): Promise<void> {
      const resolved = backend ?? (resolving ? await resolving : undefined);
      if (resolved?.close) await resolved.close();
    },
  };

  if (options.clearAll) {
    lazyBackend.clearAll = async (): Promise<void> => {
      const resolved = await resolveBackend();
      if (!resolved.clearAll) {
        throw new Error('createLazyBackend: resolved backend does not support clearAll().');
      }
      await resolved.clearAll();
    };
  }

  return lazyBackend;
}
