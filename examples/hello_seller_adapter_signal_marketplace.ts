/**
 * hello_seller_adapter_signal_marketplace — worked starting point for an
 * AdCP signals adapter that wraps an upstream signal-marketplace platform.
 *
 * Fork this. Replace `UpstreamClient` with your real backend's HTTP/SDK
 * client. The AdCP-facing platform methods stay the same.
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server signal-marketplace --port 4150
 *   UPSTREAM_URL=http://127.0.0.1:4150 \
 *     npx tsx examples/hello_seller_adapter_signal_marketplace.ts
 *   adcp storyboard run http://127.0.0.1:3001/mcp signal_marketplace \
 *     --auth sk_harness_do_not_use_in_prod
 *   curl http://127.0.0.1:4150/_debug/traffic
 *
 * Production:
 *   UPSTREAM_URL=https://my-platform.example/api UPSTREAM_API_KEY=… \
 *     npx tsx examples/hello_seller_adapter_signal_marketplace.ts
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  createUpstreamHttpClient,
  memoryBackend,
  AdcpError,
  defineSignalsPlatform,
  type DecisioningPlatform,
  type SignalsPlatform,
  type AccountStore,
  type Account,
} from '@adcp/sdk/server';
import type { GetSignalsResponse, ActivateSignalRequest, ActivateSignalSuccess } from '@adcp/sdk/types';
import { randomUUID } from 'node:crypto';

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4150';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_signal_market_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3001);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';

// ---------------------------------------------------------------------------
// Upstream client — SWAP for production.
// `createUpstreamHttpClient` from @adcp/sdk/server handles auth injection,
// 404→null, and JSON parse. Five typed wrappers below are the seams to
// swap when wiring to your real backend.
// ---------------------------------------------------------------------------

interface UpstreamCohort {
  cohort_id: string;
  name: string;
  description: string;
  member_count: number;
  total_universe: number;
  data_provider_domain: string;
  data_provider_id: string;
  data_provider_name: string;
  value_type: 'binary' | 'numeric' | 'categorical';
  range?: { min: number; max: number };
  categories?: string[];
  pricing: Array<{ pricing_id: string; model: 'cpm'; cpm_amount: number; currency: string }>;
}
interface UpstreamDestination {
  destination_id: string;
  platform_type: 'dsp' | 'ssp' | 'social' | 'ctv' | 'retail' | 'agent';
  platform_code?: string;
  agent_url?: string;
}
interface UpstreamActivation {
  activation_id: string;
  segment_id?: string;
  /** Mock returns `{ agent_segment: <string> }` — production platforms vary. */
  agent_activation_key?: { agent_segment?: string };
}

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'static_bearer', token: UPSTREAM_API_KEY },
});

const tenantHeader = (operatorId: string) => ({ 'X-Operator-Id': operatorId });

const upstream = {
  // SWAP: tenant lookup. Mock exposes /_lookup; production typically a
  // directory service or config registry.
  async lookupOperator(adcpOperator: string): Promise<string | null> {
    const { body } = await http.get<{ operator_id?: string }>('/_lookup/operator', {
      adcp_operator: adcpOperator,
    });
    return body?.operator_id ?? null;
  },

  // SWAP: catalog list.
  async listCohorts(operatorId: string): Promise<UpstreamCohort[]> {
    const { body } = await http.get<{ cohorts: UpstreamCohort[] }>(
      '/v2/cohorts',
      undefined,
      tenantHeader(operatorId)
    );
    return body?.cohorts ?? [];
  },

  // SWAP: single cohort.
  async getCohort(operatorId: string, cohortId: string): Promise<UpstreamCohort | null> {
    const { body } = await http.get<UpstreamCohort>(
      `/v2/cohorts/${encodeURIComponent(cohortId)}`,
      undefined,
      tenantHeader(operatorId)
    );
    return body;
  },

  // SWAP: destinations available to this operator.
  async listDestinations(operatorId: string): Promise<UpstreamDestination[]> {
    const { body } = await http.get<{ destinations: UpstreamDestination[] }>(
      '/v2/destinations',
      undefined,
      tenantHeader(operatorId)
    );
    return body?.destinations ?? [];
  },

  // SWAP: post an activation.
  async activate(
    operatorId: string,
    body: { cohort_id: string; destination_id: string; pricing_id: string; client_request_id: string }
  ): Promise<UpstreamActivation> {
    const r = await http.post<UpstreamActivation>('/v2/activations', body, tenantHeader(operatorId));
    if (r.body === null) {
      throw new AdcpError('SIGNAL_NOT_FOUND', { message: 'cohort or destination not found' });
    }
    return r.body;
  },
};

// ---------------------------------------------------------------------------
// AdCP-side adapter — typed against SignalsPlatform.
// ---------------------------------------------------------------------------

interface OperatorMeta {
  /** Resolved upstream tenant id, cached on the Account by accounts.resolve. */
  operator_id: string;
  [key: string]: unknown;
}

