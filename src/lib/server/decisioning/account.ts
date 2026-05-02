/**
 * Account model. Single-level (matches AdCP wire's AccountReference).
 * Platform-internal hierarchies (GAM Network → Advertiser → Order;
 * Spotify Brand → Campaign) are encoded in `metadata`, not in the typed
 * shape. Generic `TCtxMeta` lets platforms type their metadata at the call site.
 *
 * Tenant isolation is enforced at `accounts.resolve()` returning null for
 * cross-scope references, not via a multi-level type.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type {
  Account as WireAccount,
  AccountScope,
  BillingParty,
  BrandReference,
  AccountReference,
  BusinessEntity,
  ExtensionObject,
  PaymentTerms,
  ReportUsageRequest,
  ReportUsageResponse,
  SyncAccountsSuccess,
  GetAccountFinancialsRequest,
  GetAccountFinancialsSuccess,
} from '../../types/tools.generated';
import type { CursorPage, CursorRequest } from './pagination';
import type { AdcpCredential, BuyerAgent } from './buyer-agent';

/**
 * Account — framework's rich representation. A strict superset of the wire
 * `Account` shape (from `list_accounts` / response envelopes):
 *
 *   - Adds `metadata: TCtxMeta` (platform-internal fields the framework doesn't
 *     read but adopters use to thread platform-specific data)
 *   - Adds `authInfo: AuthPrincipal` (auth context for the request — MUST NOT
 *     leak to the wire)
 *   - All wire-required fields (`id`/`account_id`, `name`, `status`) are
 *     required here too.
 *
 * Framework projects to wire shape via `toWireAccount`: strips `metadata` +
 * `authInfo`, renames `id` → `account_id`. ~10 lines, no `as never` casts.
 */
export interface Account<TCtxMeta = Record<string, unknown>> {
  /** Your platform's account_id. Maps to wire `Account.account_id`. */
  id: string;

  /** Human-readable account name (e.g., 'Acme', 'Acme c/o Pinnacle'). Required on the wire. */
  name: string;

  /** Account status. Maps to wire `Account.status`. */
  status: AdcpAccountStatus;

  /** Canonical brand reference. Either id OR (brand+operator) identifies the account. */
  brand?: BrandReference;

  /** Operator domain (agency / managed-services). Pairs with `brand`. */
  operator?: string;

  /**
   * The advertiser whose rates apply to this account. Maps to wire
   * `Account.advertiser`. Use when the account is operated by an agency on
   * behalf of an advertiser whose rates differ from the operator's.
   */
  advertiser?: string;

  /**
   * Optional intermediary who receives invoices on behalf of the advertiser
   * (e.g., agency holdco). Distinct from `advertiser` (whose rates apply)
   * and from `billing.invoicedTo` (the legal billing party). Use when the
   * invoice recipient differs from both — common in agency-handled flows.
   */
  billing_proxy?: string;

  /**
   * Settlement boundary for operator-billed retail-media platforms.
   * `'agent'` = pass-through (buyer's agent settles directly with the platform).
   * `'operator'` = retail-media model (operator pays publisher, bills brand).
   * `BrandReference` = invoice routes to a third party (Amazon DSP returning
   * a different invoice principal than the requester is the canonical case).
   *
   * Optional — most platforms don't need this; comply storyboards use it to
   * assert the right party is billed.
   */
  billing?: { invoicedTo: 'agent' | 'operator' | BrandReference };

  /**
   * Business entity invoiced on this account. Carries legal name, tax IDs,
   * address, contacts, and (write-only) bank details for B2B invoicing.
   *
   * **`bank` is write-only.** The wire schema marks `BusinessEntity.bank` as
   * MUST NOT be echoed in responses (sellers store and confirm receipt
   * without returning the details). `toWireAccount` strips it on emit, so
   * adopters who store the full entity here will not leak bank details to
   * buyers — but DO NOT rely on the strip for anything beyond response
   * projection. Adopters loading the entity from their own DB SHOULD apply
   * the same rule at retrieval time, especially for non-list endpoints.
   */
  billing_entity?: BusinessEntity;

  /**
   * Identifier for the rate card applied to this account. Opaque seller-side
   * string; emitted unchanged on the wire.
   */
  rate_card?: string;

  /** Payment terms applied to this account. */
  payment_terms?: PaymentTerms;

  /** Maximum outstanding balance allowed on this account. */
  credit_limit?: WireAccount['credit_limit'];

