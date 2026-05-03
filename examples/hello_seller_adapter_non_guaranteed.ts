/**
 * hello_seller_adapter_non_guaranteed — worked starting point for an
 * AdCP non-guaranteed sales agent (specialism `sales-non-guaranteed`)
 * that wraps an upstream programmatic-auction platform with sync
 * confirmation over static Bearer.
 *
 * Closes #1458 (sub-issue of #1381 umbrella). Closest neighbor in the
 * worked-reference family is `hello_seller_adapter_guaranteed.ts` —
 * this adapter is the deletion-fork (rip out HITL approval, sync
 * confirmation throughout). The auction shape applies to DSP-side
 * sellers, retail-media remnant, header-bidding inventory, and any
 * non-walled-garden seller.
 *
 * Headline behavior: `create_media_buy` returns `media_buy_id` synchronously
 * on `success` — auction is immediate, no IO-review task. Floor-priced
 * products (`pricing_options[].fixed_price = product.min_cpm`); pacing
 * propagated to upstream order; spend-only forecast surfaced inline.
 *
 * Fork this. Replace `upstream` with calls to your real backend. The
 * AdCP-facing platform methods stay the same.
 *
 * Auction mode is the deletion-fork of the guaranteed sibling: `createMediaBuy`
 * returns sync, no `ctx.handoffToTask`, no IO poll loop, no task envelope.
 * If your backend has HITL approval, fork the guaranteed example instead.
 *
 * FORK CHECKLIST
 *   1. Replace every `// SWAP:` marker with calls to your backend.
 *   2. Replace `KNOWN_PUBLISHERS` with your tenant directory.
 *   3. Replace `projectProduct()` defaults — `publisher_properties` selector,
 *      `pricing_options[]`, `reporting_capabilities` — with values your
 *      seller actually commits to.
 *   4. Replace `advertiserId = networkCode` collapse with a real lookup
 *      (production splits network and advertiser ids).
 *   5. Validate: `node --test test/examples/hello-seller-adapter-non-guaranteed.test.js`
 *   6. **DELETE the `// TEST-ONLY` blocks** before deploying:
 *      - sandbox-arm in `accounts.resolve` (resolves storyboard runner's
 *        synthetic `{brand, sandbox: true}` refs to a known network and
 *        stamps `mode: 'sandbox'` on the returned Account so the framework
 *        gate admits the comply controller)
 *      - `complyTest:` config block on `createAdcpServerFromPlatform`
 *      - in-memory `seededMediaBuys` / `simulatedDelivery` / `adapterStatusOverrides`
 *      These exist so the conformance harness can drive cascade scenarios
 *      deterministically. Production sellers ship without them.
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server sales-non-guaranteed --port 4451
 *   UPSTREAM_URL=http://127.0.0.1:4451 \
 *     npx tsx examples/hello_seller_adapter_non_guaranteed.ts
 *   adcp storyboard run http://127.0.0.1:3007/mcp sales_non_guaranteed \
 *     --auth sk_harness_do_not_use_in_prod
 *   curl http://127.0.0.1:4451/_debug/traffic
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  createUpstreamHttpClient,
  memoryBackend,
  AdcpError,
  createMediaBuyStore,
  InMemoryStateStore,
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
  ListCreativeFormatsResponse,
} from '@adcp/sdk/types';

// `Product` isn't re-exported from `@adcp/sdk/types`; derive from response.
type Product = GetProductsResponse['products'][number];

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4451';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_sales_non_guaranteed_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3007);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';
const PUBLIC_AGENT_URL = process.env['PUBLIC_AGENT_URL'] ?? `http://127.0.0.1:${PORT}`;

const KNOWN_PUBLISHERS = ['remnant-network.example', 'acmeoutdoor.example', 'pinnacle-agency.example'];

// TEST-ONLY: id-prefix used by the sandbox arm in `accounts.resolve` so
// production sellers don't need this; remove the sandbox arm + this
// constant before deploying. See FORK CHECKLIST item 6.
const SANDBOX_ID_PREFIX = 'sandbox_';

// ---------------------------------------------------------------------------
// Upstream client — SWAP for production.
// ---------------------------------------------------------------------------

interface UpstreamNetwork {
  network_code: string;
  display_name: string;
  adcp_publisher: string;
}

interface UpstreamProductPricing {
  min_cpm: number;
  target_cpm?: number;
  currency: string;
  min_spend?: number;
}

interface UpstreamForecastPoint {
  budget?: number;
  metrics: {
    impressions?: { low: number; mid: number; high: number };
    clicks?: { low: number; mid: number; high: number };
    spend?: { low: number; mid: number; high: number };
  };
}

interface UpstreamForecast {
  product_id: string;
  forecast_range_unit: 'spend';
  method: 'modeled';
  currency: string;
  points: UpstreamForecastPoint[];
  min_budget_warning?: { required: number; reason: string };
}

interface UpstreamProduct {
  product_id: string;
  name: string;
  network_code: string;
  delivery_type: 'non_guaranteed';
  channel: 'video' | 'ctv' | 'display' | 'audio';
  format_ids: string[];
  ad_unit_ids: string[];
  pricing: UpstreamProductPricing;
  forecast?: UpstreamForecast;
}

interface UpstreamLineItem {
  line_item_id: string;
  order_id: string;
  product_id: string;
  status: 'ready' | 'paused' | 'delivering' | 'completed';
  budget: number;
  ad_unit_targeting: string[];
  creative_ids: string[];
}

interface UpstreamOrder {
  order_id: string;
  network_code: string;
  name: string;
  status: 'confirmed' | 'delivering' | 'completed' | 'canceled' | 'rejected';
  advertiser_id: string;
  currency: string;
  budget: number;
  pacing: 'even' | 'asap' | 'front_loaded';
  flight_start?: string;
  flight_end?: string;
  rejection_reason?: string;
  line_items?: UpstreamLineItem[];
  created_at?: string;
  updated_at?: string;
  replayed?: boolean;
}

interface UpstreamCreative {
  creative_id: string;
  network_code: string;
  name: string;
  format_id: string;
  advertiser_id: string;
  status: 'active' | 'paused' | 'archived';
}

interface UpstreamDelivery {
  order_id: string;
  currency: string;
  pacing: 'even' | 'asap' | 'front_loaded';
  reporting_period: { start?: string; end?: string };
  totals: { impressions: number; clicks: number; spend: number; budget_remaining: number };
  line_items: Array<{
    line_item_id: string;
    product_id: string;
    impressions: number;
    clicks: number;
    spend: number;
    currency: string;
    effective_cpm: number;
    pacing_pct: number;
  }>;
}

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'static_bearer', token: UPSTREAM_API_KEY },
});

const networkHeader = (networkCode: string): Record<string, string> => ({ 'X-Network-Code': networkCode });

const upstream = {
  // SWAP: tenant lookup. Mock exposes /_lookup; production typically a
  // network registry / service-account scope endpoint.
  async lookupNetwork(publisherDomain: string): Promise<UpstreamNetwork | null> {
    const { body } = await http.get<UpstreamNetwork>('/_lookup/network', { adcp_publisher: publisherDomain });
    return body;
  },

  // SWAP: product catalog. Mock filters by network_code via header + optional
  // ?channel. When `flight_start`/`flight_end`/`budget` are passed, the mock
  // returns per-product `forecast` inline — single round-trip instead of N
  // follow-up `/v1/forecast` calls.
  async listProducts(
    networkCode: string,
    opts?: {
      channel?: 'video' | 'ctv' | 'display' | 'audio';
      flightStart?: string;
      flightEnd?: string;
      budget?: number;
    }
  ): Promise<UpstreamProduct[]> {
    const params: Record<string, string> = {};
    if (opts?.channel) params['channel'] = opts.channel;
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
  // catalog and forecast surfaces. For the worked-mock case we fold forecast
  // into `listProducts` above; this method shows the discrete shape.
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

  // SWAP: list orders. Returns { orders: [...] }.
  async listOrders(networkCode: string): Promise<UpstreamOrder[]> {
    const { body } = await http.get<{ orders: UpstreamOrder[] }>('/v1/orders', undefined, networkHeader(networkCode));
    return body?.orders ?? [];
  },

  // SWAP: sync create. Mock returns 201 with status='confirmed'. No HITL
  // task — auction-cleared programmatic. `client_request_id` round-trips
  // to upstream for at-most-once execution; replay returns same order_id
  // with `replayed: true`.
  async createOrder(
    networkCode: string,
    body: {
      name: string;
      advertiser_id: string;
      currency: string;
      budget: number;
      pacing?: 'even' | 'asap' | 'front_loaded';
      flight_start?: string;
      flight_end?: string;
      line_items?: Array<{ product_id: string; budget: number }>;
      client_request_id?: string;
    }
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

  async listLineItems(networkCode: string, orderId: string): Promise<UpstreamLineItem[]> {
    const { body } = await http.get<{ line_items: UpstreamLineItem[] }>(
      `/v1/orders/${encodeURIComponent(orderId)}/lineitems`,
      undefined,
      networkHeader(networkCode)
    );
    return body?.line_items ?? [];
  },

  async createLineItem(
    networkCode: string,
    orderId: string,
    body: { product_id: string; budget: number; ad_unit_ids?: string[]; client_request_id?: string }
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
// AdCP-side adapter — typed against SalesCorePlatform & SalesIngestionPlatform.
// ---------------------------------------------------------------------------

interface NetworkMeta {
  network_code: string;
  publisher_domain: string;
  [key: string]: unknown;
}

const FORMAT_AGENT_URL = PUBLIC_AGENT_URL;

/** Project upstream product onto AdCP `Product`. Auction-cleared inventory
 *  surfaces `min_cpm` as the `pricing_options[].fixed_price` (floor); buyers
 *  bid at or above. Production sellers can layer `auction` pricing models or
 *  deal-id-keyed alternative pricing options on top. */
