/**
 * hello_seller_adapter_multi_tenant — one server, multiple specialisms
 * (governance + property-lists + brand-rights), multiple tenants with
 * isolated data. Models an agency / holdco hub.
 *
 * ⚠️  DO NOT DEPLOY AS-IS. This file seeds harness/demo bearer tokens in
 *    plaintext (`sk_harness_do_not_use_in_prod`, `sk_pinnacle_addie_demo`,
 *    `sk_meridian_buyer_demo`) for local exploration. Production adopters:
 *    load credentials from a secrets manager and replace the in-memory
 *    `TENANTS` map with a transactional store.
 *
 * Demonstrates the **account-routed** multi-tenant model: a single AdCP
 * endpoint hosts multiple specialism agents AND multiple tenants whose
 * data never crosses. Distinct from `decisioning-platform-multi-tenant.ts`
 * which uses **host-routed** tenancy via `TenantRegistry` (different
 * agentUrls per tenant). Both are valid; this one is what a holding
 * company / agency hub looks like.
 *
 * What it shows:
 *
 *   - One `DecisioningPlatform` class implementing three specialism
 *     interfaces: `campaignGovernance`, `propertyLists`, `brandRights`.
 *   - Per-tenant data partitioning. Plans / lists / rights catalogs /
 *     grants / brand identity records all keyed by `tenant_id`. A
 *     plan synced under tenant A is invisible to tenant B's
 *     `get_plan_audit_logs`.
 *   - Two tenant resolution paths:
 *       1. Tools that carry `account` (governance, property-lists) →
 *          `accounts.resolve(ref)` reads `ref.operator` and maps to
 *          a tenant. Same buyer credential can hit different tenants
 *          by varying `account.operator`.
 *       2. Tools that DON'T carry `account` (`get_brand_identity`,
 *          `get_rights`) → `accounts.resolve(undefined, ctx)` reads
 *          the resolved `ctx.agent` (BuyerAgent) and routes to that
 *          agent's home tenant. Different credentials → different
 *          views of the catalog without any account field on the wire.
 *   - Two distinct tenants seeded with overlapping AND distinct data so
 *     `curl`-driven exploration shows real isolation.
 *
 * Demo:
 *   NODE_ENV=development npx tsx examples/hello_seller_adapter_multi_tenant.ts
 *
 *   # As Pinnacle (default storyboard runner credential):
 *   adcp storyboard run http://127.0.0.1:3003/mcp governance-spend-authority \
 *     --auth sk_harness_do_not_use_in_prod --allow-http
 *   adcp storyboard run http://127.0.0.1:3003/mcp brand-rights \
 *     --auth sk_harness_do_not_use_in_prod --allow-http
 *
 *   # As Meridian — different tenant, different rights catalog:
 *   curl -sH "Authorization: Bearer sk_meridian_buyer_demo" \
 *        -H "Accept: application/json, text/event-stream" \
 *        -H "Content-Type: application/json" \
 *        --data '{"jsonrpc":"2.0","id":1,"method":"tools/call",
 *                 "params":{"name":"get_rights",
 *                 "arguments":{"query":"music sync","uses":["sync"]}}}' \
 *        http://127.0.0.1:3003/mcp
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  memoryBackend,
  AdcpError,
  BuyerAgentRegistry,
  defineCampaignGovernancePlatform,
  definePropertyListsPlatform,
  defineBrandRightsPlatform,
  type DecisioningPlatform,
  type CampaignGovernancePlatform,
  type PropertyListsPlatform,
  type BrandRightsPlatform,
  type AccountStore,
  type Account,
  type BuyerAgent,
  type CachedBuyerAgentRegistry,
  type ResolveContext,
  type RequestContext,
} from '@adcp/sdk/server';
import type {
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  SyncPlansRequest,
  SyncPlansResponse,
  ReportPlanOutcomeRequest,
  ReportPlanOutcomeResponse,
  GetPlanAuditLogsRequest,
  GetPlanAuditLogsResponse,
  CreatePropertyListRequest,
  CreatePropertyListResponse,
  UpdatePropertyListRequest,
  UpdatePropertyListResponse,
  GetPropertyListRequest,
  GetPropertyListResponse,
  ListPropertyListsRequest,
  ListPropertyListsResponse,
  DeletePropertyListRequest,
  DeletePropertyListResponse,
  PropertyList,
} from '@adcp/sdk/types';
import type {
  GetBrandIdentityRequest,
  GetBrandIdentitySuccess,
  GetRightsRequest,
  GetRightsSuccess,
  AcquireRightsRequest,
  AcquireRightsAcquired,
  AcquireRightsRejected,
  RightUse,
  RightType,
} from '@adcp/sdk/types/core.generated';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env['PORT'] ?? 3003);

// ---------------------------------------------------------------------------
// Per-tenant data — SWAP for your durable store. Each tenant gets its own
// brand catalog, rights catalog, plan ledger, property-list store, and
// account/binding tables. Real adopters key these tables by `tenant_id` in
// Postgres (or scope by tenant in their ORM); the in-memory shape below is
// the per-tenant slice the framework hands to handlers via
// `ctx.account.ctx_metadata.tenant_id`.
//
// In-memory module-state has no eviction and no transactional semantics.
// Production: replace `TENANTS` with row-level reads/writes against a real
// store, set per-tenant quotas (plans, lists, rights catalogs grow without
// bound here), and use proper isolation levels for concurrent writers.
// ---------------------------------------------------------------------------

interface BrandRecord {
  brand_id: string;
  house: { domain: string; name: string };
  names: Array<{ [k: string]: string }>;
  description?: string;
}

interface RightsRecord {
  rights_id: string;
  brand_id: string;
  name: string;
  description: string;
  available_uses: RightUse[];
  pricing_option_id: string;
  price: number;
  currency: string;
}

interface StoredPlan {
  plan_id: string;
  version: number;
  budget_total: number;
  currency: string;
  custom_policies: Array<{ policy_id: string; enforcement: 'must' | 'should' | 'may'; policy: string }>;
  audit: AuditEntry[];
}

interface AuditEntry {
  timestamp: string;
  kind: 'check' | 'outcome';
  check_id?: string;
  detail: Record<string, unknown>;
}

interface StoredPropertyList {
  list: PropertyList;
  auth_token: string;
}

/**
 * Per-account governance binding. Buyer registers their governance agent
 * with us (the brand agent) via `sync_governance`. We record the URL +
 * credentials + the active plan_id we should consult on rights acquisition.
 * Real adopters store this as an `account_governance_bindings` row keyed by
 * `(tenant_id, account_key)`.
 */
