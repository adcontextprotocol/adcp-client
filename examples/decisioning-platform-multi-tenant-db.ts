/**
 * DB-driven multi-tenant registry — runtime register/unregister
 *
 * Extends the static example in `decisioning-platform-multi-tenant.ts` with
 * the patterns real SaaS deployments need:
 *
 *   1. Load N tenants from a DB at startup (no hardcoded list)
 *   2. Register a newly-saved tenant without restarting the process
 *   3. Re-validate a tenant's JWKS after signing-key rotation (recheck)
 *   4. Update a tenant's platform config via unregister → re-register
 *   5. Remove a tenant — resolveByHost returns null immediately on unregister
 *
 * Health states (per-tenant, isolated from each other):
 *
 *   pending     → registered; first JWKS validation not yet completed.
 *                 resolveByHost refuses traffic until the first validation
 *                 succeeds (closes the register-then-serve race window).
 *   healthy     → JWKS validated; serving normally.
 *   unverified  → was healthy; latest recheck failed transiently (network
 *                 hiccup, brand.json 5xx). resolveByHost still serves —
 *                 graceful degradation for known-good tenants.
 *   disabled    → permanent validation failure (key not in JWKS, brand.json
 *                 malformed). resolveByHost refuses traffic; admin must call
 *                 recheck() after fixing brand.json.
 *
 * --- Semantics for callers migrating from a hand-rolled tenant map ---
 *
 * "Atomic swap" clarification: createTenantRegistry has no native hot-swap
 * primitive. To update a tenant's platform config, call unregister() then
 * register(). Between those two calls resolveByHost returns null, so new
 * requests for that tenant receive a 503. In-flight requests that already
 * resolved (obtained their server reference before unregister) complete
 * normally — they hold a reference to the old server instance. The gap is
 * typically <10ms for in-process config changes.
 *
 * For JWKS key rotation (no platform-config change), use recheck() — it
 * re-validates without any traffic gap.
 *
 * See docs/migration-6.6-to-6.7.md (tracked in #1344) for the step-by-step
 * migration recipe from hand-rolled tenant maps.
 *
 * @see `skills/build-decisioning-platform/advanced/MULTI-TENANT.md`
 */

import {
  createTenantRegistry,
  createNoopJwksValidator,
  type TenantRegistry,
  type TenantStatus,
  type DecisioningPlatform,
} from '@adcp/sdk/server';

// ---------------------------------------------------------------------------
// DB abstraction — replace with pg / better-sqlite3 / Prisma / etc.
// ---------------------------------------------------------------------------

export type TenantType = 'broadcast-tv' | 'programmatic';

export interface DbTenantRow {
  id: string;
  agentUrl: string;
  label: string;
  type: TenantType;
  /**
   * KMS key ID for webhook signing.
   *
   * 🔴 PRODUCTION: load the actual JWK pair from your KMS using this ID.
   * See docs/guides/SIGNING-GUIDE.md § "Multi-tenant KMS path" for the
   * HashiCorp Vault / AWS KMS / GCP Secret Manager recipes.
   *
   * This example omits signingKey so tenants skip JWKS validation and
   * reach `healthy` immediately — valid for local dev, NOT for production
   * (AdCP 4.0 makes signingKey mandatory).
   */
  kmsKeyId?: string;
}

/**
 * Fetch active tenants from the database at startup.
 *
 * Production: `SELECT id, agent_url, label, type FROM tenants WHERE active = TRUE`
 *
 * The async signature is load-bearing: it keeps the pattern identical whether
 * you're using pg's Pool.query(), Prisma, or a simple fetch() to an internal
 * API. Adopters swapping this stub will not need to change the call sites.
 */
export async function loadTenantsFromDb(): Promise<DbTenantRow[]> {
  // Stub — replace with your actual DB query.
  return [
    { id: 'acme_tv', agentUrl: 'https://acme-tv.example.com', label: 'Acme Broadcast TV', type: 'broadcast-tv' },
    { id: 'zenith', agentUrl: 'https://zenith.example.com', label: 'Zenith Programmatic', type: 'programmatic' },
    { id: 'metro_digital', agentUrl: 'https://metro.example.com', label: 'Metro Digital', type: 'programmatic' },
  ];
}

/**
 * Fetch a single active tenant from the DB — used on admin-save.
 *
 * Returns null when the tenant is not found or is inactive.
 */