function projectProduct(p: UpstreamProduct, publisherDomain: string): Product {
  return {
    product_id: p.product_id,
    name: p.name,
    description: `${p.name} — programmatic remnant ${p.channel}`,
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
    delivery_type: 'non_guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'cpm_floor',
        pricing_model: 'cpm',
        currency: p.pricing.currency,
        // Floor pricing — sellers accept any bid ≥ this. Auction-cleared
        // effective CPM lands somewhere between `min_cpm` and `target_cpm`
        // depending on bid pressure; we surface the floor as the firm
        // commitment.
        fixed_price: p.pricing.min_cpm,
        ...(p.pricing.min_spend !== undefined && { min_spend: p.pricing.min_spend }),
      },
    ],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 60,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'clicks', 'spend'],
      date_range_support: 'date_range',
    },
    // Pass through per-query forecast verbatim — mock returns AdCP-shape
    // already (`points`, `metrics.{impressions,clicks,spend}.{low,mid,high}`,
    // `forecast_range_unit: 'spend'`, `method: 'modeled'`). Real auction-
    // backed sellers (FreeWheel, Magnite SSP) need adapter-side translation.
    ...(p.forecast && { forecast: p.forecast }),
  };
}

function mapMediaBuyStatus(
  orderStatus: UpstreamOrder['status']
): 'pending_creatives' | 'pending_start' | 'active' | 'paused' | 'completed' | 'canceled' {
  switch (orderStatus) {
    case 'delivering':
      return 'active';
    case 'completed':
      return 'completed';
    case 'canceled':
    case 'rejected':
      return 'canceled';
    case 'confirmed':
    default:
      // Auction-cleared but no creatives attached yet → pending_creatives.
      // Buyer transitions to `active` after sync_creatives lands and the
      // first impression delivers. Framework surfaces the status change
      // via publishStatusChange on resource_type: 'media_buy'.
      return 'pending_creatives';
  }
}