interface GovernanceBinding {
  governance_agent_url: string;
  /** Plan id to evaluate against. The wire `sync_governance` payload
   * doesn't carry plan_id directly — adopters either pre-register a default
   * plan via `sync_plans` then bind via `sync_governance`, or surface a
   * 1:1 plan-per-account convention. We pick the latter for the demo:
   * the most recently synced plan for this tenant becomes the active one. */
  active_plan_id?: string;
}

interface TenantState {
  display_name: string;
  brands: Map<string, BrandRecord>;
  rights: Map<string, RightsRecord>;
  plans: Map<string, StoredPlan>;
  propertyLists: Map<string, StoredPropertyList>;
  /** Accounts the buyer registered via `sync_accounts`. Keyed by
   * `${operator}::${brand.domain}`. Tenant-scoped so an account
   * registered under Pinnacle is invisible to Meridian. */
  accounts: Map<string, { operator: string; brand_domain: string; status: 'active' }>;
  /** Governance bindings keyed by `brand.domain`. `acquire_rights` doesn't
   * carry an operator on the wire — only `buyer.domain` (a brand ref) — so
   * binding lookup on rights acquisition has to key on brand_domain alone.
   * Tenant scoping is enforced one level up: `getTenant(ctx)` already
   * narrowed to the right tenant before we ever read this map. */
  governanceBindings: Map<string, GovernanceBinding>;
  /** Most recently synced plan per tenant — used as the default when the
   * brand agent consults governance on `acquire_rights`. Real adopters
   * bind plan_id to account explicitly. */
  active_plan_id?: string;
}

function makeTenant(displayName: string): TenantState {
  return {
    display_name: displayName,
    brands: new Map(),
    rights: new Map(),
    plans: new Map(),
    propertyLists: new Map(),
    accounts: new Map(),
    governanceBindings: new Map(),
  };
}

function accountKey(operator: string, brandDomain: string): string {
  return `${operator}::${brandDomain}`;
}

const TENANTS = new Map<string, TenantState>([
  ['tenant_pinnacle', makeTenant('Pinnacle Agency (rights + governance)')],
  ['tenant_meridian', makeTenant('Meridian Media (rights + governance)')],
]);

// Tenant 1 (Pinnacle) — talent likeness + AI generation rights for the
// brand-rights compliance storyboard's `acmeoutdoor.example` buyer.
const pinnacle = TENANTS.get('tenant_pinnacle')!;
pinnacle.brands.set('acme_outdoor', {
  brand_id: 'acme_outdoor',
  house: { domain: 'acmeinc.example', name: 'Acme Inc.' },
  names: [{ en_US: 'Acme Outdoor' }],
  description: 'Acme Outdoor — outdoor gear for everyday explorers.',
});
pinnacle.brands.set('test.example', {
  brand_id: 'test.example',
  house: { domain: 'test.example', name: 'Test Brand' },
  names: [{ en_US: 'Test Brand' }],
  description: 'Storyboard placeholder brand.',
});
pinnacle.rights.set('rights_acme_likeness_q2', {
  rights_id: 'rights_acme_likeness_q2',
  brand_id: 'acme_outdoor',
  name: 'Acme Outdoor — likeness + name (Q2)',
  description: 'Single-quarter license covering likeness and name use in commercial creative.',
  available_uses: ['likeness', 'name', 'commercial'],
  pricing_option_id: 'cpm_standard',
  price: 12.5,
  currency: 'USD',
});
pinnacle.rights.set('rights_ai_generation_universal', {
  rights_id: 'rights_ai_generation_universal',
  brand_id: 'test.example',
  name: 'AI generation license (universal)',
  description: 'Synthetic-content license covering AI image generation for advertising creative.',
  available_uses: ['ai_generated_image', 'commercial', 'editorial'],
  pricing_option_id: 'cpm_ai_generation',
  price: 8.0,
  currency: 'USD',
});

// Tenant 2 (Meridian) — distinct catalog (music sync rights) so cross-tenant
// reads return DIFFERENT data, not just the same data with a different tenant
// header. This is what an isolation regression would look like if the
// per-tenant scoping was wrong.
const meridian = TENANTS.get('tenant_meridian')!;
meridian.brands.set('zenith_athletics', {
  brand_id: 'zenith_athletics',
  house: { domain: 'zenithcorp.example', name: 'Zenith Corp.' },
  names: [{ en_US: 'Zenith Athletics' }],
  description: 'Zenith Athletics — performance apparel.',
});
meridian.rights.set('rights_zenith_anthem_sync', {
  rights_id: 'rights_zenith_anthem_sync',
  brand_id: 'zenith_athletics',
  name: 'Zenith — anthem track sync rights',
  description: 'Music sync license for Zenith brand anthem in TV/CTV creative.',
  available_uses: ['sync', 'background_music', 'commercial'],
  pricing_option_id: 'flat_quarterly',
  price: 25000,
  currency: 'USD',
});

