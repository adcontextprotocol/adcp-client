/**
 * Redis backend for the idempotency store.
 *
 * Stores one key per `(principal, key, [extraScope])` carrying the JSON
 * payload `{ payloadHash, response, expiresAt }`. Expiry is enforced by
 * Redis itself via the key TTL — no sweeper job required.
 *
 * **Reclaim semantics.** `putIfAbsent` inserts only when the physical key is
 * absent. Retained logical expiry is reclaimed by
 * `replaceIfPayloadHashAndExpired`, which atomically checks the exact owner and
 * Redis server time. The key itself retains a grace window for buyer-facing
 * `IDEMPOTENCY_EXPIRED` responses; claim ownership still ends at `expiresAt`.
 *
 * **`expired` vs `miss` parity.** The store layer distinguishes `expired`
 * (cached key past TTL within clock-skew window) from `miss` (no cached
 * key) — that affects whether the buyer sees `IDEMPOTENCY_EXPIRED` or a
 * fresh execution. Postgres rows linger past `expires_at` until cleanup;
 * Redis would evict them at the second they expire, collapsing `expired`
 * into `miss`. We hold the key alive for an extra `expiredGraceSeconds`
 * (defaults to 120s — covers the store's default 60s clock skew plus a
 * margin) so the store layer can read `expiresAt` from the value and
 * return `expired` correctly within the skew window.
 *
 * **`clearAll` intentionally omitted.** A shared Redis instance is a
 * production resource — accidentally calling `FLUSHDB` from a compliance
 * reset hook would nuke unrelated keys. Test setups that want a clean
 * slate should run against a dedicated Redis db (`REDIS_URL=…/15`) and
 * call `FLUSHDB` themselves.
 *
 * @example
 * ```typescript
 * import { createClient } from 'redis';
 * import { createIdempotencyStore, createLazyBackend, redisBackend } from '@adcp/sdk/server';
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * client.on('error', (err) => console.error('redis error', err));
 * await client.connect();
 *
 * const store = createIdempotencyStore({
 *   backend: redisBackend(client, { keyPrefix: 'adcp:idem:prod-eu:' }),
 *   ttlSeconds: 86400,
 * });
 *
 * const lazyStore = createIdempotencyStore({
 *   backend: createLazyBackend(async () => redisBackend(await getRedisClient(), { keyPrefix: 'adcp:idem:prod:' })),
 *   ttlSeconds: 86400,
 * });
 * ```
 */

import type { IdempotencyBackend, IdempotencyCacheEntry } from '../store';
// `import type` is erased at emit, so this does NOT make `redis` a hard
// dependency at runtime — adopters who never use `redisBackend` never
// load the redis package. The optional peer-dep declaration in
// package.json still governs install behavior.
import type { RedisClientType } from 'redis';

/**
 * Escape-hatch interface for adopters not using the official `redis`
 * client (node-redis v4/v5) — e.g., `ioredis`, Upstash, a test double.
 *
 * Mirrors the four methods this backend actually calls. All writes use
 * Lua so ownership checks and absolute retention updates stay atomic.
 *
 * @example ioredis adapter
 * ```typescript
 * import Redis from 'ioredis';
 * const ioredis = new Redis(process.env.REDIS_URL!);
 *
 * const client: RedisLikeClient = {
 *   get: (k) => ioredis.get(k),
 *   del: (k) => ioredis.del(k as string),
 *   eval: (script, { keys, arguments: args }) =>
 *     ioredis.eval(script, keys.length, ...keys, ...args),
 *   ping: () => ioredis.ping(),
 * };
 * ```
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  del(key: string | string[]): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  ping(): Promise<string>;
}

/**
 * Accepted client shape: either a real `redis` (node-redis v4/v5)
 * `RedisClientType` (the typical path — pass `createClient(...)` straight
 * in) or an adapter that conforms to `RedisLikeClient` (for `ioredis`,
 * Upstash, or test doubles). The union avoids forcing node-redis users
 * to write `as unknown as RedisLikeClient` casts on the documented path.
 */
export type RedisBackendClient = RedisClientType<any, any, any> | RedisLikeClient;

