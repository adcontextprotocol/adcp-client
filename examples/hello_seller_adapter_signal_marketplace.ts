/**
 * Worked example: signal-marketplace ADAPTER agent.
 *
 * What this is
 * ============
 * A complete v6 typed-platform AdCP signals agent that wraps an upstream
 * signal-marketplace platform via HTTP. It demonstrates the end-to-end
 * shape of a signals adapter:
 *
 *   - Resolve the AdCP-side `account.operator` to the upstream's
 *     X-Operator-Id at runtime (no hardcoded mappings).
 *   - Translate `get_signals` into upstream `GET /v2/cohorts`.
 *   - Translate `activate_signal` into upstream
 *     `GET /v2/cohorts/{id}` + `GET /v2/destinations` + `POST /v2/activations`.
 *   - Use the v6 typed-platform path (`createAdcpServerFromPlatform` +
 *     `defineSignalsPlatform`) so handlers are fully typed.
 *
 * Why this exists
 * ===============
 * Every seller agent is an adapter — even ones whose "upstream" is internal
 * infrastructure are translating AdCP wire calls into backend calls. Reading
 * the spec + skill and synthesizing a correct agent from scratch is hard;
 * empirically (from blind LLM-built adapters in our SDK dogfood) most first-
 * pass attempts had at least one missing field, missing error code, or
 * misshapen response that cascaded through the storyboard.
 *
 * This file is the starting point. Fork it, swap UpstreamClient's HTTP
 * target for your real backend client, and validate continuously with the
 * published mock-server fixture as you swap.
 *
 * Run (full demo against the published mock fixture)
 * ==================================================
 *   # In one shell — boot the mock signal-marketplace
 *   npx @adcp/sdk@latest mock-server signal-marketplace --port 4150
 *
 *   # In another — run this adapter pointed at the mock
 *   UPSTREAM_URL=http://127.0.0.1:4150 \
 *     npx tsx examples/hello_seller_adapter_signal_marketplace.ts
 *
 * Run (production mode — connect to your real backend)
 * ====================================================
 *   UPSTREAM_URL=https://my-platform.example/api \
 *   UPSTREAM_API_KEY=$REAL_KEY \
 *     npx tsx examples/hello_seller_adapter_signal_marketplace.ts
 *
 * Validate it
 * ===========
 *   # Storyboard — wire-shape conformance
 *   adcp storyboard run http://127.0.0.1:3001/mcp signal_marketplace \
 *     --auth sk_harness_do_not_use_in_prod --json
 *
 *   # Traffic — façade resistance (after the storyboard run)
 *   curl http://127.0.0.1:4150/_debug/traffic
 *
 * Where to swap when wiring to your real backend
 * ==============================================
 * Search this file for `// SWAP:` markers. Each marks a place that assumes
 * the upstream is HTTP-shaped exactly like the published mock. Replace those
 * implementations with calls to your real backend's HTTP/SDK client. The
 * AdCP-facing shape (everything below the SWAP markers, in the platform
 * methods) stays the same.
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  memoryBackend,
  AdcpError,
  defineSignalsPlatform,
  type DecisioningPlatform,
  type SignalsPlatform,
  type AccountStore,
  type Account,
} from '@adcp/sdk/server';
import type {
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalSuccess,
} from '@adcp/sdk/types';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Config — env-driven, sensible defaults for the demo
// ---------------------------------------------------------------------------

const UPSTREAM_URL = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:4150';
/** Static bearer for the upstream. The published mock-server's default key
 *  is `mock_signal_market_key_do_not_use_in_prod` — override via env in
 *  production. The mock-server prints its accepted key on boot. */
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY ?? 'mock_signal_market_key_do_not_use_in_prod';
const PORT = Number(process.env.PORT ?? 3001);
/** Static bearer the AdCP client (buyer) presents. Compliance harnesses
 *  use this token to grade the agent. */
const ADCP_AUTH_TOKEN = process.env.ADCP_AUTH_TOKEN ?? 'sk_harness_do_not_use_in_prod';

// ---------------------------------------------------------------------------
// Upstream HTTP client — SWAP this whole class to wire a real backend
// ---------------------------------------------------------------------------

interface UpstreamCohort {
  cohort_id: string;
  name: string;
  description: string;
  category: string;
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
  name: string;
  platform_type: 'dsp' | 'ssp' | 'social' | 'ctv' | 'retail' | 'agent';
  integration: 'api_push' | 'segment_id' | 'key_value' | 'agent_url';
  platform_code?: string;
  agent_url?: string;
}

