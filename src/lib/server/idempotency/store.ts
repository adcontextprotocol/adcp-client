/**
 * Idempotency store for AdCP server handlers.
 *
 * AdCP v3 requires `idempotency_key` on every mutating request. This store:
 *
 * 1. Hashes the canonical request payload (RFC 8785 JCS) to detect same-key
 *    reuse with a different payload → `IDEMPOTENCY_CONFLICT`.
 * 2. Caches successful response payloads per `(principal, key)` for the
 *    declared replay window, so retries of the same key return the same
 *    response — without re-executing side effects.
 * 3. Rejects keys past the TTL (with ±60s clock-skew tolerance) as
 *    `IDEMPOTENCY_EXPIRED`, turning the silent-double-book footgun into
 *    a loud failure.
 * 4. Declares the window on `get_adcp_capabilities` so buyers can reason
 *    about retry safety.
 *
 * Scope is `(principal, key)` — keys don't need to be globally unique,
 * just unique per principal. Per-principal scoping prevents cross-tenant
 * replay oracles where one tenant could probe another's cached responses.
 *
 * @example
 * ```typescript
 * import { createAdcpServer, createIdempotencyStore, memoryBackend } from '@adcp/client/server';
 *
 * const idempotency = createIdempotencyStore({
 *   backend: memoryBackend(),
 *   ttlSeconds: 86400,
 * });
 *
 * createAdcpServer({
 *   idempotency,
 *   resolveSessionKey: (ctx) => ctx.account?.id,  // doubles as idempotency principal
 *   mediaBuy: { createMediaBuy: async (params, ctx) => {...} },
 * });
 * ```
 */

import { canonicalJsonSha256 } from '../../utils/jcs';

/**
 * Fields excluded from the canonical payload hash.
 *
 * Closed list — future additions are a breaking change to equivalence
 * semantics. Keep in sync with the upstream spec exclusion list:
 *
 * - `idempotency_key` — excluded by definition (it IS the dedup key)
 * - `context` — varies on retry by design (correlation IDs, etc.) BUT
 *   only when it's the standard object echo-back shape. Some tools
 *   (`si_initiate_session`, `si_get_offering`) use `context` as a
 *   load-bearing string; strings are kept in the hash so that a retry
 *   with a different handoff description is correctly flagged as
 *   IDEMPOTENCY_CONFLICT.
 * - `governance_context` — may be a refreshed signed token on retry
 * - `push_notification_config.authentication.credentials` — may be a rotated
 *   bearer/HMAC credential. The URL and scheme stay in the hash; only the
 *   credential value is excluded.
 */
const HASH_EXCLUSION_FIELDS = ['idempotency_key', 'governance_context'] as const;

/**
 * A stored cache entry for a successfully-executed mutating request.
 */
export interface IdempotencyCacheEntry {
  /** SHA-256 of the RFC 8785 JCS form of the request payload (excluding exclusion list). */
  payloadHash: string;
  /** The response payload to replay. Does NOT include the envelope — envelope fields vary per response. */
  response: unknown;
  /** Unix epoch seconds when this entry expires. */
  expiresAt: number;
}

/**
 * Storage backend interface. Swap implementations for memory, Postgres, Redis, etc.
 *
 * Keys are already composed as `{principal}\u001f{key}` (or with extra
 * scope segments for per-session tools) before reaching the backend —
 * backends don't need to know about scoping. The separator is U+001F
 * (unit separator) rather than NUL because Postgres TEXT columns reject
 * NUL bytes; either way the middleware's key-pattern validation
 * (`^[A-Za-z0-9_.:-]{16,255}$`) guarantees the separator cannot appear
 * in a legitimate key.
 *
 * **Object-identity contract.** Implementations MUST NOT return the same
 * object reference on subsequent `get` calls — the middleware injects
 * envelope fields (`replayed: true`, echo-back `context`) onto the
 * returned value, and a shared reference would leak those mutations
 * across requests. Implementations that store values by reference (e.g.,
 * `memoryBackend`) MUST deep-clone on read; implementations that
 * serialize (e.g., `pgBackend` via JSON) get this for free.
 */
