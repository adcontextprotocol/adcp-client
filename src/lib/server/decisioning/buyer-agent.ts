/**
 * Buyer-agent identity surface — Phase 1 of #1269.
 *
 * Models a buyer agent (the buying entity calling a seller) as a durable
 * commercial relationship in the seller's records, distinct from the
 * per-request credential that proves identity. The seller's `BuyerAgent`
 * record carries onboarding state (status, billing capabilities, default
 * account terms, allowed brands) that drives commercial behavior.
 *
 * The credential answers "who signed?" / "who holds this token?" The
 * `BuyerAgent` answers "who is this counterparty in our books?" — analogous
 * to how an SSP has a `buyer_id` row keyed to a DSP regardless of whether
 * the DSP authenticates via OAuth, signed requests, or a pre-shared API
 * key. Token proves identity; row drives commercial behavior.
 *
 * **Phase 1 scope.** This module ships in 3.0.x with the durable identity
 * shape. Framework-level billing-capability enforcement and the new error
 * codes from adcontextprotocol/adcp#3831 land in Phase 2 (#1292), gated on
 * the SDK's 3.1 cutover.
 *
 * @public
 */

import type { BillingParty, BusinessEntity, PaymentTerms } from '../../types/tools.generated';

/**
 * Wire billing-party enum re-exported here for the registry surface.
 * Aliased to `BillingMode` in design discussion (#1269); `BillingParty` is
 * the canonical wire-schema name.
 *
 * @public
 */
export type BuyerAgentBillingMode = BillingParty;

/**
 * Kind-discriminated credential variant on `ResolvedAuthInfo.credential`.
 *
 * `kind: 'http_sig'` is cryptographically verified — `agent_url` derives
 * from the `agents[]` entry whose `jwks_uri` resolved the keyid (per
 * adcontextprotocol/adcp#3831), NOT from JWK / JWS / envelope claims.
 * Security-relevant decisions (mutating-tool authorization, brand-side
 * authorization checks once `BrandAuthorizationResolver` lands) MUST read
 * `agent_url` from this variant, not from any informational field elsewhere
 * on `ResolvedAuthInfo`.
 *
 * `kind: 'api_key'` and `kind: 'oauth'` carry no `agent_url` on the
 * credential — the agent identity comes from the registry's
 * `resolveByCredential` lookup against the seller's onboarding record.
 *
 * @public
 */
export type AdcpCredential =
  | { readonly kind: 'api_key'; readonly key_id: string }
  | {
      readonly kind: 'oauth';
      readonly client_id: string;
      readonly scopes: readonly string[];
      readonly expires_at?: number;
    }
  | { readonly kind: 'http_sig'; readonly keyid: string; readonly agent_url: string; readonly verified_at: number };

/**
 * Status of a buyer-agent record. Drives framework-level request gating:
 *
 * - `'active'` — normal operation; requests dispatch.
 * - `'suspended'` — temporarily paused; new requests rejected with
 *   `PERMISSION_DENIED` and `error.details.scope: 'agent'`. In-flight tasks
 *   are NOT retroactively cancelled — webhooks fire, status updates flow.
 *   Sellers who need hard cutoff implement that in their platform method
 *   via `BuyerAgent.status` check.
 * - `'blocked'` — permanently denied; new requests rejected the same way as
 *   `'suspended'`. Recovery requires re-onboarding.
 *
 * Phase 1 emits `PERMISSION_DENIED + scope:'agent'` for both rejection
 * states. Phase 2 (#1292) may swap to upstream `AGENT_SUSPENDED` /
 * `AGENT_BLOCKED` codes if those land via separate spec PR.
 *
 * @public
 */
export type BuyerAgentStatus = 'active' | 'suspended' | 'blocked';

/**
 * Buyer-agent record — durable commercial relationship in the seller's
 * onboarding ledger. Returned by `BuyerAgentRegistry.resolve` and threaded
 * to handlers via `ctx.agent`.
 *
 * Fields are `readonly` to prevent post-resolution mutation that would
 * silently affect downstream `accounts.resolve` decisions. Mirrors the
 * Python frozen-dataclass shape for cross-language parity.
 *
 * @public
 */
