/**
 * Redis-backed `ReplayStore` for distributed AdCP verifier deployments.
 *
 * Sister of `PostgresReplayStore`. The spec comment on `ReplayStore.insert`
 * (`src/lib/signing/replay.ts`) literally names this as a canonical
 * implementation: "Multi-replica adopters writing Redis / Postgres
 * stores MUST implement this as a single atomic operation (e.g. Redis
 * `SET NX EX`, Postgres `INSERT ... ON CONFLICT DO NOTHING RETURNING`,
 * a `WATCH/MULTI/EXEC` transaction)."
 *
 * **Data model.** One Redis sorted set per `(keyid, scope)` pair. The
 * sorted-set members are nonces; the score is `expiresAt` (unix epoch
 * seconds). Sorted sets give us all three primitives the `ReplayStore`
 * interface needs in single Redis commands:
 *
 * - `has(nonce)` → `ZSCORE` + JS-side `score > now` check.
 * - `isCapHit()` → `ZCOUNT key (now +inf` (active nonces).
 * - `insert()` → a Lua script that runs `ZREMRANGEBYSCORE -inf now`
 *   (drop expired) → `ZSCORE` (replay check) → `ZCARD` (cap check) →
 *   `ZADD` (insert) + `PEXPIREAT` (extend set's own TTL) atomically.
 *
 * **No sweeper needed.** Expired nonces are dropped at the start of
 * every `insert` (the `ZREMRANGEBYSCORE` step), and Redis evicts the
 * entire sorted set when its `PEXPIREAT` lapses if no further inserts
 * arrive. The Postgres backend's `sweepExpiredReplays` cron has no
 * Redis equivalent — eviction is automatic.
 *
 * **Atomicity.** The Lua script runs as a single uninterruptable
 * operation against the Redis server (Redis is single-threaded; Lua
 * blocks everything else for the script duration). Two concurrent
 * `insert` calls with the same `(keyid, scope, nonce)` are guaranteed
 * to see exactly one `'ok'` and one `'replayed'` — matches the
 * `InMemoryReplayStore` semantics the spec mandates.
 *
 * @example
 * ```typescript
 * import { createClient } from 'redis';
 * import { RedisReplayStore } from '@adcp/sdk/signing/server';
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * client.on('error', (err) => console.error('redis error', err));
 * await client.connect();
 *
 * const replayStore = new RedisReplayStore(client);
 *
 * app.use(createExpressVerifier({
 *   capability: { ... },
 *   jwks,
 *   replayStore,           // <-- shared across instances
 *   resolveOperation: mcpToolNameResolver,
 * }));
 * ```
 */

// `import type` is erased at emit — `redis` stays an optional peer dep.
import type { RedisClientType } from 'redis';
import type { ReplayInsertResult, ReplayStore } from './replay';
import { maybeWarnOnSharedRedisPrefix } from '../utils/redis-default-prefix-warn';

/**
 * Escape-hatch interface for adopters not using the official `redis`
 * client (node-redis v4/v5) — `ioredis`, Upstash, test doubles.
 * Mirrors the methods this store calls.
 *
 * @example ioredis adapter
 * ```typescript
 * import Redis from 'ioredis';
 * const ioredis = new Redis(process.env.REDIS_URL!);
 *
 * const client: ReplayRedisLikeClient = {
 *   eval: (script, opts) =>
 *     ioredis.eval(script, opts.keys.length, ...opts.keys, ...opts.arguments),
 *   zScore: (k, m) => ioredis.zscore(k, m).then(v => (v === null ? null : Number(v))),
 *   zCount: (k, min, max) => ioredis.zcount(k, min, max),
 *   ping: () => ioredis.ping(),
 * };
 * ```
 */
export interface ReplayRedisLikeClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  zScore(key: string, member: string): Promise<number | null>;
  zCount(key: string, min: number | string, max: number | string): Promise<number>;
  ping(): Promise<string>;
}

/**
 * Accepted client shape: either a real node-redis client (the typical
 * path — pass `createClient(...)` straight in) or an adapter
 * conforming to `ReplayRedisLikeClient`.
 */
export type ReplayRedisBackendClient = RedisClientType<any, any, any> | ReplayRedisLikeClient;

