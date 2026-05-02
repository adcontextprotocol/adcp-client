/**
 * hello_seller_adapter_brand — worked starting point for an AdCP brand-rights
 * adapter exposing `get_brand_identity`, `get_rights`, and `acquire_rights`.
 *
 * Fork this. Replace the in-memory Maps with your real brand / rights
 * database. The AdCP-facing platform methods stay the same.
 *
 * Demo:
 *   npx tsx examples/hello_seller_adapter_brand.ts
 *   adcp storyboard run http://127.0.0.1:3005/mcp brand_rights \
 *     --auth sk_harness_do_not_use_in_prod
 *
 * Production:
 *   ADCP_AUTH_TOKEN=<your-token> PORT=3005 \
 *     npx tsx examples/hello_seller_adapter_brand.ts
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  memoryBackend,
  AdcpError,
  BuyerAgentRegistry,
  defineBrandRightsPlatform,
  checkGovernance,
  type DecisioningPlatform,
  type BrandRightsPlatform,
  type AccountStore,
  type Account,
  type BuyerAgent,
  type CachedBuyerAgentRegistry,
  type GetBrandIdentitySuccess,
  type GetRightsSuccess,
  type AcquireRightsAcquired,
} from '@adcp/sdk/server';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env['PORT'] ?? 3005);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';
const AGENT_URL = process.env['AGENT_URL'] ?? `http://127.0.0.1:${PORT}/mcp`;

// ---------------------------------------------------------------------------
// Brand catalog — SWAP: replace with your brand registry DB query.
// ---------------------------------------------------------------------------

const BRAND_ID = 'acme_outdoor';
const BRAND_DOMAIN = 'acme.example';

const BRAND_IDENTITY: GetBrandIdentitySuccess = {
  brand_id: BRAND_ID,
  house: { domain: BRAND_DOMAIN, name: 'Acme Corporation' },
  names: [{ en_US: 'Acme Outdoor' }, { en: 'Acme Outdoor' }],
  logos: [
    {
      url: 'https://cdn.acme.example/logo-primary.svg',
      orientation: 'horizontal',
      background: 'transparent-bg', // enum: 'dark-bg' | 'light-bg' | 'transparent-bg'
      variant: 'primary',
      width: 512,
      height: 128,
    },
  ],
  tone: { voice: 'Confident, outdoorsy, direct.' },
};

// ---------------------------------------------------------------------------
// Rights catalog — SWAP: replace with your rights management DB query.
// ---------------------------------------------------------------------------

const RIGHTS_CATALOG = [
  {
    rights_id: 'img_gen_standard',
    brand_id: BRAND_ID,
    name: 'AI image generation — standard',
    available_uses: ['ai_generated_image', 'commercial'] as const,
    pricing_options: [
      {
        pricing_option_id: 'monthly_standard',
        model: 'flat_rate' as const,
        price: 2500,
        currency: 'USD',
        uses: ['ai_generated_image', 'commercial'] as const,
        period: 'monthly',
      },
    ],
  },
  {
    rights_id: 'logo_placement',
    brand_id: BRAND_ID,
    name: 'Logo placement — standard',
    available_uses: ['commercial'] as const,
    pricing_options: [
      {
        pricing_option_id: 'monthly_logo',
        model: 'flat_rate' as const,
        price: 1000,
        currency: 'USD',
        uses: ['commercial'] as const,
        period: 'monthly',
      },
    ],
  },
] satisfies GetRightsSuccess['rights'];

// ---------------------------------------------------------------------------
// In-memory stores — SWAP: replace with your DB at each `// SWAP:` site.
// ---------------------------------------------------------------------------

/**
 * governance_agents per `brand.domain:operator` key, populated by
 * `sync_governance`. SWAP: replace with a DB write.
 */
const governanceStore = new Map<string, Array<{ url: string; id?: string }>>();

/**
 * Active rights grants keyed by grantId. Used to persist
 * `revocation_webhook` so you can call it on revocation.
 * SWAP: replace with a DB write.
 */
const grantStore = new Map<
  string,
  {
    rights_id: string;
    revocation_webhook: { url: string; authentication?: { schemes?: string[]; credentials?: string } };
  }
>();

// ---------------------------------------------------------------------------
// Buyer-agent registry — SWAP: replace with your onboarding ledger DB query.
// ---------------------------------------------------------------------------

