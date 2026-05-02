/**
 * hello_seller_adapter_governance — worked starting point for an AdCP
 * governance agent managing campaign spend authority and property lists.
 *
 * Fork this. Replace the in-memory Maps with your real backend storage.
 * The AdCP-facing platform methods stay the same.
 *
 * Unlike the signals adapter (which wraps an upstream HTTP backend),
 * governance state is owned by the agent itself — there is no upstream HTTP
 * seam to wire. SWAP the Maps below for `ctx.store` (with pgBackend) in
 * production to get persistence across restarts and multi-instance safety.
 *
 * Demo (no upstream backend needed):
 *   ADCP_SANDBOX=1 npx tsx examples/hello_seller_adapter_governance.ts
 *   adcp storyboard run http://127.0.0.1:3003/mcp governance_spend_authority \
 *     --auth sk_harness_do_not_use_in_prod
 *   adcp storyboard run http://127.0.0.1:3003/mcp property_lists \
 *     --auth sk_harness_do_not_use_in_prod
 *
 * Production:
 *   ADCP_AUTH_TOKEN=<real-token> \
 *     npx tsx examples/hello_seller_adapter_governance.ts
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
  type DecisioningPlatform,
  type CampaignGovernancePlatform,
  type PropertyListsPlatform,
  type AccountStore,
  type Account,
  type BuyerAgent,
  type CachedBuyerAgentRegistry,
} from '@adcp/sdk/server';
import { createComplyController } from '@adcp/sdk/testing';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env['PORT'] ?? 3003);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';

// ---------------------------------------------------------------------------
// In-memory state — SWAP for production.
//
// Governance state is owned by the agent; production implementations persist
// via `ctx.store` (backed by pgBackend or equivalent) rather than
// process-global Maps so state survives restarts and scales across instances.
//
// Maps work here because `comply_test_controller` seed functions run in a
// separate request context from governance handlers and cannot share
// `ctx.store`. For production, move seeding to an admin endpoint instead.
// ---------------------------------------------------------------------------

interface GovernancePlan {
  plan_id: string;
  budget: {
    total: number;
    currency: string;
    reallocation_threshold?: number;
    reallocation_unlimited?: boolean;
  };
  human_review_required?: boolean;
  custom_policies?: Array<{ policy_id: string; enforcement: 'must' | 'should'; policy: string }>;
  [key: string]: unknown;
}

interface PropertyListRecord {
  list_id: string;
  name: string;
  description?: string;
  list_type?: string;
  auth_token: string;
}

interface AuditEntry {
  timestamp: string;
  action: string;
  actor: string;
}

const plans = new Map<string, GovernancePlan>();
const propertyLists = new Map<string, PropertyListRecord>();
const auditLogs = new Map<string, AuditEntry[]>();
const committedBudgets = new Map<string, number>();

// ---------------------------------------------------------------------------
// Buyer-agent registry — every governance agent needs one.
//
// Same pattern as hello_seller_adapter_signal_marketplace.ts.
// SWAP: replace the in-memory ledger with your onboarding-ledger DB query.
// ---------------------------------------------------------------------------

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
      // Storyboard runner is test-only — sandbox_only: true bounds blast
      // radius if this token leaks. Production agents leave this unset.
      sandbox_only: true,
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
// Governance adapter — typed against DecisioningPlatform.
// ---------------------------------------------------------------------------

class GovernanceAdapter implements DecisioningPlatform<Record<string, never>> {
  capabilities = {
    specialisms: ['governance-spend-authority', 'property-lists'] as const,
    config: {},
  };

  agentRegistry = agentRegistry;

  accounts: AccountStore<Record<string, never>> = {
    // Governance agents resolve account from plan_id — no separate account
    // reference needed. Return a stable synthetic account for the demo.
    // SWAP: resolve from your tenant registry if you manage multiple buyers.
    resolve: async ref => {
      const id = ref && 'account_id' in ref ? String((ref as { account_id: unknown }).account_id) : 'gov_default';
      return {
        id,
        operator: 'governance',
        status: 'active' as const,
        ctx_metadata: {},
        sandbox: true, // FIXME(adopter): replace with real sandbox flag from backing store
      };
    },
  };

  campaignGovernance: CampaignGovernancePlatform<Record<string, never>> = defineCampaignGovernancePlatform({
    syncPlans: async req => {
      for (const plan of req.plans) {
        plans.set(plan.plan_id, plan as unknown as GovernancePlan);
        if (!auditLogs.has(plan.plan_id)) auditLogs.set(plan.plan_id, []);
        auditLogs.get(plan.plan_id)!.push({
          timestamp: new Date().toISOString(),
          action: 'sync_plan',
          actor: 'buyer',
        });
      }
      return {
        plans: req.plans.map(p => ({
          plan_id: p.plan_id,
          status: 'active' as const,
          version: 1,
        })),
      };
    },

    checkGovernance: async req => {
      const plan = plans.get(req.plan_id);
      if (!plan) {
        throw new AdcpError('PLAN_NOT_FOUND', {
          message: `Plan ${req.plan_id} not found — call sync_plans first`,
        });
      }

      const checkId = `chk_${randomUUID()}`;
      const payload = (req.payload ?? {}) as Record<string, unknown>;
      const budgetField = payload['total_budget'] as { amount?: number } | undefined;
      const requestedBudget = budgetField?.amount ?? 0;

      const planTotal = plan.budget?.total ?? Infinity;
      const committed = committedBudgets.get(req.plan_id) ?? 0;
      const remaining = planTotal - committed;

      const appendAudit = (action: string) =>
        auditLogs.get(req.plan_id)?.push({
          timestamp: new Date().toISOString(),
          action,
          actor: 'governance_agent',
        });

      if (plan.human_review_required) {
        appendAudit('check_governance:denied:human_review_required');
        return {
          check_id: checkId,
          status: 'denied' as const,
          plan_id: req.plan_id,
          explanation: 'Human review required per plan policy',
          findings: [
            {
              category_id: 'human_review',
              severity: 'critical' as const,
              explanation: 'Plan requires human sign-off before any authorization',
            },
          ],
        };
      }

      if (requestedBudget > remaining) {
        appendAudit('check_governance:denied:budget_exceeded');
        return {
          check_id: checkId,
          status: 'denied' as const,
          plan_id: req.plan_id,
          explanation: `Requested ${requestedBudget} exceeds remaining authority ${remaining}`,
          findings: [
            {
              category_id: 'budget_exceeded',
              severity: 'critical' as const,
              explanation: `Total committed ${committed + requestedBudget} would exceed plan total ${planTotal}`,
            },
          ],
        };
      }

      // Approve with conditions when spend is approaching the plan ceiling.
      // SWAP: implement your real policy evaluation here (channel restrictions,
      // custom_policies[], delivery-phase drift thresholds, etc.).
      if (requestedBudget > remaining * 0.8) {
        appendAudit('check_governance:conditions:near_ceiling');
        return {
          check_id: checkId,
          status: 'conditions' as const,
          plan_id: req.plan_id,
          explanation: 'Approved with conditions — spend approaching plan ceiling',
          // FIXME(adopter): AdCP 3.0 GA requires governance_context to be a compact
          // JWS (sign with your server key). A plain string will be rejected by
          // conformant buyers. See AdCP spec §governance_context.
          governance_context: `plan:${req.plan_id}:check:${checkId}`,
          findings: [
            {
              category_id: 'near_ceiling',
              severity: 'warning' as const,
              explanation: 'Spend exceeds 80% of remaining authority',
            },
          ],
          conditions: [
            {
              field: 'packages[0].reporting_frequency',
              reason: 'Spend exceeds 80% of remaining authority — weekly pacing report required',
              required_value: 'weekly',
            },
          ],
        };
      }

      appendAudit('check_governance:approved');
      return {
        check_id: checkId,
        status: 'approved' as const,
        plan_id: req.plan_id,
        explanation: 'Within spending authority',
        // FIXME(adopter): AdCP 3.0 GA requires governance_context to be a compact
        // JWS (sign with your server key). A plain string will be rejected by
        // conformant buyers. See AdCP spec §governance_context.
        governance_context: `plan:${req.plan_id}:check:${checkId}`,
      };
    },

    reportPlanOutcome: async req => {
      // committed_budget lives under seller_response, not at the top level.
      const amount = req.seller_response?.committed_budget;
      if (amount != null) {
        committedBudgets.set(req.plan_id, (committedBudgets.get(req.plan_id) ?? 0) + amount);
      }
      auditLogs.get(req.plan_id)?.push({
        timestamp: new Date().toISOString(),
        action: `outcome:${req.outcome ?? 'unknown'}`,
        actor: 'seller',
      });
      return { outcome_id: `out_${randomUUID()}`, status: 'accepted' as const };
    },

    getPlanAuditLogs: async req => {
      const planIds = req.plan_ids ?? [];
      return {
        plans: planIds.map(id => {
          const plan = plans.get(id);
          const committed = committedBudgets.get(id) ?? 0;
          const authorized = plan?.budget?.total ?? 0;
          const entries = auditLogs.get(id) ?? [];
          return {
            plan_id: id,
            plan_version: 1,
            status: 'active' as const,
            budget: {
              authorized,
              committed,
              remaining: Math.max(0, authorized - committed),
            },
            summary: {
              checks_performed: entries.filter(e => e.action.startsWith('check_governance')).length,
              outcomes_reported: entries.filter(e => e.action.startsWith('outcome')).length,
            },
          };
        }),
      };
    },
  });

  propertyLists: PropertyListsPlatform<Record<string, never>> = definePropertyListsPlatform({
    createPropertyList: async req => {
      const list_id = `pl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const auth_token = `plat_${randomUUID().replace(/-/g, '')}`;
      const record: PropertyListRecord = {
        list_id,
        name: req.name,
        description: (req as unknown as Record<string, string | undefined>)['description'],
        auth_token,
      };
      propertyLists.set(list_id, record);
      return {
        list: {
          list_id,
          name: req.name,
          description: record.description ?? '',
          property_count: 0,
        },
        auth_token,
      };
    },

    updatePropertyList: async req => {
      const record = propertyLists.get(req.list_id);
      if (!record) {
        throw new AdcpError('REFERENCE_NOT_FOUND', { message: `Property list ${req.list_id} not found` });
      }
      const newName = (req as unknown as Record<string, string | undefined>)['name'];
      if (newName) record.name = newName;
      return { list: { list_id: record.list_id, name: record.name } };
    },

    getPropertyList: async req => {
      const record = propertyLists.get(req.list_id);
      if (!record) {
        throw new AdcpError('REFERENCE_NOT_FOUND', { message: `Property list ${req.list_id} not found` });
      }
      return { list: { list_id: record.list_id, name: record.name } };
    },

    listPropertyLists: async () => ({
      lists: Array.from(propertyLists.values()).map(r => ({ list_id: r.list_id, name: r.name })),
    }),

    deletePropertyList: async req => {
      if (!propertyLists.has(req.list_id)) {
        throw new AdcpError('REFERENCE_NOT_FOUND', { message: `Property list ${req.list_id} not found` });
      }
      propertyLists.delete(req.list_id);
      return { deleted: true as const, list_id: req.list_id };
    },
  });
}

// ---------------------------------------------------------------------------
// Comply controller — seeds governance fixtures for storyboard runs.
//
// `seed.plan` writes into the same process-global Map that `checkGovernance`
// reads from, so the storyboard runner can seed a plan then immediately
// exercise governance checks against it.
//
// Import path: `@adcp/sdk/testing` (separate subpath — not `@adcp/sdk/server`).
// Sandbox gate example: set ADCP_SANDBOX=1 when running storyboard tests.
// Production deployments should not register the controller at all.
// ---------------------------------------------------------------------------

const controller = createComplyController({
  sandboxGate: () => process.env['ADCP_SANDBOX'] === '1',
  seed: {
    plan: ({ plan_id, fixture }) => {
      plans.set(plan_id, { plan_id, ...fixture } as GovernancePlan);
      auditLogs.set(plan_id, []);
    },
  },
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new GovernanceAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

serve(
  ({ taskStore }) => {
    const adcpServer = createAdcpServerFromPlatform(platform, {
      name: 'hello-governance-adapter',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<Record<string, never>> | undefined;
        return acct?.id ?? 'anonymous';
      },
    });
    controller.register(adcpServer);
    return adcpServer;
  },
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'compliance-runner' } },
    }),
  }
);

console.log(`governance adapter on http://127.0.0.1:${PORT}/mcp`);
