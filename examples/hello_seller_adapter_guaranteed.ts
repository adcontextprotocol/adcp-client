/**
 * hello_seller_adapter_guaranteed — worked starting point for an
 * AdCP guaranteed sales agent (specialism `sales-guaranteed`) that wraps
 * an upstream GAM-style ad-server with HITL IO approval over static Bearer.
 *
 * The headline behavior: `create_media_buy` returns an A2A task envelope
 * (`status: 'submitted'`), the upstream IO review runs in the background,
 * and the buyer receives the final `media_buy_id` either by polling
 * `tasks_get` or via the push_notification webhook. This is the
 * `ctx.handoffToTask(fn)` pattern in v6 typed platforms.
 *
 * Fork this. Replace `upstream` with calls to your real backend. The
 * AdCP-facing platform methods stay the same.
 *
 * FORK CHECKLIST
 *   1. Replace every `// SWAP:` marker with calls to your backend.
 *   2. Replace `KNOWN_PUBLISHERS` (line ~63) with your tenant directory
 *      (or remove and use your real `/networks/list` endpoint).
 *   3. Replace `projectProduct()` defaults — `publisher_properties` selector,
 *      `pricing_options[]`, `reporting_capabilities` — with values your
 *      seller actually commits to.
 *   4. Replace `aggressiveMeasurement` thresholds with your IO-team's
 *      committable maxima (viewability, completion-rate, etc.).
 *   5. Replace `advertiserId = networkCode` collapse with a real lookup
 *      (production splits network and advertiser ids).
 *   6. Replace the in-memory poll loop (`getTask`) with your IO-task
 *      backend; persist `(idempotency_key, lineitem_index) → upstream_lineitem_id`
 *      in your DB so a process restart can reconcile partial completion.
 *   7. Validate: `node --test test/examples/hello-seller-adapter-guaranteed.test.js`
 *   8. **DELETE the `// TEST-ONLY` blocks** before deploying:
 *      - sandbox-arm in `accounts.resolve` (resolves storyboard runner's
 *        synthetic `{brand, sandbox: true}` refs to a known network)
 *      - HITL bypass in `createMediaBuy` (the `if (isSandbox)` short-circuit)
 *      - `complyTest:` config block on `createAdcpServerFromPlatform`
 *      - in-memory `seededMediaBuys` / `simulatedDelivery` Maps
 *      These exist so the conformance harness can drive cascade scenarios
 *      deterministically. Production sellers ship without them.
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server sales-guaranteed --port 4450
 *   UPSTREAM_URL=http://127.0.0.1:4450 \
 *     npx tsx examples/hello_seller_adapter_guaranteed.ts
 *   adcp storyboard run http://127.0.0.1:3004/mcp sales_guaranteed \
 *     --auth sk_harness_do_not_use_in_prod
 *   curl http://127.0.0.1:4450/_debug/traffic
 */

import {
  createAdcpServerFromPlatform,
  createMediaBuyStore,
  InMemoryStateStore,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  createUpstreamHttpClient,
  memoryBackend,
  AdcpError,
  type DecisioningPlatform,
  type SalesCorePlatform,
  type SalesIngestionPlatform,
  type AccountStore,
  type Account,
  type SyncCreativesRow,
  type SyncAccountsResultRow,
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
} from '@adcp/sdk/types';

// `Product` isn't re-exported from `@adcp/sdk/types` (#1254 in the rollup);
// derive the shape from the response array.
type Product = GetProductsResponse['products'][number];

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4450';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_sales_guaranteed_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3004);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';
const PUBLIC_AGENT_URL = process.env['PUBLIC_AGENT_URL'] ?? `http://127.0.0.1:${PORT}`;

const KNOWN_PUBLISHERS = ['acmeoutdoor.example', 'pinnacle-agency.example', 'premium-sports.example'];

// SWAP: the seller's minimum committable max_variance_percent — the
// buyer-vs-seller billing-count delta this seller will tolerate before
// triggering resolution. 5% is industry typical for premium guaranteed
// inventory; your IO desk owns the real number.
const MIN_VARIANCE_TOLERANCE = 5;

// TEST-ONLY: id-prefix used by the sandbox arm in `accounts.resolve` so
// `createMediaBuy` can detect cascade-storyboard requests and bypass the
// HITL handoff. Production sellers don't need this; remove the sandbox
// arm + this constant before deploying. See FORK CHECKLIST item 8.
const SANDBOX_ID_PREFIX = 'sandbox_';

// ---------------------------------------------------------------------------
// Upstream client — SWAP for production.
// Each method maps one AdCP tool concern to one upstream call. Per-request
// `X-Network-Code` is injected via the `headers` parameter on each call —
// the mock requires it on every request after auth. Real GAM uses the same
// pattern (X-API-Network), as do most ad-server APIs.
// ---------------------------------------------------------------------------

interface UpstreamNetwork {
  network_code: string;
  display_name: string;
  adcp_publisher: string;
}

interface UpstreamProduct {
  product_id: string;
  name: string;
  network_code: string;
  delivery_type: 'guaranteed' | 'non_guaranteed';
  channel: 'video' | 'ctv' | 'display' | 'audio';
  format_ids: string[];
  ad_unit_ids: string[];
  pricing: { model: 'cpm' | 'cpv'; cpm: number; currency: string; min_spend?: number };
  availability?: { start_date?: string; end_date?: string; available_impressions?: number };
  /** Per-query forecast — present when GET /v1/products is called with
   * `targeting`/`flight_start`/`flight_end`/`budget` query params. Mirrors
   * AdCP `DeliveryForecast` field-for-field; pass through unchanged. */
  forecast?: UpstreamForecast;
}