export interface BuyerAgent {
  /**
   * Canonical agent URL. Treat like a public key: stable enough that
   * rotation requires explicit re-onboarding. The framework's signed-path
   * resolution checks both this canonical URL and any `aliases[]` against
   * the verified `credential.agent_url`. No separate seller-internal id —
   * adopters who want one mint it in their own DB and key off `agent_url`.
   */
  readonly agent_url: string;

  /** Human-readable name for ops / reporting / UI. */
  readonly display_name: string;

  /** See {@link BuyerAgentStatus}. */
  readonly status: BuyerAgentStatus;

  /**
   * Billing models this agent is permitted to request on `sync_accounts`.
   * Set-valued so real-world models (mixed-billing holdco with both direct
   * and agency-mediated brands) can be expressed without picking one mode.
   *
   * Migration from earlier single-enum sketches:
   * - `passthrough_only` ↔ `new Set(['operator'])`
   * - `agent_billable` ↔ `new Set(['agent', 'operator', 'advertiser'])`
   *
   * Phase 1 does not enforce — adopters who want enforcement implement it
   * adopter-side. Phase 2 (#1292) wires framework-level enforcement to the
   * `BILLING_NOT_PERMITTED_FOR_AGENT` code from adcp#3831 once the SDK
   * pin moves to AdCP 3.1.
   */
  readonly billing_capabilities: ReadonlySet<BuyerAgentBillingMode>;

  /**
   * Commercial defaults applied when accounts are provisioned under this
   * agent. Framework merges with per-request overrides on a SPARSE-MERGE
   * basis: per-request values win for any present field including explicit
   * `null`. The request is the authoritative current intent; defaults are
   * seeds for fields the buyer didn't speak to. Adopters who want
   * non-null-override semantics pre-filter nulls themselves.
   */
  readonly default_account_terms?: {
    readonly rate_card?: string;
    readonly payment_terms?: PaymentTerms;
    readonly credit_limit?: { readonly amount: number; readonly currency: string };
    readonly billing_entity?: BusinessEntity;
  };

  /**
   * Static allowlist of brand domains this agent may act for. Pre-RFC
   * stand-in for the per-request authorization check that
   * `BrandAuthorizationResolver` will perform once it lands (gated on
   * Python's RFC + adcp brand-side authz spec finalizing).
   *
   * When both this list and `BrandAuthorizationResolver` are configured,
   * the framework AND-composes them: registry says "we accept this agent
   * at all"; resolver says "and they're authorized for THIS brand." One-
   * minor deprecation cycle starts the release after
   * `BrandAuthorizationResolver` ships; sellers who want the static gate
   * gone stop populating the field.
   */
  readonly allowed_brands?: readonly string[];

  /**
   * Optional grace-period overlap during `agent_url` rotation. Framework's
   * signed-path resolution checks both canonical `agent_url` AND `aliases`
   * against the `agents[]` entry that resolved the verified keyid.
   *
   * v1 ships with the field present but no special framework behavior
   * beyond resolution; v1.5 adds the documented sunset window pattern.
   * Most adopters never populate this.
   */
  readonly aliases?: readonly string[];
}

// ---------------------------------------------------------------------------
// Registry Protocol + factory functions
// ---------------------------------------------------------------------------

/**
 * Minimal `ResolvedAuthInfo`-shaped argument to `BuyerAgentRegistry.resolve`.
 * Defined here to break a circular dependency with `account.ts` and to keep
 * the registry surface decoupled from the legacy `ResolvedAuthInfo` shape
 * during the two-minor migration cycle.
 *
 * Stage 3 of the implementation will widen `ResolvedAuthInfo` itself with
 * the `credential` field; this interface is the registry-side contract.
 *
 * @public
 */
export interface BuyerAgentResolveInput {
  /**
   * The kind-discriminated credential proven on the request. Stage 3 of
   * the Phase 1 implementation will populate this from the verifier
   * (`http_sig`) or from the legacy `ResolvedAuthInfo` shape (`api_key` /
   * `oauth`); until then, callers pass it through directly when available.
   *
   * When absent, the registry's `resolve` returns `null` — the legacy-
   * shape synthesis lands in Stage 3 alongside the `ResolvedAuthInfo`
   * migration shim, not Stage 1.
   */
  readonly credential?: AdcpCredential;