  /**
   * Setup payload for accounts in `pending_approval`. Carries the URL/message
   * the buyer surfaces to a human to complete activation (credit-app, legal
   * agreement, fund-add). Required-shape: `message` is mandatory; `url` and
   * `expires_at` are optional.
   *
   * The framework does NOT validate that `setup` is populated when status is
   * `pending_approval` — that's an adopter contract with the spec. It also
   * does NOT clear `setup` when status leaves `pending_approval`; adopters
   * who echo the same `Account` across status transitions should drop the
   * field themselves.
   */
  setup?: WireAccount['setup'];

  /** Account scope (operator / brand / operator_brand / agent). */
  account_scope?: AccountScope;

  /**
   * Governance agent endpoints registered on this account. Auth credentials
   * are write-only on the wire and not modeled here — adopters set/update
   * via `sync_governance`, not by re-emitting the Account.
   */
  governance_agents?: WireAccount['governance_agents'];

  /**
   * Cloud storage bucket for offline reporting delivery. Only present when
   * the seller's capabilities advertise `reporting_delivery_methods`
   * including `'offline'`. Per-account access MUST be IAM-scoped — see the
   * schema description for security constraints.
   */
  reporting_bucket?: WireAccount['reporting_bucket'];

  /**
   * Sandbox account marker. For implicit accounts the wire schema treats
   * this as part of the natural key — the same brand/operator pair can have
   * separate production and sandbox accounts. For explicit accounts, sandbox
   * accounts are pre-existing test accounts the seller surfaces via
   * `list_accounts`.
   */
  sandbox?: boolean;

  /**
   * Wire `ext` extension hatch. Carries forward-compatible additions the
   * codegen'd type doesn't model yet. Adopters who don't need extensions
   * leave this undefined.
   */
  ext?: ExtensionObject;

  /**
   * Adapter-internal opaque state. Framework doesn't read this; **stripped
   * before emitting on the wire**. GAM puts `{ networkId, advertiserId }`;
   * Spotify puts `{ brandId, businessId }`; Criteo puts `{ customerId }`.
   * Each platform's choice.
   *
   * Same field name (`ctx_metadata`) used across every DecisioningPlatform
   * resource (Product, MediaBuy, Package, Creative, Audience, Signal,
   * Account) for naming consistency. Account is special operationally:
   * `accounts.resolve()` is called per-request, so the publisher is the
   * canonical source of truth and the SDK does NOT round-trip Account
   * `ctx_metadata` through the cache (unlike Product / MediaBuy / etc.,
   * where the SDK bridges between `getProducts` and `createMediaBuy`).
   * Put adapter state in `ctx_metadata`; treat it as fresh from your
   * `accounts.resolve()` on every request.
   */
  ctx_metadata: TCtxMeta;

  /**
   * Caller's authenticated principal. **Stripped before emitting on the wire.**
   *
   * Optional from the adopter's perspective: when `accounts.resolve` returns
   * an `Account` without `authInfo`, the framework auto-attaches the
   * principal from `ctx.authInfo` (the auth shape extracted by
   * `serve({ authenticate })`). Adopters that need to *transform* the
   * principal — e.g. derive a tenant-scoped sub-principal from the OAuth
   * client — set it explicitly; adopters that just want the
   * `serve({ authenticate })` principal threaded through resource handlers
   * can omit the field and rely on the framework default.
   */
  authInfo?: AuthPrincipal;
}

/**
 * The OAuth-style auth shape extracted by `serve({ authenticate })`. Threaded
 * to `accounts.resolve(ref, ctx)` and to the `tasks_get` custom-tool handler
 * so adopters can authorize the resolution against the principal.
 *
 * Distinct from {@link AuthPrincipal} — `ResolvedAuthInfo` is the RAW
 * transport-level auth the framework hands to the resolver; `AuthPrincipal`
 * is what the resolver chooses to persist on the resolved `Account`. The
 * resolver decides what to keep / drop / re-shape.
 *
 * @public
 */
export interface ResolvedAuthInfo {
  /**
   * Kind-discriminated credential — Phase 1 Stage 3 of #1269. Populated by
   * the framework's built-in authenticators (`verifyApiKey`, `verifyBearer`,
   * `verifySignatureAsAuthenticator`); custom `authenticate` callbacks can
   * stamp this directly on the returned `AuthPrincipal` to opt into the
   * discriminated-credential surface. The framework propagates it from
   * `req.auth.extra.credential` to this top-level field on every request.
   *
   * **Verified vs. claimed.** `credential.kind === 'http_sig'` carries an
   * `agent_url` that is cryptographically verified by the framework's
   * signature verifier (per adcontextprotocol/adcp#3831). The framework
   * brands verified credentials with a module-private symbol that
   * `BuyerAgentRegistry` factories check before treating the credential
   * as authentic — a literal-shape `{ kind: 'http_sig', ... }` synthesized
   * by a custom authenticator is rejected at the registry layer. Adopters
   * making security-relevant decisions on `agent_url` MUST read it from
   * the credential variant; framework-stamped registry-derived URLs are
   * exposed via `ctx.agent.agent_url` only.
   */
  credential?: AdcpCredential;