export interface RedisBackendOptions {
  /**
   * Key prefix prepended to every scoped key written to Redis. Defaults
   * to `"adcp:idem:"`.
   *
   * **Sharing a Redis db across deployments? Override this.** The default
   * is fine for a dedicated Redis (or a dedicated db index) and for
   * coexisting with non-AdCP applications. But two AdCP servers sharing
   * the *same* db with the *same* default prefix will collide on any
   * overlapping principal namespace (e.g., both deployments having a
   * tenant called `acme`) — the principal segment is per-tenant, not
   * per-deployment, so it's the wrong layer to do deployment isolation.
   * Set a deployment-unique prefix (`"adcp:idem:prod-eu:"`, etc.) or use
   * separate Redis dbs.
   */
  keyPrefix?: string;
  /**
   * Suppress the one-time `console.warn` emitted at construction when the
   * default `keyPrefix` is used against a node-redis client that appears
   * to be on db 0 (the most likely signal of a shared, non-dedicated
   * Redis). Set to `true` if you know your Redis is dedicated to this
   * AdCP deployment and don't want the warning noise. The recommended
   * fix is to set `keyPrefix` explicitly, not to suppress. This flag only
   * controls development/test warnings; it is not a production isolation
   * acknowledgement.
   */
  suppressDefaultPrefixWarning?: boolean;
  /**
   * Explicitly acknowledge that this client uses a Redis database isolated
   * to one AdCP deployment. Outside development and test, this is required
   * when `keyPrefix` is omitted, empty, or equal to the shared SDK default.
   * Prefer a deployment-unique `keyPrefix`; use this only for a dedicated
   * database whose isolation is enforced operationally.
   */
  acknowledgeIsolatedDatabase?: boolean;
  /**
   * How many seconds past `expiresAt` to keep the key alive in Redis, so
   * the store layer can still read it during the clock-skew window and
   * return `IDEMPOTENCY_EXPIRED` (rather than treating it as a fresh
   * miss). Defaults to 120s — covers the store's default 60s skew with
   * margin. When this backend is passed to `createIdempotencyStore`, the
   * value must be at least that store's `clockSkewSeconds`; construction
   * fails rather than allowing Redis to evict legacy entries before the
   * advertised skew window. For newly written entries, the physical TTL
   * also never precedes the store-supplied `retainUntil` safety horizon.
   * Setting this to `0` is therefore supported only with a zero-skew store
   * (or when using the backend directly) and removes the extra Redis linger.
   */
  expiredGraceSeconds?: number;
}

const DEFAULT_KEY_PREFIX = 'adcp:idem:';
const DEFAULT_EXPIRED_GRACE_SECONDS = 120;

/**
 * Module-level once-flag: the default-prefix-on-db-0 warning fires at
 * most once per process across all redisBackend instances. Operators
 * standing up multiple backends (sharded, multi-region) shouldn't see
 * N identical warnings.
 */
let hasWarnedAboutDefaultPrefix = false;

interface SerializedEntry {
  payloadHash: string;
  response: unknown;
  expiresAt: number;
  retainUntil: number;
}

/**
 * Best-effort introspection: detect the Redis db index when the client
 * is a node-redis v4/v5 `RedisClientType`. Returns `null` for escape-
 * hatch clients (ioredis, Upstash, test doubles, mocks) where we can't
 * tell — prefer false-negative over a noisy false-positive warning.
 *
 * The default-prefix warning uses this to decide whether to fire: db 0
 * is the strong signal of a shared/non-dedicated Redis (the typical
 * "I just spun up Redis" path); db > 0 is the signal of an operator
 * who already partitioned, who doesn't need the nag.
 */