// ---------------------------------------------------------------------------
// Operator → tenant routing.
// `accounts.resolve(ref)` reads `ref.operator` and returns the matching
// tenant. Same buyer credential can hit different tenants by varying
// `account.operator` on each request.
// SWAP: in production this is a directory-service lookup or DB row, not
// a static map. The buyer-tenant authority gate in `accounts.upsert` and
// `syncGovernanceHandler` depends on this mapping being trustworthy.
// ---------------------------------------------------------------------------

const OPERATOR_TO_TENANT = new Map<string, string>([
  ['pinnacle-agency.example', 'tenant_pinnacle'],
  ['meridian-media.example', 'tenant_meridian'],
]);

// ---------------------------------------------------------------------------
// Buyer-agent registry. Three credentials seeded — three is the lesson:
//
//   - `sk_harness_do_not_use_in_prod` — the storyboard runner. Bound to
//      Pinnacle so `adcp storyboard run … --auth …` exercises tenant 1.
//      This is a known, well-published token — anyone can grep AdCP repos
//      for it. Banner at the top of this file says do-not-deploy; this is
//      where the warning bites.
//   - `sk_pinnacle_addie_demo` — Pinnacle's own demo buyer. Same tenant as
//      the harness, distinct principal, separate audit identity.
//   - `sk_meridian_buyer_demo` — Meridian's demo buyer. Different tenant.
//      Used in the curl examples in the file header to prove cross-tenant
//      isolation: same `brand_id` query, different responses.
//
// `BUYER_HOME_TENANT` is the side-map used by `accounts.resolve(undefined,
// ctx)` for no-account tools (`get_brand_identity`, `get_rights`) — the
// resolver reads `ctx.agent.agent_url`, looks up the buyer's home tenant,
// and returns the tenant-scoped account. Without this seam, no-account
// tools would fall through to a global view and leak data across tenants.
// ---------------------------------------------------------------------------

const PINNACLE_HARNESS_TOKEN = 'sk_harness_do_not_use_in_prod';
const PINNACLE_DEMO_TOKEN = 'sk_pinnacle_addie_demo';
const MERIDIAN_DEMO_TOKEN = 'sk_meridian_buyer_demo';

function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

const ADDIE_PINNACLE_URL = 'https://addie.pinnacle.example.com';
const ADDIE_MERIDIAN_URL = 'https://addie.meridian.example.com';

const ONBOARDING_LEDGER = new Map<string, BuyerAgent>([
  [
    hashApiKey(PINNACLE_HARNESS_TOKEN),
    {
      agent_url: ADDIE_PINNACLE_URL,
      display_name: 'Addie (storyboard runner @ Pinnacle)',
      status: 'active',
      billing_capabilities: new Set(['operator']),
      sandbox_only: true,
    },
  ],
  [
    hashApiKey(PINNACLE_DEMO_TOKEN),
    {
      agent_url: ADDIE_PINNACLE_URL,
      display_name: 'Pinnacle demo buyer',
      status: 'active',
      billing_capabilities: new Set(['operator']),
      sandbox_only: true,
    },
  ],
  [
    hashApiKey(MERIDIAN_DEMO_TOKEN),
    {
      agent_url: ADDIE_MERIDIAN_URL,
      display_name: 'Meridian demo buyer',
      status: 'active',
      billing_capabilities: new Set(['operator']),
      sandbox_only: true,
    },
  ],
]);

// SWAP: in production this is a row-level join in your buyer-onboarding
// store, not a static map. The trust seam: `BUYER_HOME_TENANT` is only
// as trustworthy as the registry's `agent_url` stamp. The bearer-keyed
// registry below stamps `agent_url` from the seeded ledger row keyed by
// the SHA-256 hash of the bearer — not buyer-spoofable. If you swap in
// a registry that takes `agent_url` from a buyer-controlled JWT claim,
// verify the claim before trusting it for tenant routing.
const BUYER_HOME_TENANT = new Map<string, string>([
  [ADDIE_PINNACLE_URL, 'tenant_pinnacle'],
  [ADDIE_MERIDIAN_URL, 'tenant_meridian'],
]);

const agentRegistry: CachedBuyerAgentRegistry = BuyerAgentRegistry.cached(
  BuyerAgentRegistry.bearerOnly({
    resolveByCredential: async credential => {
      if (credential.kind !== 'api_key') return null;
      return ONBOARDING_LEDGER.get(credential.key_id) ?? null;
    },
  }),
  { ttlSeconds: 60 }
);

// ---------------------------------------------------------------------------
// Tenant lookup helper. Throws ACCOUNT_NOT_FOUND if the resolved tenant
// can't be located — defensive guard against a handler running outside
// the multi-tenant rails.
// ---------------------------------------------------------------------------

interface TenantMeta {
  tenant_id: string;
  display_name: string;
  [key: string]: unknown;
}

function getTenant(ctx: { account: Account<TenantMeta> }): TenantState {
  const tenantId = ctx.account.ctx_metadata.tenant_id;
  const tenant = TENANTS.get(tenantId);
  if (!tenant) {
    throw new AdcpError('ACCOUNT_NOT_FOUND', {
      message: `Tenant '${tenantId}' is not provisioned.`,
    });
  }
  return tenant;
}

// ---------------------------------------------------------------------------
// AdCP-side adapter — typed against three specialism interfaces.
// ---------------------------------------------------------------------------

class MultiTenantAdapter implements DecisioningPlatform<Record<string, never>, TenantMeta> {
  capabilities = {
    specialisms: ['governance-spend-authority', 'property-lists', 'brand-rights'] as const,
    config: {},
    // brand-rights claim REQUIRES the brand capability block per
    // RequiredCapabilitiesFor<'brand-rights'>; framework auto-derives
    // `rights: true` from the platform impl.
    brand: {
      right_types: ['talent', 'brand_ip', 'music'] as RightType[],
      available_uses: [
        'likeness',
        'name',
        'commercial',
        'editorial',
        'ai_generated_image',
        'sync',
        'background_music',
      ] as RightUse[],
      generation_providers: [],
      description: 'Multi-tenant hello agent — governance + brand-rights for two demo tenants.',
    },
  };