interface UpstreamForecastRange {
  low?: number;
  mid?: number;
  high?: number;
  [k: string]: unknown;
}
interface UpstreamForecastPoint {
  label?: string;
  budget?: number;
  metrics: {
    impressions?: UpstreamForecastRange;
    reach?: UpstreamForecastRange;
    frequency?: UpstreamForecastRange;
    spend?: UpstreamForecastRange;
    [k: string]: UpstreamForecastRange | undefined;
  };
}
interface UpstreamForecast {
  points: UpstreamForecastPoint[];
  forecast_range_unit: 'spend' | 'availability';
  method: 'modeled' | 'guaranteed' | 'estimate';
  currency: string;
  generated_at?: string;
}

interface UpstreamOrder {
  order_id: string;
  network_code: string;
  name: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'delivering' | 'completed' | 'canceled' | 'rejected';
  advertiser_id: string;
  currency: string;
  budget?: number;
  approval_task_id?: string;
  rejection_reason?: string;
  /** Mock's GET /v1/orders/{id} omits line_items; fetch via
   * GET /v1/orders/{id}/lineitems separately. Real GAM splits the same
   * way (Order vs LineItem services). */
  line_items?: Array<{
    line_item_id: string;
    order_id: string;
    product_id: string;
    status: 'pending_creatives' | 'ready' | 'paused' | 'delivering' | 'completed';
    budget: number;
    creative_ids: string[];
  }>;
  created_at: string;
  updated_at: string;
}

interface UpstreamTask {
  task_id: string;
  order_id: string;
  status: 'submitted' | 'working' | 'completed' | 'rejected';
  result?: { outcome: 'approved' | 'rejected'; reviewer_note?: string };
}

interface UpstreamCreative {
  creative_id: string;
  network_code: string;
  name: string;
  format_id: string;
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
  line_item_breakdown?: Array<{ line_item_id: string; impressions: number; spend: number }>;
}

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'static_bearer', token: UPSTREAM_API_KEY },
});

const networkHeader = (networkCode: string) => ({ 'X-Network-Code': networkCode });

