/**
 * hello_seller_adapter_guaranteed — worked starting point for an AdCP
 * sales-guaranteed seller adapter wrapping a GAM-style upstream.
 *
 * Fork this. Replace `UpstreamClient` with your real backend's HTTP/SDK
 * client. The AdCP-facing platform methods stay the same.
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server sales-guaranteed --port 4503  # keep running
 *   UPSTREAM_URL=http://127.0.0.1:4503 \
 *     npx tsx examples/hello_seller_adapter_guaranteed.ts
 *   adcp storyboard run http://127.0.0.1:3001/mcp sales_guaranteed \
 *     --auth sk_harness_do_not_use_in_prod
 *   curl http://127.0.0.1:4503/_debug/traffic  # verify upstream was hit
 *
 * Production:
 *   UPSTREAM_URL=https://my-gam.example/api UPSTREAM_API_KEY=… \
 *     npx tsx examples/hello_seller_adapter_guaranteed.ts
 *
 * Note: specialism ID is `sales-guaranteed` (kebab-case); the storyboard
 * runner CLI arg uses `sales_guaranteed` (snake_case). Same concept, two
 * forms — see CLAUDE.md "Naming conventions".
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  createUpstreamHttpClient,
  memoryBackend,
  AdcpError,
  BuyerAgentRegistry,
  DEFAULT_REPORTING_CAPABILITIES,
  type DecisioningPlatform,
  type SalesCorePlatform,
  type SalesIngestionPlatform,
  type AccountStore,
  type Account,
  type BuyerAgent,
  type CachedBuyerAgentRegistry,
  registerTestController,
} from '@adcp/sdk/server';
import type {
  GetProductsRequest,
  GetProductsResponse,
  CreateMediaBuyRequest,
  CreateMediaBuySuccess,
  UpdateMediaBuyRequest,
  UpdateMediaBuySuccess,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  CreativeAsset,
  AccountReference,
} from '@adcp/sdk/types';
import { createUpstreamRecorder, toQueryUpstreamTrafficResponse } from '@adcp/sdk/upstream-recorder';
import { createHash, randomUUID } from 'node:crypto';

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4503';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_sales_guaranteed_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3001);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';

// ---------------------------------------------------------------------------
// Upstream types — shapes returned by the GAM-style upstream HTTP API.
// SWAP: replace with your backend SDK's types or auto-generated OpenAPI types.
// ---------------------------------------------------------------------------

interface UpstreamNetwork {
  network_code: string;
  display_name: string;
  adcp_publisher: string;
}

interface UpstreamProduct {
  product_id: string;
  name: string;
  delivery_type: 'guaranteed' | 'non_guaranteed';
  channel: 'video' | 'ctv' | 'display' | 'audio';
  format_ids: string[];
  ad_unit_ids: string[];
  pricing: { model: 'cpm' | 'cpv'; cpm: number; currency: string; min_spend?: number };
  availability?: { start_date?: string; end_date?: string; available_impressions?: number };
  forecast?: UpstreamForecast;
}

interface UpstreamForecast {
  method: string;
  currency: string;
  forecast_range_unit?: string;
  generated_at?: string;
  points: Array<{
    budget?: number;
    metrics: {
      impressions?: { low?: number; mid?: number; high?: number };
      spend?: { mid?: number };
    };
  }>;
}

interface UpstreamOrder {
  order_id: string;
  name: string;
  status: string;
  advertiser_id: string;
  currency: string;
  budget: number;
  approval_task_id?: string;
  rejection_reason?: string;
  created_at: string;
  updated_at: string;
}

interface UpstreamTask {
  task_id: string;
  order_id: string;
  status: 'submitted' | 'working' | 'completed' | 'rejected';
  result?: { outcome: 'approved' | 'rejected'; reviewer_note: string };
}

interface UpstreamCreative {
  creative_id: string;
  name: string;
  format_id: string;
  advertiser_id: string;
  status: 'active' | 'paused' | 'archived';
}

interface UpstreamDelivery {
  order_id: string;
  currency: string;
  reporting_period: { start: string; end: string };
  totals: {
    impressions: number;
    clicks: number;
    spend: number;
    viewable_impressions: number;
    video_completions: number;
    conversions: number;
  };
  line_item_breakdown: Array<{ line_item_id: string; impressions: number; spend: number }>;
}

// ---------------------------------------------------------------------------
// Upstream HTTP client — SWAP the base URL and auth for production.
// ---------------------------------------------------------------------------

const recorder = createUpstreamRecorder({
  enabled: process.env['NODE_ENV'] !== 'production',
  strict: process.env['ADCP_RECORDER_STRICT'] === '1',
});

const RECORDER_PRINCIPAL = 'compliance-runner';

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'static_bearer', token: UPSTREAM_API_KEY },
  fetch: recorder.wrapFetch(fetch),
});

const networkHeader = (networkCode: string) => ({ 'X-Network-Code': networkCode });

const upstream = {
  // SWAP: resolve AdCP publisher domain → upstream network code.
  async lookupNetwork(adcpPublisher: string): Promise<UpstreamNetwork | null> {
    const { body } = await http.get<UpstreamNetwork>('/_lookup/network', { adcp_publisher: adcpPublisher });
    return body;
  },

  // SWAP: product catalog. Pass start_date/end_date to get per-product
  // availability forecasts inline — one round-trip instead of N per product.
  async listProducts(
    networkCode: string,
    opts: { delivery_type?: string; start_date?: string; end_date?: string } = {}
  ): Promise<UpstreamProduct[]> {
    const query: Record<string, string> = {};
    if (opts.delivery_type) query['delivery_type'] = opts.delivery_type;
    if (opts.start_date) query['start_date'] = opts.start_date;
    if (opts.end_date) query['end_date'] = opts.end_date;
    const { body } = await http.get<{ products: UpstreamProduct[] }>('/v1/products', query, networkHeader(networkCode));
    return body?.products ?? [];
  },

  // SWAP: create order. Returns order_id + approval_task_id for HITL polling.
  async createOrder(
    networkCode: string,
    payload: { name: string; advertiser_id: string; currency: string; budget: number; client_request_id?: string }
  ): Promise<UpstreamOrder> {
    const r = await http.post<UpstreamOrder>('/v1/orders', payload, networkHeader(networkCode));
    if (!r.body) throw new AdcpError('SERVICE_UNAVAILABLE', { message: 'Failed to create order.' });
    return r.body;
  },

  // SWAP: poll approval task.
  async getTask(networkCode: string, taskId: string): Promise<UpstreamTask | null> {
    const { body } = await http.get<UpstreamTask>(`/v1/tasks/${encodeURIComponent(taskId)}`, undefined, networkHeader(networkCode));
    return body;
  },

  // SWAP: create creative.
  async createCreative(
    networkCode: string,
    payload: { name: string; format_id: string; advertiser_id: string; snippet?: string; client_request_id?: string }
  ): Promise<UpstreamCreative> {
    const r = await http.post<UpstreamCreative>('/v1/creatives', payload, networkHeader(networkCode));
    if (!r.body) throw new AdcpError('SERVICE_UNAVAILABLE', { message: 'Failed to create creative.' });
    return r.body;
  },

  // SWAP: delivery report for an order.
  async getDelivery(networkCode: string, orderId: string): Promise<UpstreamDelivery | null> {
    const { body } = await http.get<UpstreamDelivery>(
      `/v1/orders/${encodeURIComponent(orderId)}/delivery`,
      undefined,
      networkHeader(networkCode)
    );
    return body;
  },
};

// ---------------------------------------------------------------------------
// Buyer-agent registry — SWAP the in-memory map for a DB query in production.
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
// AdCP adapter — typed against SalesCorePlatform + SalesIngestionPlatform.
// ---------------------------------------------------------------------------

interface NetworkMeta {
  /** Resolved upstream network code for this AdCP account. */
  network_code: string;
  [key: string]: unknown;
}

