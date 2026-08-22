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
 * import { createAdcpServer, createIdempotencyStore, memoryBackend } from '@adcp/sdk/server/legacy/v5';
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

import { randomUUID } from 'node:crypto';
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
 *   bearer/HMAC credential.
 * - `reporting_webhook.authentication.credentials` — same write-only
 *   credential semantics for reporting delivery.
 *
 * For both webhook registrations, URL, scheme, token, reporting frequency,
 * requested metrics, and every other routing/semantic field stay in the hash;
 * only the credential value is excluded.
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
  /** Unix epoch seconds before which the backend must not physically prune the entry. */
  retainUntil: number;
}

/** A request attempted to publish or release after its owner lease was replaced. */
export class IdempotencyClaimOwnershipError extends Error {
  constructor(action: string) {
    super(`Idempotency ${action} refused because the request claim is no longer owned.`);
    this.name = 'IdempotencyClaimOwnershipError';
  }
}

/**
 * Storage backend interface. Swap implementations for memory, Postgres, Redis, etc.
 *
 * Keys are already composed as `{principal}\u001f{key}` (or with extra
 * scope segments for per-session tools) before reaching the backend —
 * backends don't need to know about scoping. The separator is U+001F
 * (unit separator) rather than NUL because Postgres TEXT columns reject
 * NUL bytes. The store rejects this separator in principals, keys, and
 * extra-scope segments before backend access; protocol middleware additionally
 * enforces the narrower wire key pattern (`^[A-Za-z0-9_.:-]{16,255}$`).
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
  /**
   * Minimum physical grace applied to legacy records that do not carry an
   * explicit `retainUntil`. When present, store construction rejects a
   * larger logical clock-skew window instead of allowing early pruning.
   */
  legacyRetentionGraceSeconds?: number;
  /** Validate backend-specific physical retention against the logical skew. */
  validateClockSkewSeconds?(clockSkewSeconds: number): void;
  get(scopedKey: string): Promise<IdempotencyCacheEntry | null>;
  /**
   * Atomically install an entry only if no entry exists for `scopedKey` or
   * the current entry is logically expired according to backend time.
   * Expiry comparison and replacement MUST be one atomic operation; an
   * entry expiring exactly now remains live.
   * Used as a claim step by the middleware to close the concurrent-miss
   * race (two parallel requests with the same fresh key both seeing
   * `miss` and both executing side effects). Returns `true` if the
   * caller "won" the claim and should proceed to run the handler;
   * `false` if another request claimed first (the caller should treat
   * the result as a replay or conflict on re-check). Callers that need to
   * reclaim a logically expired entry MUST use this primitive rather than a
   * read-derived CAS, which is vulnerable to renewal and completed-marker
   * ABA races.
   */
  putIfAbsent(scopedKey: string, entry: IdempotencyCacheEntry): Promise<boolean>;
  /** Atomically replace an entry only when its current payload hash matches. */
  replaceIfPayloadHash(scopedKey: string, expectedPayloadHash: string, entry: IdempotencyCacheEntry): Promise<boolean>;
  /** Atomically delete an entry only when its current payload hash matches (used by webhook dedup claims). */
  deleteIfPayloadHash(scopedKey: string, expectedPayloadHash: string): Promise<boolean>;
  /** Store an entry unconditionally. Middleware publication uses fenced replacement instead. */
  put(scopedKey: string, entry: IdempotencyCacheEntry): Promise<void>;
  /** Delete an entry unconditionally. */
  delete(scopedKey: string): Promise<void>;
  /**
   * Optional startup probe. Implementations that wrap an external store
   * (e.g., `pgBackend`) should implement this to eagerly validate the
   * connection before the server starts accepting traffic. Called by
   * `probeIdempotencyStore()` and by `serve()` when `readinessCheck` is
   * wired. Throws a descriptive error when the backend is unreachable or
   * the required schema is missing.
   */
  probe?(): Promise<void>;
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
      /**
       * Suggested retry delay in seconds, derived from the remaining TTL on
       * the first request's in-flight claim (`expiresAt - now`, capped at
       * `IN_FLIGHT_RETRY_HINT_CAP_SECONDS`). The middleware surfaces this as
       * the `retry_after` hint on the `IDEMPOTENCY_IN_FLIGHT` response so a
       * buyer's transient-retry decays toward the expected completion
       * instead of slamming back instantly. Always `>= 1`.
       */
      retryAfterSeconds: number;
    }
  | {
      /** No prior execution for this key — caller should run the handler and save. */
      kind: 'miss';
      payloadHash: string;
      /** Opaque owner fence that MUST be returned to save/release. */
      claimToken: string;
    };