  agentRegistry = agentRegistry;

  accounts: AccountStore<TenantMeta> = {
    /**
     * Two resolution paths:
     *   1. `ref.operator` is set (governance, property-lists, every tool
     *      with an `account` field) → look up tenant by operator.
     *   2. `ref` is undefined (no-account tools: `get_brand_identity`,
     *      `get_rights`) → derive tenant from the resolved buyer agent's
     *      home tenant. The framework calls this path via
     *      `resolveAccountFromAuth` so the platform doesn't reimplement
     *      auth-derived tenancy.
     */
    resolve: async (ref, ctx) => {
      // Path 2: no account on the wire. Derive from buyer agent.
      if (ref == null) {
        return resolveFromBuyer(ctx);
      }
      // Path 1: account-with-operator on the wire. Read both operator AND
      // brand off ref — downstream handlers (notably `enforceGovernance`)
      // index per-account state by `(operator, brand.domain)`, so dropping
      // brand on the floor here strands those handlers.
      const refTyped = ref as { operator?: string; brand?: { domain?: string } };
      const operator = refTyped.operator;
      if (!operator) return null;
      const tenantId = OPERATOR_TO_TENANT.get(operator);
      if (!tenantId) return null;
      const tenant = TENANTS.get(tenantId);
      if (!tenant) return null;
      return makeAccount(tenantId, tenant, operator, refTyped.brand?.domain);
    },

    /**
     * `sync_accounts` — buyers register accounts with us so subsequent
     * `sync_governance` calls have something to bind to.
     *
     * Tenant-isolation gate: derive the buyer's home tenant from
     * `ctx.agent.agent_url` (registered at onboarding, not buyer-spoofable
     * here because the bearer-keyed registry stamps the URL) and reject
     * any per-entry whose operator maps to a DIFFERENT tenant. Without
     * this check, a Meridian credential could submit
     * `operator: 'pinnacle-agency.example'` and write into Pinnacle's
     * tenant state. The spec requires sellers verify the authenticated
     * agent has authority over each referenced account before persisting.
     */
    upsert: async (refs, ctx) => {
      // Fail-CLOSED: when `homeTenantId` can't be resolved (no agent, or
      // agent_url not in BUYER_HOME_TENANT), reject everything. The earlier
      // pattern `if (homeTenantId && tenantId !== homeTenantId)` was fail-
      // OPEN — an adopter who forks this file and adds a credential without
      // a BUYER_HOME_TENANT row would silently disable tenant isolation.
      const homeTenantId = ctx?.agent ? BUYER_HOME_TENANT.get(ctx.agent.agent_url) : undefined;
      return refs.map(ref => {
        const r = ref as { operator?: string; brand?: { domain?: string } };
        const operator = r.operator;
        const brandDomain = r.brand?.domain;
        if (!operator || !brandDomain) {
          return {
            brand: { domain: brandDomain ?? 'unknown.example' },
            operator: operator ?? 'unknown',
            action: 'failed' as const,
            status: 'rejected' as const,
            errors: [{ code: 'INVALID_REQUEST', message: 'operator + brand.domain required' }],
          };
        }
        const tenantId = OPERATOR_TO_TENANT.get(operator);
        if (!tenantId) {
          return {
            brand: { domain: brandDomain },
            operator,
            action: 'failed' as const,
            status: 'rejected' as const,
            errors: [{ code: 'ACCOUNT_NOT_FOUND', message: `Unknown operator: ${operator}` }],
          };
        }
        // Tenant-isolation gate. Fail-closed: reject when home tenant
        // can't be resolved OR when the wire operator maps to a different
        // tenant than the buyer's authenticated home.
        if (!homeTenantId || tenantId !== homeTenantId) {
          return {
            brand: { domain: brandDomain },
            operator,
            action: 'failed' as const,
            status: 'rejected' as const,
            errors: [
              {
                code: 'PERMISSION_DENIED',
                message: `Buyer agent has no authority over operator '${operator}' (tenant mismatch or home tenant not configured).`,
              },
            ],
          };
        }
        const tenant = TENANTS.get(tenantId)!;
        const key = accountKey(operator, brandDomain);
        // accountKey collisions are upserts by design — same (operator, brand) = same account.
        // SWAP: row-level write under tenant transaction.
        const action = tenant.accounts.has(key) ? ('updated' as const) : ('created' as const);
        tenant.accounts.set(key, { operator, brand_domain: brandDomain, status: 'active' });
        return {
          account_id: tenantId,
          brand: { domain: brandDomain },
          operator,
          action,
          status: 'active' as const,
        };
      });
    },

    /**
     * `sync_governance` — buyers register governance agent endpoints with
     * us, scoped per-account. We persist the binding so `acquire_rights`
     * can later consult the registered agent before granting rights.
     *
     * Tenant-isolation gate: each entry's `account.operator` must map to
     * the same tenant the buyer is authenticated against (auth-derived via
     * `ctx.agent.agent_url` → BUYER_HOME_TENANT). Per-entry rejection on
     * mismatch — operation-level throw would fail the whole batch when one
     * entry crosses tenants.
     *
     * Hello-adapter shortcut: we record the first agent's URL and one
     * plan binding. The wire payload supports up to 10 governance agents
     * with category scoping and write-only credentials. Production adopters
     * MUST persist `entry.governance_agents[i].authentication.credentials`
     * and present them on outbound `check_governance` calls — silently
     * dropping them ships unauthenticated requests if you wire real cross-
     * agent calls.
     */
    syncGovernance: async (entries, ctx) => {
      const homeTenantId = ctx?.agent ? BUYER_HOME_TENANT.get(ctx.agent.agent_url) : undefined;
      return entries.map(entry => {
        const operator = entry.account.operator;
        const brandDomain = entry.account.brand?.domain;
        const govUrl = entry.governance_agents[0]?.url;
        if (!operator || !brandDomain) {
          return {
            account: entry.account,
            status: 'failed' as const,
            errors: [{ code: 'INVALID_REQUEST', message: 'account.operator + account.brand.domain required' }],
          };
        }
        const tenantId = OPERATOR_TO_TENANT.get(operator);
        if (!tenantId) {
          return {
            account: entry.account,
            status: 'failed' as const,
            errors: [{ code: 'ACCOUNT_NOT_FOUND', message: `Unknown operator: ${operator}` }],
          };
        }
        if (!homeTenantId || tenantId !== homeTenantId) {
          return {
            account: entry.account,
            status: 'failed' as const,
            errors: [
              {
                code: 'PERMISSION_DENIED',
                message: `Buyer agent has no authority over operator '${operator}' (tenant mismatch or home tenant not configured).`,
              },
            ],
          };
        }
        const tenant = TENANTS.get(tenantId)!;
        if (govUrl) {
          // SWAP: row-level write under tenant transaction. Real adopters
          // persist `governance_agents[i].authentication.credentials` —
          // they're write-only on the wire (NOT echoed back; the response
          // shape is strictly `{url, categories?}`) but required for
          // outbound `check_governance` calls.
          tenant.governanceBindings.set(brandDomain, {
            governance_agent_url: govUrl,
            active_plan_id: tenant.active_plan_id,
          });
        } else {
          tenant.governanceBindings.delete(brandDomain);
        }
        const echoedAgents = entry.governance_agents.map(a => ({
          url: a.url,
          ...(a.categories && { categories: a.categories }),
        }));
        return {
          account: entry.account,
          status: 'synced' as const,
          ...(echoedAgents.length > 0 && { governance_agents: echoedAgents }),
        };
      });
    },
  };

