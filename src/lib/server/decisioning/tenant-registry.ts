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

import type { DecisioningPlatform, RequiredPlatformsFor } from './platform';
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
   * `https://acme-tv.example.com`). Used for host-route matching and as
   * the JWKS fetch base.
   */
  agentUrl: string;
  /** Signing keypair for RFC 9421 response signing. */
  signingKey: TenantSigningKey;
  /** The DecisioningPlatform impl for this tenant. */
  platform: P & RequiredPlatformsFor<P['capabilities']['specialisms'][number]>;
  /** Display label for admin / logs. Optional. */
  label?: string;
  /** Per-tenant `createAdcpServerFromPlatform` options override. */
  serverOptions?: Partial<CreateAdcpServerFromPlatformOptions>;
}

export type TenantHealth = 'healthy' | 'unverified' | 'disabled';

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
  validate(opts: { agentUrl: string; signingKey: TenantSigningKey }): Promise<JwksValidationResult>;
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
   * Disable for tests that want to drive validation manually via `recheck`.
   */
  autoValidate?: boolean;
}

export interface TenantRegistry {
  register<P extends DecisioningPlatform>(tenantId: string, config: TenantConfig<P>): void;
  unregister(tenantId: string): void;
  /**
   * Resolve a tenant by host (the lowercased authority of the request).
   * Returns null if no tenant matches or the tenant is disabled.
   * `unverified` tenants resolve normally — operators choose graceful
   * degradation over hard failure during JWKS validation race.
   */
  resolveByHost(host: string): { tenantId: string; config: TenantConfig; server: DecisioningAdcpServer } | null;
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
export function createDefaultJwksValidator(opts?: { fetchImpl?: typeof fetch }): JwksValidator {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  return {
    async validate({ agentUrl, signingKey }): Promise<JwksValidationResult> {
      const url = new URL('/.well-known/brand.json', agentUrl).toString();
      let response: Response;
      try {
        response = await fetchImpl(url, { method: 'GET' });
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
  // Match by kid first if both sides have one — kid is the canonical
  // identifier in RFC 7517. Fall back to fingerprint-equivalent fields.
  if (typeof k.kid === 'string' && k.kid === expectedKid) return true;
  if (k.kty !== expected.kty) return false;
  // Quick structural equality on the public-half fields (n/e for RSA,
  // x/y for EC, x for OKP). A full JWK thumbprint comparison would be
  // more robust but this catches the typical "wrong key" case without
  // pulling crypto deps in.
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
  /** Pending revalidation; consulted by `recheck` to dedupe in-flight work. */
  pending?: Promise<TenantStatus>;
}

export function createTenantRegistry(opts: TenantRegistryOptions): TenantRegistry {
  const validator = opts.jwksValidator ?? createDefaultJwksValidator();
  const autoValidate = opts.autoValidate ?? true;
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
    const result = await validator.validate({
      agentUrl: entry.config.agentUrl,
      signingKey: entry.config.signingKey,
    });
    const now = new Date().toISOString();
    let status: TenantStatus;
    if (result.ok) {
      status = { tenantId, agentUrl: entry.config.agentUrl, health: 'healthy', lastCheckedAt: now };
    } else if (result.recovery === 'transient') {
      status = {
        tenantId,
        agentUrl: entry.config.agentUrl,
        health: 'unverified',
        reason: result.reason,
        lastCheckedAt: now,
      };
    } else {
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
    register<P extends DecisioningPlatform>(tenantId: string, config: TenantConfig<P>): void {
      if (tenants.has(tenantId)) {
        throw new Error(`tenant '${tenantId}' already registered; unregister first`);
      }
      const server = buildServer(config as unknown as TenantConfig);
      const initialStatus: TenantStatus = {
        tenantId,
        agentUrl: config.agentUrl,
        health: 'unverified',
        reason: 'awaiting initial JWKS validation',
        lastCheckedAt: new Date().toISOString(),
      };
      const entry: TenantEntry = { config: config as unknown as TenantConfig, server, status: initialStatus };
      tenants.set(tenantId, entry);
      if (autoValidate) {
        // Fire-and-forget; status updates land on completion.
        entry.pending = runValidation(tenantId);
        entry.pending.catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(`[adcp] tenant '${tenantId}' validation threw:`, err);
        });
      }
    },

    unregister(tenantId: string): void {
      tenants.delete(tenantId);
    },

    resolveByHost(host: string): { tenantId: string; config: TenantConfig; server: DecisioningAdcpServer } | null {
      const lowered = host.toLowerCase();
      for (const [tenantId, entry] of tenants) {
        const tenantHost = new URL(entry.config.agentUrl).host.toLowerCase();
        if (tenantHost !== lowered) continue;
        if (entry.status.health === 'disabled') return null;
        return { tenantId, config: entry.config, server: entry.server };
      }
      return null;
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