  /**
   * Optional operator seat within the buyer agent. Stamped only when the
   * authenticator's claims include a `sub` / `oid` / equivalent identifying
   * a sub-principal within the agent. Reserved for future use; v1 of
   * `BuyerAgentRegistry` doesn't consume it.
   */
  operator?: string;

  /**
   * @deprecated Use `credential.kind === 'oauth' ? credential.client_id : ...`
   * for the discriminated shape. Optional in N+1 of the deprecation cycle
   * per #1269; framework continues to populate it for adopter compatibility
   * through the cycle. Removed in N+2.
   */
  token?: string;

  /**
   * @deprecated Use `credential.client_id` (oauth) or `credential.key_id`
   * (api_key) instead.
   */
  clientId?: string;

  /** @deprecated Use `credential.scopes` (oauth) instead. */
  scopes?: string[];

  expiresAt?: number;
  extra?: Record<string, unknown>;
}

export interface ResolveContext {
  /** Authenticated principal extracted by `serve({ authenticate })`. Undefined when no `authenticate` is configured. */
  authInfo?: ResolvedAuthInfo;
  /** Tool the buyer is calling — useful for tool-aware tenant routing. */
  toolName?: string;
  /**
   * Resolved buyer agent from `BuyerAgentRegistry.resolve()`, when an
   * `agentRegistry` is configured (Phase 1 of #1269). The framework calls
   * the registry once per request before `accounts.resolve` and threads the
   * resolved record here so adopters can route tenant resolution against
   * the durable buyer-agent identity rather than re-deriving it from
   * `authInfo`. Undefined when no registry is configured OR when the
   * registry returns null for the request's credential.
   */
  agent?: BuyerAgent;
}

/**
 * Context passed to AccountStore tool methods that operate on a single
 * resolved Account (today: `getAccountFinancials`). Threads the resolved
 * `Account<TCtxMeta>` through so adopters can read `ctx.account.ctx_metadata`
 * (auth tokens, upstream IDs, etc.) without re-resolving from the request.
 *
 * Strict superset of `ResolveContext`: same `authInfo` / `toolName` fields,
 * plus the resolved account. Distinct type because `accounts.resolve()`
 * produces the account and therefore cannot receive it on input.
 *
 * **NOT applicable to `reportUsage`.** `ReportUsageRequest.usage[]` carries
 * a per-row `account: AccountReference`; a request can span multiple
 * accounts. Pre-resolving a single `ctx.account` would misrepresent that
 * shape. `reportUsage` keeps `ResolveContext` and per-row resolution is
 * the adopter's responsibility (call `accounts.resolve` from inside the
 * impl, once per row).
 *
 * @public
 */
export interface AccountToolContext<TCtxMeta = Record<string, unknown>> extends ResolveContext {
  /** Resolved Account from `accounts.resolve()`. Populated by the framework before dispatch. */
  account: Account<TCtxMeta>;
}

/**
 * Request context for tools whose wire request does not carry an `account`
 * field — `preview_creative`, `list_creative_formats`, and
 * `provide_performance_feedback`. The framework calls
 * `accounts.resolve(undefined, ctx)` for these, accepting a `null` return; if
 * `null`, `ctx.account` is undefined when the handler runs.
 *
 * Adopter handlers MUST handle the `undefined` case explicitly. Choose one of:
 *
 *   1. **Singleton fallback** — return a non-null synthetic `Account` from
 *      `accounts.resolve(undefined, ctx)` for the publisher-wide tenant
 *      (e.g., format catalog, performance feedback aggregation). Inside the
 *      handler, narrow with `if (!ctx.account) throw ...` once and treat
 *      `ctx.account` as defined for the rest.
 *   2. **Auth-derived lookup** — in `accounts.resolve(undefined, ctx)`, look
 *      up by `ctx.authInfo.clientId` (or whichever principal field your auth
 *      wires) and return the matching account.
 *   3. **Error out** — throw `AdcpError({ code: 'ACCOUNT_NOT_FOUND' })` from
 *      within the handler when `ctx.account == null` and the operation
 *      requires tenant scoping.
 *
 * The narrowed type catches the mismatch at authorship time — adopters who
 * forget to handle `ctx.account === undefined` get a TS error, not a runtime
 * `Cannot read properties of undefined` deep in their upstream call. Same
 * shape as the `definePlatformWithCompliance` invariant: convert a runtime
 * gate into a compile-time one.
 *
 * @public
 */
