/**
 * Redis backend for the idempotency store.
 *
 * Stores one key per `(principal, key, [extraScope])` carrying the JSON
 * payload `{ payloadHash, response, expiresAt }`. Expiry is enforced by
 * Redis itself via the key TTL — no sweeper job required.
 *
 * **Reclaim semantics.** The `putIfAbsent` claim maps to `SET … NX EX`:
 * because Redis auto-deletes expired keys, a crashed in-flight claim is
 * naturally reclaimable on retry without the explicit `WHERE expires_at <
 * NOW()` dance the Postgres backend needs.
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
 * import { createIdempotencyStore, redisBackend } from '@adcp/sdk/server';
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * client.on('error', (err) => console.error('redis error', err));
 * await client.connect();
 *
 * const store = createIdempotencyStore({
 *   backend: redisBackend(client),
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
 * Mirrors the four methods this backend actually calls. The `set`
 * signature follows node-redis's options-object form; `ioredis` users
 * pass a thin shim that maps to its positional API.
 *
 * @example ioredis adapter
 * ```typescript
 * import Redis from 'ioredis';
 * const ioredis = new Redis(process.env.REDIS_URL!);
 *
 * const client: RedisLikeClient = {
 *   get: (k) => ioredis.get(k),
 *   set: (k, v, { EX, NX }) =>
 *     NX
 *       ? ioredis.set(k, v, 'EX', EX, 'NX').then(r => (r === 'OK' ? 'OK' : null))
 *       : ioredis.set(k, v, 'EX', EX),
 *   del: (k) => ioredis.del(k as string),
 *   ping: () => ioredis.ping(),
 * };
 * ```
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number; NX?: boolean }): Promise<string | null>;
  del(key: string | string[]): Promise<number>;
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
   * fix is to set `keyPrefix` explicitly, not to suppress.
   */
  suppressDefaultPrefixWarning?: boolean;
  /**
   * How many seconds past `expiresAt` to keep the key alive in Redis, so
   * the store layer can still read it during the clock-skew window and
   * return `IDEMPOTENCY_EXPIRED` (rather than treating it as a fresh
   * miss). Defaults to 120s — covers the store's default 60s skew with
   * margin. Set to 0 to collapse `expired` into `miss` (not recommended
   * — buyers lose the explicit expired signal).
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
 */
export function redisBackend(client: RedisBackendClient, options: RedisBackendOptions = {}): IdempotencyBackend {
  // The function calls only the four methods on RedisLikeClient. The
  // wider RedisClientType union covers the node-redis happy path without
  // forcing a cast at the call site; internally we narrow.
  const c = client as RedisLikeClient;

  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const expiredGraceSeconds = options.expiredGraceSeconds ?? DEFAULT_EXPIRED_GRACE_SECONDS;

  if (!Number.isFinite(expiredGraceSeconds) || expiredGraceSeconds < 0) {
    throw new Error(
      `redisBackend: expiredGraceSeconds must be a non-negative finite number. Got ${expiredGraceSeconds}.`
    );
  }

  // One-time warning when the default keyPrefix is paired with a
  // node-redis client we can confidently identify as being on db 0 —
  // the strong signal of a shared/non-dedicated Redis where the
  // default prefix is most likely to collide with another deployment.
  // Stays silent for escape-hatch clients (ioredis, test doubles)
  // because we can't introspect their db index.
  if (
    options.keyPrefix === undefined &&
    !options.suppressDefaultPrefixWarning &&
    !hasWarnedAboutDefaultPrefix &&
    detectNodeRedisDbIndex(client) === 0
  ) {
    hasWarnedAboutDefaultPrefix = true;
    console.warn(
      `redisBackend: using the default keyPrefix "${DEFAULT_KEY_PREFIX}" against Redis db 0. ` +
        `If this Redis db is shared with another AdCP deployment (or other apps), the principal ` +
        `segment alone is not enough to prevent cross-deployment collision. Set a deployment-unique ` +
        `keyPrefix (e.g., "adcp:idem:prod-eu:") or use a dedicated Redis db. ` +
        `Pass { suppressDefaultPrefixWarning: true } to silence this once you've confirmed isolation.`
    );
  }

  function prefixed(scopedKey: string): string {
    return `${keyPrefix}${scopedKey}`;
  }

  /**
   * Compute the Redis TTL for an entry. The store records absolute
   * `expiresAt`; Redis wants relative seconds. Add `expiredGraceSeconds`
   * so the value lingers through the store's clock-skew window.
   *
   * Throws if the resulting TTL is non-positive — that would mean a
   * caller is writing an entry whose `expiresAt` is already past, which
   * is a logic bug, not a substrate-papering case. A silent `EX 1`
   * clamp would let the entry vanish in 1s and the next caller would
   * see `miss` and re-execute the side effect.
   */
  function ttlFor(expiresAt: number): number {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = Math.floor(expiresAt - nowSeconds + expiredGraceSeconds);
    if (ttl <= 0) {
      throw new Error(
        `redisBackend: refusing to write an entry whose expiresAt (${expiresAt}) is already past — ` +
          `the substrate-level TTL would be ${ttl}s. Caller logic error.`
      );
    }
    return ttl;
  }

  return {
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
      const raw = await c.get(prefixed(scopedKey));
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
      };
    },

    async put(scopedKey: string, entry: IdempotencyCacheEntry): Promise<void> {
      await c.set(prefixed(scopedKey), JSON.stringify(entry), { EX: ttlFor(entry.expiresAt) });
    },

    async putIfAbsent(scopedKey: string, entry: IdempotencyCacheEntry): Promise<boolean> {
      // SET … NX EX: atomic claim. Redis returns 'OK' on success and
      // null when NX prevented the write. Expired keys are already gone
      // from Redis, so the reclaim-stale-claim case the pg backend
      // handles explicitly is automatic here.
      const result = await c.set(prefixed(scopedKey), JSON.stringify(entry), {
        EX: ttlFor(entry.expiresAt),
        NX: true,
      });
      return result !== null;
    },

    async delete(scopedKey: string): Promise<void> {
      await c.del(prefixed(scopedKey));
    },
  };
}
