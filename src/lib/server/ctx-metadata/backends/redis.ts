/**
 * Redis backend for `CtxMetadataStore`.
 *
 * Stores one key per `(account_id, kind, id)` carrying the JSON payload
 * `{ value, resource?, expiresAt? }`. Entries with no `expiresAt` have
 * no Redis TTL — ctx-metadata lifetimes can be months (a media buy can
 * run all year), and silent eviction would produce "package not found"
 * errors that look like publisher bugs and run for weeks.
 *
 * **TTL semantics.** When `entry.expiresAt` is set, the backend stores
 * the key with `EX = expiresAt - now + expiredGraceSeconds` (default
 * 60s grace) so the store layer's own expiry check (`entry.expiresAt <
 * now`) can still run on values within the grace window. When
 * `entry.expiresAt` is absent, the key is stored with no TTL — durable
 * by default, matches the pg backend's `expires_at NULL` semantic.
 *
 * **`bulkGet` uses `MGET`.** Single round trip for any batch size,
 * unlike the looped-`GET` fallback. Adopters using an escape-hatch
 * `RedisLikeClient` adapter MUST implement `mGet` for batch shapes
 * (`get_products` with N products, `create_media_buy` carrying a
 * package list referencing products by ID).
 *
 * **`clearAll` intentionally omitted.** Same rationale as the
 * idempotency Redis backend — a shared Redis is a production resource,
 * and a compliance-reset `FLUSHDB` would nuke unrelated keys. Tests
 * against a dedicated db index (`REDIS_URL=…/15`) call `FLUSHDB`
 * themselves.
 *
 * @example
 * ```typescript
 * import { createClient } from 'redis';
 * import { createCtxMetadataStore, redisCtxMetadataStore } from '@adcp/sdk/server';
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * client.on('error', (err) => console.error('redis error', err));
 * await client.connect();
 *
 * const ctxMetadata = createCtxMetadataStore({
 *   backend: redisCtxMetadataStore(client),
 * });
 * ```
 */

import type { CtxMetadataBackend, CtxMetadataEntry } from '../store';
// `import type` is erased at emit, so this does NOT make `redis` a
// hard dependency at runtime — adopters who never use this backend
// never load the redis package.
import type { RedisClientType } from 'redis';
import { maybeWarnOnSharedRedisPrefix } from '../../../utils/redis-default-prefix-warn';

/**
 * Escape-hatch interface for adopters not using the official `redis`
 * client (node-redis v4/v5). Mirrors the methods this backend calls.
 *
 * `mGet` matches node-redis's batch-get shape (single round trip).
 * `ioredis` exposes `mget(keys)` which returns `(string | null)[]` in
 * the same order — the shim is one line.
 *
 * @example ioredis adapter
 * ```typescript
 * import Redis from 'ioredis';
 * const ioredis = new Redis(process.env.REDIS_URL!);
 *
 * const client: CtxMetadataRedisLikeClient = {
 *   get: (k) => ioredis.get(k),
 *   mGet: (keys) => ioredis.mget(keys),
 *   set: (k, v, opts) =>
 *     opts?.EX !== undefined
 *       ? ioredis.set(k, v, 'EX', opts.EX)
 *       : ioredis.set(k, v),
 *   del: (k) => ioredis.del(k as string),
 *   ping: () => ioredis.ping(),
 * };
 * ```
 */
export interface CtxMetadataRedisLikeClient {
  get(key: string): Promise<string | null>;
  mGet(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, options?: { EX?: number }): Promise<string | null>;
  del(key: string | string[]): Promise<number>;
  ping(): Promise<string>;
}

/**
 * Accepted client shape: either a real `redis` (node-redis v4/v5)
 * `RedisClientType` (the typical path — pass `createClient(...)`
 * straight in) or an adapter conforming to `CtxMetadataRedisLikeClient`
 * for non-node-redis clients (ioredis, Upstash, test doubles).
 */
export type CtxMetadataRedisBackendClient = RedisClientType<any, any, any> | CtxMetadataRedisLikeClient;

export interface RedisCtxMetadataBackendOptions {
  /**
   * Key prefix prepended to every scoped key written to Redis. Defaults
   * to `"adcp:ctx_meta:"`.
   *
   * **Sharing a Redis db across deployments? Override this.** The
   * default is fine for a dedicated Redis (or a dedicated db index).
   * Two AdCP servers sharing the same db with the same default prefix
   * collide on any overlapping `accountId` — the per-tenant scope
   * segment can't carry deployment isolation on its own. Set a
   * deployment-unique prefix (`"adcp:ctx_meta:prod-eu:"`, etc.) or use
   * separate Redis dbs.
   */
  keyPrefix?: string;
  /**
   * How many seconds past `entry.expiresAt` to keep the key alive in
   * Redis so the store layer's expiry check (`entry.expiresAt < now`)
   * can still observe the value within a clock-skew window. Defaults
   * to 60s.
   *
   * Only applies to entries with an `expiresAt`; entries without one
   * are stored with no TTL (durable by design).
   */
  expiredGraceSeconds?: number;
  /**
   * Suppress the one-time `console.warn` emitted at construction when
   * the default `keyPrefix` is used against a node-redis client on db
   * 0. Set to `true` if you know your Redis is dedicated to this
   * deployment. The recommended fix is to set `keyPrefix` explicitly,
   * not to suppress.
   */
  suppressDefaultPrefixWarning?: boolean;
}

const DEFAULT_KEY_PREFIX = 'adcp:ctx_meta:';
const DEFAULT_EXPIRED_GRACE_SECONDS = 60;