// Inline type-import on `RequestContext` instead of a top-level
// `import type { RequestContext } from './context'` — `context.ts` already
// imports `Account` from this file, so a top-level import would form a
// circular type dependency.
export type NoAccountCtx<TCtxMeta = Record<string, unknown>> = Omit<
  import('./context').RequestContext<Account<TCtxMeta>>,
  'account'
> & {
  /**
   * Resolved account, OR `undefined` when the wire request didn't carry an
   * account ref AND `accounts.resolve(undefined, ctx)` returned null. Always
   * narrow before reading `ctx_metadata` / `id`.
   */
  account: Account<TCtxMeta> | undefined;
};

export interface AuthPrincipal {
  /** Stable identifier for the calling agent (e.g., `https://buyer.example.com/mcp`). */
  agent_url?: string;
  /** Token kind: API key, OAuth bearer, signed-request claim. */
  kind: 'api_key' | 'oauth' | 'signature' | 'public';
  /** Bearer token / API key value. Platform-side don't log this. */
  token?: string;
  /** Token expiry (ms since epoch). Set by `accounts.refreshToken` after a successful refresh. */
  expiresAt?: number;
  /** OAuth scopes / API-key principal name. */
  principal?: string;
  /** Additional claims (jwt sub, kid, etc.). */
  claims?: Record<string, unknown>;
}

export interface AccountStore<TCtxMeta = Record<string, unknown>> {
  /**
   * How buyers reference accounts on this platform.
   * - `'explicit'` — buyer passes `account_id` inline on every request (Snap,
   *   Meta, GAM via Network/Company id). The default.
   * - `'implicit'` — buyer must `sync_accounts` first; subsequent requests are
   *   resolved from the auth principal's pre-synced linkage (LinkedIn, some
   *   retail-media operators). Framework refuses inline `account_id` references
   *   for these platforms.
   * - `'derived'` — single-tenant agents where there is no account_id on the
   *   wire at all and the auth principal alone identifies the tenant. Most
   *   self-hosted broadcasters and retail-media operators in proxy mode.
   *
   * Defaults to `'explicit'` when omitted.
   */
  readonly resolution?: 'explicit' | 'implicit' | 'derived';

  /**
   * Resolve buyer's AccountReference into the platform's tenant model.
   *
   * `ref` is `undefined` when the wire request didn't carry an account
   * field — `provide_performance_feedback` and `list_creative_formats` are
   * the canonical examples. Per `resolution` mode:
   * - `'derived'` (single-tenant): return the singleton account regardless.
   * - `'implicit'`: look up the account from the auth principal.
   * - `'explicit'` (default): no account is available; either throw
   *   `AccountNotFoundError` to signal "tool requires account" OR return
   *   a synthetic singleton if the tool legitimately doesn't need
   *   tenant scoping (e.g., publisher-wide format catalog from
   *   `list_creative_formats`).
   *
   * `ctx.authInfo` is the caller's authenticated principal (when
   * `serve({ authenticate })` is wired). Adapters fronting an upstream
   * platform API (Snap, Meta, retail-media) translate auth to tenant ID:
   *
   * ```ts
   * resolve: async (ref, ctx) => {
   *   if (ref?.account_id) return await this.db.findById(ref.account_id);
   *   const cred = ctx?.authInfo?.credential;
   *   const clientKey = cred?.kind === 'oauth' ? cred.client_id
   *     : cred?.kind === 'api_key' ? cred.key_id
   *     : undefined;
   *   const platformAcct = clientKey ? await myUpstream.findByClientKey(clientKey) : null;
   *   return platformAcct ? this.toAccount(platformAcct) : null;
   * }
   * ```
   *
   * Two failure shapes:
   * - **Unknown / cross-tenant reference**: return `null` (canonical) — OR
   *   throw `AccountNotFoundError` if your codebase already throws a
   *   not-found exception class. Framework emits the spec's fixed
   *   `ACCOUNT_NOT_FOUND` envelope either way. The buyer learns no detail
   *   beyond "not found" — guarding against principal-enumeration.
   * - **Transient upstream failure** (DB outage, identity-provider 5xx):
   *   throw a generic exception. Framework maps to `SERVICE_UNAVAILABLE`
   *   so the buyer can retry.
   */
  resolve(ref: AccountReference | undefined, ctx?: ResolveContext): Promise<Account<TCtxMeta> | null>;