export interface IdempotencyBackend {
  get(scopedKey: string): Promise<IdempotencyCacheEntry | null>;
  /**
   * Atomically insert an entry only if no entry exists for `scopedKey`.
   * Used as a claim step by the middleware to close the concurrent-miss
   * race (two parallel requests with the same fresh key both seeing
   * `miss` and both executing side effects). Returns `true` if the
   * caller "won" the claim and should proceed to run the handler;
   * `false` if another request claimed first (the caller should treat
   * the result as a replay or conflict on re-check).
   */
  putIfAbsent(scopedKey: string, entry: IdempotencyCacheEntry): Promise<boolean>;
  /**
   * Store an entry, overwriting any existing entry with the same
   * `scopedKey`. Used by the middleware to replace the in-flight
   * placeholder (written via `putIfAbsent` at claim time) with the final
   * response after the handler completes.
   */
  put(scopedKey: string, entry: IdempotencyCacheEntry): Promise<void>;
  /**
   * Delete an entry. Used by the middleware to release the claim when
   * the handler fails — errors MUST NOT be cached, so the placeholder
   * is rolled back on error so a retry can re-execute.
   */
  delete(scopedKey: string): Promise<void>;
  /**
   * Optional hook for implementations that need to release resources
   * (close pools, clear timers). Called by `store.close()`.
   */
  close?(): Promise<void>;
  /**
   * Optional test-harness hook that drops every cached entry without
   * releasing backend resources. Used by `AdcpServer.compliance.reset()`
   * between storyboards so idempotency cache hits from one storyboard
   * don't replay into the next (shared brand domain, same key prefix).
   *
   * Production backends that can't cheaply flush everything (e.g., a
   * shared Postgres cluster) should leave this undefined — the reset
   * hook refuses to run when this method is missing unless the caller
   * explicitly opts in with `{ force: true }`.
   */
  clearAll?(): Promise<void>;
}

/**
 * Result of checking the store for a given key + payload.
 */
export type IdempotencyCheckResult =
  | {
      /** Cache hit with matching payload — replay the cached response. */
      kind: 'replay';
      response: unknown;
    }
  | {
      /** Cache hit with different payload — reject as IDEMPOTENCY_CONFLICT. */
      kind: 'conflict';
    }
  | {
      /** Cached key exists but is past TTL — reject as IDEMPOTENCY_EXPIRED. */
      kind: 'expired';
    }
  | {
      /** A parallel request is currently executing the same key — the caller should retry the check. */
      kind: 'in-flight';
    }
  | {
      /** No prior execution for this key — caller should run the handler and save. */
      kind: 'miss';
      payloadHash: string;
    };

export interface IdempotencyStoreConfig {
  /** Storage backend. Use `memoryBackend()` for tests, `pgBackend(pool)` for production. */
  backend: IdempotencyBackend;
  /**
   * Replay window in seconds. MUST be between 3600 (1h) and 604800 (7d)
   * per spec. Out-of-range values throw at construction — silent clamping
   * would hide operator misconfiguration (e.g., `60` meaning "one minute"
   * becoming `3600` and getting declared to buyers as a 1h replay window).
   * Defaults to 86400 (24h).
   */
  ttlSeconds?: number;
  /**
   * Clock-skew tolerance in seconds. A key is treated as still valid for
   * this many seconds past its actual expiry, to avoid spurious
   * IDEMPOTENCY_EXPIRED rejections when the buyer's clock drifts forward.
   * Defaults to 60 (1 minute).
   */
  clockSkewSeconds?: number;
}

/**
 * Additional scope contributors for a specific tool, composed into the
 * cache key alongside `(principal, key)`. Used for tools with per-session
 * semantics (`si_send_message` scopes by `session_id`).
 */
export type ExtraScopeResolver = (args: { toolName: string; params: Record<string, unknown> }) => string | undefined;