  campaignGovernance: CampaignGovernancePlatform<TenantMeta> = defineCampaignGovernancePlatform<TenantMeta>({
    syncPlans: async (req: SyncPlansRequest, ctx): Promise<SyncPlansResponse> => {
      const tenant = getTenant(ctx);
      const plans = (req.plans ?? []).map(p => {
        const existing = tenant.plans.get(p.plan_id);
        const version = existing ? existing.version + 1 : 1;
        const budget = (p.budget ?? {}) as { total?: number; currency?: string };
        const stored: StoredPlan = {
          plan_id: p.plan_id,
          version,
          budget_total: budget.total ?? 0,
          currency: budget.currency ?? 'USD',
          custom_policies: (p.custom_policies ?? []).map(cp => ({
            policy_id: cp.policy_id,
            enforcement: cp.enforcement,
            policy: cp.policy,
          })),
          audit: existing?.audit ?? [],
        };
        tenant.plans.set(p.plan_id, stored);
        return { plan_id: p.plan_id, status: 'active' as const, version };
      });
      // First-plan-wins convention for the auto-bind on `sync_governance`.
      // Set once, deterministically, AFTER the loop — last-wins inside the
      // map is order-dependent garbage when buyers sync multiple plans.
      // Real adopters bind plan_id to account explicitly via the buyer's
      // compliance configuration; this fallback only fires when
      // `sync_governance` is called WITHOUT an explicit binding for a
      // pre-existing plan.
      const firstNew = (req.plans ?? [])[0]?.plan_id;
      if (firstNew && !tenant.active_plan_id) tenant.active_plan_id = firstNew;
      return { plans };
    },

    checkGovernance: async (req: CheckGovernanceRequest, ctx): Promise<CheckGovernanceResponse> => {
      const tenant = getTenant(ctx);
      const plan = tenant.plans.get(req.plan_id);
      if (!plan) {
        throw new AdcpError('PLAN_NOT_FOUND', {
          message: `Unknown plan: ${req.plan_id}`,
          field: 'plan_id',
        });
      }
      const checkId = randomUUID();
      const proposed =
        (req.payload as { total_budget?: number; packages?: Array<{ budget?: number }> } | undefined) ?? {};
      const proposedBudget =
        typeof proposed.total_budget === 'number'
          ? proposed.total_budget
          : (proposed.packages ?? []).reduce((s, p) => s + (p.budget ?? 0), 0);

      const overBudget = proposedBudget > plan.budget_total;
      const status = overBudget ? 'denied' : plan.custom_policies.length > 0 ? 'conditions' : 'approved';

      const response: CheckGovernanceResponse = {
        check_id: checkId,
        status,
        plan_id: plan.plan_id,
        explanation: overBudget
          ? `Proposed spend ${proposedBudget} ${plan.currency} exceeds plan budget ${plan.budget_total} ${plan.currency}.`
          : status === 'conditions'
            ? 'Approved with custom policy conditions.'
            : 'Approved.',
        ...(status === 'denied' && {
          findings: [
            {
              category_id: 'budget_compliance',
              severity: 'critical' as const,
              explanation: `Proposed spend ${proposedBudget} exceeds plan budget ${plan.budget_total}.`,
            },
          ],
        }),
        ...(status === 'conditions' && {
          conditions: plan.custom_policies.map(p => ({
            field: `payload.${p.policy_id}`,
            reason: p.policy,
          })),
        }),
        ...(status !== 'denied' && {
          governance_context: `gov_ctx_${plan.plan_id}_${checkId}`,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }),
      };

      plan.audit.push({
        timestamp: new Date().toISOString(),
        kind: 'check',
        check_id: checkId,
        detail: { status, proposed_budget: proposedBudget },
      });
      return response;
    },

    reportPlanOutcome: async (req: ReportPlanOutcomeRequest, ctx): Promise<ReportPlanOutcomeResponse> => {
      const tenant = getTenant(ctx);
      const plan = tenant.plans.get(req.plan_id);
      if (!plan) {
        throw new AdcpError('PLAN_NOT_FOUND', {
          message: `Unknown plan: ${req.plan_id}`,
          field: 'plan_id',
        });
      }
      const committed = req.seller_response?.committed_budget ?? 0;
      plan.audit.push({
        timestamp: new Date().toISOString(),
        kind: 'outcome',
        check_id: req.check_id,
        detail: { outcome: req.outcome, purchase_type: req.purchase_type, committed_budget: committed },
      });
      return {
        outcome_id: randomUUID(),
        status: 'accepted',
        committed_budget: committed,
        plan_summary: {
          total_committed: committed,
          budget_remaining: Math.max(0, plan.budget_total - committed),
        },
      };
    },

    getPlanAuditLogs: async (req: GetPlanAuditLogsRequest, ctx): Promise<GetPlanAuditLogsResponse> => {
      const tenant = getTenant(ctx);
      const ids = req.plan_ids ?? [];
      const plans = ids.map(id => {
        const plan = tenant.plans.get(id);
        if (!plan) {
          throw new AdcpError('PLAN_NOT_FOUND', { message: `Unknown plan: ${id}`, field: 'plan_ids' });
        }
        const checks = plan.audit.filter(a => a.kind === 'check').length;
        const outcomes = plan.audit.filter(a => a.kind === 'outcome').length;
        return {
          plan_id: plan.plan_id,
          plan_version: plan.version,
          status: 'active' as const,
          budget: { authorized: plan.budget_total },
          summary: { checks_performed: checks, outcomes_reported: outcomes },
          governed_actions: [],
        };
      });
      return { plans };
    },
  });