function toAdcpSignal(c: UpstreamCohort): GetSignalsResponse['signals'][number] {
  const coverage = c.total_universe > 0 ? Math.round((c.member_count / c.total_universe) * 100) : 0;
  return {
    signal_agent_segment_id: c.cohort_id,
    signal_id: {
      source: 'catalog',
      data_provider_domain: c.data_provider_domain,
      id: c.data_provider_id,
    },
    name: c.name,
    description: c.description,
    value_type: c.value_type,
    signal_type: 'marketplace',
    data_provider: c.data_provider_name,
    coverage_percentage: coverage,
    deployments: [],
    pricing_options: c.pricing.map(p => ({
      pricing_option_id: p.pricing_id,
      model: p.model,
      currency: p.currency,
      cpm: p.cpm_amount,
    })),
    ...(c.range ? { range: c.range } : {}),
    ...(c.categories ? { categories: c.categories } : {}),
  };
}

class SignalMarketplaceAdapter implements DecisioningPlatform<Record<string, never>, OperatorMeta> {
  capabilities = {
    specialisms: ['signal-marketplace'] as const,
    config: {},
  };

  accounts: AccountStore<OperatorMeta> = {
    /** Translate AdCP `account.operator` → upstream `operator_id`, cache on
     *  the Account so handlers read from `ctx.account.ctx_metadata`. */
    resolve: async ref => {
      const adcpOperator = (ref as { operator?: string })?.operator;
      if (!adcpOperator) return null;
      const operatorId = await upstream.lookupOperator(adcpOperator);
      if (!operatorId) return null;
      return {
        id: operatorId,
        name: adcpOperator,
        status: 'active',
        operator: adcpOperator,
        ctx_metadata: { operator_id: operatorId },
      };
    },
  };

  signals: SignalsPlatform<OperatorMeta> = defineSignalsPlatform<OperatorMeta>({
    getSignals: async (req, ctx) => {
      const operatorId = ctx.account.ctx_metadata.operator_id;
      // `signal_spec` is a semantic brief, not a substring keyword. A real
      // semantic-search backend would consume it; the published mock does
      // literal substring filtering on /v2/cohorts?q=. Fetch the full
      // catalog and filter client-side via signal_ids.
      const cohorts = await upstream.listCohorts(operatorId);
      const filtered = cohorts.filter(c => {
        if (!Array.isArray(req.signal_ids) || req.signal_ids.length === 0) return true;
        // signal_ids is signal_id[] — provenance objects, not strings.
        // Narrow on the catalog variant before reading data_provider_domain.
        // See skills/SHAPE-GOTCHAS.md §2.
        return req.signal_ids.some(
          sid =>
            sid.source === 'catalog' &&
            sid.data_provider_domain === c.data_provider_domain &&
            sid.id === c.data_provider_id
        );
      });
      return { signals: filtered.map(toAdcpSignal) } satisfies GetSignalsResponse;
    },

    activateSignal: async (req: ActivateSignalRequest, ctx): Promise<ActivateSignalSuccess> => {
      const operatorId = ctx.account.ctx_metadata.operator_id;
      const cohortId = req.signal_agent_segment_id;
      const cohort = await upstream.getCohort(operatorId, cohortId);
      if (!cohort) {
        throw new AdcpError('SIGNAL_NOT_FOUND', {
          message: `Unknown signal: ${cohortId}`,
          field: 'signal_agent_segment_id',
        });
      }
      const upstreamDests = await upstream.listDestinations(operatorId);
      const pricingId = req.pricing_option_id ?? cohort.pricing[0]?.pricing_id;
      if (!pricingId) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'pricing_option_id required and no default pricing on signal',
          field: 'pricing_option_id',
        });
      }
      const idempotency = req.idempotency_key ?? randomUUID();

      const deployments = await Promise.all(
        req.destinations.map(async (dest, i) => {
          const matched =
            dest.type === 'platform'
              ? upstreamDests.find(d => d.platform_type !== 'agent' && d.platform_code === dest.platform)
              : upstreamDests.find(d => d.platform_type === 'agent' && d.agent_url === dest.agent_url);
          if (!matched) {
            const target = dest.type === 'platform' ? dest.platform : dest.agent_url;
            throw new AdcpError('INVALID_REQUEST', {
              message: `No upstream destination matches ${target}`,
              field: 'destinations',
            });
          }
          const activation = await upstream.activate(operatorId, {
            cohort_id: cohort.cohort_id,
            destination_id: matched.destination_id,
            pricing_id: pricingId,
            client_request_id: `${idempotency}.${i}`,
          });
          if (dest.type === 'agent') {
            // ActivationKey oneOf — for `type: 'key_value'`, `key` and `value`
            // sit at the TOP level (not nested under a `key_value` field).
            // `value` MUST be string. See skills/SHAPE-GOTCHAS.md §1.
            return {
              type: 'agent' as const,
              agent_url: dest.agent_url,
              is_live: true,
              activation_key: {
                type: 'key_value' as const,
                key: 'agent_segment',
                value: activation.agent_activation_key?.agent_segment ?? activation.activation_id,
              },
              deployed_at: new Date().toISOString(),
            };
          }
          return {
            type: 'platform' as const,
            platform: dest.platform,
            is_live: false,
            activation_key: {
              type: 'segment_id' as const,
              segment_id: activation.segment_id ?? activation.activation_id,
            },
            estimated_activation_duration_minutes: 30,
          };
        })
      );
      return { deployments } satisfies ActivateSignalSuccess;
    },
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new SignalMarketplaceAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-signal-marketplace',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        // ctx.account is typed as Account<OperatorMeta> | undefined here.
        const acct = ctx.account as Account<OperatorMeta> | undefined;
        return acct?.id ?? 'anonymous';
      },
    }),
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'compliance-runner' } },
    }),
  }
);

console.log(`signals adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