export interface IdempotencyStore {
  /**
   * Check the store for `(principal, key, payload)` and return whether the
   * caller should replay, reject, or execute fresh.
   *
   * On `miss`, the store writes an in-flight placeholder atomically via
   * the backend's `putIfAbsent`. Only the caller that wins the claim gets
   * `miss`; parallel callers with the same key see `in-flight` and should
   * retry the check after a brief delay. The returned `payloadHash` MUST
   * be passed back to `save()` to avoid double-hashing.
   */
  check(params: {
    principal: string;
    key: string;
    payload: unknown;
    extraScope?: string;
  }): Promise<IdempotencyCheckResult>;
  /**
   * Save a successful execution's response to the cache, replacing the
   * in-flight placeholder written at check time.
   */
  save(params: {
    principal: string;
    key: string;
    payloadHash: string;
    response: unknown;
    extraScope?: string;
  }): Promise<void>;
  /**
   * Release the in-flight claim written at check time — used by the
   * middleware when the handler fails, so a retry can re-execute rather
   * than replay a cached error.
   */
  release(params: { principal: string; key: string; extraScope?: string }): Promise<void>;
  /**
   * Short-TTL cache for an error envelope that the handler is guaranteed
   * to reproduce on re-execution (currently: strict-mode response
   * VALIDATION_ERROR driven by handler drift).
   *
   * Optional on the interface so custom store implementations aren't
   * forced to migrate — when absent, the dispatcher falls back to
   * `release()` (the pre-#758 behavior). Stores backed by
   * `createIdempotencyStore` always include it.
   *
   * Retry-storm guard, not a spec replay. Without it, a drifted handler
   * under strict validation + a retrying buyer produces unbounded
   * re-execution (release-on-error lets every retry hit the handler again
   * with the same drift). Caching for `TRANSIENT_ERROR_TTL_SECONDS` (10s)
   * short-circuits retries within the buyer's typical backoff window.
   *
   * **Operational note — DoS primitive.** A drifted handler reachable by
   * a hostile buyer is a cache-fill vector: every fresh idempotency_key
   * writes a new 10s-TTL entry, cheap because the handler fails fast.
   * Alert on sustained `VALIDATION_ERROR` rates per principal — they
   * indicate either a broken handler (deploy regression) or a buyer
   * probing for drift. Steady-state `VALIDATION_ERROR` should be zero.
   *
   * **Dev-experience note — TTL opacity.** After deploying a handler fix,
   * same-key retries within the 10s window still replay the cached error
   * before the fix takes effect. Iterative handler authors should use a
   * fresh `idempotency_key` to bypass the cache during development.
   */
  saveTransientError?(params: {
    principal: string;
    key: string;
    payloadHash: string;
    response: unknown;
    extraScope?: string;
  }): Promise<void>;
  /**
   * Capability fragment for `get_adcp_capabilities` — tells buyers the
   * replay window so they can reason about retry safety. Pass to
   * `createAdcpServer` via `capabilities.idempotency`.
   */
  capability(): { replay_ttl_seconds: number };
  /** The replay window in seconds (already bounds-checked at construction). */
  readonly ttlSeconds: number;
  /** Release backend resources (close pools, clear timers). */
  close(): Promise<void>;
  /**
   * Drop every cached entry without releasing backend resources.
   * Present only when the configured backend supports it (e.g.,
   * `memoryBackend`). Production-leaning backends leave this undefined
   * so an accidental production call can't flush the cache.
   *
   * Only invoked from `AdcpServer.compliance.reset()` — do not call from
   * production code paths.
   */
  clearAll?(): Promise<void>;
}

const MIN_TTL = 3600; // 1 hour
const MAX_TTL = 604800; // 7 days
const DEFAULT_TTL = 86400; // 24 hours
const DEFAULT_CLOCK_SKEW = 60;
/**
 * How long an in-flight claim lives before it can be reclaimed. Matches
 * the AdCP working-response timeout (120s): a handler that's still
 * running after 120s should have returned `submitted` with a task_id
 * already, so this bounds the "crashed handler" recovery window without
 * holding parallel requests hostage for the full replay TTL.
 */
const IN_FLIGHT_TTL_SECONDS = 120;
/**
 * How long a transient-error cache entry lives. Long enough to absorb a
 * buyer SDK's retry storm (typical exponential backoff takes ~2–3
 * attempts past 10s), short enough that genuine fixes by the handler
 * author aren't gated on TTL expiry during iterative development.
 */
const TRANSIENT_ERROR_TTL_SECONDS = 10;
/**
 * Payload hash for in-flight claims. Different from any real hash so a
 * parallel `check()` with the same payload sees the claim as
 * `in-flight`, not `replay` (an empty claim shouldn't pretend to be a
 * valid cached response).
 */
const IN_FLIGHT_HASH = '__adcp_in_flight__';

/**
 * Create an idempotency store bound to a specific backend and replay window.
 *
 * Throws if `ttlSeconds` is out of spec bounds (1h–7d) — silent clamping
 * would hide operator misconfiguration and lie to buyers about the
 * effective replay window.
 */
