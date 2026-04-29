/**
 * TenantRegistry — multi-tenant deployment helper for the v6.0 decisioning
 * runtime.
 *
 * Holds a map of `agentUrl → TenantConfig` and tracks per-tenant health.
 * Composes with the existing `serve()` host-routing surface: the registry
 * returns an `AdcpServer` factory that dispatches based on `ctx.host`.
 *
 * **Three health states**, never startup-fatal:
 *
 *   - `healthy` — JWKS validated, accepting traffic normally.
 *   - `unverified` — validation hasn't completed (server starting, or
 *     JWKS unreachable transiently). Tenant accepts traffic with a
 *     warning header; framework periodically re-validates.
 *   - `disabled` — validation failed deterministically (signing key not
 *     in published JWKS, brand.json malformed). Tenant returns
 *     `SERVICE_UNAVAILABLE` until an admin recheck succeeds.
 *
 * One bad tenant doesn't take down others — health is per-tenant, the
 * other tenants keep serving.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { DecisioningPlatform, RequiredPlatformsFor, RequiredCapabilitiesFor } from './platform';
import type { DecisioningAdcpServer, CreateAdcpServerFromPlatformOptions } from './runtime/from-platform';
import { createAdcpServerFromPlatform } from './runtime/from-platform';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TenantSigningKey {
  /** Stable key identifier — appears in the `Signature-Input` header. */
  keyId: string;
  /**
   * JWK form of the public key. MUST appear in the JWKS at
   * `{agentUrl}/.well-known/brand.json` for the tenant to validate.
   */
  publicJwk: JsonWebKey;
  /** Private JWK used to sign outbound responses (RFC 9421). */
  privateJwk: JsonWebKey;
}

export interface TenantConfig<P extends DecisioningPlatform = DecisioningPlatform> {
  /**
   * Public URL the tenant accepts traffic on (e.g.,
   * `https://acme-tv.example.com`). Used for host-route matching and —
   * unless `jwksUrl` overrides — as the JWKS fetch base (the default
   * validator computes `{host}/.well-known/brand.json` from this URL).
   */
  agentUrl: string;
  /**
   * Override the JWKS fetch URL for this tenant. Use this when the
   * tenant's brand.json doesn't sit at the host root — i.e., a single
   * host serves multiple agents under path prefixes
   * (`https://shared.example.com/api/agent-a`,
   * `https://shared.example.com/api/agent-b`) and each prefix has its
   * own brand identity. Without this override, the default validator
   * resolves `/.well-known/brand.json` against the host root, which
   * collapses both agents onto the same brand.
   *
   * Spec convention is host-root, so the override is only needed for
   * sub-routed multi-tenant deployments. Custom validators that take a
   * different shape entirely (e.g., reading from a vault) read this
   * field via the `jwksUrl` argument on `JwksValidator.validate`.
   */
  jwksUrl?: string;
  /** Signing keypair for RFC 9421 response signing. */
  signingKey: TenantSigningKey;
  /** The DecisioningPlatform impl for this tenant. */
  platform: P &
    RequiredPlatformsFor<P['capabilities']['specialisms'][number]> &
    RequiredCapabilitiesFor<P['capabilities']['specialisms'][number]>;
  /** Display label for admin / logs. Optional. */
  label?: string;
  /** Per-tenant `createAdcpServerFromPlatform` options override. */
  serverOptions?: Partial<CreateAdcpServerFromPlatformOptions>;
}

/**
 * Tenant health lifecycle:
 *   - `'pending'` — first JWKS validation hasn't succeeded yet. Brand-new
 *     tenants land here. `resolveByHost` REFUSES TRAFFIC for `pending`
 *     tenants — host transport should respond 503 + Retry-After. This
 *     closes the register-then-serve race window where a tenant
 *     registered with a wrong signing key would have served signed
 *     responses no buyer can verify until the first refresh detected
 *     the mismatch (60+ seconds).
 *   - `'healthy'` — JWKS validation has succeeded at least once.
 *     Periodic rechecks confirm.
 *   - `'unverified'` — was previously `healthy`; latest recheck failed
 *     transiently (network error, 5xx, etc.). `resolveByHost` still
 *     returns the tenant — graceful degradation for known-good tenants
 *     when brand.json is briefly unreachable. Distinct from `'pending'`
 *     where we've never validated.
 *   - `'disabled'` — permanent validation failure (key not in published
 *     JWKS, brand.json malformed, etc.). `resolveByHost` returns null;
 *     operator must fix and call `recheck()` to revive.
 */
