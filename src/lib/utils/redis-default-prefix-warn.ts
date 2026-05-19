/**
 * Shared default-prefix-on-db-0 warning helper for Redis backends.
 *
 * Every Redis-backed SDK store (idempotency, ctx-metadata, replay)
 * prefixes its keys (`"adcp:idem:"`, `"adcp:ctx_meta:"`, `"adcp:replay:"`)
 * so a shared Redis instance can host multiple AdCP servers — or AdCP
 * alongside other apps — without collision. But two AdCP deployments
 * sharing the *same* db with the *same* default prefix collide on any
 * overlapping principal/account/keyid namespace.
 *
 * This helper emits a one-time `console.warn` at backend construction
 * when the default prefix meets a node-redis client we can confidently
 * identify as being on db 0 (the most likely signal of a shared,
 * non-dedicated Redis). Once per process across every backend that uses
 * it — operators standing up multiple Redis backends shouldn't see N
 * identical warnings.
 *
 * Best-effort: stays silent for escape-hatch clients (ioredis, Upstash,
 * test doubles) where we can't introspect the db index. Prefer
 * false-negative over a noisy false-positive warning.
 */

let hasWarnedAboutDefaultPrefix = false;

/**
 * Detect the Redis db index when the client is a node-redis v4/v5
 * `RedisClientType`. Returns `null` for clients we can't introspect.
 *
 * Reads `client.options.database` (numeric, present when the client was
 * constructed with `createClient({ database: N })`) or parses the path
 * component of `client.options.url`. Escape-hatch clients (no `options`
 * object of the canonical shape) return `null` and skip the warn.
 */
export function detectNodeRedisDbIndex(client: unknown): number | null {
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

export interface WarnOnSharedRedisPrefixOptions {
  /** The Redis client passed to the backend constructor. */
  client: unknown;
  /** `options.keyPrefix` as the caller passed it — `undefined` means default. */
  callerKeyPrefix: string | undefined;
  /** The backend's own default prefix (e.g., `"adcp:idem:"`). */
  defaultKeyPrefix: string;
  /** Caller-supplied suppression switch. */
  suppress: boolean | undefined;
  /** Backend label for the warning text (e.g., `"redisBackend"`, `"redisCtxMetadataStore"`). */
  backendName: string;
}

/**
 * Emit the one-time warn if (a) the caller used the default `keyPrefix`,
 * (b) didn't pass `suppress`, (c) we can confidently see db 0 from the
 * client. Otherwise silent.
 *
 * **Once per process.** All Redis backends share the warn flag — an
 * adopter who configures three Redis-backed stores against the same
 * misconfigured Redis sees one warning total, not three.
 */
export function maybeWarnOnSharedRedisPrefix(options: WarnOnSharedRedisPrefixOptions): void {
  if (options.callerKeyPrefix !== undefined) return;
  if (options.suppress) return;
  if (hasWarnedAboutDefaultPrefix) return;
  if (detectNodeRedisDbIndex(options.client) !== 0) return;

  hasWarnedAboutDefaultPrefix = true;
  console.warn(
    `${options.backendName}: using the default keyPrefix "${options.defaultKeyPrefix}" against Redis db 0. ` +
      `If this Redis db is shared with another AdCP deployment (or other apps), the per-tenant scope ` +
      `segment alone is not enough to prevent cross-deployment collision. Set a deployment-unique ` +
      `keyPrefix (e.g., "${options.defaultKeyPrefix}prod-eu:") or use a dedicated Redis db. ` +
      `Pass { suppressDefaultPrefixWarning: true } to silence this once you've confirmed isolation.`
  );
}

/**
 * Test-only escape hatch to reset the once-warn flag between test runs.
 * Not exported through any public index — adopters can't reach it from
 * outside the SDK.
 */
export function __resetDefaultPrefixWarningForTests(): void {
  hasWarnedAboutDefaultPrefix = false;
}