export async function loadOneTenantFromDb(tenantId: string): Promise<DbTenantRow | null> {
  const rows = await loadTenantsFromDb();
  return rows.find(r => r.id === tenantId) ?? null;
}

/**
 * Build the platform for a DB row.
 *
 * Replace this stub with your actual platform implementations:
 *
 * ```ts
 * import { BroadcastTvSeller } from './decisioning-platform-broadcast-tv';
 * import { ProgrammaticSeller } from './decisioning-platform-programmatic';
 *
 * function buildPlatform(row: DbTenantRow): DecisioningPlatform {
 *   if (row.type === 'broadcast-tv') return new BroadcastTvSeller();
 *   return new ProgrammaticSeller();
 * }
 * ```
 *
 * Each concrete type (BroadcastTvSeller, ProgrammaticSeller) satisfies
 * DecisioningPlatform — TypeScript infers the platform generic param P
 * at the `register()` call site, so the RequiredPlatformsFor<specialism>
 * constraint is checked per-tenant at compile time.
 *
 * NOTE: a factory function that returns the broad `DecisioningPlatform`
 * interface (rather than a concrete class) causes P to be inferred as the
 * base interface, which triggers a large union intersection for
 * `RequiredPlatformsFor<AdCPSpecialism>`. In `registerRow` below we cast the
 * return value to `any` at the call site — the runtime behavior is correct
 * (validatePlatform checks specialisms[] at startup) but TypeScript can't
 * verify the specialism→sub-interface mapping without a concrete type.
 * Concrete classes remain the type-safe path for production adopters.
 */
export function buildPlatform(_row: DbTenantRow): DecisioningPlatform {
  // Minimal stub for illustration — swap for your real implementations.
  // DecisioningCapabilities only requires `specialisms`; other fields are
  // optional overlays for the wire protocol (channels, pricing, etc.).
  // AccountStore.list is optional — omit unless the platform supports
  // buyer-initiated account listing. AccountStore.resolve is required.
  return {
    capabilities: {
      specialisms: [] as const,
      // TConfig defaults to `unknown` for stubs — any value satisfies it.
      // Concrete platforms type this as their own config shape (e.g.,
      // `DecisioningPlatform<{ networkId: string }>`).
      config: {},
    },
    accounts: {
      resolve: async () => null,
    },
  };
}

// ---------------------------------------------------------------------------
// Registry construction
// ---------------------------------------------------------------------------

export interface BuildRegistryOptions {
  /**
   * Dev/test: skip JWKS validation so tenants go straight to `healthy`.
   *
   * createNoopJwksValidator() only constructs under NODE_ENV=test/development
   * or when ADCP_NOOP_JWKS_ACK=1 is set. It throws in production, which is
   * intentional — JWKS validation is the security check that ensures a
   * tenant's signing key matches its published brand.json.
   */
  noopValidator?: boolean;
}

/**
 * Build a registry seeded from the DB.
 *
 * Awaits the first JWKS validation for each tenant before returning, so
 * callers can start serving immediately without polling health status.
 *
 * Usage:
 *
 * ```ts
 * import { serve } from '@adcp/sdk/server';
 * const registry = await buildDbMultiTenantRegistry();
 * serve(ctx => {
 *   const resolved = registry.resolveByHost(ctx.host);
 *   if (!resolved) throw new Error(`unknown host: ${ctx.host}`);
 *   return resolved.server;
 * }, { port: process.env.PORT });
 * ```
 */
export async function buildDbMultiTenantRegistry(opts?: BuildRegistryOptions): Promise<TenantRegistry> {
  const registry = createTenantRegistry({
    defaultServerOptions: {
      name: 'multi-tenant-host',
      version: '1.0.0',
      validation: { requests: 'strict', responses: 'strict' },
    },
    ...(opts?.noopValidator ? { jwksValidator: createNoopJwksValidator() } : {}),
    autoValidate: true,
  });

  const rows = await loadTenantsFromDb();
  for (const row of rows) {
    await registerRow(registry, row);
  }

  return registry;
}

/**
 * Register a single DB row.
 *
 * Uses `register()` directly so TypeScript infers the concrete platform type —
 * the RequiredPlatformsFor constraint is checked per specialism at the call
 * site. A generic factory returning `TenantConfig<DecisioningPlatform>` would
 * lose that check.
 *
 * Awaits first validation so the caller knows the health outcome immediately.
 */
