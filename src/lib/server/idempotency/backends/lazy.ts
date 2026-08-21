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
  /**
   * Minimum legacy-record retention grace promised by the eventual backend.
   * Declare this for lazy PostgreSQL backends so unsafe skew is rejected at
   * store construction, before the asynchronous factory runs.
   */
  legacyRetentionGraceSeconds?: number;
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
  let requiredClockSkewSeconds: number | undefined;

  if (
    options.legacyRetentionGraceSeconds !== undefined &&
    (!Number.isSafeInteger(options.legacyRetentionGraceSeconds) || options.legacyRetentionGraceSeconds < 0)
  ) {
    throw new TypeError('legacyRetentionGraceSeconds must be a non-negative safe integer.');
  }

  function validateResolvedRetention(resolved: IdempotencyBackend): void {
    const declaredGrace = options.legacyRetentionGraceSeconds;
    const resolvedGrace = resolved.legacyRetentionGraceSeconds;
    if (declaredGrace !== undefined && resolvedGrace !== undefined && resolvedGrace < declaredGrace) {
      throw new Error(
        `createLazyBackend: resolved backend legacy retention grace (${resolvedGrace}s) is below ` +
          `the wrapper's declared grace (${declaredGrace}s).`
      );
    }
    if (
      requiredClockSkewSeconds !== undefined &&
      resolvedGrace !== undefined &&
      resolvedGrace < requiredClockSkewSeconds
    ) {
      throw new Error(
        `createLazyBackend: resolved backend legacy retention grace (${resolvedGrace}s) must be at least ` +
          `clockSkewSeconds (${requiredClockSkewSeconds}s).`
      );
    }
    resolved.validateClockSkewSeconds?.(requiredClockSkewSeconds ?? 0);
  }

  async function resolveBackend(): Promise<IdempotencyBackend> {
    if (backend) return backend;
    if (!resolving) {
      resolving = Promise.resolve()
        .then(factory)
        .then(resolved => {
          if (!resolved || typeof resolved !== 'object') {
            throw new Error('createLazyBackend: factory must resolve to an IdempotencyBackend.');
          }
          if (
            typeof resolved.replaceIfPayloadHash !== 'function' ||
            typeof resolved.deleteIfPayloadHash !== 'function'
          ) {
            throw new Error(
              'createLazyBackend: resolved backend must support atomic replaceIfPayloadHash and deleteIfPayloadHash fencing.'
            );
          }
          validateResolvedRetention(resolved);
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
    ...(options.legacyRetentionGraceSeconds !== undefined && {
      legacyRetentionGraceSeconds: options.legacyRetentionGraceSeconds,
    }),
    validateClockSkewSeconds(clockSkewSeconds: number): void {
      requiredClockSkewSeconds = Math.max(requiredClockSkewSeconds ?? 0, clockSkewSeconds);
      if (backend) validateResolvedRetention(backend);
    },
    async get(scopedKey: string): Promise<IdempotencyCacheEntry | null> {
      return (await resolveBackend()).get(scopedKey);
    },

    async putIfAbsent(scopedKey: string, entry: IdempotencyCacheEntry): Promise<boolean> {
      return (await resolveBackend()).putIfAbsent(scopedKey, entry);
    },

    async replaceIfPayloadHash(
      scopedKey: string,
      expectedPayloadHash: string,
      entry: IdempotencyCacheEntry
    ): Promise<boolean> {
      const resolved = await resolveBackend();
      if (!resolved.replaceIfPayloadHash) {
        throw new Error('createLazyBackend: resolved backend does not support atomic payload-hash replacement.');
      }
      return resolved.replaceIfPayloadHash(scopedKey, expectedPayloadHash, entry);
    },

    async deleteIfPayloadHash(scopedKey: string, expectedPayloadHash: string): Promise<boolean> {
      const resolved = await resolveBackend();
      if (!resolved.deleteIfPayloadHash) {
        throw new Error('createLazyBackend: resolved backend does not support atomic payload-hash deletion.');
      }
      return resolved.deleteIfPayloadHash(scopedKey, expectedPayloadHash);
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