export type TenantHealth = 'pending' | 'healthy' | 'unverified' | 'disabled';

export interface TenantStatus {
  tenantId: string;
  agentUrl: string;
  health: TenantHealth;
  /** Reason for unverified/disabled state. */
  reason?: string;
  /** ISO timestamp of the last health check. */
  lastCheckedAt: string;
}

export interface JwksValidationResult {
  ok: boolean;
  /** Recovery classification when `ok === false`. */
  recovery?: 'transient' | 'permanent';
  reason?: string;
}

export interface JwksValidator {
  /**
   * Validate that the tenant's signing key appears in the published JWKS.
   *
   * - `agentUrl` is the tenant's public URL (used for host-relative URL
   *   computation by the default validator).
   * - `jwksUrl` is the explicit JWKS fetch URL when the tenant's
   *   `TenantConfig.jwksUrl` was set; absent for the spec-default
   *   host-root resolution.
   * - `signingKey` is what to look for in the published JWKS.
   */
  validate(opts: { agentUrl: string; jwksUrl?: string; signingKey: TenantSigningKey }): Promise<JwksValidationResult>;
}

export interface TenantRegistryOptions {
  /**
   * JWKS validator. Defaults to a fetch-based validator that hits
   * `{agentUrl}/.well-known/brand.json`. Tests can pass a fake.
   */
  jwksValidator?: JwksValidator;
  /**
   * Per-tenant `createAdcpServerFromPlatform` options applied to every
   * tenant unless overridden by `TenantConfig.serverOptions`.
   */
  defaultServerOptions: CreateAdcpServerFromPlatformOptions;
  /**
   * Auto-validate tenants when they're registered. Defaults to `true`.
   *
   * Disable ONLY for tests that drive validation manually via `recheck` —
   * with this off, every `register()` leaves the tenant in `'pending'`
   * health and `resolveByRequest` silently refuses traffic until the
   * caller recheck()s each tenant. Production deployments should leave
   * this at the default; the framework emits a one-shot console.warn at
   * registry construction when `autoValidate: false` is set, to surface
   * the "all traffic blocked" consequence.
   */
  autoValidate?: boolean;
}

export interface TenantRegistry {
  /**
   * Register a tenant. Tenant lands in `'pending'` health initially —
   * `resolveByHost` refuses traffic until the first JWKS validation
   * succeeds. Pass `{ awaitFirstValidation: true }` to block on the
   * synchronous validation outcome (returns the resulting status; throws
   * if registration is incompatible). Without the flag, register fires
   * validation in the background and returns immediately; the caller
   * polls `getStatus(tenantId).health === 'healthy'` if needed.
   *
   * **Admin-API security.** This method is the privileged surface — any
   * caller invoking `register` can introduce a tenant that will sign
   * outbound webhooks. Hosts wiring an HTTP/RPC endpoint in front of
   * `register` MUST gate it with operator-level auth (mTLS, signed
   * admin tokens, network ACL). The framework doesn't ship admin-HTTP
   * scaffolding because the right auth shape varies by deployment;
   * adopters who want a vetted shape can layer Express middleware
   * around their `registry.register(...)` route handler.
   */
  register<P extends DecisioningPlatform>(
    tenantId: string,
    config: TenantConfig<P>,
    opts?: { awaitFirstValidation?: boolean }
  ): Promise<TenantStatus> | void;
  unregister(tenantId: string): void;
  /**
   * Resolve a tenant by host alone (the lowercased authority of the
   * request). Convenience wrapper around `resolveByRequest(host, '/')` —
   * works for the canonical subdomain-routing pattern (e.g.,
   * `sales.training.example.com`) where each tenant has its own host.
   *
   * For path-based routing (`training.example.com/sales`,
   * `training.example.com/creative` on a single host), use
   * `resolveByRequest(host, pathname)` instead.
   *
   * Returns null if no tenant matches, the tenant is `pending` (first
   * validation hasn't succeeded), or the tenant is `disabled`.
   * `unverified` tenants resolve normally — graceful degradation for
   * known-good tenants whose latest recheck failed transiently.
   */
  resolveByHost(host: string): { tenantId: string; config: TenantConfig; server: DecisioningAdcpServer } | null;
  /**
   * Resolve a tenant by host AND request path. The framework matches
   * tenants whose `agentUrl` host equals the request host AND whose
   * `agentUrl` path is a prefix of the request `pathname`. When multiple
   * tenants share a host, the LONGEST matching path prefix wins (so
   * `/sales-broadcast` is preferred over `/sales` for a request to
   * `/sales-broadcast/mcp`).
   *
   * Use this for path-routed multi-tenant deployments where adopters
   * don't want per-tenant subdomain DNS / TLS overhead. Each tenant's
   * `agentUrl` carries the path: `https://training.example.com/sales`.
   * Subdomain-routed tenants (`https://sales.training.example.com`)
   * keep working — their path prefix is `/`, which matches any pathname.
   *
   * Returns null on no match, `pending`, or `disabled`. `unverified`
   * tenants resolve normally (graceful degradation).
   */
  resolveByRequest(
    host: string,
    pathname: string
  ): { tenantId: string; config: TenantConfig; server: DecisioningAdcpServer } | null;
  getStatus(tenantId: string): TenantStatus | null;
  list(): readonly TenantStatus[];
  /**
   * Trigger a JWKS recheck for the tenant. Admin UI calls this after
   * fixing a brand.json mismatch.
   */
  recheck(tenantId: string): Promise<TenantStatus>;
}