  /** Adopter-provided extension data threaded from `authenticate()`. */
  readonly extra?: Record<string, unknown>;
}

/**
 * Buyer-agent registry — durable identity surface called once per request
 * before `accounts.resolve`. Adopters construct via one of the factory
 * functions; the resulting object exposes a single `resolve` method the
 * framework dispatcher invokes.
 *
 * Three implementer postures, encoded at construction:
 *
 * - {@link signingOnly} — production target. Bearer/API-key/OAuth requests
 *   refused at the registry layer; signed requests resolve via
 *   `resolveByAgentUrl` against the verified `credential.agent_url`.
 * - {@link bearerOnly} — pre-trust beta. No signature support; bearer-shaped
 *   credentials resolve via `resolveByCredential` against the seller's
 *   onboarding ledger.
 * - {@link mixed} — transition. Both paths active. Signed traffic resolves
 *   cryptographically; bearer falls through to the legacy key table.
 *
 * The factories produce a `BuyerAgentRegistry` whose `resolve` method
 * routes by `credential.kind` and returns `null` when the credential is
 * not honored by the configured posture (e.g., bearer credential against
 * a `signingOnly` registry → `null`, framework rejects the request).
 *
 * @public
 */
export interface BuyerAgentRegistry {
  /**
   * Resolve a request's credential to a buyer-agent record.
   *
   * Returns `null` when the credential is not recognized OR when the
   * configured posture rejects the credential's kind (e.g., `bearerOnly`
   * registry receiving an `http_sig` credential).
   *
   * Throws when the underlying lookup fails (DB outage, identity-provider
   * 5xx). Framework projects the throw to `SERVICE_UNAVAILABLE` so the
   * buyer can retry; the inner error is logged server-side.
   */
  resolve(authInfo: BuyerAgentResolveInput): Promise<BuyerAgent | null>;
}

/**
 * Resolver function type for the signed path. Receives the
 * cryptographically-verified `agent_url` from the request signature and
 * returns the seller's record (or `null` for unrecognized agents).
 *
 * @public
 */
export type ResolveBuyerAgentByAgentUrl = (agent_url: string) => Promise<BuyerAgent | null>;

/**
 * Resolver function type for the bearer/API-key/OAuth path. Receives the
 * raw credential and returns the seller's record (or `null` for
 * unrecognized credentials).
 *
 * **Implementations MUST switch on `credential.kind`** and reject (return
 * `null`) on any kind they don't explicitly recognize. A naive
 * `WHERE token = $1` lookup against an api-key table would otherwise mis-
 * resolve when handed an `http_sig` credential whose `keyid` happens to
 * collide with an existing api-key value — the credential variants share
 * no key namespace, and the registry MUST NOT bridge them.
 *
 * **Credential exposure.** This callback receives unredacted credential
 * payloads (token, key_id, client_id). Adopters MUST NOT log raw credential
 * values AND MUST NOT include them in thrown `Error` messages — the
 * framework projects `err.message` into `error.details.reason` on the wire
 * when `exposeErrorDetails` is on (default: non-production). Throw with
 * a generic message and log the credential separately if you need it for
 * server-side debugging. The framework redacts credential payloads in any
 * log line emitted from registry-resolution code (Stage 4); adopter
 * implementations are expected to do the same (or to use prepared-statement
 * parameters that don't log).
 *
 * @public
 */
export type ResolveBuyerAgentByCredential = (credential: AdcpCredential) => Promise<BuyerAgent | null>;

/**
 * Belt-and-suspenders check that an `http_sig` credential carries a non-
 * empty `agent_url`. A misbehaving authenticator could produce `kind:
 * 'http_sig'` without populating the verified URL — without this guard, the
 * registry would pass `undefined` (or `''`) to the adopter's resolver and
 * silently get back `null`. Caller is responsible for the kind dispatch;
 * this function only validates the http_sig payload shape.
 */
function isVerifiedHttpSigPayload(credential: { agent_url?: string }): credential is { agent_url: string } {
  return typeof credential.agent_url === 'string' && credential.agent_url.length > 0;
}