interface UpstreamActivation {
  activation_id: string;
  cohort_id: string;
  destination_id: string;
  status: 'pending' | 'active' | 'failed';
  /** Platform destinations: the platform-native segment ID, populated when
   *  status transitions to `active`. */
  segment_id?: string;
  /** Agent destinations: the SA-side activation key. The mock exposes this
   *  as `{ agent_segment: <string> }`. */
  agent_activation_key?: { agent_segment?: string };
}

class UpstreamClient {
  // SWAP: replace the constructor / connection setup with your real client's
  // bootstrap. Keep the method shapes — every platform method below depends
  // on these signatures.
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  // SWAP: replace with your backend's tenant-resolution lookup. The mock
  // exposes this at `GET /_lookup/operator?adcp_operator=<value>`; production
  // platforms typically have a configuration registry or directory service.
  async lookupOperator(adcpOperator: string): Promise<string | null> {
    const url = `${this.baseUrl}/_lookup/operator?adcp_operator=${encodeURIComponent(adcpOperator)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`upstream lookupOperator ${res.status}`);
    const body = (await res.json()) as { operator_id?: string };
    return body.operator_id ?? null;
  }

  // SWAP: replace with your backend's signal/cohort listing. The optional
  // `q` is a free-text filter; map it to your search index.
  async listCohorts(operatorId: string, q?: string): Promise<UpstreamCohort[]> {
    const url = new URL(`${this.baseUrl}/v2/cohorts`);
    if (q) url.searchParams.set('q', q);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'X-Operator-Id': operatorId },
    });
    if (!res.ok) throw new Error(`upstream listCohorts ${res.status}`);
    const body = (await res.json()) as { cohorts: UpstreamCohort[] };
    return body.cohorts;
  }

  // SWAP: single-cohort lookup by ID.
  async getCohort(operatorId: string, cohortId: string): Promise<UpstreamCohort | null> {
    const url = `${this.baseUrl}/v2/cohorts/${encodeURIComponent(cohortId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'X-Operator-Id': operatorId },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`upstream getCohort ${res.status}`);
    return (await res.json()) as UpstreamCohort;
  }