  /**
   * sync_accounts API surface. Framework normalizes the wire request; platform
   * upserts and returns per-account result rows. `throw new AdcpError(...)`
   * for buyer-facing rejection.
   *
   * **Optional.** Stateless platforms (creative-template, signal-marketplace
   * proxies) that don't manage account lifecycle can omit this; framework
   * surfaces `UNSUPPORTED_FEATURE` to buyers calling `sync_accounts`.
   *
   * `ctx.authInfo` carries the caller's authenticated principal (when
   * `serve({ authenticate })` is wired); `ctx.agent` carries the resolved
   * `BuyerAgent` record (when an `agentRegistry` is configured). Adopters
   * implementing principal-keyed gates (e.g., per-buyer-agent
   * `BILLING_NOT_PERMITTED_FOR_AGENT` on the spec's billing surfaces) read
   * the principal here — same threading as `accounts.resolve`.
   *
   * **Prefer `ctx.agent` over `ctx.authInfo.credential` for commercial-
   * relationship decisions.** `ctx.agent` is the registry-resolved durable
   * identity (status, billing capabilities, default account terms);
   * `ctx.authInfo.credential` is the raw transport-level credential. For
   * billing gates the registry-resolved identity is canonical. Use
   * `credential` only for transport-level branching (e.g., reading the
   * verified `agent_url` from `credential.kind === 'http_sig'` when
   * `agentRegistry` is not configured).
   */
  upsert?(refs: AccountReference[], ctx?: ResolveContext): Promise<SyncAccountsResultRow[]>;

  /**
   * list_accounts API surface. Framework wraps with cursor envelope.
   *
   * **Optional.** Same rationale as `upsert` — stateless platforms can omit.
   *
   * `ctx.authInfo` and `ctx.agent` carry the caller's principal — adopters
   * scope the listing per-principal (e.g., return only accounts visible to
   * the calling buyer agent) without re-deriving identity from the request.
   */
  list?(filter: AccountFilter & CursorRequest, ctx?: ResolveContext): Promise<CursorPage<Account<TCtxMeta>>>;

  /**
   * report_usage API surface. Operator-billed platforms accept usage rows
   * (often impressions / spend by media_buy + period) for billing
   * reconciliation. Optional — adopters that don't run billing through the
   * agent leave this unimplemented and the framework returns
   * UNSUPPORTED_FEATURE.
   *
   * Idempotent on `(account, period_start, period_end, line_item_id)` —
   * platform must dedupe replays under the framework's idempotency key.
   *
   * `ctx.authInfo` carries the caller's OAuth principal (when
   * `serve({ authenticate })` is wired); `ctx.agent` carries the resolved
   * `BuyerAgent` record (when an `agentRegistry` is configured). Platforms
   * fronting an upstream billing API (Snap, Meta, retail-media) use them
   * to authorize the usage post against the principal's tenant — same
   * pattern as `accounts.resolve`. Prefer `ctx.agent` for principal-keyed
   * commercial gates; see `upsert?` for the rationale.
   */
  reportUsage?(req: ReportUsageRequest, ctx?: ResolveContext): Promise<ReportUsageResponse>;

  /**
   * get_account_financials API surface. Operator-billed platforms expose
   * spend / credit / payment status per the wire shape. Optional — agent-
   * billed platforms (where the buyer settles directly with the publisher)
   * leave this unimplemented.
   *
   * Read tool — no idempotency requirement. Throw `AdcpError` for buyer-
   * fixable rejection (`'PERMISSION_DENIED'` if the principal can't see
   * financials for the requested account).
   *
   * `ctx.account` is the resolved `Account<TCtxMeta>` (framework calls
   * `accounts.resolve(req.account)` first and threads the result in).
   * Adopters fronting an upstream platform read tokens / upstream IDs from
   * `ctx.account.ctx_metadata` without re-resolving.
   *
   * `ctx.authInfo` carries the caller's OAuth principal (when
   * `serve({ authenticate })` is wired); `ctx.agent` carries the resolved
   * `BuyerAgent` record (when an `agentRegistry` is configured). Platforms
   * that guard financials per-principal use them to authorize the read —
   * same pattern as `accounts.resolve`. Prefer `ctx.agent` for principal-
   * keyed commercial gates; see `upsert?` for the rationale.
   */
  getAccountFinancials?(
    req: GetAccountFinancialsRequest,
    ctx: AccountToolContext<TCtxMeta>
  ): Promise<GetAccountFinancialsSuccess>;