  propertyLists: PropertyListsPlatform<TenantMeta> = definePropertyListsPlatform<TenantMeta>({
    createPropertyList: async (req: CreatePropertyListRequest, ctx): Promise<CreatePropertyListResponse> => {
      const tenant = getTenant(ctx);
      const listId = `pl_${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const list: PropertyList = {
        list_id: listId,
        name: req.name,
        ...(req.description && { description: req.description }),
        ...(req.account && { account: req.account }),
        ...(req.base_properties && { base_properties: req.base_properties }),
        ...(req.filters && { filters: req.filters }),
        ...(req.brand && { brand: req.brand }),
        cache_duration_hours: 24,
        created_at: now,
        updated_at: now,
        property_count: 0,
      };
      const auth_token = `pltok_${randomUUID().replace(/-/g, '')}`;
      tenant.propertyLists.set(listId, { list, auth_token });
      return { list, auth_token };
    },

    updatePropertyList: async (req: UpdatePropertyListRequest, ctx): Promise<UpdatePropertyListResponse> => {
      const tenant = getTenant(ctx);
      const stored = tenant.propertyLists.get(req.list_id);
      if (!stored) {
        throw new AdcpError('REFERENCE_NOT_FOUND', {
          message: `Unknown property list: ${req.list_id}`,
          field: 'list_id',
        });
      }
      const updated: PropertyList = {
        ...stored.list,
        ...(req.name !== undefined && { name: req.name }),
        ...(req.description !== undefined && { description: req.description }),
        ...(req.base_properties !== undefined && { base_properties: req.base_properties }),
        ...(req.filters !== undefined && { filters: req.filters }),
        ...(req.brand !== undefined && { brand: req.brand }),
        updated_at: new Date().toISOString(),
      };
      stored.list = updated;
      return { list: updated };
    },

    getPropertyList: async (req: GetPropertyListRequest, ctx): Promise<GetPropertyListResponse> => {
      const tenant = getTenant(ctx);
      const stored = tenant.propertyLists.get(req.list_id);
      if (!stored) {
        throw new AdcpError('REFERENCE_NOT_FOUND', {
          message: `Unknown property list: ${req.list_id}`,
          field: 'list_id',
        });
      }
      return {
        list: stored.list,
        identifiers: [],
        resolved_at: new Date().toISOString(),
        cache_valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    },

    listPropertyLists: async (req: ListPropertyListsRequest, ctx): Promise<ListPropertyListsResponse> => {
      const tenant = getTenant(ctx);
      const all = Array.from(tenant.propertyLists.values()).map(s => s.list);
      const filtered = req.name_contains
        ? all.filter(l => l.name.toLowerCase().includes(req.name_contains!.toLowerCase()))
        : all;
      return { lists: filtered };
    },

    deletePropertyList: async (req: DeletePropertyListRequest, ctx): Promise<DeletePropertyListResponse> => {
      const tenant = getTenant(ctx);
      const existed = tenant.propertyLists.delete(req.list_id);
      return { deleted: existed, list_id: req.list_id };
    },
  });

  brandRights: BrandRightsPlatform<TenantMeta> = defineBrandRightsPlatform<TenantMeta>({
    getBrandIdentity: async (req: GetBrandIdentityRequest, ctx): Promise<GetBrandIdentitySuccess> => {
      const tenant = getTenant(ctx);
      const brand = tenant.brands.get(req.brand_id);
      if (!brand) {
        throw new AdcpError('REFERENCE_NOT_FOUND', {
          message: `Unknown brand: ${req.brand_id}`,
          field: 'brand_id',
        });
      }
      return {
        brand_id: brand.brand_id,
        house: brand.house,
        names: brand.names,
        ...(brand.description && { description: brand.description }),
      };
    },

    getRights: async (req: GetRightsRequest, ctx): Promise<GetRightsSuccess> => {
      const tenant = getTenant(ctx);
      const requestedUses = new Set(req.uses);
      const matches = Array.from(tenant.rights.values()).filter(r => {
        if (req.brand_id && r.brand_id !== req.brand_id) return false;
        return r.available_uses.some(u => requestedUses.has(u));
      });
      return {
        rights: matches.map(r => ({
          rights_id: r.rights_id,
          brand_id: r.brand_id,
          name: r.name,
          description: r.description,
          available_uses: r.available_uses,
          pricing_options: [
            {
              pricing_option_id: r.pricing_option_id,
              model: 'cpm',
              price: r.price,
              currency: r.currency,
              uses: r.available_uses,
            },
          ],
        })),
      };
    },

    acquireRights: async (req: AcquireRightsRequest, ctx): Promise<AcquireRightsAcquired | AcquireRightsRejected> => {
      const tenant = getTenant(ctx);
      const offering = tenant.rights.get(req.rights_id);
      if (!offering) {
        throw new AdcpError('REFERENCE_NOT_FOUND', {
          message: `Unknown rights offering: ${req.rights_id}`,
          field: 'rights_id',
        });
      }
      if (req.pricing_option_id !== offering.pricing_option_id) {
        throw new AdcpError('INVALID_REQUEST', {
          message: `Unknown pricing_option_id: ${req.pricing_option_id}`,
          field: 'pricing_option_id',
        });
      }
      // Spec: brand agents MUST reject with INVALID_REQUEST (field:
      // campaign.end_date) when end_date is in the past — acquiring
      // rights for an elapsed window produces a zero-duration grant.
      // See acquire-rights-request.json campaign.end_date description.
      if (req.campaign.end_date && Date.parse(req.campaign.end_date) < Date.now()) {
        throw new AdcpError('INVALID_REQUEST', {
          message: `campaign.end_date '${req.campaign.end_date}' is in the past — rights cannot be acquired for an elapsed window.`,
          field: 'campaign.end_date',
        });
      }
      // Validation seam: when an explicit governance binding exists for
      // this brand, projecting CPM spend will need `estimated_impressions`.
      // Hoisted from `enforceGovernance` so the request-validation MUSTs
      // sit at the boundary rather than nested under enforcement logic.
      // Spec wording (acquire-rights-request.json:64) MUSTs this only
      // under intent-phase `governance_context` + CPM; the broader gate
      // here is conservative — when this adapter holds a registered
      // binding, projecting spend without impressions silently grants
      // under-priced rights. Tighten if your offerings are mixed-pricing
      // or your governance flow uses `governance_context` tokens.
      const hasBinding = tenant.governanceBindings.has(req.buyer.domain);
      if (hasBinding && (req.campaign.estimated_impressions == null || req.campaign.estimated_impressions <= 0)) {
        throw new AdcpError('INVALID_REQUEST', {
          message:
            'campaign.estimated_impressions is required when acquiring CPM-priced rights under a registered governance plan.',
          field: 'campaign.estimated_impressions',
        });
      }
      const denial = await this.enforceGovernance(tenant, ctx, offering, req);
      if (denial) return denial;
      const offered = new Set(offering.available_uses);
      const unsupported = req.campaign.uses.filter(u => !offered.has(u));
      if (unsupported.length > 0) {
        return {
          rights_id: offering.rights_id,
          status: 'rejected',
          brand_id: offering.brand_id,
          reason: `Requested uses [${unsupported.join(', ')}] are not covered by offering ${offering.rights_id}.`,
          suggestions: [`This offering covers: ${offering.available_uses.join(', ')}.`],
        };
      }
      // Real adopters persist the grant here — payment record, rights
      // ledger entry, audit row. The hello adapter doesn't expose a
      // read tool over the grant ledger so we skip the write. Add
      // tenant-scoped persistence when wiring a real backend.
      return {
        rights_id: offering.rights_id,
        status: 'acquired',
        brand_id: offering.brand_id,
        terms: {
          pricing_option_id: offering.pricing_option_id,
          amount: offering.price,
          currency: offering.currency,
          uses: req.campaign.uses,
          ...(req.campaign.start_date && { start_date: req.campaign.start_date }),
          ...(req.campaign.end_date && { end_date: req.campaign.end_date }),
        },
        generation_credentials: [],
        rights_constraint: {
          rights_id: offering.rights_id,
          rights_agent: { url: `http://127.0.0.1:${PORT}/mcp`, id: 'hello-multi-tenant-adapter' },
          uses: req.campaign.uses,
          ...(req.campaign.start_date && { valid_from: toDateTime(req.campaign.start_date, 'start') }),
          ...(req.campaign.end_date && { valid_until: toDateTime(req.campaign.end_date, 'end') }),
        },
      };
    },
  });

  /**
   * Cross-specialism governance check. Called from `acquireRights` after
   * the validation seam has already enforced `estimated_impressions` for
   * binding-aware paths. Returns `AcquireRightsRejected` on denial,
   * `null` otherwise (no binding, approved, or conditions — rights flow
   * proceeds either way).
   *
   * **Same-tenant invariant**: this method dispatches `checkGovernance`
   * via `this.campaignGovernance` and forwards the same `ctx`. Both
   * specialisms share `getTenant(ctx)` here by construction (single
   * adapter instance, single tenant resolved per request). If a future
   * deployment splits brand-rights and governance into different tenants
   * — or registers a remote governance agent and dials out via the
   * @adcp/sdk client — this in-process short-circuit no longer applies
   * and the assumption needs revisiting.
   *
   * **⚠️  DO NOT copy this into a single-specialism brand-rights agent.**
   * Without a co-resident `campaignGovernance` handler, the in-process
   * call has nothing to dispatch to. Single-specialism adopters must
   * dial out to the registered governance agent's URL via the
   * @adcp/sdk client instead, supplying the credentials persisted
   * during `sync_governance` (this adapter drops them — see
   * `syncGovernanceHandler`).
   *
   * Uses `ctx.account` (framework-resolved tenant account) — never
   * re-parses operator/brand from the request body, since that would
   * skip the framework's auth-derived tenant resolution.
   */
  private async enforceGovernance(
    tenant: TenantState,
    ctx: RequestContext<Account<TenantMeta>>,
    offering: RightsRecord,
    req: AcquireRightsRequest
  ): Promise<AcquireRightsRejected | null> {
    // `acquire_rights` carries `buyer: BrandReference` (not an `account`
    // field — see AcquireRightsRequest schema). Bindings are keyed by
    // brand_domain inside the tenant so we look up against
    // `req.buyer.domain`. Tenant scoping is upstream: `getTenant(ctx)`
    // narrowed by auth-derived account before we got here.
    //
    // Limitation: keying solely on brand_domain means two buyers from
    // different operators within the same tenant targeting the same
    // brand will share a binding. Filed as adcontextprotocol/adcp#3918
    // (add `account: AccountReference` to AcquireRightsRequest); until
    // that lands, this is a hello-adapter scoping shortcut, not a
    // production-grade resolution.
    const brandDomain = req.buyer?.domain;
    if (!brandDomain) return null;
    const binding = tenant.governanceBindings.get(brandDomain);
    if (!binding?.active_plan_id) return null;
    const planId = binding.active_plan_id;
    if (!tenant.plans.has(planId)) return null;

    // `estimated_impressions` is enforced at the validation seam in
    // `acquireRights` before we get here — this is just the projection.
    const estimatedSpend = (offering.price * req.campaign.estimated_impressions!) / 1000;

    const govResp = await this.campaignGovernance.checkGovernance(
      {
        plan_id: planId,
        caller: `http://127.0.0.1:${PORT}/mcp`,
        tool: 'acquire_rights',
        purchase_type: 'rights_license',
        payload: { total_budget: estimatedSpend },
      },
      ctx
    );
    if (govResp.status !== 'denied') return null;

    // Spec-correct denial shape: `AcquireRightsRejected` with `reason`
    // (and optional `suggestions`). Don't echo the buyer-controlled
    // `governance_agent_url` from the binding — adopters who copied
    // that into the response shipped a small prompt-injection vector
    // (URL planted by one buyer surfaced to another). Forensic detail
    // belongs in server-side logs, not the buyer envelope.
    return {
      rights_id: offering.rights_id,
      status: 'rejected',
      brand_id: offering.brand_id,
      reason: `Denied by governance plan ${planId}: ${govResp.explanation}`,
      ...(govResp.findings &&
        govResp.findings.length > 0 && {
          suggestions: govResp.findings.map(f => `[${f.severity}] ${f.category_id}: ${f.explanation}`),
        }),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(
  tenantId: string,
  tenant: TenantState,
  operator: string,
  brandDomain?: string
): Account<TenantMeta> {
  return {
    id: tenantId,
    name: `${tenant.display_name} (${operator})`,
    status: 'active',
    operator,
    ...(brandDomain && { brand: { domain: brandDomain } }),
    ctx_metadata: { tenant_id: tenantId, display_name: tenant.display_name },
    // NOTE(adopter): replace with your real sandbox flag from backing store.
    sandbox: true,
  };
}

function resolveFromBuyer(ctx: ResolveContext | undefined): Account<TenantMeta> | null {
  const buyer = ctx?.agent;
  if (!buyer) return null;
  const tenantId = BUYER_HOME_TENANT.get(buyer.agent_url);
  if (!tenantId) return null;
  const tenant = TENANTS.get(tenantId);
  if (!tenant) return null;
  // Synthetic operator string — this account is auth-derived, no
  // operator domain on the wire. Using `buyer.agent_url` as the
  // pseudo-operator keeps account.id stable across requests from the
  // same buyer agent.
  return {
    id: tenantId,
    name: `${tenant.display_name} (auth-derived for ${buyer.display_name})`,
    status: 'active',
    operator: buyer.agent_url,
    ctx_metadata: { tenant_id: tenantId, display_name: tenant.display_name },
    sandbox: true,
  };
}

function toDateTime(value: string, edge: 'start' | 'end'): string {
  if (/T/.test(value)) return value;
  return `${value}T${edge === 'start' ? '00:00:00.000Z' : '23:59:59.999Z'}`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new MultiTenantAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-multi-tenant',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<TenantMeta> | undefined;
        return acct?.id ?? 'anonymous';
      },
    }),
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: {
        [PINNACLE_HARNESS_TOKEN]: { principal: 'compliance-runner@pinnacle' },
        [PINNACLE_DEMO_TOKEN]: { principal: 'demo-buyer@pinnacle' },
        [MERIDIAN_DEMO_TOKEN]: { principal: 'demo-buyer@meridian' },
      },
    }),
  }
);

console.log(`multi-tenant adapter on http://127.0.0.1:${PORT}/mcp`);
console.log(`  tenants: ${Array.from(TENANTS.keys()).join(', ')}`);
console.log(`  operators: ${Array.from(OPERATOR_TO_TENANT.keys()).join(', ')}`);
console.log(`  credentials (3 = 1 harness pinned for storyboards + 2 demo buyers, one per tenant):`);
console.log(`    ${PINNACLE_HARNESS_TOKEN} → tenant_pinnacle (storyboard runner)`);
console.log(`    ${PINNACLE_DEMO_TOKEN} → tenant_pinnacle`);
console.log(`    ${MERIDIAN_DEMO_TOKEN} → tenant_meridian`);