function detectNodeRedisDbIndex(client: unknown): number | null {
  if (!client || typeof client !== 'object') return null;
  const opts = (client as { options?: Record<string, unknown> }).options;
  if (!opts || typeof opts !== 'object') return null;
  if (typeof opts.database === 'number') return opts.database;
  if (typeof opts.url === 'string') {
    try {
      const u = new URL(opts.url);
      if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') return null;
      const path = u.pathname.replace(/^\//, '');
      if (path === '') return 0;
      const n = Number(path);
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Test-only escape hatch to reset the once-warn flag between test runs.
 * Not exported through any index — adopters can't reach it from outside
 * this file.
 */
export function __resetDefaultPrefixWarningForTests(): void {
  hasWarnedAboutDefaultPrefix = false;
}

/**
 * Create a Redis-backed idempotency cache.
 *
 * **Startup probe.** Call `store.probe()` (or `probeIdempotencyStore(store)`)
 * before serving traffic to catch a bad `REDIS_URL` or unreachable
 * instance at boot rather than on the first mutating request. Wire it via:
 *
 * ```ts
 * serve(createAgent, { readinessCheck: () => store.probe() });
 * ```
 *
 * **Client error handling.** node-redis emits errors on the client itself
 * for transient connection drops. Without a listener, Node's
 * `EventEmitter` default-throws and crashes the process. Add one in your
 * bootstrap:
 *
 * ```ts
 * client.on('error', (err) => console.error('redis error', err));
 * ```
 *
 * **Redis memory policy — set this on the deployment.** A buyer with a
 * valid principal can mint unbounded distinct `idempotency_key` values
 * and hit any mutating tool; each write adds a key to Redis with the
 * configured `ttlSeconds` (default 24h). A sufficient rate can pressure
 * Redis memory before TTLs evict naturally. Configure your Redis with:
 *
 * - **`maxmemory-policy volatile-lru`** (recommended) — evicts only
 *   TTL'd keys, containing blast radius to AdCP's keyspace if the
 *   instance is shared with other apps. All keys this backend writes
 *   carry TTL, so this is safe.
 * - **`maxmemory-policy allkeys-lru`** — only on a Redis db dedicated
 *   to AdCP. Will evict your other keys if shared.
 * - **`maxmemory-policy noeviction`** (Redis default) — fail-closed:
 *   the backend's writes will start erroring once memory fills, and
 *   mutating requests will fail. Operationally noisy but never serves
 *   stale data; choose this only if you'd rather page than evict.
 *
 * Pair with alerting on a per-principal `VALIDATION_ERROR` rate — a
 * drifted handler hit by a retrying buyer writes 10s-TTL entries on
 * every fresh key, amplifying the rate of cache fill. Steady-state
 * `VALIDATION_ERROR` should be zero.
 */
export function redisBackend(client: RedisBackendClient, options: RedisBackendOptions = {}): IdempotencyBackend {
  // The function calls only the four methods on RedisLikeClient. The
  // wider RedisClientType union covers the node-redis happy path without
  // forcing a cast at the call site; internally we narrow.
  const c = client as RedisLikeClient;

  for (const method of ['get', 'del', 'eval', 'ping'] as const) {
    if (typeof c?.[method] !== 'function') {
      throw new Error(
        `redisBackend: client must implement ${method}(). ` +
          'Pass a node-redis compatible client or an adapter implementing get/del/eval/ping; atomic replay fencing depends on these methods.'
      );
    }
  }

  if (options.keyPrefix !== undefined && typeof options.keyPrefix !== 'string') {
    throw new Error('redisBackend: keyPrefix must be a string when provided.');
  }
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const usesUnsafeDefaultPrefix =
    options.keyPrefix === undefined || keyPrefix.trim().length === 0 || keyPrefix === DEFAULT_KEY_PREFIX;
  const expiredGraceSeconds = options.expiredGraceSeconds ?? DEFAULT_EXPIRED_GRACE_SECONDS;

  if (!Number.isSafeInteger(expiredGraceSeconds) || expiredGraceSeconds < 0) {
    throw new Error(
      `redisBackend: expiredGraceSeconds must be a non-negative safe integer. Got ${expiredGraceSeconds}.`
    );
  }

  const isAllowlistedDevEnv = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (!isAllowlistedDevEnv && usesUnsafeDefaultPrefix && !options.acknowledgeIsolatedDatabase) {
    throw new Error(
      'redisBackend: non-development environments require a deployment-unique keyPrefix. ' +
        'Use a dedicated Redis database and pass acknowledgeIsolatedDatabase: true only as an explicit isolation acknowledgement.'
    );
  }

  // One-time warning when the default keyPrefix is paired with a
  // node-redis client we can confidently identify as being on db 0 —
  // the strong signal of a shared/non-dedicated Redis where the
  // default prefix is most likely to collide with another deployment.
  // Stays silent for escape-hatch clients (ioredis, test doubles)
  // because we can't introspect their db index.
  if (
    usesUnsafeDefaultPrefix &&
    !options.suppressDefaultPrefixWarning &&
    !options.acknowledgeIsolatedDatabase &&
    !hasWarnedAboutDefaultPrefix &&
    detectNodeRedisDbIndex(client) === 0
  ) {
    hasWarnedAboutDefaultPrefix = true;
    console.warn(
      `redisBackend: using the default keyPrefix "${DEFAULT_KEY_PREFIX}" against Redis db 0. ` +
        `If this Redis db is shared with another AdCP deployment (or other apps), the principal ` +
        `segment alone is not enough to prevent cross-deployment collision. Set a deployment-unique ` +
        `keyPrefix (e.g., "adcp:idem:prod-eu:") or use a dedicated Redis db. ` +
        `In development/test, pass { suppressDefaultPrefixWarning: true } to silence this warning. ` +
        `For a dedicated database outside development/test, pass { acknowledgeIsolatedDatabase: true }.`
    );
  }

  function prefixed(scopedKey: string): string {
    return `${keyPrefix}${scopedKey}`;
  }

  async function runtimeCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      throw new Error(`redisBackend.${operation}: database operation failed`, { cause: err });
    }
  }

  /** Resolve the absolute physical-retention horizon passed into Redis Lua. */
  function physicalExpiryFor(entry: Pick<IdempotencyCacheEntry, 'expiresAt' | 'retainUntil'>): number {
    const physicalExpiry = Math.max(entry.retainUntil ?? entry.expiresAt, entry.expiresAt + expiredGraceSeconds);
    if (!Number.isSafeInteger(physicalExpiry)) {
      throw new Error('redisBackend: refusing to write an entry with an invalid retention horizon.');
    }
    return physicalExpiry;
  }

  return {
    legacyRetentionGraceSeconds: expiredGraceSeconds,
    async probe(): Promise<void> {
      try {
        await c.ping();
      } catch (err) {
        // Generic user-facing message; the underlying error rides on
        // `Error.cause` for operators who log it. Avoids leaking infra
        // shape (`ECONNREFUSED 10.0.x.x`, `WRONGPASS …`) into any
        // adopter that wires probe failures into an external-facing
        // `/healthz` body.
        throw new Error(
          `idempotency backend probe failed: Redis is unreachable or misconfigured. ` +
            `The server would advertise IdempotencySupported but every mutating call would fail. ` +
            `Check REDIS_URL and that the instance is up. See server logs for the underlying cause.`,
          { cause: err }
        );
      }
    },

    async get(scopedKey: string): Promise<IdempotencyCacheEntry | null> {
      const raw = await runtimeCall('get', () => c.get(prefixed(scopedKey)));
      if (raw === null) return null;
      let parsed: SerializedEntry;
      try {
        parsed = JSON.parse(raw) as SerializedEntry;
      } catch (err) {
        // A corrupt value at our key is a bigger problem than a single
        // cache miss — surface it loudly so an operator can investigate
        // (key collision with another app, manual tampering, etc.). The
        // scoped key contains the principal — omit it from the public
        // message and attach the parse error as Error.cause so server
        // logs retain the detail without leaking via response bodies.
        throw new Error('redisBackend: corrupt cache entry — not valid JSON. See server logs for key + parse error.', {
          cause: err,
        });
      }
      return {
        payloadHash: parsed.payloadHash,
        response: parsed.response,
        expiresAt: parsed.expiresAt,
        retainUntil: parsed.retainUntil ?? parsed.expiresAt + expiredGraceSeconds,
      };
    },

    async put(scopedKey: string, entry: IdempotencyCacheEntry): Promise<void> {
      await runtimeCall('put', () =>
        c.eval(
          `local redis_time = redis.call('TIME')
         local now = tonumber(redis_time[1])
         local ttl = tonumber(ARGV[2]) - now + 1
         if ttl <= 0 then return redis.error_reply('retention horizon is already past') end
         redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
         return 1`,
          {
            keys: [prefixed(scopedKey)],
            arguments: [JSON.stringify(entry), String(physicalExpiryFor(entry))],
          }
        )
      );
    },

    async putIfAbsent(scopedKey: string, entry: IdempotencyCacheEntry): Promise<boolean> {
      const result = await runtimeCall('putIfAbsent', () =>
        c.eval(
          `local raw = redis.call('GET', KEYS[1])
         if raw then return 0 end
         local redis_time = redis.call('TIME')
         local now = tonumber(redis_time[1])
         local ttl = tonumber(ARGV[2]) - now + 1
         if ttl <= 0 then return redis.error_reply('retention horizon is already past') end
         redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
         return 1`,
          {
            keys: [prefixed(scopedKey)],
            arguments: [JSON.stringify(entry), String(physicalExpiryFor(entry))],
          }
        )
      );
      return Number(result) === 1;
    },

    async replaceIfPayloadHash(
      scopedKey: string,
      expectedPayloadHash: string,
      entry: IdempotencyCacheEntry
    ): Promise<boolean> {
      const result = await runtimeCall('replaceIfPayloadHash', () =>
        c.eval(
          `local raw = redis.call('GET', KEYS[1])
         if not raw then return 0 end
         local current = cjson.decode(raw)
         if current.payloadHash ~= ARGV[1] then return 0 end
         local redis_time = redis.call('TIME')
         local now = tonumber(redis_time[1])
         local ttl = tonumber(ARGV[3]) - now + 1
         if ttl <= 0 then return redis.error_reply('retention horizon is already past') end
         redis.call('SET', KEYS[1], ARGV[2], 'EX', ttl)
         return 1`,
          {
            keys: [prefixed(scopedKey)],
            arguments: [expectedPayloadHash, JSON.stringify(entry), String(physicalExpiryFor(entry))],
          }
        )
      );
      return Number(result) === 1;
    },

    async replaceIfPayloadHashAndExpired(
      scopedKey: string,
      expectedPayloadHash: string,
      entry: IdempotencyCacheEntry
    ): Promise<boolean> {
      const result = await runtimeCall('replaceIfPayloadHashAndExpired', () =>
        c.eval(
          `local raw = redis.call('GET', KEYS[1])
         if not raw then return 0 end
         local current = cjson.decode(raw)
         if current.payloadHash ~= ARGV[1] then return 0 end
         local redis_time = redis.call('TIME')
         local now = tonumber(redis_time[1])
         if tonumber(current.expiresAt) >= now then return 0 end
         local ttl = tonumber(ARGV[3]) - now + 1
         if ttl <= 0 then return redis.error_reply('retention horizon is already past') end
         redis.call('SET', KEYS[1], ARGV[2], 'EX', ttl)
         return 1`,
          {
            keys: [prefixed(scopedKey)],
            arguments: [expectedPayloadHash, JSON.stringify(entry), String(physicalExpiryFor(entry))],
          }
        )
      );
      return Number(result) === 1;
    },

    async deleteIfPayloadHash(scopedKey: string, expectedPayloadHash: string): Promise<boolean> {
      const result = await runtimeCall('deleteIfPayloadHash', () =>
        c.eval(
          `local raw = redis.call('GET', KEYS[1])
         if not raw then return 0 end
         local current = cjson.decode(raw)
         if current.payloadHash ~= ARGV[1] then return 0 end
         return redis.call('DEL', KEYS[1])`,
          { keys: [prefixed(scopedKey)], arguments: [expectedPayloadHash] }
        )
      );
      return Number(result) === 1;
    },

    async delete(scopedKey: string): Promise<void> {
      await runtimeCall('delete', () => c.del(prefixed(scopedKey)));
    },
  };
}