  /**
   * Mid-request token refresh hook. Optional. Called by the framework when
   * a platform method throws `AdcpError({ code: 'AUTH_REQUIRED' })` AND
   * `refreshToken` is defined — the framework refreshes via this hook,
   * mutates `account.authInfo.token` with the returned value, and retries
   * the failing platform method exactly once.
   *
   * The reason string lets adopters distinguish trigger conditions:
   *   - `'auth_required'` — platform method threw AUTH_REQUIRED in flight.
   *
   * Treat as an open string union: future values may be added. Adopters
   * SHOULD switch exhaustively (`default: throw`) so behavior drift on
   * minor SDK bumps fails loud rather than silently no-oping.
   *
   * **In-flight only.** The refreshed token is scoped to the current
   * request — the framework does NOT echo it back to the buyer. Use this
   * for adapters that front an upstream platform API (Snap, Meta,
   * retail-media OAuth flows) where the SDK caches an upstream token
   * server-side and the buyer's auth-to-this-agent is separate.
   *
   * **Account-object identity contract.** The framework mutates
   * `account.authInfo.token` (and `expiresAt` if returned) on the Account
   * passed in. Adopters who memoize / cache `Account` objects across
   * requests MUST return a fresh copy from `accounts.resolve()` for each
   * request — sharing a cached Account would leak the refreshed token to
   * any subsequent caller that resolves the same id. Returning a new
   * object literal per call (the canonical pattern) is safe.
   *
   * **Concurrency.** `refreshToken` MUST be safe under concurrent
   * invocation on the same account — two parallel in-flight calls hitting
   * AUTH_REQUIRED at once will both call this hook. Adopters whose
   * upstream provider rate-limits refresh should coalesce internally
   * (e.g., a per-account in-flight refresh promise). The framework does
   * not coalesce.
   *
   * **Failure surfaces correctable AUTH_REQUIRED.** If `refreshToken`
   * itself throws, the framework projects to `AUTH_REQUIRED` with
   * `recovery: 'correctable'` and a fixed message (the inner exception
   * text is NOT echoed on the wire — refresh failures routinely include
   * upstream details that should not cross the trust boundary). Log inner
   * details server-side. Don't use SERVICE_UNAVAILABLE — refresh failure
   * means the upstream authorization is gone, not that the service is
   * transiently down.
   *
   * **Expiry timestamp** (`expiresAt`, ms since epoch) is optional. When
   * returned, the framework writes it to `account.authInfo.expiresAt` so
   * adopters reading the resolved Account can branch on it (proactive
   * refresh is not yet wired; reactive-only in v6.x).
   */
  refreshToken?(account: Account<TCtxMeta>, reason: 'auth_required'): Promise<{ token: string; expiresAt?: number }>;
}

/**
 * Optional throw-class for `AccountStore.resolve` not-found signaling. Returning
 * `null` from `resolve` is canonical and equivalent; throw this only if your
 * codebase already throws a typed not-found exception elsewhere.
 *
 * **Throwable only from `AccountStore.resolve()`.** Throwing it from a
 * specialism method (`createMediaBuy`, `getProducts`, etc.) bypasses the
 * framework's not-found mapping and surfaces as `SERVICE_UNAVAILABLE`.
 *
 * The constructor's `message` is for server-side operator diagnostics only.
 * The framework emits a fixed `ACCOUNT_NOT_FOUND` envelope regardless; the
 * message never reaches the buyer. Operator-side log pipelines may aggregate
 * this string, so MUST NOT include caller-supplied identifiers (echoed account
 * refs, request args) — those leak across operator / buyer trust boundaries.
 *
 * Use ONLY for the narrow not-found case. Upstream-API outages, misconfigured
 * env vars, and schema-validation failures should propagate as generic
 * exceptions and surface to the buyer as `SERVICE_UNAVAILABLE`.
 */
export class AccountNotFoundError extends Error {
  readonly name = 'AccountNotFoundError' as const;
  constructor(message = 'Account not found') {
    super(message);
  }
}

export interface AccountFilter {
  /** Filter by brand domain across all operators. */
  brand_domain?: string;
  /** Filter by operator across all brands. */
  operator?: string;
  /** Filter by status. */
  status?: AdcpAccountStatus[];
}