/**
 * Configuration for `createIdempotencyStore`.
 *
 * **Cached responses at rest — handler responsibility.** The store
 * caches whatever the handler returned as the response payload, then
 * `JSON.stringify`-s it into the configured backend for the declared
 * `ttlSeconds` (default 24h, max 7d). The hash-exclusion list strips
 * `idempotency_key`, `governance_context`, and
 * `authentication.credentials` from both `push_notification_config`
 * and `reporting_webhook` from the **hash** so a rotated credential on
 * retry doesn't false-conflict. URL, scheme, token, frequency, metrics,
 * and all other routing/semantic fields remain hashed,
 * but the **stored response** is the handler's verbatim output.
 *
 * If a handler returns a response that includes:
 *
 * - a refreshed bearer / OAuth access token,
 * - a signed governance / auth payload,
 * - `push_notification_config.authentication.credentials` (a buyer-
 *   supplied write-only secret — the contract is that sellers MUST
 *   NOT echo it back; receipt correlation uses
 *   `push_notification_config.token` instead),
 * - `reporting_webhook.authentication.credentials` (the equivalent
 *   write-only reporting-delivery secret),
 * - any other secret material,
 *
 * those secrets sit at rest in the backend for `ttlSeconds`. On Redis
 * without TLS, they're also plaintext over the wire. The framework
 * does not scrub responses before caching — the AdCP spec doesn't
 * require it of either party, and a built-in scrubber would change
 * the wire shape of legitimate adopter responses without warning.
 *
 * Practical guidance:
 *
 * - **Don't return credentials in handler responses.** No AdCP tool's
 *   response schema asks for them; if your adapter is echoing them
 *   back, refactor. `push_notification_config.credentials` in
 *   particular is write-only — `token` is the field a seller uses to
 *   confirm receipt.
 * - If a handler nonetheless must produce a secret-bearing response
 *   (e.g., an internal-only echo for adapter debugging), wrap your
 *   handler to scrub before returning, OR use a custom
 *   `IdempotencyBackend` that transforms entries on the write path.
 *
 * See also `docs/guides/CTX-METADATA-SAFETY.md` for related guidance
 * on what NOT to put in `ctx_metadata` (which has its own caching
 * surface with the same at-rest concern).
 */
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
   * Extend an in-flight request claim while its handler is still running.
   * The implementation MUST compare against `claimToken` atomically and
   * throw `IdempotencyClaimOwnershipError` if that owner no longer holds
   * the claim. Servers call this periodically until the response is saved
   * or the claim is released.
   */
  renew(params: { principal: string; key: string; claimToken: string; extraScope?: string }): Promise<void>;
  /**
   * Save a successful execution's response to the cache, replacing the
   * in-flight placeholder written at check time.
   */
  save(params: {
    principal: string;
    key: string;
    payloadHash: string;
    /** Owner fence returned by the matching `check()` miss. */
    claimToken: string;
    response: unknown;
    extraScope?: string;
  }): Promise<void>;
  /**
   * Release the in-flight claim written at check time — used by the
   * middleware when the handler fails. The built-in store atomically replaces
   * ownership with a retryable marker, preserving the original payload
   * binding while allowing an exact retry to re-execute.
   */
  release(params: { principal: string; key: string; claimToken: string; extraScope?: string }): Promise<void>;
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
    /** Owner fence returned by the matching `check()` miss. */
    claimToken: string;
    response: unknown;
    extraScope?: string;
  }): Promise<void>;
  /**
   * Probe the backend at server startup. Delegates to `backend.probe()` if
   * the backend implements it; otherwise resolves immediately. Wire into
   * `serve()` via `readinessCheck: () => store.probe()` so the server
   * never accepts traffic with a broken pool.
   */
  probe?(): Promise<void>;
  /**
   * Capability fragment describing this store's replay window. Servers
   * created by `createAdcpServer` derive the wire capability directly from
   * the wired store; adopters do not need to pass this value separately.
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
const IN_FLIGHT_HASH_PREFIX = '__adcp_in_flight__:';
const RETRYABLE_HASH_PREFIX = '__adcp_retryable__:';

function isInFlightHash(payloadHash: string): boolean {
  return payloadHash.startsWith(IN_FLIGHT_HASH_PREFIX);
}

function reservedRequestHash(token: string, prefix: string): string | undefined {
  if (!token.startsWith(prefix)) return undefined;
  const suffix = token.slice(prefix.length);
  const separator = suffix.indexOf(':');
  if (separator < 0) return undefined;
  const requestHash = suffix.slice(0, separator);
  return /^[0-9a-f]{64}$/.test(requestHash) ? requestHash : undefined;
}

function inFlightRequestHash(claimToken: string): string | undefined {
  return reservedRequestHash(claimToken, IN_FLIGHT_HASH_PREFIX);
}

function retryableRequestHash(marker: string): string | undefined {
  return reservedRequestHash(marker, RETRYABLE_HASH_PREFIX);
}
/**
 * Soft cap on the retry hint surfaced to buyers on the in-flight branch.
 * Without a cap, a freshly-claimed key (up to the full replay window
 * remaining) would tell the buyer to wait hours or days — worse than the
 * spec's "retry shortly" intent and the buyer's own retry barrier. 30s
 * amortizes a slow handler's tail latency
 * without stalling buyers behind a fresh long-tail claim.
 */