/** Project an upstream product onto AdCP Product shape. */
function toAdcpProduct(p: UpstreamProduct, publisherDomain: string): GetProductsResponse['products'][number] {
  return {
    product_id: p.product_id,
    name: p.name,
    delivery_type: p.delivery_type,
    // The upstream uses string format IDs; AdCP wraps them as structured objects.
    format_ids: p.format_ids.map(id => ({ id })),
    publisher_properties: [{ publisher_domain: publisherDomain, selection_type: 'all' as const }],
    pricing_options: [
      {
        pricing_option_id: `${p.product_id}_${p.pricing.model}`,
        pricing_model: p.pricing.model,
        fixed_price: p.pricing.cpm,
        currency: p.pricing.currency,
        ...(p.pricing.min_spend !== undefined && { min_budget: p.pricing.min_spend }),
      },
    ],
    reporting_capabilities: {
      ...DEFAULT_REPORTING_CAPABILITIES,
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 60,
    },
    // Map upstream forecast when present (populated by GET /v1/products?start_date=&end_date=).
    // Explicit field mapping: method, currency, forecast_range_unit, generated_at, points.
    // valid_until is intentionally omitted — the mock does not emit it.
    // SWAP: add `...(p.forecast.valid_until && { valid_until: p.forecast.valid_until })` if
    // your upstream returns an expiry timestamp.
    ...(p.forecast && {
      forecast: {
        method: p.forecast.method as 'estimate' | 'modeled' | 'guaranteed',
        currency: p.forecast.currency,
        // All eight ForecastRangeUnit values are valid; cast from string.
        ...(p.forecast.forecast_range_unit && {
          forecast_range_unit: p.forecast.forecast_range_unit as
            | 'spend' | 'availability' | 'reach_freq' | 'weekly'
            | 'daily' | 'clicks' | 'conversions' | 'package',
        }),
        ...(p.forecast.generated_at && { generated_at: p.forecast.generated_at }),
        points: p.forecast.points.map(pt => ({
          ...(pt.budget !== undefined && { budget: pt.budget }),
          metrics: {
            ...(pt.metrics.impressions && { impressions: pt.metrics.impressions }),
            ...(pt.metrics.spend && { spend: pt.metrics.spend }),
          },
        })),
      },
    }),
  };
}