  // SWAP: list destinations the operator can activate to.
  async listDestinations(operatorId: string): Promise<UpstreamDestination[]> {
    const res = await fetch(`${this.baseUrl}/v2/destinations`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'X-Operator-Id': operatorId },
    });
    if (!res.ok) throw new Error(`upstream listDestinations ${res.status}`);
    const body = (await res.json()) as { destinations: UpstreamDestination[] };
    return body.destinations;
  }

  // SWAP: post an activation for one (cohort, destination) pair.
  async activate(
    operatorId: string,
    payload: { cohort_id: string; destination_id: string; pricing_id: string; client_request_id: string },
  ): Promise<UpstreamActivation> {
    const res = await fetch(`${this.baseUrl}/v2/activations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'X-Operator-Id': operatorId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 404) throw new AdcpError('SIGNAL_NOT_FOUND', { message: 'cohort or destination not found' });
    if (res.status === 403) throw new AdcpError('PERMISSION_DENIED', { message: 'operator not permitted' });
    if (!res.ok) throw new Error(`upstream activate ${res.status}`);
    return (await res.json()) as UpstreamActivation;
  }
}

// ---------------------------------------------------------------------------
// AdCP-side adapter — typed against SignalsPlatform; no SWAPs needed below
// ---------------------------------------------------------------------------

interface OperatorMeta {
  /** Resolved upstream tenant ID, cached on the Account by `accounts.resolve`. */
  operator_id: string;
  [key: string]: unknown;
}

const upstream = new UpstreamClient(UPSTREAM_URL, UPSTREAM_API_KEY);

/** Map an upstream cohort to the AdCP `Signal` wire shape. The storyboard
 *  validator extracts `signal_agent_segment_id`, `signal_id.{source,
 *  data_provider_domain, id}`, `pricing_options[]`, and
 *  `coverage_percentage` from each entry — every field below is required. */
function toAdcpSignal(c: UpstreamCohort): GetSignalsResponse['signals'][number] {
  const coverage = c.total_universe > 0 ? Math.round((c.member_count / c.total_universe) * 100) : 0;
  return {
    signal_agent_segment_id: c.cohort_id,
    signal_id: {
      source: 'catalog' as const,
      data_provider_domain: c.data_provider_domain,
      id: c.data_provider_id,
    },
    name: c.name,
    description: c.description,
    value_type: c.value_type,
    signal_type: 'marketplace' as const,
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
    /** Translate AdCP `account.operator` → upstream operator_id. Cache on
     *  the Account so handlers read from `ctx.account.ctx_metadata.operator_id`
     *  instead of looking up on every call. */
    resolve: async ref => {
      const adcpOperator = (ref as { operator?: string }).operator;
      if (!adcpOperator) return null;
      const operatorId = await upstream.lookupOperator(adcpOperator);
      if (!operatorId) return null;
      return {
        id: operatorId,
        name: adcpOperator,
        status: 'active' as const,
        operator: adcpOperator,
        ctx_metadata: { operator_id: operatorId },
      } satisfies Account<OperatorMeta>;
    },
  };

  signals: SignalsPlatform<OperatorMeta> = defineSignalsPlatform<OperatorMeta>({
    getSignals: async (req, ctx) => {
      const operatorId = ctx.account.ctx_metadata.operator_id;
      // The AdCP `signal_spec` is a semantic brief ("In-market EV buyers
      // near auto dealerships"). A real semantic-search backend understands
      // it; substring matching does not. We fetch the full catalog and let
      // the buyer's `signal_ids` filter narrow it client-side. Production
      // adapters with a real semantic-search index should pass `signal_spec`
      // into that index instead.
      const cohorts = await upstream.listCohorts(operatorId);
      const filtered = cohorts.filter(c => {
        if (Array.isArray(req.signal_ids) && req.signal_ids.length > 0) {
          // `signal_ids` is `signal_id[]` — an array of provenance tuples
          // `{ source, data_provider_domain, id }`, NOT bare strings. The
          // schema description (`/schemas/.../core/signal-id.json`) is the
          // authoritative shape. Match against the data-provider's id
          // because that's what the upstream cohort exposes.
          return req.signal_ids.some(
            sid => sid.data_provider_domain === c.data_provider_domain && sid.id === c.data_provider_id,
          );
        }
        return true;
      });
      const signals = filtered.map(toAdcpSignal);
      return { signals } satisfies GetSignalsResponse;
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

      const pricingId =
        req.pricing_option_id ??
        cohort.pricing[0]?.pricing_id;
      if (!pricingId) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'pricing_option_id is required and signal has no default pricing',
          field: 'pricing_option_id',
        });
      }

      const idempotency = req.idempotency_key ?? randomUUID();

      const deployments = await Promise.all(
        req.destinations.map(async (dest, i) => {
          let upstreamDest: UpstreamDestination | undefined;
          if (dest.type === 'platform') {
            upstreamDest = upstreamDests.find(
              d => d.platform_type !== 'agent' && d.platform_code === dest.platform,
            );
          } else {
            upstreamDest = upstreamDests.find(
              d => d.platform_type === 'agent' && d.agent_url === dest.agent_url,
            );
          }
          if (!upstreamDest) {
            throw new AdcpError('INVALID_REQUEST', {
              message: `No upstream destination matches ${
                dest.type === 'platform' ? dest.platform : dest.agent_url
              }`,
              field: 'destinations',
            });
          }

          const activation = await upstream.activate(operatorId, {
            cohort_id: cohort.cohort_id,
            destination_id: upstreamDest.destination_id,
            pricing_id: pricingId,
            client_request_id: `${idempotency}.${i}`,
          });

          if (dest.type === 'agent') {
            return {
              type: 'agent' as const,
              agent_url: dest.agent_url!,
              is_live: true,
              // ActivationKey is a oneOf — `type: 'key_value'` puts `key`
              // and `value` at the TOP level of the activation_key object,
              // NOT nested under a `key_value` field. `value` MUST be a
              // string. See /schemas/3.0.1/core/activation-key.json.
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
            platform: dest.platform!,
            is_live: false,
            activation_key: {
              type: 'segment_id' as const,
              segment_id: activation.segment_id ?? activation.activation_id,
            },
            estimated_activation_duration_minutes: 30,
          };
        }),
      );

      return { deployments } satisfies ActivateSignalSuccess;
    },
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new SignalMarketplaceAdapter();

const idempotencyStore = createIdempotencyStore({
  backend: memoryBackend(),
  ttlSeconds: 86_400,
});

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-signal-marketplace',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => ctx.account?.id ?? 'anonymous',
    }),
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'compliance-runner' } },
    }),
  },
);

console.log(`AdCP signals adapter on http://127.0.0.1:${PORT}/mcp`);
console.log(`Wrapping upstream: ${UPSTREAM_URL}`);
console.log(`Auth (buyer side): Bearer ${ADCP_AUTH_TOKEN}`);
console.log('');
console.log('To validate end-to-end:');
console.log(`  adcp storyboard run http://127.0.0.1:${PORT}/mcp signal_marketplace --auth ${ADCP_AUTH_TOKEN}`);
console.log(`  curl ${UPSTREAM_URL}/_debug/traffic`);