const upstream = {
  // SWAP: tenant lookup. Mock exposes /_lookup; production typically a
  // network registry / service-account scope endpoint.
  async lookupNetwork(publisherDomain: string): Promise<UpstreamNetwork | null> {
    const { body } = await http.get<UpstreamNetwork>('/_lookup/network', { adcp_publisher: publisherDomain });
    return body;
  },

  // SWAP: product catalog. Mock filters by network_code via header + optional
  // ?delivery_type. When `flight_start`/`flight_end`/`budget` are passed, the
  // mock returns per-product `forecast` inline — single round-trip instead of
  // N follow-up `/v1/forecast` calls. Real GAM exposes `/networks/{code}/products`
  // for the catalog and `forecastService.getDeliveryForecast` for forecast;
  // adopters whose backend doesn't fold forecast into the catalog response
  // call `getForecast` per product (or in parallel) below.
  async listProducts(
    networkCode: string,
    opts?: {
      deliveryType?: 'guaranteed' | 'non_guaranteed';
      flightStart?: string;
      flightEnd?: string;
      budget?: number;
    }
  ): Promise<UpstreamProduct[]> {
    const params: Record<string, string> = {};
    if (opts?.deliveryType) params['delivery_type'] = opts.deliveryType;
    if (opts?.flightStart) params['flight_start'] = opts.flightStart;
    if (opts?.flightEnd) params['flight_end'] = opts.flightEnd;
    if (opts?.budget !== undefined) params['budget'] = String(opts.budget);
    const { body } = await http.get<{ products: UpstreamProduct[] }>(
      '/v1/products',
      params,
      networkHeader(networkCode)
    );
    return body?.products ?? [];
  },

  // SWAP: per-product forecast. Use this when your backend separates the
  // catalog and forecast surfaces (typical for GAM's `forecastService` vs
  // `inventoryService`). For the worked-mock case we fold forecast into
  // `listProducts` above; this method shows the discrete shape.
  async getForecast(
    networkCode: string,
    body: {
      product_id: string;
      targeting?: Record<string, unknown>;
      flight_dates?: { start?: string; end?: string };
      budget?: number;
    }
  ): Promise<UpstreamForecast | null> {
    const r = await http.post<UpstreamForecast>('/v1/forecast', body, networkHeader(networkCode));
    return r.body;
  },

  // SWAP: list orders.
  async listOrders(networkCode: string): Promise<UpstreamOrder[]> {
    const { body } = await http.get<{ orders: UpstreamOrder[] }>('/v1/orders', undefined, networkHeader(networkCode));
    return body?.orders ?? [];
  },

  // SWAP: create order. Mock returns 201 with status='pending_approval' +
  // approval_task_id. Real platforms vary; GAM creates an Order in DRAFT
  // and IO signing is handled out-of-band.
  async createOrder(
    networkCode: string,
    body: { name: string; advertiser_id: string; currency: string; budget: number; client_request_id?: string }
  ): Promise<UpstreamOrder> {
    const r = await http.post<UpstreamOrder>('/v1/orders', body, networkHeader(networkCode));
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'order creation rejected by upstream' });
    }
    return r.body;
  },

  async getOrder(networkCode: string, orderId: string): Promise<UpstreamOrder | null> {
    const { body } = await http.get<UpstreamOrder>(
      `/v1/orders/${encodeURIComponent(orderId)}`,
      undefined,
      networkHeader(networkCode)
    );
    return body;
  },

  // SWAP: list line items under an order. Mock's GET /v1/orders/{id} strips
  // line_items from the response — fetch them via this separate call.
  // Real GAM mirrors this split (OrderService vs LineItemService).
  //
  // Note: returns `[]` on null response body. Callers MUST validate the
  // order exists separately (via `getOrder`) before calling — a missing
  // order returns `[]` here rather than throwing, so it would surface as
  // "no packages match" rather than `MEDIA_BUY_NOT_FOUND`. Both
  // `updateMediaBuy` and `getMediaBuys` below pre-validate by calling
  // `getOrder` / `listOrders`, so the existence check has already run.
  async listLineItems(networkCode: string, orderId: string): Promise<NonNullable<UpstreamOrder['line_items']>> {
    const { body } = await http.get<{ line_items: NonNullable<UpstreamOrder['line_items']> }>(
      `/v1/orders/${encodeURIComponent(orderId)}/lineitems`,
      undefined,
      networkHeader(networkCode)
    );
    return body?.line_items ?? [];
  },

  // SWAP: create line item under an order. Real GAM uses LineItemService.
  async createLineItem(
    networkCode: string,
    orderId: string,
    body: { product_id: string; budget: number; ad_unit_targeting?: string[]; client_request_id?: string }
  ): Promise<{ line_item_id: string }> {
    const r = await http.post<{ line_item_id: string }>(
      `/v1/orders/${encodeURIComponent(orderId)}/lineitems`,
      body,
      networkHeader(networkCode)
    );
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'line item creation rejected by upstream' });
    }
    return r.body;
  },

  // SWAP: poll the IO review task. Mock auto-promotes submitted → working →
  // completed after 2 polls. Real platforms expose a similar poll endpoint
  // OR push the result via webhook; mirror whichever your backend uses.
  async getTask(networkCode: string, taskId: string): Promise<UpstreamTask | null> {
    const { body } = await http.get<UpstreamTask>(
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      networkHeader(networkCode)
    );
    return body;
  },

  async createCreative(
    networkCode: string,
    body: { name: string; format_id: string; advertiser_id: string; client_request_id?: string }
  ): Promise<UpstreamCreative> {
    const r = await http.post<UpstreamCreative>('/v1/creatives', body, networkHeader(networkCode));
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'creative creation rejected by upstream' });
    }
    return r.body;
  },

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
// AdCP-side adapter — typed against SalesPlatform.
// ---------------------------------------------------------------------------

interface NetworkMeta {
  network_code: string;
  publisher_domain: string;
  [key: string]: unknown;
}

const FORMAT_AGENT_URL = PUBLIC_AGENT_URL;

/** Project upstream product onto AdCP `Product`. The wire `Product` shape
 *  has many optional fields; we populate only the ones the storyboard
 *  validates plus the bare-minimum required spec fields. Production
 *  adopters lift more from their backend (forecast, performance_standards,
 *  reporting_capabilities, etc.). */
function projectProduct(p: UpstreamProduct, publisherDomain: string): Product {
  return {
    product_id: p.product_id,
    name: p.name,
    description: `${p.name} — ${p.delivery_type} ${p.channel}`,
    // publisher_properties is required minItems: 1. Production sellers
    // surface their actual property catalog (per adagents.json). For the
    // worked example we declare the catch-all selector — every property
    // owned by the publisher domain is in scope.
    publisher_properties: [{ publisher_domain: publisherDomain, selection_type: 'all' }],
    channels: [
      p.channel === 'video'
        ? 'olv'
        : p.channel === 'ctv'
          ? 'ctv'
          : p.channel === 'audio'
            ? 'streaming_audio'
            : 'display',
    ],
    format_ids: p.format_ids.map(id => ({ agent_url: FORMAT_AGENT_URL, id })),
    delivery_type: p.delivery_type,
    pricing_options: [
      {
        pricing_option_id: 'cpm_guaranteed_fixed',
        pricing_model: 'cpm',
        currency: p.pricing.currency,
        fixed_price: p.pricing.cpm,
        ...(p.pricing.min_spend !== undefined && { min_spend: p.pricing.min_spend }),
      },
    ],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'clicks', 'spend'],
      date_range_support: 'date_range',
    },
    // Pass through per-query forecast verbatim — mock returns AdCP-shape
    // already (`points`, `metrics.{impressions,reach,frequency,spend}` with
    // `{low,mid,high}`, `forecast_range_unit`, `method`, `currency`). Real
    // GAM responses need adapter-side translation; the mock skips that step
    // intentionally so adopters can see what AdCP-shape forecast looks like
    // without writing the projection first.
    ...(p.forecast && { forecast: p.forecast }),
  };
}