const DEFAULT_KEY_PREFIX = 'adcp:replay:';
const DEFAULT_CAP = 100_000;
/**
 * Extra seconds added to the sorted-set's own `PEXPIREAT` past the
 * latest entry's `expiresAt`. Without this, a sorted set whose last
 * entry just expired would be evicted by Redis between `insert` calls,
 * losing the cap-counter accounting briefly. 1 hour is conservative —
 * memory-cheap because the set is also empty (`ZREMRANGEBYSCORE` ran
 * before the eventual eviction) and short enough that abandoned
 * `(keyid, scope)` tuples don't leak indefinitely.
 */
const DEFAULT_SET_TTL_GRACE_SECONDS = 3600;

export interface RedisReplayStoreOptions {
  /**
   * Key prefix prepended to every `(keyid, scope)` Redis key. Defaults
   * to `"adcp:replay:"`.
   *
   * **Sharing a Redis db across deployments? Override this.** The
   * default is fine for a dedicated Redis (or db index). Two verifier
   * deployments sharing the same db with the same default prefix can
   * collide on overlapping `keyid`s — set a deployment-unique prefix
   * or use separate dbs.
   */
  keyPrefix?: string;
  /**
   * Max retained (unexpired) nonces per `(keyid, scope)` pair before
   * `insert` returns `'rate_abuse'`. Mirrors `PostgresReplayStore`'s
   * cap. Defaults to 100,000.
   *
   * Unlike the Postgres backend, the cap check is **strictly atomic**
   * — it runs inside the same Lua script as the insert. Concurrent
   * inserts at `cap - 1` can never both succeed.
   */
  cap?: number;
  /**
   * How many seconds past the latest entry's `expiresAt` to keep the
   * sorted set alive in Redis. Defaults to 3600 (1h). See the
   * `DEFAULT_SET_TTL_GRACE_SECONDS` comment for rationale.
   */
  setTtlGraceSeconds?: number;
  /**
   * Suppress the one-time `console.warn` at construction when the
   * default `keyPrefix` is used against a node-redis client on db 0.
   */
  suppressDefaultPrefixWarning?: boolean;
}

/**
 * Lua script — atomic replay check, cap check, and insert.
 *
 * KEYS[1] — the sorted-set key for this `(keyid, scope)` pair.
 * ARGV[1] — nonce.
 * ARGV[2] — expiresAt (unix epoch seconds).
 * ARGV[3] — now (unix epoch seconds).
 * ARGV[4] — cap (max retained nonces).
 * ARGV[5] — setTtlGraceSeconds (extra TTL on the sorted set itself).
 *
 * Returns the literal string `'ok'`, `'replayed'`, or `'rate_abuse'`
 * to match the `ReplayInsertResult` enum.
 *
 * Precedence (matches `InMemoryReplayStore` and `PostgresReplayStore`):
 *   1. replay wins,
 *   2. then rate_abuse,
 *   3. then ok.
 *
 * The `ZREMRANGEBYSCORE` step drops entries whose score is `<= now` —
 * matching the pg backend's `expires_at > to_timestamp($4)` "still
 * valid" semantic.
 */
const INSERT_LUA = `
local key = KEYS[1]
local nonce = ARGV[1]
local expiresAt = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cap = tonumber(ARGV[4])
local grace = tonumber(ARGV[5])

-- Drop expired entries first (inclusive: score <= now is expired)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

-- Replay check — only unexpired entries can be found by ZSCORE because
-- the cleanup above ran.
if redis.call('ZSCORE', key, nonce) then
  return 'replayed'
end

-- Cap check (count of unexpired entries — already pruned above)
if redis.call('ZCARD', key) >= cap then
  return 'rate_abuse'
end

-- Insert + extend set TTL so abandoned (keyid, scope) tuples evict
redis.call('ZADD', key, expiresAt, nonce)
redis.call('PEXPIREAT', key, (expiresAt + grace) * 1000)
return 'ok'
`;

/**
 * Reject non-finite / out-of-range timestamps before they reach Redis.
 * Matches the Postgres backend's defensive guard so a buggy `options.now()`
 * injection can't DoS the verifier with Redis parse errors.
 */
