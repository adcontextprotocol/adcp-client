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
 * values. The framework redacts credential payloads in any log line emitted
 * from registry-resolution code (Stage 4); adopter implementations are
 * expected to do the same (or to use prepared-statement parameters that
 * don't log).
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
};