const IN_FLIGHT_RETRY_HINT_CAP_SECONDS = 30;

/**
 * Derive the buyer-facing `retry_after` hint from how much time is left on
 * the in-flight claim (`expiresAt - now`). A freshly-claimed key surfaces
 * `IN_FLIGHT_RETRY_HINT_CAP_SECONDS`; the hint decays as the claim ages so
 * a buyer retrying just before expiry doesn't over-wait. Always clamped to
 * `>= 1` so a near-expired claim doesn't tell the buyer to retry instantly.
 */
function inFlightRetryAfter(expiresAt: number, nowSeconds: number): number {
  const remaining = expiresAt - nowSeconds;
  return Math.max(1, Math.min(IN_FLIGHT_RETRY_HINT_CAP_SECONDS, remaining));
}

/**
 * Create an idempotency store bound to a specific backend and replay window.
 *
 * Throws if `ttlSeconds` is out of spec bounds (1h–7d) — silent clamping
 * would hide operator misconfiguration and lie to buyers about the
 * effective replay window.
 */
export function createIdempotencyStore(config: IdempotencyStoreConfig): IdempotencyStore {
  if (!config || typeof config !== 'object') {
    throw new TypeError(
      'createIdempotencyStore requires an IdempotencyStoreConfig. ' +
        'For tests / single-process: `createIdempotencyStore({ backend: memoryBackend() })`. ' +
        'For production: `createIdempotencyStore({ backend: pgBackend(pool) })`.'
    );
  }
  if (!config.backend) {
    throw new TypeError(
      'createIdempotencyStore: config.backend is required. ' +
        'Pass `memoryBackend()` for tests / single-process deployments or `pgBackend(pool)` for production.'
    );
  }
  const ttlSeconds = validateTtl(config.ttlSeconds ?? DEFAULT_TTL);
  const clockSkewSeconds = config.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW;
  if (!Number.isSafeInteger(clockSkewSeconds) || clockSkewSeconds < 0) {
    throw new TypeError('clockSkewSeconds must be a non-negative safe integer.');
  }
  const backend = config.backend;
  if (backend.legacyRetentionGraceSeconds !== undefined && backend.legacyRetentionGraceSeconds < clockSkewSeconds) {
    throw new TypeError(
      `Idempotency backend legacy retention grace (${backend.legacyRetentionGraceSeconds}s) must be at least ` +
        `clockSkewSeconds (${clockSkewSeconds}s).`
    );
  }
  backend.validateClockSkewSeconds?.(clockSkewSeconds);
  if (typeof backend.replaceIfPayloadHash !== 'function' || typeof backend.deleteIfPayloadHash !== 'function') {
    throw new TypeError(
      'createIdempotencyStore requires atomic replaceIfPayloadHash and deleteIfPayloadHash fencing so stale request owners cannot publish or release newer claims. ' +
        'Use memoryBackend(), pgBackend(pool), redisBackend(client), or implement both methods on the custom backend.'
    );
  }

  return {
    ttlSeconds,

    async check({ principal, key, payload, extraScope }): Promise<IdempotencyCheckResult> {
      const scopedKey = scope(principal, key, extraScope);
      const payloadHash = hashPayload(payload);

      const cached = await backend.get(scopedKey);
      if (cached) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const retryablePayloadHash = retryableRequestHash(cached.payloadHash);
        if (retryablePayloadHash !== undefined) {
          if (cached.expiresAt + clockSkewSeconds < nowSeconds) return { kind: 'expired' };
          if (retryablePayloadHash !== payloadHash) return { kind: 'conflict' };
          const expiresAt = nowSeconds + ttlSeconds;
          const retainUntil = expiresAt + clockSkewSeconds;
          const claimToken = `${IN_FLIGHT_HASH_PREFIX}${payloadHash}:${randomUUID()}`;
          const reclaimed = await backend.replaceIfPayloadHash(scopedKey, cached.payloadHash, {
            payloadHash: claimToken,
            response: null,
            expiresAt,
            retainUntil,
          });
          if (reclaimed) return { kind: 'miss', payloadHash, claimToken };
          const raced = await backend.get(scopedKey);
          if (!raced) return { kind: 'in-flight', retryAfterSeconds: 1 };
          const racedRequestHash = retryableRequestHash(raced.payloadHash) ?? inFlightRequestHash(raced.payloadHash);
          if (racedRequestHash !== undefined && racedRequestHash !== payloadHash) return { kind: 'conflict' };
          if (retryableRequestHash(raced.payloadHash) !== undefined) {
            return { kind: 'in-flight', retryAfterSeconds: 1 };
          }
          if (isInFlightHash(raced.payloadHash)) {
            return { kind: 'in-flight', retryAfterSeconds: inFlightRetryAfter(raced.expiresAt, nowSeconds) };
          }
          if (raced.payloadHash !== payloadHash) return { kind: 'conflict' };
          return { kind: 'replay', response: raced.response };
        }
        if (isInFlightHash(cached.payloadHash)) {
          const activePayloadHash = inFlightRequestHash(cached.payloadHash);
          if (activePayloadHash !== undefined && activePayloadHash !== payloadHash) {
            return { kind: 'conflict' };
          }
          if (cached.expiresAt >= nowSeconds) {
            return { kind: 'in-flight', retryAfterSeconds: inFlightRetryAfter(cached.expiresAt, nowSeconds) };
          }
          if (cached.expiresAt + clockSkewSeconds >= nowSeconds) {
            // Do not turn a just-expired mutation claim into fresh execution
            // while peers may still reasonably observe it as live. The same
            // skew horizon used for completed replay must fence unresolved
            // ownership too.
            return { kind: 'in-flight', retryAfterSeconds: 1 };
          }
          // Fall through to putIfAbsent, whose atomic logical-expiry
          // replacement protects a concurrent renewal from stale-read
          // takeover.
        } else {
          if (cached.expiresAt + clockSkewSeconds < nowSeconds) {
            return { kind: 'expired' };
          }
          if (cached.payloadHash !== payloadHash) {
            return { kind: 'conflict' };
          }
          return { kind: 'replay', response: cached.response };
        }
      }

      // Claim the key so parallel requests with the same key see 'in-flight'
      // rather than racing us to execute the handler. Use the full replay
      // window as the base claim fence: if renewal infrastructure is down
      // while a money-moving handler is still active, a retry must remain
      // blocked rather than automatically re-entering after 120 seconds.
      // The tradeoff is deliberate: a crashed handler can hold its key for
      // the advertised replay window, after which natural-key reconciliation
      // is required anyway.
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const retainUntil = expiresAt + clockSkewSeconds;
      const claimToken = `${IN_FLIGHT_HASH_PREFIX}${payloadHash}:${randomUUID()}`;
      const claimed = await backend.putIfAbsent(scopedKey, {
        payloadHash: claimToken,
        response: null,
        expiresAt,
        retainUntil,
      });

      if (!claimed) {
        // Someone beat us to the claim — re-read to find out what they did.
        const recheck = await backend.get(scopedKey);
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (!recheck) return { kind: 'in-flight', retryAfterSeconds: 1 };
        if (isInFlightHash(recheck.payloadHash)) {
          const activePayloadHash = inFlightRequestHash(recheck.payloadHash);
          if (activePayloadHash !== undefined && activePayloadHash !== payloadHash) return { kind: 'conflict' };
          return { kind: 'in-flight', retryAfterSeconds: inFlightRetryAfter(recheck.expiresAt, nowSeconds) };
        }
        const releasedPayloadHash = retryableRequestHash(recheck.payloadHash);
        if (releasedPayloadHash !== undefined) {
          if (releasedPayloadHash !== payloadHash) return { kind: 'conflict' };
          // The failed owner released while this request's initial claim was
          // pending. A following retry can reclaim the marker through the
          // normal initial-read path; never misclassify its reserved token as
          // a different canonical request hash.
          return { kind: 'in-flight', retryAfterSeconds: 1 };
        }
        if (recheck.payloadHash !== payloadHash) return { kind: 'conflict' };
        return { kind: 'replay', response: recheck.response };
      }

      // Besides asserting ownership, this resolves lazy backends and
      // verifies their atomic fencing support before handler side effects.
      // The replacement is value-identical and keeps the original lease.
      const fenced = await backend.replaceIfPayloadHash(scopedKey, claimToken, {
        payloadHash: claimToken,
        response: null,
        expiresAt,
        retainUntil,
      });
      if (!fenced) {
        return { kind: 'in-flight', retryAfterSeconds: inFlightRetryAfter(expiresAt, Math.floor(Date.now() / 1000)) };
      }

      return { kind: 'miss', payloadHash, claimToken };
    },

    async renew({ principal, key, claimToken, extraScope }): Promise<void> {
      const scopedKey = scope(principal, key, extraScope);
      if (!claimToken || !isInFlightHash(claimToken)) {
        throw new Error('Idempotency renew requires the claimToken returned by check().');
      }
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const retainUntil = expiresAt + clockSkewSeconds;
      const renewed = await backend.replaceIfPayloadHash(scopedKey, claimToken, {
        payloadHash: claimToken,
        response: null,
        expiresAt,
        retainUntil,
      });
      if (!renewed) throw new IdempotencyClaimOwnershipError('renew');
    },

    async save({ principal, key, payloadHash, claimToken, response, extraScope }): Promise<void> {
      const scopedKey = scope(principal, key, extraScope);
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const retainUntil = expiresAt + clockSkewSeconds;
      if (!claimToken || !isInFlightHash(claimToken)) {
        throw new Error('Idempotency save requires the claimToken returned by check().');
      }
      const replaced = await backend.replaceIfPayloadHash(scopedKey, claimToken, {
        payloadHash,
        response,
        expiresAt,
        retainUntil,
      });
      if (!replaced) throw new IdempotencyClaimOwnershipError('save');
    },

    async release({ principal, key, claimToken, extraScope }): Promise<void> {
      const scopedKey = scope(principal, key, extraScope);
      const payloadHash = inFlightRequestHash(claimToken);
      if (!claimToken || payloadHash === undefined) {
        throw new Error('Idempotency release requires the claimToken returned by check().');
      }
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
      const released = await backend.replaceIfPayloadHash(scopedKey, claimToken, {
        payloadHash: `${RETRYABLE_HASH_PREFIX}${payloadHash}:${randomUUID()}`,
        response: null,
        expiresAt,
        retainUntil: expiresAt + clockSkewSeconds,
      });
      if (!released) throw new IdempotencyClaimOwnershipError('release');
    },

    async saveTransientError({ principal, key, payloadHash, claimToken, response, extraScope }): Promise<void> {
      const scopedKey = scope(principal, key, extraScope);
      const expiresAt = Math.floor(Date.now() / 1000) + TRANSIENT_ERROR_TTL_SECONDS;
      if (!claimToken || !isInFlightHash(claimToken)) {
        throw new Error('Idempotency transient-error save requires the claimToken returned by check().');
      }
      const replaced = await backend.replaceIfPayloadHash(scopedKey, claimToken, {
        payloadHash,
        response,
        expiresAt,
        retainUntil: expiresAt + clockSkewSeconds,
      });
      if (!replaced) {
        throw new IdempotencyClaimOwnershipError('transient-error save');
      }
    },

    async probe() {
      if (backend.probe) await backend.probe();
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
 * `authentication.credentials` from both `push_notification_config` and
 * `reporting_webhook`) before hashing with RFC 8785 JCS + SHA-256.
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
    if (
      (k === 'push_notification_config' || k === 'reporting_webhook') &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = stripWebhookAuthenticationCredentials(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function stripWebhookAuthenticationCredentials(config: Record<string, unknown>): Record<string, unknown> {
  const auth = config.authentication;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return config;
  const authCopy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(auth as Record<string, unknown>)) {
    if (k !== 'credentials') authCopy[k] = v;
  }
  return { ...config, authentication: authCopy };
}

// ASCII unit separator (U+001F). Used to join scope segments without
// risking ambiguity. `scope()` rejects this byte in every segment before
// backend access; protocol middleware separately enforces its narrower
// idempotency-key pattern.
// NUL bytes (U+0000) would be simpler but Postgres TEXT columns reject
// them, so we pick the next-safest non-printable separator.
const SCOPE_SEPARATOR = '\u001f';
const MAX_SCOPE_SEGMENT_LENGTH = 4096;

function scope(principal: string, key: string, extraScope?: string): string {
  validateScopeSegment(principal, 'principal');
  validateScopeSegment(key, 'key');
  if (extraScope !== undefined) validateScopeSegment(extraScope, 'extraScope');
  return extraScope
    ? `${principal}${SCOPE_SEPARATOR}${extraScope}${SCOPE_SEPARATOR}${key}`
    : `${principal}${SCOPE_SEPARATOR}${key}`;
}

function validateScopeSegment(value: string, label: 'principal' | 'key' | 'extraScope'): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SCOPE_SEGMENT_LENGTH) {
    throw new TypeError(
      `Invalid idempotency ${label}: must be a non-empty string no longer than ${MAX_SCOPE_SEGMENT_LENGTH} characters.`
    );
  }
  if (value.includes(SCOPE_SEPARATOR)) {
    throw new TypeError(`Invalid idempotency ${label}: U+001F is reserved as the internal scope separator.`);
  }
}

/**
 * Escape-hatch for callers that manage their own lifecycle (Lambda, custom
 * HTTP frameworks) and cannot use `serve({ readinessCheck })`. Delegates to
 * `store.probe()`. For servers built with `serve()`, prefer:
 *
 * ```ts
 * serve(createAgent, { readinessCheck: () => store.probe() });
 * ```
 *
 * Resolves immediately when the backend has no `probe()` (e.g., `memoryBackend`).
 * Throws with a descriptive error when the backend is unreachable or its
 * required schema is missing.
 */
export async function probeIdempotencyStore(store: IdempotencyStore): Promise<void> {
  if (store.probe) await store.probe();
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