interface SerializedEntry {
  value: unknown;
  resource?: unknown;
  expiresAt?: number;
}

/**
 * Create a Redis-backed ctx-metadata cache.
 *
 * **Startup probe.** Call `store.probe()` before serving traffic to
 * catch a bad `REDIS_URL` at boot rather than on the first
 * ctx_metadata write.
 *
 * **Client error handling.** node-redis emits errors on the client
 * itself for transient connection drops. Without a listener, Node's
 * `EventEmitter` default-throws and crashes the process. Add one in
 * your bootstrap:
 *
 * ```ts
 * client.on('error', (err) => console.error('redis error', err));
 * ```
 */
export function redisCtxMetadataStore(
  client: CtxMetadataRedisBackendClient,
  options: RedisCtxMetadataBackendOptions = {}
): CtxMetadataBackend {
  // The function calls only the methods on CtxMetadataRedisLikeClient.
  // The wider RedisClientType union covers the node-redis happy path
  // without forcing a cast at the call site; internally we narrow.
  const c = client as CtxMetadataRedisLikeClient;

  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const expiredGraceSeconds = options.expiredGraceSeconds ?? DEFAULT_EXPIRED_GRACE_SECONDS;

  if (!Number.isFinite(expiredGraceSeconds) || expiredGraceSeconds < 0) {
    throw new Error(
      `redisCtxMetadataStore: expiredGraceSeconds must be a non-negative finite number. Got ${expiredGraceSeconds}.`
    );
  }

  maybeWarnOnSharedRedisPrefix({
    client,
    callerKeyPrefix: options.keyPrefix,
    defaultKeyPrefix: DEFAULT_KEY_PREFIX,
    suppress: options.suppressDefaultPrefixWarning,
    backendName: 'redisCtxMetadataStore',
  });

  function prefixed(scopedKey: string): string {
    return `${keyPrefix}${scopedKey}`;
  }

  /**
   * Compute the Redis TTL when `expiresAt` is set. Returns `undefined`
   * when no TTL should be applied (entry is durable). Throws if the
   * resulting TTL would be non-positive — a logic bug at the caller.
   */
  function ttlFor(expiresAt: number | undefined): number | undefined {
    if (expiresAt === undefined) return undefined;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = Math.floor(expiresAt - nowSeconds + expiredGraceSeconds);
    if (ttl <= 0) {
      throw new Error(
        `redisCtxMetadataStore: refusing to write an entry whose expiresAt (${expiresAt}) is already past — ` +
          `the substrate-level TTL would be ${ttl}s. Caller logic error.`
      );
    }
    return ttl;
  }

  function parseEntry(raw: string, scopedKey: string): CtxMetadataEntry {
    let parsed: SerializedEntry;
    try {
      parsed = JSON.parse(raw) as SerializedEntry;
    } catch (err) {
      // The scoped key contains the account id — omit from the public
      // message; attach the parse error as Error.cause so server logs
      // retain the detail without leaking via response bodies.
      void scopedKey;
      throw new Error(
        'redisCtxMetadataStore: corrupt cache entry — not valid JSON. See server logs for key + parse error.',
        {
          cause: err,
        }
      );
    }
    const entry: CtxMetadataEntry = { value: parsed.value };
    if (parsed.resource !== undefined) entry.resource = parsed.resource;
    if (parsed.expiresAt !== undefined) entry.expiresAt = parsed.expiresAt;
    return entry;
  }

  return {
    async probe(): Promise<void> {
      try {
        await c.ping();
      } catch (err) {
        throw new Error(
          `ctx_metadata backend probe failed: Redis is unreachable or misconfigured. ` +
            `Check REDIS_URL and that the instance is up. See server logs for the underlying cause.`,
          { cause: err }
        );
      }
    },

    async get(scopedKey: string): Promise<CtxMetadataEntry | null> {
      const raw = await c.get(prefixed(scopedKey));
      if (raw === null) return null;
      return parseEntry(raw, scopedKey);
    },

    async bulkGet(scopedKeys: readonly string[]): Promise<Map<string, CtxMetadataEntry>> {
      if (scopedKeys.length === 0) return new Map();
      const prefixedKeys = scopedKeys.map(k => prefixed(k));
      const raws = await c.mGet(prefixedKeys);
      const out = new Map<string, CtxMetadataEntry>();
      for (let i = 0; i < scopedKeys.length; i++) {
        const raw = raws[i];
        if (raw === null || raw === undefined) continue;
        const scopedKey = scopedKeys[i];
        if (scopedKey === undefined) continue;
        out.set(scopedKey, parseEntry(raw, scopedKey));
      }
      return out;
    },

    async put(scopedKey: string, entry: CtxMetadataEntry): Promise<void> {
      const serialized: SerializedEntry = { value: entry.value };
      if (entry.resource !== undefined) serialized.resource = entry.resource;
      if (entry.expiresAt !== undefined) serialized.expiresAt = entry.expiresAt;
      const ttl = ttlFor(entry.expiresAt);
      const body = JSON.stringify(serialized);
      if (ttl !== undefined) {
        await c.set(prefixed(scopedKey), body, { EX: ttl });
      } else {
        // No TTL: durable entry. Pass undefined / empty options so the
        // call site is symmetric with the pg backend's `expires_at = NULL`.
        await c.set(prefixed(scopedKey), body);
      }
    },

    async delete(scopedKey: string): Promise<void> {
      await c.del(prefixed(scopedKey));
    },
  };
}