/**
 * Module-private symbol used as a provenance brand on verifier-produced
 * `http_sig` credentials. NOT registered via `Symbol.for(...)` — code
 * outside this module cannot synthesize the symbol value, which is what
 * makes it a usable provenance check.
 *
 * The brand is non-enumerable so it's invisible to `JSON.stringify`,
 * `Object.keys`, spread, and structured-clone — meaning a credential
 * that crosses a serialization boundary loses its brand. For the
 * security model that's correct: a hostile relay or replay strips the
 * brand and the registry refuses to treat the credential as verified.
 *
 * Only `markVerifiedHttpSig` (called by the framework's signature
 * verifier in `src/lib/server/auth-signature.ts`) attaches the brand.
 * Custom `authenticate` callbacks that synthesize a literal-shape
 * `{ kind: 'http_sig', ... }` credential will NOT carry the brand —
 * `signingOnly` and `mixed` registry factories reject those.
 */
const VERIFIED_HTTP_SIG_BRAND: unique symbol = Symbol('@adcp/sdk.verifiedHttpSig');

type VerifiedHttpSig = Extract<AdcpCredential, { kind: 'http_sig' }> & {
  readonly [VERIFIED_HTTP_SIG_BRAND]: true;
};

/**
 * Brand an `http_sig` credential as verifier-produced. Only the framework's
 * signature verifier (`verifySignatureAsAuthenticator`) calls this; the
 * brand is the registry's proof that the credential's `agent_url` was
 * cryptographically verified per adcontextprotocol/adcp#3831.
 *
 * Returned object is a fresh shallow copy — the input is not mutated.
 *
 * @internal — exported for `auth-signature.ts` only; not part of the
 * adopter surface.
 */