// Status overrides persisted at the adapter level. Real backends mutate the
// upstream Order on creative-attach (the line-item status flips, the order
// status flips with it). The mock doesn't model that transition; we track
// the override here so `get_media_buys` returns the advanced status the
// storyboard validates. SWAP: drop this map and read upstream state — your
// backend already persists what we're tracking here.
//
// Keyed by `<network_code>::<order_id>` so a forking adopter who keeps the
// map for in-flight scenarios doesn't accidentally surface tenant A's
// override on tenant B's `media_buy_id` collision (mock IDs are 32 bits).
const adapterStatusOverrides = new Map<string, 'pending_start' | 'active'>();
const overrideKey = (networkCode: string, orderId: string): string => `${networkCode}::${orderId}`;

class SalesNonGuaranteedAdapter implements DecisioningPlatform<Record<string, never>, NetworkMeta> {
  capabilities = {
    specialisms: ['sales-non-guaranteed'] as const,
    channels: ['olv', 'ctv', 'display', 'streaming_audio'] as const,
    pricingModels: ['cpm'] as const,
    config: {},
    compliance_testing: {
      scenarios: ['force_media_buy_status', 'simulate_delivery'] as const,
    },
  };

  accounts: AccountStore<NetworkMeta> = {
    resolve: async ref => {
      if (!ref) return null;
      // SWAP: persist `account_id → network_code` during sync_accounts and
      // serve account_id lookups from there.
      if ('account_id' in ref) return null;

      // ─── TEST-ONLY: cascade-scenario sandbox-arm ─────────────────────
      // DELETE THIS BLOCK BEFORE DEPLOYING. The compliance runner injects
      // synthetic refs like `{brand: {domain: 'test.example'}, sandbox: true}`
      // for `media_buy_seller/*` cascade scenarios. Routes those refs to a
      // fixed seeded network so the rest of the adapter has something
      // concrete to operate on. Production sellers either reject sandbox
      // refs entirely or route them to a dedicated sandbox tenant.
      //
      // Gate is `ref.sandbox === true` from the wire `AccountReference`.
      // Stamping `mode: 'sandbox'` on the returned `Account` is what admits
      // the framework's `comply_test_controller` gate — see #1435 phase 2/3.
      // No env var is consulted; production traffic that doesn't set
      // `sandbox: true` on the wire never hits this branch.
      if (ref.sandbox === true) {
        const sandboxDomain = 'acmeoutdoor.example';
        const network = await upstream.lookupNetwork(sandboxDomain);
        if (!network) return null;
        return {
          id: `${SANDBOX_ID_PREFIX}${network.network_code}`,
          name: `Sandbox: ${network.display_name}`,
          status: 'active',
          mode: 'sandbox',
          ...(ref.operator !== undefined && { operator: ref.operator }),
          brand: { domain: ref.brand.domain ?? sandboxDomain },
          ctx_metadata: { network_code: network.network_code, publisher_domain: network.adcp_publisher },
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
        ctx_metadata: { network_code: network.network_code, publisher_domain: network.adcp_publisher },
      };
    },

    upsert: async refs => {
      const out: SyncAccountsResultRow[] = [];
      for (const ref of refs) {
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
  // annotation per migration recipe #11 — `defineSalesPlatform` widens to
  // all-optional and `RequiredPlatformsFor<'sales-non-guaranteed'>` requires
  // the closed shape on the way out.
  sales: SalesCorePlatform<NetworkMeta> & SalesIngestionPlatform<NetworkMeta> = {
    getProducts: async (req: GetProductsRequest, ctx): Promise<GetProductsResponse> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const publisherDomain = ctx.account.ctx_metadata.publisher_domain;
      // When the buyer provides structured filters (flight dates, budget),
      // forward them so each product comes back with a per-query forecast.
      // Single upstream round-trip surfaces both the catalog and the
      // forecast curve.
      const briefBudget = (req.filters?.budget_range as { max?: number } | undefined)?.max;
      const products = await upstream.listProducts(networkCode, {
        ...(req.filters?.start_date && { flightStart: req.filters.start_date }),
        ...(req.filters?.end_date && { flightEnd: req.filters.end_date }),
        ...(briefBudget !== undefined && { budget: briefBudget }),
      });
      return { products: products.map(p => projectProduct(p, publisherDomain)) };
    },

    /**
     * Sync `create_media_buy`. Returns `media_buy_id` on the sync-success
     * arm immediately — auction-cleared inventory has no IO-review step.
     * `idempotency_key` round-trips to upstream `client_request_id`.
     */
    createMediaBuy: async (req: CreateMediaBuyRequest, ctx) => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      // SWAP: production splits network_code (publisher tenant) and
      // advertiser_id (brand seat). Mock collapses both — real DSPs/SSPs
      // resolve advertiser_id from `req.brand` against the publisher's
      // advertiser directory.
      const advertiserId = networkCode;

      const totalBudget =
        req.total_budget?.amount ??
        (req.packages ?? []).reduce((s, p) => s + ((p as { budget?: number }).budget ?? 0), 0);
      const currency = req.total_budget?.currency ?? 'USD';

      // Budget-floor enforcement happens upstream — the mock returns
      // budget_too_low if any line item is below product.min_spend.
      // Adopters who want to enforce client-side (skip the upstream call
      // for an obvious reject) can iterate `req.packages` and check
      // against a cached product catalog before calling the upstream.

      const packagesRequest = (req.packages ?? []) as Array<{
        product_id?: string;
        budget?: number;
      }>;

      // Build the line_items array up front so the upstream POST is one
      // round-trip. Production splits this when line-item validation needs
      // to happen per-LI server-side; the mock accepts the array inline.
      const lineItemsBody: Array<{ product_id: string; budget: number }> = [];
      for (let i = 0; i < packagesRequest.length; i++) {
        const pkg = packagesRequest[i];
        if (!pkg) continue;
        if (!pkg.product_id) {
          throw new AdcpError('INVALID_REQUEST', {
            message: `package[${i}]: product_id required`,
            field: `packages[${i}].product_id`,
          });
        }
        lineItemsBody.push({ product_id: pkg.product_id, budget: pkg.budget ?? 0 });
      }

      // SWAP: pacing extraction — production reads from req.packages[i].pacing
      // or req.delivery_settings, varying by your contract surface. AdCP 3.0.5
      // doesn't carry an order-level `pacing` on the wire — the mock accepts
      // it because real platforms (Meta, TTD, etc.) all expose pacing on
      // their own non-guaranteed shape. Default 'even' if unspecified;
      // reject typos rather than silently passing them through.
      const PACING_VALUES = ['even', 'asap', 'front_loaded'] as const;
      const rawPacing = (req as { pacing?: unknown }).pacing;
      let pacing: (typeof PACING_VALUES)[number] = 'even';
      if (typeof rawPacing === 'string') {
        if (!(PACING_VALUES as readonly string[]).includes(rawPacing)) {
          throw new AdcpError('INVALID_REQUEST', {
            message: `pacing must be one of ${PACING_VALUES.join(', ')} (got: ${rawPacing})`,
            field: 'pacing',
            recovery: 'correctable',
          });
        }
        pacing = rawPacing as (typeof PACING_VALUES)[number];
      }

      let order: UpstreamOrder;
      try {
        order = await upstream.createOrder(networkCode, {
          name: `MediaBuy from ${req.brand?.domain ?? 'unknown'}`,
          advertiser_id: advertiserId,
          currency,
          budget: totalBudget,
          pacing,
          ...(req.start_time && { flight_start: req.start_time }),
          ...(req.end_time && { flight_end: req.end_time }),
          line_items: lineItemsBody,
          client_request_id: req.idempotency_key,
        });
      } catch (e) {
        // Surface upstream-typed error bodies as AdcpError with the
        // appropriate code. Mock returns `code: 'budget_too_low'` /
        // `code: 'product_not_found'` / etc.; we map a few of these
        // explicitly so adopters see typed errors at the buyer boundary.
        if (e instanceof AdcpError) throw e;
        throw new AdcpError('SERVICE_UNAVAILABLE', {
          message: (e as Error).message ?? 'upstream order creation failed',
          recovery: 'transient',
        });
      }

      // Project the response. The upstream order carries `line_items[]`
      // already (since we created them inline); each maps to a wire
      // `package`.
      const packagesOut: CreateMediaBuySuccess['packages'] = (order.line_items ?? []).map((li, i) => ({
        package_id: li.line_item_id,
        product_id: li.product_id,
        budget: li.budget,
        // Re-thread the buyer's package_id if supplied — adopters who
        // care about preserving buyer-side ids should round-trip them
        // here. SWAP: persist the mapping.
        ...(packagesRequest[i] !== undefined &&
          (packagesRequest[i] as { buyer_ref?: string }).buyer_ref !== undefined && {
            buyer_ref: (packagesRequest[i] as { buyer_ref?: string }).buyer_ref,
          }),
      }));

      return {
        media_buy_id: order.order_id,
        // pending_creatives — buy is auction-confirmed but no creatives
        // attached yet. Buyer transitions to `active` after sync_creatives.
        status: 'pending_creatives',
        confirmed_at: order.created_at ?? new Date().toISOString(),
        packages: packagesOut,
      };
    },

    updateMediaBuy: async (id: string, patch: UpdateMediaBuyRequest, ctx): Promise<UpdateMediaBuySuccess> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      // Validate existence first — production sellers PATCH the upstream
      // order to apply pacing / budget / status changes; the worked
      // example echoes the current state for clarity. SWAP: wire your
      // backend's order-mutation endpoint here.
      const existing = await upstream.getOrder(networkCode, id);
      if (!existing) {
        throw new AdcpError('MEDIA_BUY_NOT_FOUND', {
          message: `media_buy ${id} not found in this seller's network`,
          recovery: 'terminal',
        });
      }
      // Validate any patch.packages reference real line items. Storyboard
      // exercises bogus package_id and asserts PACKAGE_NOT_FOUND on the wire.
      const patchPackages = (
        patch as {
          packages?: Array<{ package_id?: string; creative_assignments?: unknown[] }>;
        }
      ).packages;
      let hasCreativeAssignment = false;
      if (patchPackages?.length) {
        const lineItems = await upstream.listLineItems(networkCode, id);
        const knownPackageIds = new Set(lineItems.map(li => li.line_item_id));
        for (const p of patchPackages) {
          if (p.package_id && !knownPackageIds.has(p.package_id)) {
            throw new AdcpError('PACKAGE_NOT_FOUND', {
              message: `Package ${p.package_id} not found in media buy ${id}`,
              field: 'packages.package_id',
              recovery: 'terminal',
            });
          }
          if (Array.isArray(p.creative_assignments) && p.creative_assignments.length > 0) {
            hasCreativeAssignment = true;
          }
        }
      }
      // Status advances when the buyer attaches creatives — pending_creatives
      // → pending_start (or active if the flight already started). Production
      // backends would also persist the assignment to the upstream line item;
      // the worked example just advances the response state.
      const baseStatus = mapMediaBuyStatus(existing.status);
      let nextStatus: ReturnType<typeof mapMediaBuyStatus> =
        adapterStatusOverrides.get(overrideKey(networkCode, id)) ?? baseStatus;
      if (hasCreativeAssignment && nextStatus === 'pending_creatives') {
        const flightStarted = existing.flight_start !== undefined && Date.parse(existing.flight_start) <= Date.now();
        nextStatus = flightStarted ? 'active' : 'pending_start';
        adapterStatusOverrides.set(overrideKey(networkCode, id), nextStatus);
      }
      return {
        media_buy_id: existing.order_id,
        status: nextStatus,
      };
    },

    getMediaBuyDelivery: async (req: GetMediaBuyDeliveryRequest, ctx): Promise<GetMediaBuyDeliveryResponse> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const requestedIds = req.media_buy_ids ?? [];
      // Multi-id pass-through per #1342 contract — fan out per id; framework
      // dev-mode warn (post-#1410) fires automatically if we accidentally
      // truncate to ids[0]. Filter undefined results so an unknown id
      // produces no row rather than an error (matches upstream semantics).
      const deliveries = await Promise.all(
        requestedIds.map(async id => {
          const d = await upstream.getDelivery(networkCode, id);
          if (!d) return null;
          return {
            media_buy_id: d.order_id,
            currency: d.currency,
            reporting_period: d.reporting_period,
            totals: d.totals,
            packages: d.line_items.map(li => ({
              package_id: li.line_item_id,
              product_id: li.product_id,
              impressions: li.impressions,
              clicks: li.clicks,
              spend: li.spend,
              currency: li.currency,
            })),
          };
        })
      );
      const filtered = deliveries.filter((d): d is NonNullable<typeof d> => d !== null);
      // Surface a debugging-friendly trace when buyers ask about ids the
      // upstream doesn't know — silently dropping rows looks like delivery
      // simply hasn't started yet, which buries the actual error.
      const missing = requestedIds.filter((_, i) => deliveries[i] === null);
      if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[sales-non-guaranteed] get_media_buy_delivery: ${missing.length} unknown media_buy_id(s) returned no delivery rows: ${missing.join(', ')}`
        );
      }
      const response: GetMediaBuyDeliveryResponse = {
        currency: filtered[0]?.currency ?? 'USD',
        reporting_period: {
          start: filtered[0]?.reporting_period.start ?? new Date().toISOString(),
          end: filtered[0]?.reporting_period.end ?? new Date().toISOString(),
        },
        aggregated_totals: {
          impressions: filtered.reduce((s, d) => s + d.totals.impressions, 0),
          spend: filtered.reduce((s, d) => s + d.totals.spend, 0),
          clicks: filtered.reduce((s, d) => s + d.totals.clicks, 0),
          media_buy_count: filtered.length,
        },
        media_buy_deliveries: filtered.map(d => ({
          media_buy_id: d.media_buy_id,
          // Required field on media_buy_deliveries[i]. Auction inventory in
          // active delivery defaults to 'active'; production sellers map
          // upstream order state through `mapMediaBuyStatus` like elsewhere.
          status: 'active' as const,
          totals: d.totals,
          by_package: d.packages.map(p => ({
            package_id: p.package_id,
            impressions: p.impressions,
            spend: p.spend,
          })),
        })),
      };
      return response;
    },

    getMediaBuys: async (req: GetMediaBuysRequest, ctx): Promise<GetMediaBuysResponse> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const requestedIds = req.media_buy_ids ?? [];
      let orders: UpstreamOrder[];
      if (requestedIds.length > 0) {
        orders = (await Promise.all(requestedIds.map(id => upstream.getOrder(networkCode, id)))).filter(
          (o): o is UpstreamOrder => o !== null
        );
      } else {
        orders = await upstream.listOrders(networkCode);
      }
      // Fetch per-order line items. Mock's GET /v1/orders/{id} omits them;
      // GAM-style backends similarly split Order vs LineItem services. SWAP:
      // batch via `?include=lineitems` if your platform supports it.
      const media_buys = await Promise.all(
        orders.map(async o => {
          const lineItems = await upstream.listLineItems(networkCode, o.order_id);
          const baseStatus = mapMediaBuyStatus(o.status);
          const status = adapterStatusOverrides.get(overrideKey(networkCode, o.order_id)) ?? baseStatus;
          return {
            media_buy_id: o.order_id,
            status,
            currency: o.currency,
            ...(o.budget !== undefined && { total_budget: o.budget }),
            ...(o.updated_at !== undefined && { confirmed_at: o.updated_at }),
            ...(o.created_at !== undefined && { created_at: o.created_at }),
            ...(o.updated_at !== undefined && { updated_at: o.updated_at }),
            ...(o.flight_start && { start_time: o.flight_start }),
            ...(o.flight_end && { end_time: o.flight_end }),
            packages: lineItems.map(li => ({
              package_id: li.line_item_id,
              product_id: li.product_id,
              budget: li.budget,
              currency: o.currency,
            })),
          };
        })
      );
      const response: GetMediaBuysResponse = { media_buys };
      return response;
    },

    syncCreatives: async (creatives, ctx) => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const advertiserId = networkCode; // SWAP: same collapse caveat as createMediaBuy.
      const out: SyncCreativesRow[] = [];
      for (const c of creatives) {
        const formatRef = (c as { format_id?: { id?: string } | string }).format_id;
        const formatId = typeof formatRef === 'string' ? formatRef : formatRef?.id;
        if (!formatId) {
          out.push({
            creative_id: (c as { creative_id?: string }).creative_id ?? 'unknown',
            action: 'failed',
            status: 'rejected',
            errors: [{ code: 'CREATIVE_REJECTED', message: 'format_id is required' }],
          });
          continue;
        }
        try {
          const creativeIdHint = (c as { creative_id?: string }).creative_id;
          const created = await upstream.createCreative(networkCode, {
            name: (c as { name?: string }).name ?? 'Untitled',
            format_id: formatId,
            advertiser_id: advertiserId,
            ...(creativeIdHint !== undefined && { client_request_id: creativeIdHint }),
          });
          out.push({
            creative_id: created.creative_id,
            action: 'created',
            status: 'approved',
          });
        } catch (e) {
          out.push({
            creative_id: (c as { creative_id?: string }).creative_id ?? 'unknown',
            action: 'failed',
            status: 'rejected',
            errors: [
              { code: 'CREATIVE_REJECTED', message: (e as Error).message ?? 'upstream creative creation failed' },
            ],
          });
        }
      }
      return out;
    },

    listCreativeFormats: async (_req, _ctx): Promise<ListCreativeFormatsResponse> => {
      // Publisher-owned format catalog. The mock doesn't have a discrete
      // formats endpoint (formats live inline on Product); production sellers
      // typically expose `/v1/formats` separately. SWAP: replace with your
      // backend's format catalog.
      return {
        formats: [
          {
            format_id: { agent_url: FORMAT_AGENT_URL, id: 'display_300x250' },
            name: 'Display 300x250 (medrec)',
            renders: [{ role: 'main', dimensions: { width: 300, height: 250, unit: 'px' } }],
          },
          {
            format_id: { agent_url: FORMAT_AGENT_URL, id: 'display_728x90' },
            name: 'Display 728x90 (leaderboard)',
            renders: [{ role: 'main', dimensions: { width: 728, height: 90, unit: 'px' } }],
          },
          {
            format_id: { agent_url: FORMAT_AGENT_URL, id: 'video_30s' },
            name: 'Video 30s outstream / instream',
            renders: [{ role: 'main', dimensions: { width: 1920, height: 1080, unit: 'px' } }],
          },
          {
            format_id: { agent_url: FORMAT_AGENT_URL, id: 'video_15s' },
            name: 'Video 15s',
            renders: [{ role: 'main', dimensions: { width: 1920, height: 1080, unit: 'px' } }],
          },
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

const platform = new SalesNonGuaranteedAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

// Persist `packages[].targeting_overlay` from create_media_buy and echo it
// on get_media_buys. Required for any seller claiming property-lists /
// collection-lists. SWAP `InMemoryStateStore` for `PostgresStateStore` in
// production — in-memory loss after restart silently strips the echo.
const stateStore = new InMemoryStateStore();
const mediaBuyStore = createMediaBuyStore({ store: stateStore });

// ─── TEST-ONLY: comply-controller in-memory state ───────────────────────
// DELETE BEFORE DEPLOYING. Module-scope maps shared across accounts; only
// the conformance harness reaches them via the gate below.
const seededMediaBuys = new Map<string, { status: string; revision: number }>();
const simulatedDelivery = new Map<
  string,
  { impressions: number; clicks: number; reported_spend: { amount: number; currency: string } }
>();
// ─── /TEST-ONLY ──────────────────────────────────────────────────────────

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-non-guaranteed',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      mediaBuyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<NetworkMeta> | undefined;
        return acct?.id ?? 'anonymous';
      },
      // ─── TEST-ONLY: comply_test_controller wiring ──────────────────────
      // DELETE BEFORE DEPLOYING. The framework auto-gates on the resolved
      // account's `mode === 'sandbox'` (see `accounts.resolve` synthesis arm
      // above) — adapters no longer carry their own gate callback. #1435 phase 3.
      complyTest: {
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

console.log(`sales-non-guaranteed adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