function assertFiniteSeconds(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`RedisReplayStore: ${label} must be a finite non-negative number; received ${value}`);
  }
}

export class RedisReplayStore implements ReplayStore {
  private readonly c: ReplayRedisLikeClient;
  private readonly keyPrefix: string;
  private readonly cap: number;
  private readonly setTtlGraceSeconds: number;

  constructor(client: ReplayRedisBackendClient, options: RedisReplayStoreOptions = {}) {
    this.c = client as ReplayRedisLikeClient;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.cap = options.cap ?? DEFAULT_CAP;
    this.setTtlGraceSeconds = options.setTtlGraceSeconds ?? DEFAULT_SET_TTL_GRACE_SECONDS;

    if (!Number.isFinite(this.cap) || this.cap <= 0) {
      throw new Error(`RedisReplayStore: cap must be a positive finite number. Got ${this.cap}.`);
    }
    if (!Number.isFinite(this.setTtlGraceSeconds) || this.setTtlGraceSeconds < 0) {
      throw new Error(
        `RedisReplayStore: setTtlGraceSeconds must be a non-negative finite number. Got ${this.setTtlGraceSeconds}.`
      );
    }

    maybeWarnOnSharedRedisPrefix({
      client,
      callerKeyPrefix: options.keyPrefix,
      defaultKeyPrefix: DEFAULT_KEY_PREFIX,
      suppress: options.suppressDefaultPrefixWarning,
      backendName: 'RedisReplayStore',
    });
  }

  /**
   * Compose the sorted-set Redis key for a `(keyid, scope)` pair.
   * Uses `\x1f` (unit separator) between segments — illegal in RFC
   * 7517 JWK kids and in URLs, so no legitimate input collides.
   */
  private redisKey(keyid: string, scope: string): string {
    return `${this.keyPrefix}${keyid}\x1f${scope}`;
  }

  /**
   * Probe — ping Redis. Not part of the `ReplayStore` interface; call
   * before serving traffic if you want a boot-time readiness check.
   */
  async probe(): Promise<void> {
    try {
      await this.c.ping();
    } catch (err) {
      throw new Error(
        `RedisReplayStore probe failed: Redis is unreachable or misconfigured. ` +
          `The verifier would accept signed requests but every replay-cache write would fail. ` +
          `Check REDIS_URL and that the instance is up. See server logs for the underlying cause.`,
        { cause: err }
      );
    }
  }

  async has(keyid: string, scope: string, nonce: string, now: number): Promise<boolean> {
    assertFiniteSeconds('now', now);
    const score = await this.c.zScore(this.redisKey(keyid, scope), nonce);
    // Score === expiresAt. An entry is "present" only if it's still
    // unexpired (score > now). The Lua script also prunes expired
    // entries on insert, but `has` is called independently and can
    // race a never-since-touched key.
    return score !== null && score > now;
  }

  async isCapHit(keyid: string, scope: string, now: number): Promise<boolean> {
    assertFiniteSeconds('now', now);
    // ZCOUNT with `(now` lower bound is exclusive — only entries
    // strictly in the future count toward the cap. Stale entries
    // beyond their expiresAt don't inflate the count even before the
    // next insert prunes them.
    const active = await this.c.zCount(this.redisKey(keyid, scope), `(${now}`, '+inf');
    return active >= this.cap;
  }

  async insert(
    keyid: string,
    scope: string,
    nonce: string,
    ttlSeconds: number,
    now: number
  ): Promise<ReplayInsertResult> {
    assertFiniteSeconds('now', now);
    assertFiniteSeconds('ttlSeconds', ttlSeconds);
    const expiresAt = now + ttlSeconds;
    const result = await this.c.eval(INSERT_LUA, {
      keys: [this.redisKey(keyid, scope)],
      arguments: [nonce, String(expiresAt), String(now), String(this.cap), String(this.setTtlGraceSeconds)],
    });
    if (result !== 'ok' && result !== 'replayed' && result !== 'rate_abuse') {
      throw new Error(`RedisReplayStore.insert: Lua script returned unexpected value: ${String(result)}`);
    }
    return result;
  }
}