async function registerRow(registry: TenantRegistry, row: DbTenantRow): Promise<TenantStatus> {
  return registry.register(
    row.id,
    {
      agentUrl: row.agentUrl,
      label: row.label,
      // `as any` because buildPlatform() returns DecisioningPlatform (the base
      // interface), which causes P to be inferred broadly and triggers the
      // RequiredPlatformsFor<AdCPSpecialism> union. Concrete classes don't
      // need this cast — use BroadcastTvSeller / ProgrammaticSeller directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platform: buildPlatform(row) as any,
      // signingKey: await loadSigningKeyFromKms(row.kmsKeyId),  // 🔴 ADD IN PRODUCTION
    },
    { awaitFirstValidation: true }
  ) as Promise<TenantStatus>;
}

// ---------------------------------------------------------------------------
// Admin operations
//
// 🔴 SECURITY: wire these behind operator-level auth — mTLS, signed admin
// tokens, or network ACL. Any caller that can invoke register() can
// introduce a tenant that signs outbound webhooks. The SDK doesn't ship
// admin-HTTP scaffolding because the right auth shape is deployment-specific.
// ---------------------------------------------------------------------------

/**
 * Register a newly-saved tenant without restarting the process.
 *
 * Typically called from an admin-save webhook:
 *   POST /admin/tenants/:tenantId/activate
 */
export async function adminRegisterTenant(registry: TenantRegistry, tenantId: string): Promise<TenantStatus> {
  const row = await loadOneTenantFromDb(tenantId);
  if (!row) throw new Error(`tenant '${tenantId}' not found in DB or inactive`);
  return registerRow(registry, row);
}

/**
 * Re-validate a tenant's JWKS after signing-key rotation.
 *
 * Call this after the tenant has published their new key to brand.json.
 * This is the zero-traffic-gap path — unlike adminUpdateTenant, recheck
 * does not remove the tenant from the routing table during validation.
 *
 * Possible transitions after recheck:
 *   healthy    → healthy  (key still present in JWKS; nominal)
 *   disabled   → healthy  (admin fixed brand.json; tenant revived)
 *   unverified → healthy  (transient network error resolved)
 *   healthy    → disabled (key removed from JWKS; tenant immediately blocked)
 */
export async function adminRecheckTenant(registry: TenantRegistry, tenantId: string): Promise<TenantStatus> {
  return registry.recheck(tenantId);
}

/**
 * Update a tenant's platform config (e.g., new capacity settings, feature
 * flags) via unregister → re-register.
 *
 * ⚠️  TRAFFIC GAP: between unregister() and the re-register completing,
 * resolveByHost returns null for this tenant. New requests get a 503 for
 * the duration of the gap (typically <10ms for in-process calls; longer
 * if awaitFirstValidation triggers a brand.json fetch).
 *
 * In-flight requests that already resolved — i.e., obtained a server
 * reference before unregister was called — complete normally. They hold
 * a direct reference to the old server instance.
 *
 * For signing-key rotation without a config change, prefer
 * adminRecheckTenant() — it transitions health with no traffic gap.
 *
 * ⚠️  CONCURRENCY: concurrent admin writes to the same tenantId must be
 * serialized by the caller. A second call that fires while the DB await is
 * in-flight will see `'tenant already registered'` from register() or will
 * overwrite with stale data if its DB call resolves last. A per-tenant
 * async Mutex (or your job queue) prevents this.
 *
 * Migrating from a hand-rolled tenant map? See docs/migration-6.6-to-6.7.md
 * (tracked in #1344) for the migration recipe.
 */
export async function adminUpdateTenant(registry: TenantRegistry, tenantId: string): Promise<TenantStatus> {
  registry.unregister(tenantId);
  const row = await loadOneTenantFromDb(tenantId);
  if (!row) throw new Error(`tenant '${tenantId}' not found in DB or inactive`);
  return registerRow(registry, row);
}

/**
 * Remove a tenant permanently.
 *
 * resolveByHost returns null immediately after this call. In-flight requests
 * that already hold a server reference complete normally (no drain period —
 * the server instance stays alive until GC). New resolve calls return null
 * and callers should respond with 503/404 depending on their host-routing
 * semantics.
 */
export function adminUnregisterTenant(registry: TenantRegistry, tenantId: string): void {
  registry.unregister(tenantId);
}