/**
 * Compute the `credential.key_id` that `verifyApiKey` stamps.
 * Store this hash (NOT the raw token) in your onboarding ledger.
 */
function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

const ONBOARDING_LEDGER = new Map<string, BuyerAgent>([
  [
    hashApiKey(ADCP_AUTH_TOKEN),
    {
      agent_url: 'https://addie.example.com',
      display_name: 'Addie (storyboard runner)',
      status: 'active',
      billing_capabilities: new Set(['operator']),
      sandbox_only: true, // test-agent default — framework rejects non-sandbox accounts
    },
  ],
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
// Platform
// ---------------------------------------------------------------------------

interface BrandMeta {
  brand_domain: string;
  operator: string;
}

class BrandRightsAdapter implements DecisioningPlatform<Record<string, never>, BrandMeta> {
  capabilities = {
    specialisms: ['brand-rights'] as const,
    config: {} as Record<string, never>,
    brand: { rights: true as const },
  };

  agentRegistry = agentRegistry;

  accounts: AccountStore<BrandMeta> = {
    /**
     * Brand-rights references carry `brand.domain` AND `operator` — both
     * required. Guard for either absent (unlike the signals adapter which
     * checks `ref.operator` alone). SWAP: look up brand in your registry.
     */
    resolve: async ref => {
      const brandDomain = (ref as { brand?: { domain?: string } })?.brand?.domain;
      const operator = (ref as { operator?: string })?.operator;
      if (!brandDomain || brandDomain !== BRAND_DOMAIN) return null;
      const accountId = `${brandDomain}:${operator ?? 'unknown'}`;
      return {
        id: accountId,
        name: `${BRAND_IDENTITY.house.name} via ${operator ?? 'unknown'}`,
        status: 'active',
        brand: { domain: brandDomain },
        operator: operator ?? 'unknown',
        ctx_metadata: { brand_domain: brandDomain, operator: operator ?? 'unknown' },
        sandbox: true, // FIXME(adopter): replace with real sandbox flag from backing store
      };
    },
  };

  brandRights: BrandRightsPlatform<BrandMeta> = defineBrandRightsPlatform<BrandMeta>({
    getBrandIdentity: async req => {
      if (req.brand_id !== BRAND_ID) {
        throw new AdcpError('REFERENCE_NOT_FOUND', {
          message: `Brand ${req.brand_id} is not managed by this agent`,
        });
      }
      // SWAP: query your brand registry by brand_id.
      return BRAND_IDENTITY;
    },

    getRights: async req => {
      const filtered = RIGHTS_CATALOG.filter(r => {
        if (req.brand_id && req.brand_id !== r.brand_id) return false;
        if (Array.isArray(req.uses) && req.uses.length > 0) {
          return req.uses.some(u => (r.available_uses as readonly string[]).includes(u));
        }
        return true;
      });
      // SWAP: query your rights management system by brand_id + available_uses.
      return { rights: filtered } satisfies GetRightsSuccess;
    },

    acquireRights: async (req, ctx) => {
      // Governance check — required so the `governance_denied` storyboard
      // scenario fires. SWAP: thread the resolved governance_context through
      // subsequent lifecycle calls when your plan model requires continuity.
      const accountKey = `${ctx.account.ctx_metadata.brand_domain}:${ctx.account.ctx_metadata.operator}`;
      const govAgents = governanceStore.get(accountKey);
      if (govAgents?.length) {
        // AcquireRightsRequest has no plan_id; use rights_id as the governance
        // plan identifier — adequate for storyboard validation. SWAP: thread
        // the real plan_id from your campaign state if your governance agent
        // requires continuity across lifecycle checks.
        const gov = await checkGovernance({
          agentUrl: govAgents[0].url,
          planId: req.rights_id,
          caller: AGENT_URL,
          tool: 'acquire_rights',
          payload: { rights_id: req.rights_id, pricing_option_id: req.pricing_option_id },
        });
        if (gov.approved !== true) {
          throw new AdcpError('GOVERNANCE_DENIED', {
            message: gov.explanation,
          });
        }
      }

      // Campaign expiry pre-flight — reject before allocating any state.
      if (req.campaign?.end_date && new Date(req.campaign.end_date) < new Date()) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'Campaign end_date is in the past',
          field: 'campaign.end_date',
        });
      }

      // SWAP: look up rights and pricing in your DB.
      const right = RIGHTS_CATALOG.find(r => r.rights_id === req.rights_id);
      if (!right) {
        throw new AdcpError('REFERENCE_NOT_FOUND', {
          message: `Rights ${req.rights_id} not available for brand ${BRAND_ID}`,
          field: 'rights_id',
        });
      }
      const pricingOption =
        right.pricing_options.find(
          p => !req.pricing_option_id || p.pricing_option_id === req.pricing_option_id
        ) ?? right.pricing_options[0];

      const grantId = `grant_${Date.now()}_${randomUUID().slice(0, 8)}`;

      // Persist revocation_webhook so you can call it on credential rotation
      // or brand takedown. SWAP: persist to DB keyed by grantId.
      grantStore.set(grantId, {
        rights_id: req.rights_id,
        revocation_webhook: req.revocation_webhook as {
          url: string;
          authentication?: { schemes?: string[]; credentials?: string };
        },
      });

      return {
        rights_id: req.rights_id,
        status: 'acquired',
        brand_id: BRAND_ID,
        terms: {
          pricing_option_id: pricingOption.pricing_option_id, // required
          amount: pricingOption.price,                        // required
          currency: pricingOption.currency,                    // required
          uses: [...pricingOption.uses],                       // required
          period: pricingOption.period,
          // exclusivity is an object { scope, countries }, NOT a string.
          exclusivity: { scope: 'non_exclusive', countries: ['US', 'CA'] },
        },
        generation_credentials: [
          // At least one credential so the acquired arm is semantically valid.
          // SWAP: return real scoped credentials from your LLM provider integration.
          {
            provider: 'stub',
            rights_key: `${grantId}.gen`,
            uses: [...pricingOption.uses],
          },
        ],
        rights_constraint: {
          rights_id: req.rights_id,              // required — NOT brand_id
          rights_agent: { url: AGENT_URL, id: BRAND_ID }, // required — {url, id}
          uses: [...pricingOption.uses],           // required
        },
        // URL your agent hosts — buyer POSTs creative-approval-request there.
        // credentials MUST be ≥32 chars (spec: push-notification-config.json).
        approval_webhook: {
          url: `${AGENT_URL.replace('/mcp', '')}/webhooks/approval/${grantId}`,
          authentication: {
            schemes: ['Bearer'],
            credentials: randomUUID().replace(/-/g, ''), // 32-char hex token
          },
        },
      } satisfies AcquireRightsAcquired;
    },
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new BrandRightsAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-brand',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        // Brand-rights account key is composite: brand.domain + operator.
        const acct = ctx.account as Account<BrandMeta> | undefined;
        return acct
          ? `${acct.ctx_metadata.brand_domain}:${acct.ctx_metadata.operator}`
          : 'anonymous';
      },
      // sync_accounts + sync_governance are not yet part of AccountStore in v6;
      // pass them via the escape hatch so the governance_denied storyboard works.
      accounts: {
        syncAccounts: async params => {
          // SWAP: upsert accounts in your DB.
          const accounts = (params.accounts ?? []) as Array<{
            brand?: { domain?: string };
            operator?: string;
          }>;
          return {
            accounts: accounts.map(a => ({
              brand: a.brand as { domain: string },
              operator: a.operator ?? '',
              account_id: `${a.brand?.domain}:${a.operator}`,
              status: 'active' as const,
              action: 'created' as const,
            })),
          };
        },
        syncGovernance: async params => {
          // SWAP: persist governance agent URLs to your DB.
          const accs = (params.accounts ?? []) as Array<{
            account?: { brand?: { domain?: string }; operator?: string };
            governance_agents?: Array<{ url: string; id?: string }>;
          }>;
          for (const acc of accs) {
            const key = `${acc.account?.brand?.domain}:${acc.account?.operator}`;
            governanceStore.set(key, acc.governance_agents ?? []);
          }
          return {
            status: 'synced' as const,
            governance_agents: accs.flatMap(a => a.governance_agents ?? []) as Array<{
              url: string;
              id?: string;
            }>,
          };
        },
      },
    }),
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'compliance-runner' } },
    }),
  }
);

console.log(`brand-rights adapter on http://127.0.0.1:${PORT}/mcp`);
