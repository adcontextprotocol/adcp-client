/**
 * Multi-tenant deployment — one process serving many advertiser-tenants
 * across different hosts with mixed shapes.
 *
 * Composes `createTenantRegistry()` with the framework's existing
 * host-routed `serve()` factory: the registry holds host → tenant config,
 * the factory resolves the tenant per request and returns its server.
 *
 * Each tenant has its own DecisioningPlatform impl, signing key, and
 * health state. One bad tenant (JWKS mismatch, brand.json malformed) is
 * disabled in isolation — the rest keep serving.
 *
 * @see `docs/proposals/decisioning-platform-v2-hitl-split.md`
 */

import {
  createTenantRegistry,
  type TenantRegistry,
  type TenantSigningKey,
  type DecisioningAdcpServer,
} from '@adcp/sdk/server/decisioning';
import { BroadcastTvSeller } from './decisioning-platform-broadcast-tv';
import { ProgrammaticSeller } from './decisioning-platform-programmatic';

// ---------------------------------------------------------------------------
// 🔴 PRODUCTION: REPLACE WITH KMS-BACKED LOADER
// ---------------------------------------------------------------------------
//
// The fixtures below are DUMMY values — the `n` modulus is a placeholder
// string, not a valid RSA modulus. They exist so the example file
// typechecks and the test harness can mock the JWKS validator.
//
// In a real multi-tenant deployment these MUST come from a key-management
// system (HashiCorp Vault, AWS KMS, GCP Secret Manager) — never commit
// real signing material to source. The TenantRegistry's `pending` health
// state will refuse to serve a tenant whose JWKS validation fails, but
// shipping placeholder keys to a non-test environment is still a
// production incident waiting to happen.
//
// See `skills/build-decisioning-platform/SKILL.md` § "Multi-tenant
// hosting (TenantRegistry)" for the production wiring pattern.
// ---------------------------------------------------------------------------
const TENANT_KEYS: Record<string, TenantSigningKey> = {
  acme_tv: {
    keyId: 'acme_tv-2026-04',
    publicJwk: { kty: 'RSA', n: 'pub_modulus_acme', e: 'AQAB' },
    privateJwk: { kty: 'RSA', n: 'pub_modulus_acme', e: 'AQAB', d: 'priv_exp_acme' },
  },
  zenith_programmatic: {
    keyId: 'zenith-2026-04',
    publicJwk: { kty: 'RSA', n: 'pub_modulus_zenith', e: 'AQAB' },
    privateJwk: { kty: 'RSA', n: 'pub_modulus_zenith', e: 'AQAB', d: 'priv_exp_zenith' },
  },
};

/**
 * Build a registry seeded with two tenants of mixed shapes:
 *
 *   - `acme_tv` hosts a `BroadcastTvSeller` (HITL — `*Task` variants).
 *   - `zenith_programmatic` hosts a `ProgrammaticSeller` (sync + status-change).
 *
 * Buyers reach each at their own agentUrl; the framework dispatches based
 * on `ctx.host` resolved from `X-Forwarded-Host` (proxied) or the request
 * `Host` header (direct).
 */
export function buildMultiTenantRegistry(): TenantRegistry {
  const registry = createTenantRegistry({
    defaultServerOptions: {
      name: 'multi-tenant-host',
      version: '0.0.1',
      validation: { requests: 'strict', responses: 'strict' },
    },
    autoValidate: true,
  });

  registry.register('acme_tv', {
    agentUrl: 'https://acme-tv.example.com',
    signingKey: TENANT_KEYS.acme_tv!,
    platform: new BroadcastTvSeller(),
    label: 'Acme Broadcast TV',
    serverOptions: {
      name: 'acme-tv',
      version: '1.0.0',
    },
  });

  registry.register('zenith_programmatic', {
    agentUrl: 'https://zenith.example.com',
    signingKey: TENANT_KEYS.zenith_programmatic!,
    platform: new ProgrammaticSeller(),
    label: 'Zenith Programmatic',
    serverOptions: {
      name: 'zenith-programmatic',
      version: '1.0.0',
    },
  });

  return registry;
}

/**
 * Factory the caller passes to `serve(createAgent, options)`. Resolves the
 * tenant by `ctx.host`, returns its `AdcpServer`. Throws `UnknownHostError`-
 * compatible behavior when no tenant matches — the framework projects this
 * to the standard 404/unknown-host wire response.
 *
 * In a real deployment this is wired alongside `serve()`:
 *
 * ```ts
 * import { serve } from '@adcp/sdk/server';
 * const registry = buildMultiTenantRegistry();
 * serve(makeMultiTenantFactory(registry), { ... });
 * ```
 *
 * Disabled tenants resolve to null → factory throws → framework returns
 * SERVICE_UNAVAILABLE. Healthy and unverified tenants both serve normally;
 * unverified tenants log a warning per request so operators know which
 * are awaiting validation.
 */
export function makeMultiTenantFactory(registry: TenantRegistry): (ctx: { host: string }) => DecisioningAdcpServer {
  return ctx => {
    const resolved = registry.resolveByHost(ctx.host);
    if (!resolved) {
      throw new Error(`No tenant registered for host '${ctx.host}'`);
    }
    return resolved.server;
  };
}