function mapMediaBuyStatus(
  orderStatus: UpstreamOrder['status']
): 'pending_creatives' | 'pending_start' | 'active' | 'paused' | 'completed' | 'canceled' {
  switch (orderStatus) {
    case 'delivering':
      return 'active';
    case 'approved':
      return 'pending_start';
    case 'completed':
      return 'completed';
    case 'canceled':
    case 'rejected':
      return 'canceled';
    default:
      // pending_approval / draft both project to pending_creatives — by the
      // time the buyer reads MediaBuy status the upstream has at minimum
      // accepted the order. The HITL-only "pending_approval" upstream state
      // never reaches MediaBuy.status in this adapter because
      // `createMediaBuy` blocks the task envelope until upstream transitions
      // out of pending_approval.
      return 'pending_creatives';
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

class SalesGuaranteedAdapter implements DecisioningPlatform<Record<string, never>, NetworkMeta> {
  capabilities = {
    specialisms: ['sales-guaranteed'] as const,
    channels: ['olv', 'ctv', 'display'] as const,
    pricingModels: ['cpm'] as const,
    config: {},
    // Declares the comply_test_controller surface so the conformance
    // runner picks up `controller_detected: true` and grades missing
    // scenarios as `not_applicable` instead of `failed`. The framework
    // auto-derives the actual `scenarios` list from the `complyTest:`
    // adapter set wired on `createAdcpServerFromPlatform` below.
    compliance_testing: {
      scenarios: ['force_media_buy_status', 'simulate_delivery'] as const,
    },
  };

  accounts: AccountStore<NetworkMeta> = {
    /** AdCP `account.brand.domain` → upstream `network_code`. The storyboard
     *  uses brand.domain, mapped 1:1 onto the mock's `adcp_publisher` field.
     *  Production may use account.publisher or a separate auth-derived
     *  binding. */
    resolve: async ref => {
      if (!ref) return null;
      // AccountReference discriminated union — see the worked-example notes
      // on the same pattern in hello_seller_adapter_social. The mock has no
      // account_id → network_code index, so the account_id arm is
      // unreachable; production sellers add a directory lookup.
      // SWAP: persist `account_id → network_code` during sync_accounts and
      // serve account_id lookups from there.
      if ('account_id' in ref) return null;

      // ─── TEST-ONLY: cascade-scenario sandbox-arm ─────────────────────
      // DELETE THIS BLOCK BEFORE DEPLOYING. The compliance runner injects
      // synthetic refs like `{brand: {domain: 'test.example'}, sandbox: true}`
      // for `media_buy_seller/*` cascade scenarios that test wire shape
      // without depending on real test-kit principals. The block routes
      // those synthetic refs to a fixed seeded network so the rest of the
      // adapter has something concrete to operate on. Production sellers
      // either reject sandbox refs entirely or route them to a dedicated
      // sandbox tenant their IO desk owns; either way, this in-example
      // synthesis isn't appropriate for prod traffic.
      //
      // Gate is `ADCP_SANDBOX === '1'` exclusively — single-source so
      // accidentally setting `ADCP_SANDBOX` in any non-sandbox environment
      // is the only way this branch fires.
      if (ref.sandbox === true && process.env['ADCP_SANDBOX'] === '1') {
        const sandboxDomain = 'acmeoutdoor.example';
        const network = await upstream.lookupNetwork(sandboxDomain);
        if (!network) return null;
        return {
          id: `${SANDBOX_ID_PREFIX}${network.network_code}`,
          name: `Sandbox: ${network.display_name}`,
          status: 'active',
          ...(ref.operator !== undefined && { operator: ref.operator }),
          brand: { domain: ref.brand.domain ?? sandboxDomain },
          ctx_metadata: {
            network_code: network.network_code,
            publisher_domain: network.adcp_publisher,
          },
        };
      }
      // ─── /TEST-ONLY ──────────────────────────────────────────────────

      const publisherDomain = ref.brand.domain;
      if (!publisherDomain) return null;
      const network = await upstream.lookupNetwork(publisherDomain);
      if (!network) return null;
      const operator = ref.operator;
      return {
        id: network.network_code,
        name: network.display_name,
        status: 'active',
        ...(operator !== undefined && { operator }),
        brand: { domain: network.adcp_publisher },
        ctx_metadata: {
          network_code: network.network_code,
          publisher_domain: network.adcp_publisher,
        },
      };
    },

    /** sync_accounts handler. Echoes the buyer's account refs back with the
     *  resolved upstream network_code. */
    upsert: async refs => {
      const out: SyncAccountsResultRow[] = [];
      for (const ref of refs) {
        // sync_accounts always carries the brand+operator arm — buyer is
        // registering, not referencing.
        if ('account_id' in ref) {
          out.push({
            brand: { domain: '' },
            operator: '',
            action: 'failed',
            status: 'rejected',
            errors: [{ code: 'INVALID_REQUEST', message: 'sync_accounts requires brand+operator, not account_id' }],
          });
          continue;
        }
        const domain = ref.brand.domain;
        const operator = ref.operator;
        const network = domain ? await upstream.lookupNetwork(domain) : null;
        if (!network) {
          out.push({
            brand: { domain },
            operator,
            action: 'failed',
            status: 'rejected',
            errors: [{ code: 'ACCOUNT_NOT_FOUND', message: `No publisher network registered for ${domain}` }],
          });
          continue;
        }
        out.push({
          account_id: network.network_code,
          name: network.display_name,
          brand: { domain: network.adcp_publisher },
          operator,
          action: 'unchanged',
          status: 'active',
        });
      }
      return out;
    },

    list: async () => {
      const items: Array<Account<NetworkMeta>> = [];
      for (const domain of KNOWN_PUBLISHERS) {
        const n = await upstream.lookupNetwork(domain);
        if (!n) continue;
        items.push({
          id: n.network_code,
          name: n.display_name,
          status: 'active',
          brand: { domain: n.adcp_publisher },
          ctx_metadata: { network_code: n.network_code, publisher_domain: n.adcp_publisher },
        });
      }
      return { items, has_more: false };
    },
  };

  // Required: explicit `SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta>`
  // annotation. `defineSalesPlatform` widens to all-optional, and the
  // per-specialism `RequiredPlatformsFor<'sales-guaranteed'>` check rejects
  // a widened literal. The intersection annotation flows the closed shape
  // into the literal so all five core methods stay required at the type
  // level. See `decisioning.type-checks.ts` for the regression-locked
  // patterns.
  sales: SalesCorePlatform<NetworkMeta> & SalesIngestionPlatform<NetworkMeta> = {
    getProducts: async (req: GetProductsRequest, ctx): Promise<GetProductsResponse> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const publisherDomain = ctx.account.ctx_metadata.publisher_domain;
      // Storyboard sends buying_mode: 'brief' with a free-text brief —
      // production maps to a relevance ranker. The mock returns the full
      // product catalog; we pull guaranteed products to match the
      // sales-guaranteed specialism's value proposition.
      //
      // When the buyer provides structured filters (flight dates, budget),
      // forward them so each product comes back with a per-query
      // DeliveryForecast — a single upstream round-trip surfaces both the
      // catalog and the forecast curve. SWAP: production GAM splits this
      // into `inventoryService` (catalog) + `forecastService.getDeliveryForecast`
      // (per-product forecast). Use the discrete `getForecast` below if
      // your backend can't fold forecast into the catalog response.
      const briefBudget = (req.filters?.budget_range as { max?: number } | undefined)?.max;
      const guaranteed = await upstream.listProducts(networkCode, {
        deliveryType: 'guaranteed',
        ...(req.filters?.start_date && { flightStart: req.filters.start_date }),
        ...(req.filters?.end_date && { flightEnd: req.filters.end_date }),
        ...(briefBudget !== undefined && { budget: briefBudget }),
      });
      return { products: guaranteed.map(p => projectProduct(p, publisherDomain)) };
    },

    /**
     * HITL-handoff create_media_buy. Returns `ctx.handoffToTask(fn)`; the
     * buyer gets `{status: 'submitted', task_id}` immediately and the
     * framework runs `fn` in the background. `fn`'s returned
     * `CreateMediaBuySuccess` becomes the task's terminal artifact, which
     * the buyer reads via `tasks_get` polling or the configured webhook.
     */
    createMediaBuy: async (req: CreateMediaBuyRequest, ctx) => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      // SWAP: production splits network_code (the publisher's tenant) and
      // advertiser_id (the brand seat under that tenant) — they're distinct
      // upstream identifiers. The mock doesn't model the split (every
      // advertiser is owned by the same network), so this worked example
      // collapses both into network_code. Real GAM/FreeWheel/Operative
      // adapters resolve advertiser_id from `req.brand` against the
      // publisher's advertiser directory before issuing the order.
      const advertiserId = networkCode;

      // Reject aggressive measurement_terms before the buy hits upstream.
      // The storyboard exercises this path and asserts TERMS_REJECTED on
      // the wire. Production sellers branch on viewability / completion-rate
      // / IVT thresholds the platform won't commit to.
      //
      // SWAP: replace these defaults with your IO team's committable maxima.
      const MAX_VIEWABILITY = 0.85;
      const MAX_COMPLETION_RATE = 0.9;
      // Surface the offending package + threshold name + observed value +
      // committable max so the buyer agent can fix the constraint and retry.
      // Opaque "exceed seller commitments" messages get cargo-culted into
      // every adopter's constraint enforcement and produce un-actionable
      // errors at the buyer-agent boundary.
      // The cascade `measurement_terms_rejected` storyboard sends 0% (zero
      // tolerance), which no operator commits to. Threshold lives at module
      // scope above for one-grep tunability.
      const packagesArr = (req.packages ?? []) as Array<{
        measurement_terms?: {
          viewability_threshold?: number;
          completion_rate_threshold?: number;
          billing_measurement?: { max_variance_percent?: number };
        };
      }>;
      for (let i = 0; i < packagesArr.length; i++) {
        const terms = packagesArr[i]?.measurement_terms;
        if (!terms) continue;
        if (typeof terms.viewability_threshold === 'number' && terms.viewability_threshold > MAX_VIEWABILITY) {
          throw new AdcpError('TERMS_REJECTED', {
            message: `packages[${i}].measurement_terms.viewability_threshold = ${terms.viewability_threshold} exceeds maximum committable threshold (${MAX_VIEWABILITY}). Lower to ≤${MAX_VIEWABILITY} or remove the term to retry.`,
            field: `packages[${i}].measurement_terms.viewability_threshold`,
            recovery: 'correctable',
          });
        }
        if (
          typeof terms.completion_rate_threshold === 'number' &&
          terms.completion_rate_threshold > MAX_COMPLETION_RATE
        ) {
          throw new AdcpError('TERMS_REJECTED', {
            message: `packages[${i}].measurement_terms.completion_rate_threshold = ${terms.completion_rate_threshold} exceeds maximum committable threshold (${MAX_COMPLETION_RATE}). Lower to ≤${MAX_COMPLETION_RATE} or remove the term to retry.`,
            field: `packages[${i}].measurement_terms.completion_rate_threshold`,
            recovery: 'correctable',
          });
        }
        const variance = terms.billing_measurement?.max_variance_percent;
        if (typeof variance === 'number' && variance < MIN_VARIANCE_TOLERANCE) {
          throw new AdcpError('TERMS_REJECTED', {
            message: `packages[${i}].measurement_terms.billing_measurement.max_variance_percent = ${variance} is below the seller's minimum commitment (${MIN_VARIANCE_TOLERANCE}%). Real billing-count divergence between buyer and seller routinely exceeds zero; commit to ≥${MIN_VARIANCE_TOLERANCE}% or remove the term.`,
            field: `packages[${i}].measurement_terms.billing_measurement.max_variance_percent`,
            recovery: 'correctable',
          });
        }
      }

      const totalBudget =
        req.total_budget?.amount ??
        (req.packages ?? []).reduce((s, p) => s + ((p as { budget?: number }).budget ?? 0), 0);
      const currency = req.total_budget?.currency ?? 'USD';

      // Create the upstream order eagerly. The mock returns immediately
      // with status: 'pending_approval' + approval_task_id. The buyer
      // never sees this state — we hold the task envelope open until
      // upstream completes IO review.
      const order = await upstream.createOrder(networkCode, {
        name: `MediaBuy from ${req.brand?.domain ?? 'unknown'}`,
        advertiser_id: advertiserId,
        currency,
        budget: totalBudget,
        client_request_id: req.idempotency_key,
      });

      const packagesRequest = (req.packages ?? []) as Array<{
        product_id?: string;
        budget?: number;
      }>;

      // Build the synchronous-confirmation flow as a closure so both
      // the HITL handoff path AND the sandbox-direct path can call it.
      // The work is identical; only the wrapper differs.
      const completeIoAndCreateLineItems = async (): Promise<CreateMediaBuySuccess> => {
        // Poll upstream IO task to terminal state. Mock promotes
        // submitted → working → completed across two polls; production
        // platforms vary in cadence. Bound the poll loop so a stuck
        // upstream doesn't keep the AdCP task open indefinitely.
        if (order.approval_task_id) {
          for (let i = 0; i < 10; i++) {
            const task = await upstream.getTask(networkCode, order.approval_task_id);
            if (!task) break;
            if (task.status === 'completed' && task.result?.outcome === 'approved') break;
            if (task.status === 'rejected' || task.result?.outcome === 'rejected') {
              throw new AdcpError('INVALID_REQUEST', {
                message: task.result?.reviewer_note ?? 'IO review rejected the buy',
                recovery: 'terminal',
              });
            }
            await sleep(50);
          }
        }

        // Trigger the upstream order's auto-transition approved → delivering
        // by reading it once. Real platforms publish this transition via
        // status webhooks; the mock advances on GET.
        await upstream.getOrder(networkCode, order.order_id);

        // Create line items per requested package.
        const packagesOut: CreateMediaBuySuccess['packages'] = [];
        for (let i = 0; i < packagesRequest.length; i++) {
          const pkg = packagesRequest[i];
          if (!pkg) continue;
          if (!pkg.product_id) {
            throw new AdcpError('INVALID_REQUEST', {
              message: `package[${i}]: product_id required`,
              field: `packages[${i}].product_id`,
            });
          }
          const li = await upstream.createLineItem(networkCode, order.order_id, {
            product_id: pkg.product_id,
            budget: pkg.budget ?? 0,
            client_request_id: `${req.idempotency_key}.li.${i}`,
          });
          packagesOut.push({
            package_id: li.line_item_id,
            product_id: pkg.product_id,
            budget: pkg.budget ?? 0,
          });
        }

        // `confirmed_at = now` per the spec (`media-buy.json:24-28` —
        // "ISO 8601 timestamp when the seller confirmed this media buy.
        // A successful create_media_buy response constitutes order
        // confirmation"). The handoff fn's return IS that confirmation.
        //
        // Status is `pending_creatives` (not `active`) until creatives
        // sync. The MediaBuyStatus enum is `pending_creatives | pending_start
        // | active | paused | completed | rejected | canceled` —
        // `pending_creatives` is the right value when the buy is approved
        // but no creatives have been assigned. Buyers transition to
        // `active` after `sync_creatives` lands, which the framework
        // surfaces via `publishStatusChange` on `resource_type: 'media_buy'`.
        return {
          media_buy_id: order.order_id,
          status: 'pending_creatives',
          confirmed_at: new Date().toISOString(),
          packages: packagesOut,
        };
      };

      // ─── TEST-ONLY: HITL bypass for sandbox accounts ─────────────────
      // DELETE THIS BLOCK BEFORE DEPLOYING. The compliance runner expects
      // synchronous `media_buy_id` for `media_buy_seller/*` cascade
      // scenarios (pending_creatives_to_start / inventory_list_* /
      // invalid_transitions / measurement_terms_rejected follow-up); the
      // BASE `sales_guaranteed` storyboard tests the IO-signing async
      // path. Production sellers route every buy through the same path —
      // either always-HITL or always-sync, never both based on a runtime
      // flag. Belt-and-suspenders env re-check below: if the env flag
      // isn't set even though the id flowed in marked sandbox, fall
      // through to the production HITL path. Defends against an
      // upstream-resolved account that somehow carries the sandbox prefix
      // without the env being sandbox-mode.
      const isSandbox = ctx.account.id.startsWith(SANDBOX_ID_PREFIX) && process.env['ADCP_SANDBOX'] === '1';
      if (isSandbox) {
        return completeIoAndCreateLineItems();
      }
      // ─── /TEST-ONLY ──────────────────────────────────────────────────

      return ctx.handoffToTask(async (taskCtx): Promise<CreateMediaBuySuccess> => {
        void taskCtx;
        return completeIoAndCreateLineItems();
      });
    },

    updateMediaBuy: async (buyId: string, patch: UpdateMediaBuyRequest, ctx): Promise<UpdateMediaBuySuccess> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      // Validate the buy exists before touching it. Storyboard exercises
      // bogus media_buy_id and bogus package_id paths and asserts the
      // wire spec's MEDIA_BUY_NOT_FOUND / PACKAGE_NOT_FOUND error codes.
      const order = await upstream.getOrder(networkCode, buyId);
      if (!order) {
        throw new AdcpError('MEDIA_BUY_NOT_FOUND', {
          message: `Media buy ${buyId} not found`,
          field: 'media_buy_id',
          recovery: 'terminal',
        });
      }
      if (patch.packages) {
        const lineItems = await upstream.listLineItems(networkCode, buyId);
        const knownPackageIds = new Set(lineItems.map(li => li.line_item_id));
        for (const p of patch.packages) {
          const pid = (p as { package_id?: string }).package_id;
          if (pid && !knownPackageIds.has(pid)) {
            throw new AdcpError('PACKAGE_NOT_FOUND', {
              message: `Package ${pid} not found in media buy ${buyId}`,
              field: 'packages.package_id',
              recovery: 'terminal',
            });
          }
        }
      }
      // Mock doesn't model partial updates; production wires each patch
      // field onto the upstream's OrderService update endpoint. The
      // worked example just echoes success.
      return {
        media_buy_id: buyId,
        status: mapMediaBuyStatus(order.status),
      };
    },

    getMediaBuys: async (req: GetMediaBuysRequest, ctx): Promise<GetMediaBuysResponse> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const orders = await upstream.listOrders(networkCode);
      const filtered = req.media_buy_ids ? orders.filter(o => req.media_buy_ids!.includes(o.order_id)) : orders;
      // Fetch line items per order — mock's GET /v1/orders strips them.
      // Production GAM/FreeWheel similarly splits Order vs LineItem services.
      // SWAP: this is N+1 against the upstream. Real adapters either batch
      // (e.g. POST /v1/lineitems:batchGet with order_ids[]) or accept the
      // round-trip cost. Some platforms expose a `?include=lineitems`
      // query param on the list endpoint that folds them in.
      const buys = await Promise.all(
        filtered.map(async o => {
          const lineItems = await upstream.listLineItems(networkCode, o.order_id);
          return {
            media_buy_id: o.order_id,
            status: mapMediaBuyStatus(o.status),
            currency: o.currency,
            ...(o.budget !== undefined && { total_budget: o.budget }),
            confirmed_at: o.updated_at,
            created_at: o.created_at,
            updated_at: o.updated_at,
            packages: lineItems.map(li => ({
              package_id: li.line_item_id,
              product_id: li.product_id,
              budget: li.budget,
              currency: o.currency,
            })),
          };
        })
      );
      return { media_buys: buys };
    },

    syncCreatives: async (creatives, ctx): Promise<SyncCreativesRow[]> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const rows: SyncCreativesRow[] = [];
      for (const c of creatives) {
        try {
          const created = await upstream.createCreative(networkCode, {
            name: c.name,
            format_id: c.format_id.id,
            advertiser_id: networkCode,
          });
          rows.push({
            creative_id: c.creative_id,
            action: 'created',
            status: 'approved',
            platform_id: created.creative_id,
          });
        } catch (err) {
          rows.push({
            creative_id: c.creative_id,
            action: 'failed',
            errors: [
              {
                code: err instanceof AdcpError ? err.code : 'INVALID_REQUEST',
                message: err instanceof Error ? err.message : 'creative sync failed',
              },
            ],
          });
        }
      }
      return rows;
    },

    getMediaBuyDelivery: async (req: GetMediaBuyDeliveryRequest, ctx): Promise<GetMediaBuyDeliveryResponse> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const ids = req.media_buy_ids ?? [];
      const deliveries = await Promise.all(ids.map(id => upstream.getDelivery(networkCode, id)));
      const present = deliveries.filter((d): d is UpstreamDelivery => d !== null);

      const earliest = present.reduce(
        (acc, d) => (acc < d.reporting_period.start ? acc : d.reporting_period.start),
        present[0]?.reporting_period.start ?? new Date().toISOString()
      );
      const latest = present.reduce(
        (acc, d) => (acc > d.reporting_period.end ? acc : d.reporting_period.end),
        present[0]?.reporting_period.end ?? new Date().toISOString()
      );
      const currency = present[0]?.currency ?? 'USD';

      const aggregateImpressions = present.reduce((s, d) => s + d.totals.impressions, 0);
      const aggregateSpend = present.reduce((s, d) => s + d.totals.spend, 0);
      const aggregateClicks = present.reduce((s, d) => s + d.totals.clicks, 0);

      return {
        reporting_period: { start: earliest, end: latest },
        currency,
        aggregated_totals: {
          impressions: aggregateImpressions,
          spend: aggregateSpend,
          clicks: aggregateClicks,
          media_buy_count: present.length,
        },
        media_buy_deliveries: present.map(d => ({
          media_buy_id: d.order_id,
          status: 'active' as const,
          totals: {
            impressions: d.totals.impressions,
            spend: d.totals.spend,
            clicks: d.totals.clicks,
          },
          // by_package is required even when we don't have per-package
          // breakdown from upstream — include an empty array OR project
          // the line-item-level rows the mock returns. Mock's
          // line_item_breakdown carries impressions+spend per LI.
          by_package: (d.line_item_breakdown ?? []).map(li => ({
            package_id: li.line_item_id,
            impressions: li.impressions,
            spend: li.spend,
          })),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new SalesGuaranteedAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

// ─── TEST-ONLY: in-memory state for comply_test_controller adapters ─────
// DELETE THESE MAPS BEFORE DEPLOYING (or scope per-tenant if you keep the
// controller wired in a sandbox tenant). Module-scope shared maps leak
// state across accounts — that's fine for a worked example whose only
// caller is the conformance harness, but unacceptable in production.
// SWAP: scope by `account.id` (or your tenant key) and persist via the
// same data layer your production handlers read from. The controller
// and production tools should share one source of truth for state.
const seededMediaBuys = new Map<string, { status: string; revision: number }>();
const simulatedDelivery = new Map<
  string,
  { impressions: number; clicks: number; reported_spend: { amount: number; currency: string } }
>();
// ─── /TEST-ONLY ──────────────────────────────────────────────────────────

// Persist `packages[].targeting_overlay` from create_media_buy and echo it
// on get_media_buys. The seller spec MANDATES this echo for any seller
// claiming property-lists / collection-lists, and SHOULD echo any persisted
// targeting regardless. SWAP `InMemoryStateStore` for `PostgresStateStore`
// in production — in-memory loss after restart silently strips the echo
// from buyers who created buys before the bounce.
const stateStore = new InMemoryStateStore();
const mediaBuyStore = createMediaBuyStore({ store: stateStore });

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-guaranteed',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      mediaBuyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<NetworkMeta> | undefined;
        return acct?.id ?? 'anonymous';
      },
      // ─── TEST-ONLY: comply_test_controller wiring ──────────────────────
      // DELETE THIS BLOCK BEFORE DEPLOYING. The conformance runner uses
      // `comply_test_controller` to seed media-buy fixtures and force
      // state transitions deterministically across cascade scenarios.
      // Production sellers don't need this surface — and shouldn't ship
      // it. Per `examples/comply-controller-seller.ts`, the recommended
      // production posture is "don't register the controller at all";
      // a seller running their own sandbox tenant gates registration on
      // an env flag controlled by the deploy pipeline (`ADCP_SANDBOX=1`).
      //
      // SECURITY: gate is `ADCP_SANDBOX === '1'` exclusively — single env
      // var. Don't add an `|| NODE_ENV === 'test'` clause — staging boxes
      // commonly run with `NODE_ENV=test` and the controller would open
      // there too. The gate test (`test/examples/hello-seller-adapter-
      // guaranteed.test.js`) sets `ADCP_SANDBOX=1` in `extraEnv`.
      complyTest: {
        sandboxGate: () => process.env['ADCP_SANDBOX'] === '1',
        seed: {
          media_buy: ({ media_buy_id, fixture }) => {
            const existing = seededMediaBuys.get(media_buy_id);
            const status = typeof fixture['status'] === 'string' ? (fixture['status'] as string) : 'pending_creatives';
            seededMediaBuys.set(media_buy_id, { status, revision: existing?.revision ?? 0 });
          },
        },
        force: {
          media_buy_status: ({ media_buy_id, status, rejection_reason }) => {
            const buy = seededMediaBuys.get(media_buy_id);
            const previous = buy?.status ?? 'pending_creatives';
            seededMediaBuys.set(media_buy_id, { status, revision: (buy?.revision ?? 0) + 1 });
            void rejection_reason;
            return { success: true, previous_state: previous, current_state: status };
          },
        },
        simulate: {
          delivery: ({ media_buy_id, impressions, clicks, reported_spend }) => {
            const prev = simulatedDelivery.get(media_buy_id) ?? {
              impressions: 0,
              clicks: 0,
              reported_spend: { amount: 0, currency: 'USD' },
            };
            simulatedDelivery.set(media_buy_id, {
              impressions: prev.impressions + (impressions ?? 0),
              clicks: prev.clicks + (clicks ?? 0),
              reported_spend: reported_spend ?? prev.reported_spend,
            });
            return { success: true, simulated: { media_buy_id, impressions, clicks, reported_spend } };
          },
        },
      },
      // ─── /TEST-ONLY ──────────────────────────────────────────────────
    }),
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'compliance-runner' } },
    }),
  }
);

console.log(`sales-guaranteed adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