export function markVerifiedHttpSig(
  credential: Extract<AdcpCredential, { kind: 'http_sig' }>
): Extract<AdcpCredential, { kind: 'http_sig' }> {
  const branded = { ...credential };
  Object.defineProperty(branded, VERIFIED_HTTP_SIG_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return branded as VerifiedHttpSig;
}

/**
 * Predicate the registry factories use to distinguish verifier-produced
 * `http_sig` credentials from literal-shape impostors. Returns true ONLY
 * when the credential was produced by the framework's signature verifier
 * (or another caller that imported the symbol from this module — there
 * are none).
 */
function isVerifiedHttpSig(credential: AdcpCredential): boolean {
  return credential.kind === 'http_sig' && (credential as Record<symbol, unknown>)[VERIFIED_HTTP_SIG_BRAND] === true;
}

/**
 * Construct a signing-only `BuyerAgentRegistry`. Bearer/API-key/OAuth
 * requests resolve to `null` (framework rejects); only signed requests
 * are honored.
 *
 * The path-of-least-resistance factory for production sellers — implement
 * one resolver, traffic that doesn't sign is automatically refused.
 *
 * @public
 */
export function signingOnly(opts: { resolveByAgentUrl: ResolveBuyerAgentByAgentUrl }): BuyerAgentRegistry {
  if (typeof opts.resolveByAgentUrl !== 'function') {
    throw new TypeError('BuyerAgentRegistry.signingOnly: resolveByAgentUrl must be a function');
  }
  const resolveByAgentUrl = opts.resolveByAgentUrl;
  return {
    async resolve(authInfo) {
      const credential = authInfo.credential;
      if (credential === undefined || credential.kind !== 'http_sig') return null;
      // Reject literal-shape http_sig credentials: only the framework's
      // signature verifier brands a credential as verified. A custom
      // `authenticate` callback that synthesizes `{ kind: 'http_sig', ... }`
      // from arbitrary data would otherwise be routed as if cryptographically
      // verified — the brand check closes that forgery vector.
      if (!isVerifiedHttpSig(credential)) return null;
      if (!isVerifiedHttpSigPayload(credential)) return null;
      return resolveByAgentUrl(credential.agent_url);
    },
  };
}

/**
 * Construct a bearer-only `BuyerAgentRegistry`. Signed requests still
 * authenticate via the existing signature-verifier surface, but the
 * registry resolves all credential kinds via `resolveByCredential` against
 * the seller's onboarding ledger — useful in pre-trust-beta deployments
 * where the seller maintains a credential→agent table out-of-band.
 *
 * @public
 */
export function bearerOnly(opts: { resolveByCredential: ResolveBuyerAgentByCredential }): BuyerAgentRegistry {
  if (typeof opts.resolveByCredential !== 'function') {
    throw new TypeError('BuyerAgentRegistry.bearerOnly: resolveByCredential must be a function');
  }
  const resolveByCredential = opts.resolveByCredential;
  return {
    async resolve(authInfo) {
      const credential = authInfo.credential;
      if (credential === undefined) return null;
      return resolveByCredential(credential);
    },
  };
}

/**
 * Construct a mixed-mode `BuyerAgentRegistry` that supports both signed and
 * bearer/OAuth/API-key credentials. Signed traffic resolves through
 * `resolveByAgentUrl` against the verified `credential.agent_url`; non-
 * signed credentials fall through to `resolveByCredential`.
 *
 * Framework prefers the signed path: when both an `Authorization: Bearer`
 * and a valid `Signature: ...` are present on the same request, the
 * `http_sig` credential variant is what reaches `resolve`, and only
 * `resolveByAgentUrl` is invoked. The bearer path is never consulted on
 * signed traffic.
 *
 * @public
 */
export function mixed(opts: {
  resolveByAgentUrl: ResolveBuyerAgentByAgentUrl;
  resolveByCredential: ResolveBuyerAgentByCredential;
}): BuyerAgentRegistry {
  if (typeof opts.resolveByAgentUrl !== 'function') {
    throw new TypeError('BuyerAgentRegistry.mixed: resolveByAgentUrl must be a function');
  }
  if (typeof opts.resolveByCredential !== 'function') {
    throw new TypeError('BuyerAgentRegistry.mixed: resolveByCredential must be a function');
  }
  const resolveByAgentUrl = opts.resolveByAgentUrl;
  const resolveByCredential = opts.resolveByCredential;
  return {
    async resolve(authInfo) {
      const credential = authInfo.credential;
      if (credential === undefined) return null;
      if (credential.kind === 'http_sig') {
        // Same forgery clamp as `signingOnly`: only verifier-branded
        // http_sig credentials route through the signed path.
        if (!isVerifiedHttpSig(credential)) return null;
        // Reject a malformed `http_sig` credential here rather than falling
        // through to resolveByCredential. Otherwise `mixed` would be strictly
        // weaker than signingOnly: an authenticator that produces an
        // http_sig-shaped credential without a verified agent_url could
        // bypass signed-path enforcement by routing through the bearer table.
        if (!isVerifiedHttpSigPayload(credential)) return null;
        return resolveByAgentUrl(credential.agent_url);
      }
      return resolveByCredential(credential);
    },
  };
}

// ---------------------------------------------------------------------------
// Caching decorator — Phase 1 Stage 5 of #1269
// ---------------------------------------------------------------------------

/**
 * Options for {@link cached}.
 *
 * @public
 */
export interface BuyerAgentCacheOptions {
  /**
   * TTL (seconds) for successful resolutions. Default: 60.
   *
   * Adopters whose registry sits in front of a Postgres / external lookup
   * benefit from caching for the request lifecycle of a single buyer's
   * traffic burst. Long TTLs (several minutes) are appropriate for
   * stable agent records; short TTLs (a few seconds) for rapidly-mutating
   * relationships (suspension flags, billing-capability changes).
   *
   * Status changes propagate within `ttlSeconds` of the seller flipping
   * the agent's row in their store — adopters needing instant
   * propagation either set a short TTL or invalidate the cache out-of-
   * band when they mutate.
   */
  ttlSeconds?: number;

  /**
   * TTL (seconds) for `null` returns (negative cache). Default: 0
   * (don't cache nulls). A freshly onboarded agent is recognized within
   * one request when nulls aren't cached; sellers willing to delay
   * recognition by N seconds in exchange for fewer DB hits set this to
   * a small positive value.
   *
   * **Timing-oracle note.** When null caching is enabled, an
   * unauthenticated prober comparing hit vs. miss latency on null
   * returns can infer "this credential was probed recently." Pair with
   * rate-limiting at the edge if your deployment runs in a hostile
   * environment. The default (0) avoids the oracle entirely.
   */
  cacheNullsTtlSeconds?: number;

  /**
   * Maximum cache entries before LRU eviction. Default: 10000.
   * The cache is bounded so a malicious or misconfigured caller spamming
   * unique credentials (e.g., random api keys probing the seller's
   * onboarding surface) can't exhaust memory.
   */
  maxSize?: number;

  /** Override clock for deterministic tests. Returns ms since epoch. */
  now?: () => number;
}

interface CacheEntry {
  value: BuyerAgent | null;
  expiresAtMs: number;
}

/**
 * Cached registry surface. Strict superset of {@link BuyerAgentRegistry}
 * with explicit invalidation hooks adopters call when they mutate the
 * backing record (status flip, billing-capability change). Without
 * `invalidate`, adopters could only purge stale entries by waiting for
 * `ttlSeconds` to expire — for status changes that's exactly the
 * window during which a now-suspended agent retains access.
 *
 * `BuyerAgentRegistry.cached(...)` returns this richer type so adopters
 * can hold a reference and call the invalidation methods directly.
 *
 * @public
 */
export interface CachedBuyerAgentRegistry extends BuyerAgentRegistry {
  /**
   * Drop the cache entry for a single credential. No-op when the
   * credential isn't currently cached. Use this when the agent's
   * record is mutated in your backing store so the next request
   * re-resolves rather than serving the stale entry.
   */
  invalidate(credential: AdcpCredential): void;

  /**
   * Drop all cached entries. Use on bulk record mutations (onboarding-
   * record migration, daily reset) or test-environment cleanup.
   */
  clear(): void;
}

/**
 * Compute a cache key from a credential. Returns null when the
 * credential is undefined — uncacheable, falls through to the inner
 * registry on each call. Keys are namespaced by kind so an api_key
 * `key_id` value can never collide with an http_sig `keyid` value or
 * an oauth `client_id`. Note that `key_id` is already a stable hash
 * (Stage 3); using it as a cache key is safe.
 */
function cacheKeyForCredential(credential: AdcpCredential | undefined): string | null {
  if (credential === undefined) return null;
  switch (credential.kind) {
    case 'http_sig':
      return `http_sig:${credential.agent_url}`;
    case 'api_key':
      return `api_key:${credential.key_id}`;
    case 'oauth':
      return `oauth:${credential.client_id}`;
    default: {
      // Exhaustiveness check — adding a new credential kind without
      // updating this switch produces a compile error here, not a
      // runtime cache-miss bug.
      const _exhaustive: never = credential;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Wrap a {@link BuyerAgentRegistry} with TTL-based result caching and
 * concurrent-resolve coalescing. Adopters whose `resolveByAgentUrl` /
 * `resolveByCredential` hit a database or external service compose
 * the cache via:
 *
 * ```ts
 * const registry = BuyerAgentRegistry.cached(
 *   BuyerAgentRegistry.signingOnly({
 *     resolveByAgentUrl: async url => db.findBuyerAgent(url),
 *   }),
 *   { ttlSeconds: 60 }
 * );
 * ```
 *
 * Cache properties:
 * - **TTL-bounded.** Entries expire after `ttlSeconds` (default 60).
 *   Negative cache (null returns) is opt-in via `cacheNullsTtlSeconds`.
 * - **LRU-evicted.** Bounded to `maxSize` entries (default 10000).
 *   Oldest-accessed entry evicts on overflow.
 * - **Concurrent-resolve coalesced.** N parallel `resolve()` calls on
 *   the same key produce ONE upstream invocation. Subsequent callers
 *   await the in-flight promise — important when the seller front-ends
 *   a slow upstream and a buyer burst arrives.
 * - **Per-kind cache keys.** Keys are namespaced (`http_sig:`,
 *   `api_key:`, `oauth:`) so cross-kind collisions cannot leak an agent
 *   resolved through one credential type to a different type.
 * - **Skips uncacheable inputs.** When the credential is undefined,
 *   `resolve()` falls through to the inner registry on each call —
 *   adopters wiring custom auth without `credential` synthesis (Stage 3
 *   migration cycle) see no behavior change.
 * - **Explicit invalidation.** Returns a {@link CachedBuyerAgentRegistry}
 *   with `.invalidate(credential)` and `.clear()` methods. Call
 *   `invalidate` when you mutate an agent's record (status flip,
 *   billing-capability change) so the next request re-resolves rather
 *   than serving the stale entry. Without this, the stale-status window
 *   is bounded by `ttlSeconds` — a now-suspended agent retains access
 *   for up to that long.
 *
 * Mirrors the `AsyncCachingJwksResolver` over `JwksResolver` pattern
 * already in `src/lib/signing/`.
 *
 * @public
 */
export function cached(inner: BuyerAgentRegistry, options: BuyerAgentCacheOptions = {}): CachedBuyerAgentRegistry {
  if (typeof inner !== 'object' || inner === null || typeof inner.resolve !== 'function') {
    throw new TypeError('BuyerAgentRegistry.cached: `inner` must be a BuyerAgentRegistry');
  }
  const ttlMs = (options.ttlSeconds ?? 60) * 1000;
  const nullsTtlMs = (options.cacheNullsTtlSeconds ?? 0) * 1000;
  const maxSize = options.maxSize ?? 10000;
  const now = options.now ?? Date.now;

  if (ttlMs <= 0) throw new RangeError('BuyerAgentRegistry.cached: ttlSeconds must be > 0');
  if (nullsTtlMs < 0) throw new RangeError('BuyerAgentRegistry.cached: cacheNullsTtlSeconds must be >= 0');
  if (maxSize < 1) throw new RangeError('BuyerAgentRegistry.cached: maxSize must be >= 1');

  // Map iteration order is insertion order, so re-inserting on hit
  // gives us LRU-on-access semantics for free.
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<BuyerAgent | null>>();

  return {
    async resolve(authInfo) {
      const key = cacheKeyForCredential(authInfo.credential);
      if (key === null) {
        // Uncacheable input — pass through. Adopters wiring custom
        // auth that hasn't migrated to `credential` synthesis see
        // every call hit the inner resolver.
        return inner.resolve(authInfo);
      }

      const entry = cache.get(key);
      if (entry !== undefined && now() < entry.expiresAtMs) {
        // LRU touch: re-insert so this entry becomes the most-recent.
        cache.delete(key);
        cache.set(key, entry);
        return entry.value;
      }
      if (entry !== undefined) {
        // Expired — drop before refetch.
        cache.delete(key);
      }

      // Coalesce concurrent resolves: subsequent callers on the same
      // key await the existing in-flight promise rather than firing
      // their own upstream lookup. If the upstream rejects, all
      // coalesced callers see the same rejection; the `finally` below
      // releases `inFlight` so the next caller retries upstream
      // (rejected promises do NOT poison the cache — `cache.set`
      // inside the IIFE is unreachable on rejection).
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;

      const promise = (async () => {
        const value = await inner.resolve(authInfo);
        const entryTtlMs = value === null ? nullsTtlMs : ttlMs;
        if (entryTtlMs > 0) {
          // Defense-in-depth: freeze the resolved record before
          // sharing across coalesced callers. The dispatcher seam
          // also freezes per-request (Stage 2), but freezing here
          // makes the cached-shared-reference invariant load-
          // bearing rather than coincidental — a future caller
          // mutating `BuyerAgent.status` would otherwise corrupt
          // every other cached-hit consumer's view.
          if (value !== null && !Object.isFrozen(value)) {
            if (value.billing_capabilities instanceof Set) {
              Object.freeze(value.billing_capabilities);
            }
            Object.freeze(value);
          }
          cache.set(key, { value, expiresAtMs: now() + entryTtlMs });
          while (cache.size > maxSize) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey === undefined) break;
            cache.delete(oldestKey);
          }
        }
        return value;
      })();
      inFlight.set(key, promise);
      try {
        return await promise;
      } finally {
        inFlight.delete(key);
      }
    },

    invalidate(credential) {
      const key = cacheKeyForCredential(credential);
      if (key !== null) cache.delete(key);
    },

    clear() {
      cache.clear();
    },
  };
}

/**
 * Factory namespace mirroring the documented surface from #1269. Adopters
 * import the namespace and call `BuyerAgentRegistry.signingOnly({...})`,
 * etc. Individual functions are also exported above for direct use.
 *
 * @public
 */
export const BuyerAgentRegistry = {
  signingOnly,
  bearerOnly,
  mixed,
  cached,
};