/**
 * Per-account result row returned by an adopter's `accounts.upsert`
 * implementation. Maps to one element of the wire `sync_accounts` response's
 * `accounts[]` array.
 *
 * Carries the same optional commercial / lifecycle fields as the wire shape
 * so adopters can echo `setup` (for `pending_approval` accounts), `billing`,
 * `billing_entity`, `payment_terms`, etc. on creation. The framework
 * projects these through `toWireSyncAccountRow` before emit, applying the
 * same `billing_entity.bank` strip as `toWireAccount` (write-only contract).
 *
 * **MUST NOT carry `authInfo` or other auth-derived fields.** This shape is
 * emitted on the `sync_accounts` response wire. The framework's projector
 * does not read `authInfo`, but adopters MUST NOT add an `authInfo` key on
 * returned rows — same MUST-NOT-LEAK rule the framework enforces on
 * `Account.authInfo`.
 */
export interface SyncAccountsResultRow {
  account_id?: string;
  brand: BrandReference;
  operator: string;
  /** Human-readable account name assigned by the seller. */
  name?: string;
  action: 'created' | 'updated' | 'unchanged' | 'failed';
  status: AdcpAccountStatus;
  /** Invoiced-to party. Echoes the request's `billing` after seller acceptance. */
  billing?: BillingParty;
  /** Business entity invoiced. `bank` is stripped on emit (write-only). */
  billing_entity?: BusinessEntity;
  account_scope?: AccountScope;
  /** Setup payload for `pending_approval` accounts (URL/message/expiry). */
  setup?: WireAccount['setup'];
  rate_card?: string;
  payment_terms?: PaymentTerms;
  credit_limit?: WireAccount['credit_limit'];
  errors?: { code: string; message: string }[];
  warnings?: string[];
  sandbox?: boolean;
}

export type AdcpAccountStatus =
  | 'active'
  | 'pending_approval'
  | 'rejected'
  | 'payment_required'
  | 'suspended'
  | 'closed';

// ---------------------------------------------------------------------------
// Wire projection — strip framework-internal fields before emit
// ---------------------------------------------------------------------------

/**
 * Project a framework `Account<TCtxMeta>` to the wire `Account` shape.
 *
 * Strips `ctx_metadata` and `authInfo` (framework-internal); renames `id` →
 * `account_id`; passes through wire-shaped fields. Strips
 * `billing_entity.bank` per the schema's write-only constraint — bank
 * coordinates flow buyer→seller in `sync_accounts` requests but MUST NOT
 * appear in any response payload.
 *
 * Used by the framework when emitting `list_accounts` and other wire
 * responses that include account data. Adopters never call this directly —
 * they return `Account<TCtxMeta>` from `accounts.resolve` / `accounts.list`
 * and the framework projects.
 */
export function toWireAccount<TCtxMeta>(account: Account<TCtxMeta>): WireAccount {
  const wire: WireAccount = {
    account_id: account.id,
    name: account.name,
    status: account.status,
  };
  if (account.brand !== undefined) wire.brand = account.brand;
  if (account.operator !== undefined) wire.operator = account.operator;
  if (account.advertiser !== undefined) wire.advertiser = account.advertiser;
  if (account.billing_proxy !== undefined) wire.billing_proxy = account.billing_proxy;
  if (account.billing !== undefined) {
    // Wire `Account.billing: 'operator' | 'agent' | 'advertiser'` is the
    // invoiced-to party. Internal `billing.invoicedTo` collapses string +
    // BrandReference; a BrandReference indicates a third-party advertiser
    // (Amazon DSP-shaped flow), which projects to `'advertiser'`.
    const t = account.billing.invoicedTo;
    wire.billing = typeof t === 'string' ? t : 'advertiser';
  }
  const projectedEntity = projectBillingEntity(account.billing_entity);
  if (projectedEntity !== undefined) wire.billing_entity = projectedEntity;
  if (account.rate_card !== undefined) wire.rate_card = account.rate_card;
  if (account.payment_terms !== undefined) wire.payment_terms = account.payment_terms;
  if (account.credit_limit !== undefined) wire.credit_limit = account.credit_limit;
  if (account.setup !== undefined) wire.setup = account.setup;
  if (account.account_scope !== undefined) wire.account_scope = account.account_scope;
  if (account.governance_agents !== undefined) {
    wire.governance_agents = account.governance_agents.map(projectGovernanceAgent);
  }
  if (account.reporting_bucket !== undefined) wire.reporting_bucket = account.reporting_bucket;
  if (account.sandbox !== undefined) wire.sandbox = account.sandbox;
  if (account.ext !== undefined) wire.ext = account.ext;
  return wire;
}