export function createIdempotencyStore(config: IdempotencyStoreConfig): IdempotencyStore {
  const ttlSeconds = validateTtl(config.ttlSeconds ?? DEFAULT_TTL);
  const clockSkewSeconds = config.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW;
  const backend = config.backend;

  return {
    ttlSeconds,

    async check({ principal, key, payload, extraScope }): Promise<IdempotencyCheckResult> {
      const scopedKey = scope(principal, key, extraScope);
      const payloadHash = hashPayload(payload);

      const cached = await backend.get(scopedKey);
      if (cached) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (cached.expiresAt + clockSkewSeconds < nowSeconds) {
          return { kind: 'expired' };
        }
        if (cached.payloadHash === IN_FLIGHT_HASH) {
          return { kind: 'in-flight' };
        }
        if (cached.payloadHash !== payloadHash) {
          return { kind: 'conflict' };
        }
        return { kind: 'replay', response: cached.response };
      }

      // Claim the key so parallel requests with the same key see 'in-flight'
      // rather than racing us to execute the handler. Claim TTL is short
      // (120s) so a crashed handler's claim is reclaimable, without
      // holding parallel requests hostage for the full replay window.
      const expiresAt = Math.floor(Date.now() / 1000) + IN_FLIGHT_TTL_SECONDS;
      const claimed = await backend.putIfAbsent(scopedKey, {
        payloadHash: IN_FLIGHT_HASH,
        response: null,
        expiresAt,
      });

      if (!claimed) {
        // Someone beat us to the claim — re-read to find out what they did.
        const recheck = await backend.get(scopedKey);
        if (!recheck) return { kind: 'in-flight' };
        if (recheck.payloadHash === IN_FLIGHT_HASH) return { kind: 'in-flight' };
        if (recheck.payloadHash !== payloadHash) return { kind: 'conflict' };
        return { kind: 'replay', response: recheck.response };
      }

      return { kind: 'miss', payloadHash };
    },

    async save({ principal, key, payloadHash, response, extraScope }): Promise<void> {
      const scopedKey = scope(principal, key, extraScope);
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      await backend.put(scopedKey, { payloadHash, response, expiresAt });
    },

    async release({ principal, key, extraScope }): Promise<void> {
      const scopedKey = scope(principal, key, extraScope);
      await backend.delete(scopedKey);
    },

    async saveTransientError({ principal, key, payloadHash, response, extraScope }): Promise<void> {
      const scopedKey = scope(principal, key, extraScope);
      const expiresAt = Math.floor(Date.now() / 1000) + TRANSIENT_ERROR_TTL_SECONDS;
      await backend.put(scopedKey, { payloadHash, response, expiresAt });
    },

    capability() {
      return { replay_ttl_seconds: ttlSeconds };
    },

    async close() {
      if (backend.close) await backend.close();
    },

    ...(backend.clearAll
      ? {
          async clearAll() {
            await backend.clearAll!();
          },
        }
      : {}),
  };
}

/**
 * Compute the canonical payload hash used for idempotency equivalence.
 *
 * Strips the closed exclusion list (`idempotency_key`, `context` when
 * it's the echo-back object, `governance_context`, and
 * `push_notification_config.authentication.credentials`) before hashing
 * with RFC 8785 JCS + SHA-256.
 */
export function hashPayload(payload: unknown): string {
  return canonicalJsonSha256(stripExclusions(payload));
}

function stripExclusions(payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const src = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if ((HASH_EXCLUSION_FIELDS as readonly string[]).includes(k)) continue;
    // Exclude `context` only when it's the echo-back object shape. SI tools
    // (`si_initiate_session`, `si_get_offering`) use `context` as a
    // load-bearing string (handoff description, offering context); those
    // MUST stay in the hash so a retry with different text is correctly
    // rejected as IDEMPOTENCY_CONFLICT.
    if (k === 'context' && v !== null && typeof v === 'object' && !Array.isArray(v)) continue;
    if (k === 'push_notification_config' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = stripPushNotificationCredentials(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function stripPushNotificationCredentials(pnc: Record<string, unknown>): Record<string, unknown> {
  const auth = pnc.authentication;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return pnc;
  const authCopy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(auth as Record<string, unknown>)) {
    if (k !== 'credentials') authCopy[k] = v;
  }
  return { ...pnc, authentication: authCopy };
}

// ASCII unit separator (U+001F). Used to join scope segments without
// risking ambiguity — the middleware's key-pattern validation bans
// control characters in the key, and principals are server-controlled,
// so this byte can't appear in either segment by legitimate input.
// NUL bytes (U+0000) would be simpler but Postgres TEXT columns reject
// them, so we pick the next-safest non-printable separator.
const SCOPE_SEPARATOR = '\u001f';

function scope(principal: string, key: string, extraScope?: string): string {
  return extraScope
    ? `${principal}${SCOPE_SEPARATOR}${extraScope}${SCOPE_SEPARATOR}${key}`
    : `${principal}${SCOPE_SEPARATOR}${key}`;
}

function validateTtl(seconds: number): number {
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
    throw new Error(`createIdempotencyStore: ttlSeconds must be a finite integer. Got ${seconds}.`);
  }
  if (seconds < MIN_TTL) {
    throw new Error(
      `createIdempotencyStore: ttlSeconds must be >= ${MIN_TTL} (1 hour per AdCP spec). Got ${seconds} — did you mean minutes?`
    );
  }
  if (seconds > MAX_TTL) {
    throw new Error(`createIdempotencyStore: ttlSeconds must be <= ${MAX_TTL} (7 days per AdCP spec). Got ${seconds}.`);
  }
  return seconds;
}