// ---------------------------------------------------------------------------
// Default JWKS validator
// ---------------------------------------------------------------------------

/**
 * Default JWKS validator. Fetches `{agentUrl}/.well-known/brand.json` and
 * checks that `signingKey.publicJwk` appears in the JWKS keys array.
 *
 * Uses the global `fetch`. Network errors classify as `transient`;
 * 4xx / parse-error / key-not-in-JWKS classify as `permanent`.
 */
export function createDefaultJwksValidator(opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }): JwksValidator {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  // 10-second default timeout. A slow brand.json server (or a malicious
  // one dribbling bytes) would otherwise pin the tenant in `pending`
  // for the lifetime of the fetch — and `register({ awaitFirstValidation: true })`
  // would block the booting host indefinitely. Adopters with strict SLAs
  // pass a tighter value; adopters fronting brand.json behind a slow
  // CDN can extend it. Round-6 Sec-M1.
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  return {
    async validate({ agentUrl, jwksUrl, signingKey }): Promise<JwksValidationResult> {
      // Explicit jwksUrl wins (sub-routed deployments where brand.json
      // lives under a path prefix). Default falls back to the spec-
      // canonical host-root location — `new URL('/.well-known/brand.json',
      // agentUrl)` REPLACES the path because the second arg starts with
      // '/'. That's correct for host-level brand identity (one brand per
      // host), wrong for multi-tenant sub-routed deployments — adopters
      // there set `TenantConfig.jwksUrl` to point at the per-tenant
      // brand.json.
      // Reject empty-string jwksUrl as defense-in-depth — `??` only
      // catches null/undefined, so an empty string would otherwise
      // reach `fetch('')` and produce an opaque error. Treat empty as
      // "use default."
      const url = jwksUrl && jwksUrl.length > 0 ? jwksUrl : new URL('/.well-known/brand.json', agentUrl).toString();
      let response: Response;
      try {
        response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        return {
          ok: false,
          recovery: 'transient',
          reason: `JWKS fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          recovery: response.status >= 500 ? 'transient' : 'permanent',
          reason: `JWKS fetch returned ${response.status} ${response.statusText}`,
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        return {
          ok: false,
          recovery: 'permanent',
          reason: `JWKS body not JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const jwks = (body as { jwks?: { keys?: unknown[] } }).jwks;
      if (!jwks || !Array.isArray(jwks.keys)) {
        return {
          ok: false,
          recovery: 'permanent',
          reason: '`brand.json` has no `jwks.keys` array',
        };
      }
      const matched = jwks.keys.find(k => isMatchingKey(k, signingKey.publicJwk, signingKey.keyId));
      if (!matched) {
        return {
          ok: false,
          recovery: 'permanent',
          reason: `signingKey.keyId='${signingKey.keyId}' not present in published JWKS`,
        };
      }
      return { ok: true };
    },
  };
}

function isMatchingKey(jwk: unknown, expected: JsonWebKey, expectedKid: string): boolean {
  if (!jwk || typeof jwk !== 'object') return false;
  const k = jwk as Record<string, unknown>;
  // Both `kid` AND public-key material must match. `kid` alone is NOT
  // sufficient — RFC 7517 § 4.5 explicitly notes that `kid` is just a
  // hint and clashes are possible. An attacker who can publish a JWKS
  // with a colliding `kid` would otherwise bypass verification.
  if (typeof k.kid === 'string' && k.kid !== expectedKid) return false;
  if (k.kty !== expected.kty) return false;
  // Structural equality on the public-half fields (n/e for RSA, x/y for
  // EC, x for OKP). A full JWK thumbprint comparison (RFC 7638) would be
  // more robust but this catches the typical "wrong key" case without
  // pulling crypto deps in. Asymmetric pubkeys are public — comparing
  // the components here doesn't need constant-time semantics.
  if (expected.kty === 'RSA') {
    return k.n === expected.n && k.e === expected.e;
  }
  if (expected.kty === 'EC') {
    return k.crv === expected.crv && k.x === expected.x && k.y === expected.y;
  }
  if (expected.kty === 'OKP') {
    return k.crv === expected.crv && k.x === expected.x;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

interface TenantEntry {
  config: TenantConfig;
  server: DecisioningAdcpServer;
  status: TenantStatus;
  /** Lowercased host parsed from `config.agentUrl`. */
  host: string;
  /**
   * Path prefix parsed from `config.agentUrl`. Always starts with `/`,
   * never ends with a trailing `/` unless the prefix IS `/` (root).
   * Subdomain-routed tenants have prefix `/`; path-routed tenants have
   * prefix like `/sales` or `/creative`.
   */
  pathPrefix: string;
  /** Pending revalidation; consulted by `recheck` to dedupe in-flight work. */
  pending?: Promise<TenantStatus>;
}

/**
 * Parse host + path prefix from an agent URL. Normalizes the path:
 * always starts with `/`; trailing `/` stripped unless the prefix is
 * itself `/` (root, the subdomain-routing case).
 */
function parseHostAndPrefix(agentUrl: string): { host: string; pathPrefix: string } {
  const url = new URL(agentUrl);
  const host = url.host.toLowerCase();
  let pathPrefix = url.pathname || '/';
  if (pathPrefix.length > 1 && pathPrefix.endsWith('/')) {
    pathPrefix = pathPrefix.slice(0, -1);
  }
  return { host, pathPrefix };
}

/**
 * Does `requestPath` fall under tenant's `pathPrefix`?
 *
 *   - Tenant prefix `/` matches any path (subdomain-routing case).
 *   - Tenant prefix `/sales` matches `/sales`, `/sales/mcp`, `/sales/a2a`, etc.
 *     Does NOT match `/sales-broadcast` (no boundary).
 *
 * **Caller contract.** `requestPath` MUST be a normalized URL pathname:
 * no query string, no fragment, no leading scheme/authority. Express's
 * `req.path`, Node's `new URL(req.url, base).pathname`, or any
 * properly-decoded equivalent. Raw `req.url` includes the query string
 * (`/sales/mcp?token=abc`) which fails the boundary check at the `?`
 * char. The framework strips query/fragment defensively (see
 * `stripQueryAndFragment`) but downstream URL normalization (`..`
 * resolution, percent-decoding) is the caller's responsibility.
 */
function pathPrefixMatches(pathPrefix: string, requestPath: string): boolean {
  if (pathPrefix === '/') return true;
  if (!requestPath.startsWith(pathPrefix)) return false;
  // Boundary check: char immediately after the prefix must be `/` or
  // end-of-string. Prevents `/sales` from matching `/sales-broadcast`.
  const next = requestPath.charAt(pathPrefix.length);
  return next === '' || next === '/';
}

/**
 * Defensive normalization for callers who hand us `req.url` (raw HTTP
 * path with query / fragment). Strips `?...` and `#...` so the boundary
 * check in `pathPrefixMatches` works. Idempotent on already-normalized
 * paths.
 */
function stripQueryAndFragment(pathname: string): string {
  const queryIdx = pathname.indexOf('?');
  const fragmentIdx = pathname.indexOf('#');
  let cut = pathname.length;
  if (queryIdx !== -1 && queryIdx < cut) cut = queryIdx;
  if (fragmentIdx !== -1 && fragmentIdx < cut) cut = fragmentIdx;
  return cut === pathname.length ? pathname : pathname.slice(0, cut);
}

export function createTenantRegistry(opts: TenantRegistryOptions): TenantRegistry {
  const validator = opts.jwksValidator ?? createDefaultJwksValidator();
  const autoValidate = opts.autoValidate ?? true;
  // One-shot footgun guard: developers reaching for `autoValidate: false`
  // typically expect "skip the validation cost," but the actual semantics
  // are "every tenant lands in `pending` and `resolveByRequest` silently
  // refuses traffic until the operator calls `recheck()` on each one."
  // That divergence is hard to debug without a clue. Surface it once at
  // construction so the test/dev path stays usable but the production
  // misuse is visible.
  if (opts.autoValidate === false) {
    // eslint-disable-next-line no-console
    console.warn(
      "[adcp] TenantRegistry created with autoValidate: false — every register() lands tenants in 'pending' " +
        'health and resolveByRequest will refuse all traffic until you call recheck(tenantId) on each one. ' +
        'If you wanted to skip validation cost, REMOVE the flag — the default (true) validates in the ' +
        'background and traffic is served as soon as the first validation succeeds. autoValidate: false ' +
        'only suits tests that drive recheck() manually.'
    );
  }
  const tenants = new Map<string, TenantEntry>();

  function buildServer(config: TenantConfig): DecisioningAdcpServer {
    const merged: CreateAdcpServerFromPlatformOptions = {
      ...opts.defaultServerOptions,
      ...config.serverOptions,
    };
    return createAdcpServerFromPlatform(config.platform, merged);
  }

  async function runValidation(tenantId: string): Promise<TenantStatus> {
    const entry = tenants.get(tenantId);
    if (!entry) {
      throw new Error(`runValidation: tenant '${tenantId}' not registered`);
    }
    let result: JwksValidationResult;
    try {
      result = await validator.validate({
        agentUrl: entry.config.agentUrl,
        ...(entry.config.jwksUrl !== undefined && { jwksUrl: entry.config.jwksUrl }),
        signingKey: entry.config.signingKey,
      });
    } catch (err) {
      // Validator threw — treat as transient (network glitch, etc.).
      // Without this catch the tenant would be stuck in `pending`
      // forever — `runValidation` rejects, `entry.status` never
      // transitions. Closes Emma's round-1 #16.
      result = {
        ok: false,
        recovery: 'transient',
        reason: `validator threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const now = new Date().toISOString();
    const wasFirstValidation = entry.status.health === 'pending';
    let status: TenantStatus;
    if (result.ok) {
      status = { tenantId, agentUrl: entry.config.agentUrl, health: 'healthy', lastCheckedAt: now };
    } else if (result.recovery === 'transient') {
      // Transient failure on FIRST validation → stay `pending` (refuse
      // traffic). Transient failure AFTER first success → `unverified`
      // (graceful degradation — the tenant's known good).
      status = {
        tenantId,
        agentUrl: entry.config.agentUrl,
        health: wasFirstValidation ? 'pending' : 'unverified',
        reason: result.reason,
        lastCheckedAt: now,
      };
    } else {
      // Permanent failure → `disabled` regardless of prior state. The
      // signing-key material doesn't match what's published; refusing
      // traffic is the safe default.
      status = {
        tenantId,
        agentUrl: entry.config.agentUrl,
        health: 'disabled',
        reason: result.reason,
        lastCheckedAt: now,
      };
    }
    entry.status = status;
    return status;
  }

  return {
    register<P extends DecisioningPlatform>(
      tenantId: string,
      config: TenantConfig<P>,
      opts?: { awaitFirstValidation?: boolean }
    ): Promise<TenantStatus> | void {
      if (tenants.has(tenantId)) {
        throw new Error(`tenant '${tenantId}' already registered; unregister first`);
      }
      const server = buildServer(config as unknown as TenantConfig);
      const initialStatus: TenantStatus = {
        tenantId,
        agentUrl: config.agentUrl,
        // `pending` (NOT `unverified`) — first validation hasn't run.
        // resolveByHost refuses traffic until validation succeeds at
        // least once. Closes the register-then-serve race window.
        health: 'pending',
        reason: 'awaiting initial JWKS validation',
        lastCheckedAt: new Date().toISOString(),
      };
      const { host, pathPrefix } = parseHostAndPrefix(config.agentUrl);
      const entry: TenantEntry = {
        config: config as unknown as TenantConfig,
        server,
        status: initialStatus,
        host,
        pathPrefix,
      };
      tenants.set(tenantId, entry);
      // Operability: log when an explicit jwksUrl points somewhere
      // OTHER than the spec-canonical agentUrl-relative location. An
      // admin who pasted a typo into config gets a visible audit trail
      // before the tenant goes live; a sub-routed deployment that
      // intentionally overrode sees the configured URL confirmed.
      // One-shot per register() — not per validate() — so periodic
      // rechecks don't spam logs.
      if (config.jwksUrl && config.jwksUrl.length > 0) {
        let canonical: string;
        try {
          canonical = new URL('/.well-known/brand.json', config.agentUrl).toString();
        } catch {
          canonical = '<invalid agentUrl>';
        }
        if (config.jwksUrl !== canonical) {
          // eslint-disable-next-line no-console
          console.info(
            `[adcp] tenant '${tenantId}' jwksUrl override: '${config.jwksUrl}' (spec-canonical from agentUrl: '${canonical}')`
          );
        }
      }
      if (!autoValidate) return;
      const validation = runValidation(tenantId);
      entry.pending = validation;
      // Always clear pending on settle so subsequent recheck() doesn't
      // dedupe against a settled promise.
      validation.finally(() => {
        if (entry.pending === validation) entry.pending = undefined;
      });
      if (opts?.awaitFirstValidation) {
        return validation;
      }
      // Background fire — log throws so they don't surface as
      // UnhandledPromiseRejection. (runValidation now catches inside;
      // belt-and-suspenders.)
      validation.catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[adcp] tenant '${tenantId}' validation threw:`, err);
      });
    },

    unregister(tenantId: string): void {
      tenants.delete(tenantId);
    },

    resolveByHost(host: string): { tenantId: string; config: TenantConfig; server: DecisioningAdcpServer } | null {
      // Convenience for subdomain-routed deployments — request path is
      // implicitly `/`, which only matches root-prefix tenants.
      return this.resolveByRequest(host, '/');
    },

    resolveByRequest(
      host: string,
      pathname: string
    ): { tenantId: string; config: TenantConfig; server: DecisioningAdcpServer } | null {
      const lowered = host.toLowerCase();
      // Strip query/fragment defensively — adopters wiring `req.url`
      // (Node raw HTTP) instead of `req.path` (Express normalized)
      // would otherwise fail the boundary check on `/sales/mcp?x=1`.
      const cleanPath = stripQueryAndFragment(pathname);
      let best: { tenantId: string; entry: TenantEntry; prefixLength: number } | null = null;
      for (const [tenantId, entry] of tenants) {
        if (entry.host !== lowered) continue;
        if (!pathPrefixMatches(entry.pathPrefix, cleanPath)) continue;
        // Refuse traffic for pending (first validation hasn't succeeded)
        // and disabled (permanent validation failure). `unverified` —
        // previously healthy, latest recheck failed transiently — still
        // resolves; operators choose graceful degradation here.
        if (entry.status.health === 'pending' || entry.status.health === 'disabled') continue;
        // Longest-prefix match wins. `/sales-broadcast` beats `/sales`.
        const prefixLength = entry.pathPrefix === '/' ? 0 : entry.pathPrefix.length;
        if (best === null || prefixLength > best.prefixLength) {
          best = { tenantId, entry, prefixLength };
        }
      }
      if (best === null) return null;
      return { tenantId: best.tenantId, config: best.entry.config, server: best.entry.server };
    },

    getStatus(tenantId: string): TenantStatus | null {
      const entry = tenants.get(tenantId);
      return entry?.status ?? null;
    },

    list(): readonly TenantStatus[] {
      return Array.from(tenants.values()).map(e => e.status);
    },

    async recheck(tenantId: string): Promise<TenantStatus> {
      const entry = tenants.get(tenantId);
      if (!entry) {
        throw new Error(`recheck: tenant '${tenantId}' not registered`);
      }
      // Dedupe concurrent rechecks against the same tenant.
      if (entry.pending) {
        try {
          await entry.pending;
        } catch {
          // ignore — fall through to fresh recheck
        }
      }
      entry.pending = runValidation(tenantId);
      try {
        return await entry.pending;
      } finally {
        entry.pending = undefined;
      }
    },
  };
}