type WireSyncAccountRow = SyncAccountsSuccess['accounts'][number];

/**
 * Project an adopter `SyncAccountsResultRow` to the wire shape returned by
 * `sync_accounts`. Applies the same `billing_entity.bank` strip as
 * `toWireAccount` — the wire schema marks bank coordinates write-only on
 * EVERY response, not just `list_accounts`. Adopters returning a row that
 * spreads a DB record carrying `bank` (e.g.,
 * `{ ...db.findByBrand(r.brand), action: 'updated' }`) have it stripped
 * before emit.
 *
 * Used by the framework when emitting `sync_accounts` responses. Adopters
 * never call this directly — they return `SyncAccountsResultRow[]` from
 * `accounts.upsert` and the framework projects.
 */
export function toWireSyncAccountRow(row: SyncAccountsResultRow): WireSyncAccountRow {
  const wire: WireSyncAccountRow = {
    brand: row.brand,
    operator: row.operator,
    action: row.action,
    status: row.status,
  };
  if (row.account_id !== undefined) wire.account_id = row.account_id;
  if (row.name !== undefined) wire.name = row.name;
  if (row.billing !== undefined) wire.billing = row.billing;
  const projectedEntity = projectBillingEntity(row.billing_entity);
  if (projectedEntity !== undefined) wire.billing_entity = projectedEntity;
  if (row.account_scope !== undefined) wire.account_scope = row.account_scope;
  if (row.setup !== undefined) wire.setup = row.setup;
  if (row.rate_card !== undefined) wire.rate_card = row.rate_card;
  if (row.payment_terms !== undefined) wire.payment_terms = row.payment_terms;
  if (row.credit_limit !== undefined) wire.credit_limit = row.credit_limit;
  if (row.errors !== undefined) wire.errors = row.errors;
  if (row.warnings !== undefined) wire.warnings = row.warnings;
  if (row.sandbox !== undefined) wire.sandbox = row.sandbox;
  return wire;
}

/**
 * Strip `BusinessEntity.bank` per the schema's write-only constraint, and
 * skip emission entirely when nothing else is populated. Bank-only inputs
 * project to `undefined`, signaling the caller to omit `billing_entity`
 * rather than emit an empty object that would fail `legal_name` validation.
 *
 * Destructure-and-rest excludes `bank` regardless of source shape: own
 * non-enumerable, getter, prototype-chain, and Proxy-backed bank fields
 * are all excluded by the ES rest-spread evaluation order
 * (`CopyDataProperties` walks own-enumerable keys and skips the
 * destructured names).
 */
function projectBillingEntity(entity: BusinessEntity | undefined): BusinessEntity | undefined {
  if (entity === undefined) return undefined;
  const { bank: _bank, ...rest } = entity;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

type WireGovernanceAgent = NonNullable<WireAccount['governance_agents']>[number];

/**
 * Project a governance-agent element to the wire shape, dropping any keys
 * the wire schema doesn't model. The schema notes that authentication
 * credentials are write-only and not included in responses; the wire type
 * already carries only `url` and `categories`, but TS is erased at runtime
 * so adopters using JS or `as any` could otherwise smuggle a `credentials`
 * field straight to the wire. Explicit projection closes that gap.
 */
function projectGovernanceAgent(agent: WireGovernanceAgent): WireGovernanceAgent {
  const projected: WireGovernanceAgent = { url: agent.url };
  if (agent.categories !== undefined) projected.categories = agent.categories;
  return projected;
}

// ---------------------------------------------------------------------------
// AccountReference helpers
// ---------------------------------------------------------------------------

/**
 * Extract `account_id` from an `AccountReference` discriminated union without
 * casting. Returns `undefined` when `ref` is absent or the union arm doesn't
 * carry an `account_id` (e.g., `{ brand, operator }` or sandbox variants).
 *
 * Typical use in `accounts.resolve` implementations:
 *
 * ```ts
 * resolve: async (ref, ctx) => {
 *   const id = refAccountId(ref);
 *   if (id) return this.db.findById(id);
 *   const cred = ctx?.authInfo?.credential;
 *   const key = cred?.kind === 'oauth' ? cred.client_id : cred?.kind === 'api_key' ? cred.key_id : undefined;
 *   return key ? this.db.findByClientKey(key) : null;
 * }
 * ```
 *
 * @public
 */
export function refAccountId(ref?: AccountReference): string | undefined {
  return ref && 'account_id' in ref ? (ref as { account_id?: string }).account_id : undefined;
}