class GuaranteedSellerAdapter implements DecisioningPlatform<Record<string, never>, NetworkMeta> {
  capabilities = {
    specialisms: ['sales-guaranteed'] as const,
    channels: ['video', 'ctv', 'display', 'audio'] as const,
    pricingModels: ['cpm'] as const,
    config: {},
  };

  statusMappers = {};
  agentRegistry = agentRegistry;

  accounts: AccountStore<NetworkMeta> = {
    resolve: async (ref: AccountReference, ctx) => {
      const adcpPublisher = (ref as { publisher?: string })?.publisher;
      if (!adcpPublisher) return null;
      void ctx; // ctx.agent available for buyer-agent gating
      const network = await upstream.lookupNetwork(adcpPublisher);
      if (!network) return null;
      return {
        id: network.network_code,
        name: network.display_name,
        status: 'active',
        operator: adcpPublisher,
        ctx_metadata: { network_code: network.network_code },
        sandbox: true, // TODO(adopter): replace with real sandbox flag from your backing store
      };
    },
  };

  sales: SalesCorePlatform<NetworkMeta> & Pick<SalesIngestionPlatform<NetworkMeta>, 'syncCreatives'> = {
    // --------------------------------------------------------------------
    // get_products — one upstream call. Pass flight dates from AdCP filters
    // so the upstream returns per-product availability forecasts inline,
    // eliminating the need for N per-product forecast calls.
    // --------------------------------------------------------------------
    getProducts: (req: GetProductsRequest, ctx): Promise<GetProductsResponse> =>
      recorder.runWithPrincipal(RECORDER_PRINCIPAL, async () => {
        const networkCode = ctx.account.ctx_metadata.network_code;
        const publisherDomain = ctx.account.operator ?? '';
        const products = await upstream.listProducts(networkCode, {
          delivery_type: 'guaranteed',
          // req.filters.start_date / end_date map to the upstream's date params.
          // When present, the upstream enriches each product with a forecast field.
          start_date: req.filters?.start_date,
          end_date: req.filters?.end_date,
        });
        return { products: products.map(p => toAdcpProduct(p, publisherDomain)) };
      }),

    // --------------------------------------------------------------------
    // create_media_buy — HITL path. Guaranteed inventory always requires IO
    // review before activation; ctx.handoffToTask handles the polling loop.
    // --------------------------------------------------------------------
    createMediaBuy: async (req: CreateMediaBuyRequest, ctx) => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const order = await upstream.createOrder(networkCode, {
        name: `adcp_${Date.now()}`,
        advertiser_id: ctx.account.id,
        // total_budget is { amount, currency } in AdCP 3.x; also accept legacy flat number.
        budget:
          typeof req.total_budget === 'number'
            ? req.total_budget
            : ((req.total_budget as { amount?: number })?.amount ?? 50_000),
        currency:
          typeof req.total_budget === 'object' && req.total_budget !== null
            ? ((req.total_budget as { currency?: string }).currency ?? 'USD')
            : 'USD',
        client_request_id: req.idempotency_key,
      });

      if (!order.approval_task_id) {
        // Order was auto-approved (possible on some platforms). Return sync.
        return {
          media_buy_id: order.order_id,
          status: 'active' as const,
          confirmed_at: new Date().toISOString(),
          packages: [],
        };
      }

      const taskId = order.approval_task_id;
      return ctx.handoffToTask(async () => {
        // Poll the approval task. The mock auto-advances in 2 polls;
        // real GAM / FreeWheel platforms take minutes to hours.
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise(r => setTimeout(r, 500));
          const task = await upstream.getTask(networkCode, taskId);
          if (!task) continue;
          if (task.status === 'completed' && task.result?.outcome === 'approved') {
            return {
              media_buy_id: order.order_id,
              status: 'active' as const,
              confirmed_at: new Date().toISOString(),
              packages: [],
            };
          }
          if (task.status === 'rejected') {
            throw new AdcpError('MEDIA_BUY_REJECTED', {
              recovery: 'terminal',
              message: task.result?.reviewer_note ?? 'Order rejected by IO review.',
            });
          }
        }
        throw new AdcpError('SERVICE_UNAVAILABLE', { message: 'Order approval timed out after 30 s.' });
      });
    },

    // --------------------------------------------------------------------
    // update_media_buy — pause/resume only for guaranteed inventory.
    // Complex line-item mutations (budget change, date shift) go through
    // a re-approval flow on the upstream (not modeled here).
    // --------------------------------------------------------------------
    updateMediaBuy: async (buyId: string, patch: UpdateMediaBuyRequest): Promise<UpdateMediaBuySuccess> => {
      // FIXME(adopter): PATCH /v1/orders/{orderId} and re-poll if re-approval is required.
      // Leaving this as a no-op stub means pauses and budget updates are silently ignored.
      void patch;
      return { media_buy_id: buyId, status: 'active' };
    },

    // --------------------------------------------------------------------
    // get_media_buys — return active orders for this account.
    // --------------------------------------------------------------------
    getMediaBuys: async (_req: GetMediaBuysRequest, ctx): Promise<GetMediaBuysResponse> => {
      // FIXME(adopter): GET /v1/orders?network_code=... and map to AdCP MediaBuy shape.
      // Leaving as empty stub means buyers always see zero active buys.
      void ctx;
      return { media_buys: [] };
    },

    // --------------------------------------------------------------------
    // get_media_buy_delivery — map upstream delivery report.
    // --------------------------------------------------------------------
    getMediaBuyDelivery: async (req: GetMediaBuyDeliveryRequest, ctx): Promise<GetMediaBuyDeliveryResponse> =>
      recorder.runWithPrincipal(RECORDER_PRINCIPAL, async () => {
        const networkCode = ctx.account.ctx_metadata.network_code;
        const delivery = await upstream.getDelivery(networkCode, req.media_buy_id);
        if (!delivery) {
          throw new AdcpError('MEDIA_BUY_NOT_FOUND', {
            message: `No delivery data for media buy ${req.media_buy_id}.`,
          });
        }
        return {
          currency: delivery.currency,
          reporting_period: {
            start: delivery.reporting_period.start,
            end: delivery.reporting_period.end,
          },
          media_buy_deliveries: [
            {
              media_buy_id: delivery.order_id,
              impressions: delivery.totals.impressions,
              clicks: delivery.totals.clicks,
              spend: delivery.totals.spend,
              viewable_impressions: delivery.totals.viewable_impressions,
              video_completions: delivery.totals.video_completions,
            },
          ],
        };
      }),

    // --------------------------------------------------------------------
    // sync_creatives — create or update creatives on the upstream.
    // --------------------------------------------------------------------
    syncCreatives: async (creatives: CreativeAsset[], ctx): Promise<{ creative_id: string; action: string; status: string }[]> =>
      recorder.runWithPrincipal(RECORDER_PRINCIPAL, async () => {
        const networkCode = ctx.account.ctx_metadata.network_code;
        return Promise.all(
          creatives.map(async c => {
            const asset = c as {
              creative_id?: string;
              name?: string;
              format_id?: { id?: string } | string;
              snippet?: string;
            };
            const formatId =
              typeof asset.format_id === 'string'
                ? asset.format_id
                : asset.format_id?.id ?? 'unknown';
            const result = await upstream.createCreative(networkCode, {
              name: asset.name ?? 'Untitled',
              format_id: formatId,
              advertiser_id: ctx.account.id,
              snippet: asset.snippet,
              client_request_id: randomUUID(),
            });
            // Video creatives require review on real GAM platforms;
            // mirror that here so buyers see the pending_review path.
            const needsReview = formatId.startsWith('video_');
            return {
              creative_id: result.creative_id,
              action: 'created',
              status: needsReview ? 'pending_review' : 'approved',
            };
          })
        );
      }),
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const platform = new GuaranteedSellerAdapter();
const idempotencyStore = createIdempotencyStore(memoryBackend());

serve(
  ({ taskStore }) => {
    const adcpServer = createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-guaranteed',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<NetworkMeta> | undefined;
        return acct?.id ?? 'anonymous';
      },
    });

    registerTestController(adcpServer, {
      queryUpstreamTraffic: async params => {
        const result = recorder.query({
          principal: RECORDER_PRINCIPAL,
          ...(params.since_timestamp !== undefined && { sinceTimestamp: params.since_timestamp }),
          ...(params.endpoint_pattern !== undefined && { endpointPattern: params.endpoint_pattern }),
          ...(params.limit !== undefined && { limit: params.limit }),
        });
        return toQueryUpstreamTrafficResponse(result);
      },
    });

    return adcpServer;
  },
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'compliance-runner' } },
    }),
  }
);

console.log(`guaranteed seller adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
