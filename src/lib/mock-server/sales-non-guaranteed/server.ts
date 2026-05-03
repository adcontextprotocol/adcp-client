/**
 * `sales-non-guaranteed` upstream-shape mock-server. Programmatic-auction
 * remnant inventory; sync confirmation on `POST /v1/orders`; floor pricing
 * per product; spend-only forecast (no availability check).
 *
 * Closes #1457 (sub-issue of #1381). Pattern modeled on
 * `sales-guaranteed/server.ts` with these deltas:
 *
 *   - Order confirmation is **sync**: `POST /v1/orders` returns
 *     `status: 'confirmed'` immediately. No HITL approval task.
 *   - Pricing is **floor-based** (`min_cpm`). Effective CPM at the
 *     requested budget = `target_cpm` if set, else `1.3 × min_cpm`,
 *     saturating toward `2 × min_cpm` at high budgets.
 *   - Forecast is **`spend`-only**. No `availability` unit; auction
 *     mocks don't pre-commit inventory.
 *   - Delivery scales with `(budget × elapsed_pct × pacing_curve)`.
 *     Pacing modes: `even`, `asap`, `front_loaded`.
 *   - No CAPI / conversions surface (out of scope per #1457).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import {
  AD_UNITS,
  DEFAULT_API_KEY,
  NETWORKS,
  PRODUCTS,
  type MockAdUnit,
  type MockNetwork,
  type MockProduct,
} from './seed-data';

export interface BootOptions {
  port: number;
  apiKey?: string;
  networks?: MockNetwork[];
  adUnits?: MockAdUnit[];
  products?: MockProduct[];
}

export interface BootResult {
  url: string;
  close: () => Promise<void>;
}

type OrderStatus = 'confirmed' | 'delivering' | 'completed' | 'canceled' | 'rejected';
type LineItemStatus = 'ready' | 'paused' | 'delivering' | 'completed';
type Pacing = 'even' | 'asap' | 'front_loaded';

interface OrderState {
  order_id: string;
  network_code: string;
  name: string;
  status: OrderStatus;
  advertiser_id: string;
  currency: string;
  budget: number;
  pacing: Pacing;
  flight_start?: string;
  flight_end?: string;
  rejection_reason?: string;
  line_items: Map<string, LineItemState>;
  body_fingerprint: string;
  created_at: string;
  updated_at: string;
}

interface LineItemState {
  line_item_id: string;
  order_id: string;
  product_id: string;
  status: LineItemStatus;
  budget: number;
  ad_unit_targeting: string[];
  creative_ids: string[];
  body_fingerprint: string;
  created_at: string;
}

interface CreativeState {
  creative_id: string;
  network_code: string;
  name: string;
  format_id: string;
  advertiser_id: string;
  snippet?: string;
  status: 'active' | 'paused' | 'archived';
  body_fingerprint: string;
  created_at: string;
}

interface ForecastPoint {
  budget?: number;
  metrics: {
    impressions?: { low: number; mid: number; high: number };
    clicks?: { low: number; mid: number; high: number };
    spend?: { low: number; mid: number; high: number };
  };
}

interface DeliveryForecast {
  product_id: string;
  forecast_range_unit: 'spend';
  method: 'modeled';
  currency: string;
  points: ForecastPoint[];
  /** Set when the requested budget is below the product's `min_spend`
   * floor (typical for video/CTV inventory). Mirrors Meta-style learning-
   * phase warnings; programmatic remnant has the same dynamic at
   * platforms that enforce a daily-budget minimum. */
  min_budget_warning?: { required: number; reason: string };
}

export async function bootSalesNonGuaranteed(options: BootOptions): Promise<BootResult> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const networks = options.networks ?? NETWORKS;
  const adUnits = options.adUnits ?? AD_UNITS;
  const products = options.products ?? PRODUCTS;

  const orders = new Map<string, OrderState>();
  const creatives = new Map<string, CreativeState>();
  // Idempotency table — keyed `<network_code>::<resource_kind>::<client_request_id>`.
  // Value is the resource id or a 409-conflict marker `409:<fingerprint>`.
  const idempotency = new Map<string, string>();

  // Traffic counters keyed by `<METHOD> <route-template>`. Harness queries
  // `GET /_debug/traffic` after the storyboard run and asserts headline
  // routes were hit ≥1. Façade adapters that skip the upstream produce
  // zero counters and fail the assertion. Mirrors the pattern from
  // `sales-guaranteed/server.ts` (#1225 lineage).
  const traffic = new Map<string, number>();
  const bump = (routeTemplate: string): void => {
    traffic.set(routeTemplate, (traffic.get(routeTemplate) ?? 0) + 1);
  };

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      writeJson(res, 500, { code: 'internal_error', message: err?.message ?? 'unexpected error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : options.port;
  const url = `http://127.0.0.1:${boundPort}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = reqUrl.pathname;
    const method = req.method ?? 'GET';

    // Façade-detection traffic dump — harness-only, no auth required.
    if (method === 'GET' && path === '/_debug/traffic') {
      writeJson(res, 200, { traffic: Object.fromEntries(traffic) });
      return;
    }

    // Discovery endpoint — replaces hardcoded principal-mapping. Adapters
    // resolve at runtime by querying with the AdCP-side identifier from
    // buyers (`account.publisher`, `account.brand.domain`). No auth —
    // discovery happens before the agent has any network context. #1225.
    if (method === 'GET' && path === '/_lookup/network') {
      bump('GET /_lookup/network');
      const adcpPublisher = reqUrl.searchParams.get('adcp_publisher');
      if (!adcpPublisher) {
        writeJson(res, 400, { code: 'invalid_request', message: 'adcp_publisher query parameter is required.' });
        return;
      }
      const match = networks.find(n => n.adcp_publisher === adcpPublisher);
      if (!match) {
        writeJson(res, 404, {
          code: 'network_not_found',
          message: `No upstream network registered for adcp_publisher=${adcpPublisher}.`,
        });
        return;
      }
      writeJson(res, 200, {
        adcp_publisher: match.adcp_publisher,
        network_code: match.network_code,
        display_name: match.display_name,
      });
      return;
    }

    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== apiKey) {
      writeJson(res, 401, { code: 'unauthorized', message: 'Missing or invalid bearer credential.' });
      return;
    }
    const networkHeader = req.headers['x-network-code'];
    const networkCode = Array.isArray(networkHeader) ? networkHeader[0] : networkHeader;
    if (!networkCode) {
      writeJson(res, 403, { code: 'network_required', message: 'X-Network-Code header is required on every request.' });
      return;
    }
    const network = networks.find(n => n.network_code === networkCode);
    if (!network) {
      writeJson(res, 403, { code: 'unknown_network', message: `Unknown network: ${networkCode}` });
      return;
    }

    if (method === 'GET' && path === '/v1/inventory') {
      bump('GET /v1/inventory');
      return handleListInventory(network, res);
    }
    if (method === 'GET' && path === '/v1/products') {
      bump('GET /v1/products');
      return handleListProducts(reqUrl, network, res);
    }
    if (method === 'POST' && path === '/v1/forecast') {
      bump('POST /v1/forecast');
      return handleForecast(req, network, res);
    }
    if (method === 'GET' && path === '/v1/creatives') {
      bump('GET /v1/creatives');
      return handleListCreatives(network, res);
    }
    if (method === 'POST' && path === '/v1/creatives') {
      bump('POST /v1/creatives');
      return handleCreateCreative(req, network, res);
    }

    if (method === 'GET' && path === '/v1/orders') {
      bump('GET /v1/orders');
      return handleListOrders(network, res);
    }
    if (method === 'POST' && path === '/v1/orders') {
      bump('POST /v1/orders');
      return handleCreateOrder(req, network, res);
    }

    const orderMatch = path.match(/^\/v1\/orders\/([^/]+)(\/.*)?$/);
    if (orderMatch && orderMatch[1]) {
      const orderId = decodeURIComponent(orderMatch[1]);
      const subPath = orderMatch[2] ?? '/';
      const order = orders.get(orderId);
      if (!order || order.network_code !== network.network_code) {
        writeJson(res, 404, { code: 'order_not_found', message: `Order ${orderId} not found.` });
        return;
      }
      if (method === 'GET' && subPath === '/') {
        bump('GET /v1/orders/{id}');
        return handleGetOrder(order, res);
      }
      if (method === 'PATCH' && subPath === '/') {
        bump('PATCH /v1/orders/{id}');
        return handleUpdateOrder(req, order, res);
      }
      if (method === 'GET' && subPath === '/lineitems') {
        bump('GET /v1/orders/{id}/lineitems');
        return handleListLineItems(order, res);
      }
      if (method === 'POST' && subPath === '/lineitems') {
        bump('POST /v1/orders/{id}/lineitems');
        return handleCreateLineItem(req, order, res);
      }
      if (method === 'GET' && subPath === '/delivery') {
        bump('GET /v1/orders/{id}/delivery');
        return handleGetDelivery(order, res);
      }
    }

    writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
  }

  // ────────────────────────────────────────────────────────────
  // Inventory / Products
  // ────────────────────────────────────────────────────────────

  function handleListInventory(network: MockNetwork, res: ServerResponse): void {
    const visible = adUnits.filter(au => au.network_code === network.network_code);
    writeJson(res, 200, { ad_units: visible });
  }

  function handleListProducts(reqUrl: URL, network: MockNetwork, res: ServerResponse): void {
    let visible = products.filter(p => p.network_code === network.network_code);
    const channel = reqUrl.searchParams.get('channel');
    if (channel) visible = visible.filter(p => p.channel === channel);

    // Per-query forecast embedding. Mirrors the sales-guaranteed pattern
    // (PR #1414): when the caller passes targeting / flight / budget
    // params, attach a deterministic-seeded forecast curve to each
    // product so `getProducts` surfaces both the catalog and the
    // forecast in one call. Back-compat: omit the params, get the
    // static catalog.
    const targeting = reqUrl.searchParams.get('targeting');
    const flightStart = parseDateParam(reqUrl.searchParams.get('flight_start'));
    const flightEnd = parseDateParam(reqUrl.searchParams.get('flight_end'));
    const budget = parsePositiveNumber(reqUrl.searchParams.get('budget'));
    const hasQuery = Boolean(targeting || flightStart || flightEnd || budget !== undefined);
    if (hasQuery) {
      const decorated = visible.map(p => ({
        ...p,
        forecast: synthForecast(p, { targeting, dates: { start: flightStart, end: flightEnd }, budget }),
      }));
      writeJson(res, 200, { products: decorated });
      return;
    }
    writeJson(res, 200, { products: visible });
  }

  // ────────────────────────────────────────────────────────────
  // Forecast (spend-only — no availability check; auction-cleared)
  // ────────────────────────────────────────────────────────────

  async function handleForecast(req: IncomingMessage, network: MockNetwork, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { product_id, targeting, flight_dates, budget } = body as Record<string, unknown>;
    if (typeof product_id !== 'string') {
      writeJson(res, 400, { code: 'invalid_request', message: 'product_id is required.' });
      return;
    }
    const product = products.find(p => p.product_id === product_id && p.network_code === network.network_code);
    if (!product) {
      writeJson(res, 404, { code: 'product_not_found', message: `Product ${product_id} not found.` });
      return;
    }
    const dates = isObject(flight_dates) ? flight_dates : {};
    const targetingKey = serializeTargeting(targeting);
    const forecast = synthForecast(product, {
      targeting: targetingKey,
      dates: {
        start: typeof dates.start === 'string' ? dates.start : undefined,
        end: typeof dates.end === 'string' ? dates.end : undefined,
      },
      budget: typeof budget === 'number' ? budget : undefined,
    });
    writeJson(res, 200, forecast);
  }

  // ────────────────────────────────────────────────────────────
  // Creatives library (network-scoped, idempotent on client_request_id)
  // ────────────────────────────────────────────────────────────

  function handleListCreatives(network: MockNetwork, res: ServerResponse): void {
    const visible = Array.from(creatives.values()).filter(c => c.network_code === network.network_code);
    writeJson(res, 200, { creatives: visible });
  }

  async function handleCreateCreative(req: IncomingMessage, network: MockNetwork, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const clientRequestId = typeof body.client_request_id === 'string' ? body.client_request_id : undefined;
    const fingerprint = sha256(JSON.stringify(body));
    if (clientRequestId) {
      const replayed = checkIdempotency(network.network_code, 'creative', clientRequestId, fingerprint);
      if (replayed.kind === 'replay') {
        const existing = creatives.get(replayed.id);
        if (existing) {
          writeJson(res, 200, { ...existing, replayed: true });
          return;
        }
      }
      if (replayed.kind === 'conflict') {
        writeJson(res, 409, {
          code: 'idempotency_conflict',
          message: `client_request_id ${clientRequestId} previously used for a different body.`,
        });
        return;
      }
    }

    const name = typeof body.name === 'string' ? body.name : 'Untitled Creative';
    const formatId = typeof body.format_id === 'string' ? body.format_id : null;
    const advertiserId = typeof body.advertiser_id === 'string' ? body.advertiser_id : null;
    if (!formatId || !advertiserId) {
      writeJson(res, 400, { code: 'invalid_request', message: 'format_id and advertiser_id are required.' });
      return;
    }
    const creativeId = `cr_${randomUUID().slice(0, 8)}`;
    const creative: CreativeState = {
      creative_id: creativeId,
      network_code: network.network_code,
      name,
      format_id: formatId,
      advertiser_id: advertiserId,
      snippet: typeof body.snippet === 'string' ? body.snippet : undefined,
      status: 'active',
      body_fingerprint: fingerprint,
      created_at: new Date().toISOString(),
    };
    creatives.set(creativeId, creative);
    if (clientRequestId) recordIdempotency(network.network_code, 'creative', clientRequestId, fingerprint, creativeId);
    writeJson(res, 201, creative);
  }

  // ────────────────────────────────────────────────────────────
  // Orders — sync confirmation (no HITL)
  // ────────────────────────────────────────────────────────────

  function handleListOrders(network: MockNetwork, res: ServerResponse): void {
    const visible = Array.from(orders.values())
      .filter(o => o.network_code === network.network_code)
      .map(toWireOrder);
    writeJson(res, 200, { orders: visible });
  }

  async function handleCreateOrder(req: IncomingMessage, network: MockNetwork, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const clientRequestId = typeof body.client_request_id === 'string' ? body.client_request_id : undefined;
    const fingerprint = sha256(JSON.stringify(body));
    if (clientRequestId) {
      const replayed = checkIdempotency(network.network_code, 'order', clientRequestId, fingerprint);
      if (replayed.kind === 'replay') {
        const existing = orders.get(replayed.id);
        if (existing) {
          writeJson(res, 200, { ...toWireOrder(existing), replayed: true });
          return;
        }
      }
      if (replayed.kind === 'conflict') {
        writeJson(res, 409, {
          code: 'idempotency_conflict',
          message: `client_request_id ${clientRequestId} previously used for a different body.`,
        });
        return;
      }
    }

    const name = typeof body.name === 'string' ? body.name : 'Untitled Order';
    const advertiserId = typeof body.advertiser_id === 'string' ? body.advertiser_id : null;
    const budget = typeof body.budget === 'number' ? body.budget : null;
    const currency = typeof body.currency === 'string' ? body.currency : 'USD';
    if (!advertiserId || budget === null) {
      writeJson(res, 400, { code: 'invalid_request', message: 'advertiser_id and budget are required.' });
      return;
    }
    if (budget <= 0) {
      writeJson(res, 400, { code: 'invalid_request', message: 'budget must be positive.', field: 'budget' });
      return;
    }

    // Validate line_items if supplied. Product existence isn't required —
    // storyboard cascades seed product fixtures via comply_test_controller
    // independent of the seller's actual catalog (mirrors the sales-guaranteed
    // mock's looser pattern). Min_spend is enforced ONLY when the product is
    // known on this network — gives compliance harnesses a permissive path
    // while keeping the floor-pricing test surface available for known products.
    const lineItemsInput = Array.isArray(body.line_items) ? body.line_items : [];
    const lineItems: LineItemState[] = [];
    for (const raw of lineItemsInput) {
      if (!isObject(raw)) {
        writeJson(res, 400, { code: 'invalid_request', message: 'each line_item must be an object.' });
        return;
      }
      const productId = typeof raw.product_id === 'string' ? raw.product_id : null;
      const liBudget = typeof raw.budget === 'number' ? raw.budget : 0;
      if (!productId) {
        writeJson(res, 400, { code: 'invalid_request', message: 'each line_item requires product_id.' });
        return;
      }
      const product = products.find(p => p.product_id === productId && p.network_code === network.network_code);
      if (product && product.pricing.min_spend !== undefined && liBudget < product.pricing.min_spend) {
        writeJson(res, 400, {
          code: 'budget_too_low',
          message: `line_item for ${productId}: budget ${liBudget} below product min_spend ${product.pricing.min_spend}.`,
          field: 'line_items[].budget',
        });
        return;
      }
      lineItems.push({
        line_item_id: `li_${randomUUID().slice(0, 8)}`,
        order_id: '', // filled below once order_id is known
        product_id: productId,
        status: 'ready',
        budget: liBudget,
        ad_unit_targeting: Array.isArray(raw.ad_unit_ids)
          ? raw.ad_unit_ids.filter((s): s is string => typeof s === 'string')
          : [],
        creative_ids: Array.isArray(raw.creative_ids)
          ? raw.creative_ids.filter((s): s is string => typeof s === 'string')
          : [],
        body_fingerprint: sha256(JSON.stringify(raw)),
        created_at: new Date().toISOString(),
      });
    }

    const orderId = `ord_${randomUUID().slice(0, 8)}`;
    const pacing = parsePacing(body.pacing);
    const now = new Date().toISOString();
    const order: OrderState = {
      order_id: orderId,
      network_code: network.network_code,
      name,
      // Sync confirmation — auction-cleared programmatic, no HITL approval.
      status: 'confirmed',
      advertiser_id: advertiserId,
      currency,
      budget,
      pacing,
      flight_start: typeof body.flight_start === 'string' ? body.flight_start : undefined,
      flight_end: typeof body.flight_end === 'string' ? body.flight_end : undefined,
      line_items: new Map(),
      body_fingerprint: fingerprint,
      created_at: now,
      updated_at: now,
    };
    for (const li of lineItems) {
      li.order_id = orderId;
      order.line_items.set(li.line_item_id, li);
    }
    orders.set(orderId, order);
    if (clientRequestId) recordIdempotency(network.network_code, 'order', clientRequestId, fingerprint, orderId);
    writeJson(res, 201, toWireOrder(order));
  }

  function handleGetOrder(order: OrderState, res: ServerResponse): void {
    writeJson(res, 200, toWireOrder(order));
  }

  async function handleUpdateOrder(req: IncomingMessage, order: OrderState, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (typeof body.status === 'string') {
      const validStatuses: OrderStatus[] = ['confirmed', 'delivering', 'completed', 'canceled', 'rejected'];
      if (!validStatuses.includes(body.status as OrderStatus)) {
        writeJson(res, 400, { code: 'invalid_request', message: `Invalid status: ${body.status}` });
        return;
      }
      order.status = body.status as OrderStatus;
    }
    if (typeof body.budget === 'number' && body.budget > 0) order.budget = body.budget;
    if (typeof body.pacing === 'string') order.pacing = parsePacing(body.pacing);
    order.updated_at = new Date().toISOString();
    writeJson(res, 200, toWireOrder(order));
  }

  function handleListLineItems(order: OrderState, res: ServerResponse): void {
    writeJson(res, 200, { line_items: Array.from(order.line_items.values()) });
  }

  async function handleCreateLineItem(req: IncomingMessage, order: OrderState, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const productId = typeof body.product_id === 'string' ? body.product_id : null;
    const liBudget = typeof body.budget === 'number' ? body.budget : 0;
    if (!productId) {
      writeJson(res, 400, { code: 'invalid_request', message: 'product_id is required.' });
      return;
    }
    // Product existence isn't required at line-item creation — cascade
    // scenarios seed product fixtures via comply_test_controller. Min_spend
    // is enforced ONLY when the product is known on this network.
    const product = products.find(p => p.product_id === productId && p.network_code === order.network_code);
    if (product && product.pricing.min_spend !== undefined && liBudget < product.pricing.min_spend) {
      writeJson(res, 400, {
        code: 'budget_too_low',
        message: `budget ${liBudget} below product min_spend ${product.pricing.min_spend}.`,
        field: 'budget',
      });
      return;
    }
    const lineItem: LineItemState = {
      line_item_id: `li_${randomUUID().slice(0, 8)}`,
      order_id: order.order_id,
      product_id: productId,
      status: 'ready',
      budget: liBudget,
      ad_unit_targeting: Array.isArray(body.ad_unit_ids)
        ? body.ad_unit_ids.filter((s): s is string => typeof s === 'string')
        : [],
      creative_ids: Array.isArray(body.creative_ids)
        ? body.creative_ids.filter((s): s is string => typeof s === 'string')
        : [],
      body_fingerprint: sha256(JSON.stringify(body)),
      created_at: new Date().toISOString(),
    };
    order.line_items.set(lineItem.line_item_id, lineItem);
    order.updated_at = new Date().toISOString();
    writeJson(res, 201, lineItem);
  }

  // ────────────────────────────────────────────────────────────
  // Delivery — synth `(budget × elapsed_pct × pacing_curve)`
  // ────────────────────────────────────────────────────────────

  function handleGetDelivery(order: OrderState, res: ServerResponse): void {
    // Determine elapsed-pct of flight. If flight dates aren't set,
    // assume the order is mid-flight at 50% so adapters get non-zero
    // numbers even on synthetic test orders.
    const elapsed = computeElapsedPct(order);
    const pacingCurve = pacingCurveAt(order.pacing, elapsed);
    const liDeliveries: Array<Record<string, unknown>> = [];
    let totalImpressions = 0;
    let totalSpend = 0;
    let totalClicks = 0;
    for (const li of order.line_items.values()) {
      const product = products.find(p => p.product_id === li.product_id);
      if (!product) continue;
      const targetCpm = product.pricing.target_cpm ?? product.pricing.min_cpm * 1.3;
      const spent = li.budget * pacingCurve;
      const impressions = Math.max(0, Math.floor((spent / targetCpm) * 1000));
      const ctr = ctrFor(product.channel);
      const clicks = Math.max(0, Math.floor(impressions * ctr));
      liDeliveries.push({
        line_item_id: li.line_item_id,
        product_id: li.product_id,
        impressions,
        clicks,
        spend: round2(spent),
        currency: order.currency,
        effective_cpm: round2(targetCpm),
        pacing_pct: round2(pacingCurve * 100),
      });
      totalImpressions += impressions;
      totalSpend += spent;
      totalClicks += clicks;
    }
    writeJson(res, 200, {
      order_id: order.order_id,
      currency: order.currency,
      pacing: order.pacing,
      reporting_period: { start: order.flight_start, end: order.flight_end },
      totals: {
        impressions: totalImpressions,
        clicks: totalClicks,
        spend: round2(totalSpend),
        budget_remaining: round2(Math.max(0, order.budget - totalSpend)),
      },
      line_items: liDeliveries,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Forecast synthesis (spend-only, deterministic-seeded)
  // ────────────────────────────────────────────────────────────

  function synthForecast(
    product: MockProduct,
    opts: { targeting?: string | null; dates: { start?: string; end?: string }; budget?: number }
  ): DeliveryForecast {
    const seed = sha256(
      `${product.product_id}::${opts.targeting ?? ''}::${opts.dates.start ?? ''}::${opts.dates.end ?? ''}`
    );
    const seedNum = parseInt(seed.slice(0, 8), 16);
    // Effective CPM scales with budget — auction-clearing premium.
    // At small budgets: ~1.0x floor (low competition).
    // At target_cpm-aligned budgets: target_cpm.
    // At very large budgets: saturating toward 2x floor (auction pressure).
    const minCpm = product.pricing.min_cpm;
    const targetCpm = product.pricing.target_cpm ?? minCpm * 1.3;
    const points: ForecastPoint[] = [];
    if (opts.budget !== undefined && opts.budget > 0) {
      const eff = computeEffectiveCpm(minCpm, targetCpm, opts.budget);
      const impressions = Math.floor((opts.budget / eff) * 1000);
      // ±15% variance, deterministic-seeded.
      const variance = 0.15;
      const lowImps = Math.floor(impressions * (1 - variance));
      const highImps = Math.floor(impressions * (1 + variance));
      const ctr = ctrFor(product.channel);
      points.push({
        budget: opts.budget,
        metrics: {
          impressions: { low: lowImps, mid: impressions, high: highImps },
          clicks: {
            low: Math.floor(lowImps * ctr),
            mid: Math.floor(impressions * ctr),
            high: Math.floor(highImps * ctr),
          },
          spend: { low: opts.budget, mid: opts.budget, high: opts.budget },
        },
      });
    } else {
      // No budget specified — return three indicative points: $1k / $10k / $100k.
      for (const b of [1_000, 10_000, 100_000]) {
        const eff = computeEffectiveCpm(minCpm, targetCpm, b);
        const impressions = Math.floor((b / eff) * 1000);
        const variance = 0.15;
        const lowImps = Math.floor(impressions * (1 - variance));
        const highImps = Math.floor(impressions * (1 + variance));
        const ctr = ctrFor(product.channel);
        points.push({
          budget: b,
          metrics: {
            impressions: { low: lowImps, mid: impressions, high: highImps },
            clicks: {
              low: Math.floor(lowImps * ctr),
              mid: Math.floor(impressions * ctr),
              high: Math.floor(highImps * ctr),
            },
            spend: { low: b, mid: b, high: b },
          },
        });
      }
      // Suppress unused-var warning for the deterministic seed when no
      // budget is supplied (the seed shapes the variance for a future
      // tightening; today we use a fixed ±15%). Keep the seed-derivation
      // call site so the variance hook is in place.
      void seedNum;
    }

    const out: DeliveryForecast = {
      product_id: product.product_id,
      forecast_range_unit: 'spend',
      method: 'modeled',
      currency: product.pricing.currency,
      points,
    };
    if (
      opts.budget !== undefined &&
      product.pricing.min_spend !== undefined &&
      opts.budget < product.pricing.min_spend
    ) {
      out.min_budget_warning = {
        required: product.pricing.min_spend,
        reason: `Budget ${opts.budget} is below the product's learning-phase floor (${product.pricing.min_spend}). Programmatic remnant typically requires a minimum daily spend to clear auction.`,
      };
    }
    return out;
  }

  function computeEffectiveCpm(minCpm: number, targetCpm: number, budget: number): number {
    // Auction-clearing curve. Saturating function that:
    //   - At budget=0: returns ~minCpm (low competition).
    //   - At budget=10x targetCpm: returns ~targetCpm.
    //   - At budget=∞: asymptotes to 2*minCpm (high competition).
    const inflection = targetCpm * 1000; // point where bidding starts pushing CPM up
    const ratio = budget / (budget + inflection);
    const ceiling = minCpm * 2;
    return minCpm + (ceiling - minCpm) * ratio;
  }

  // ────────────────────────────────────────────────────────────
  // Idempotency helpers
  // ────────────────────────────────────────────────────────────

  function checkIdempotency(
    networkCode: string,
    kind: string,
    clientRequestId: string,
    fingerprint: string
  ): { kind: 'replay'; id: string } | { kind: 'conflict' } | { kind: 'fresh' } {
    const key = `${networkCode}::${kind}::${clientRequestId}`;
    const existing = idempotency.get(key);
    if (!existing) return { kind: 'fresh' };
    if (existing.startsWith('409:')) {
      const storedFingerprint = existing.slice(4);
      if (storedFingerprint !== fingerprint) return { kind: 'conflict' };
      return { kind: 'fresh' };
    }
    // existing is "<resourceId>::<fingerprint>"
    const [resourceId, storedFingerprint] = existing.split('::');
    if (!resourceId || !storedFingerprint) return { kind: 'fresh' };
    if (storedFingerprint !== fingerprint) {
      idempotency.set(key, `409:${storedFingerprint}`);
      return { kind: 'conflict' };
    }
    return { kind: 'replay', id: resourceId };
  }

  function recordIdempotency(
    networkCode: string,
    kind: string,
    clientRequestId: string,
    fingerprint: string,
    resourceId: string
  ): void {
    const key = `${networkCode}::${kind}::${clientRequestId}`;
    idempotency.set(key, `${resourceId}::${fingerprint}`);
  }
}

// ────────────────────────────────────────────────────────────
// Helpers (module-scoped, no closure capture needed)
// ────────────────────────────────────────────────────────────

function toWireOrder(order: {
  order_id: string;
  name: string;
  status: string;
  advertiser_id: string;
  currency: string;
  budget: number;
  pacing: string;
  flight_start?: string;
  flight_end?: string;
  line_items: Map<string, unknown>;
  created_at: string;
  updated_at: string;
  rejection_reason?: string;
}): Record<string, unknown> {
  return {
    order_id: order.order_id,
    name: order.name,
    status: order.status,
    advertiser_id: order.advertiser_id,
    currency: order.currency,
    budget: order.budget,
    pacing: order.pacing,
    flight_start: order.flight_start,
    flight_end: order.flight_end,
    line_items: Array.from(order.line_items.values()),
    rejection_reason: order.rejection_reason,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}

function parsePacing(raw: unknown): Pacing {
  if (raw === 'asap' || raw === 'front_loaded' || raw === 'even') return raw;
  return 'even';
}

function pacingCurveAt(pacing: Pacing, elapsed: number): number {
  // Returns fraction-of-budget-spent at the elapsed-fraction-of-flight.
  const t = Math.max(0, Math.min(1, elapsed));
  if (pacing === 'even') return t;
  if (pacing === 'asap') return Math.min(1, t * 3); // 3x acceleration, caps at 100%
  if (pacing === 'front_loaded') return Math.min(1, Math.sqrt(t)); // sqrt curve front-loads
  return t;
}

function computeElapsedPct(order: { flight_start?: string; flight_end?: string; created_at: string }): number {
  if (!order.flight_start || !order.flight_end) return 0.5;
  const start = Date.parse(order.flight_start);
  const end = Date.parse(order.flight_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0.5;
  const now = Date.now();
  if (now <= start) return 0;
  if (now >= end) return 1;
  return (now - start) / (end - start);
}

function ctrFor(channel: 'video' | 'ctv' | 'display' | 'audio'): number {
  // CTR baselines per channel. Programmatic remnant is lower than
  // premium guaranteed.
  if (channel === 'video') return 0.005; // 0.5%
  if (channel === 'ctv') return 0.001; // 0.1% (mostly view-through, low click)
  if (channel === 'audio') return 0.001;
  return 0.001; // display 0.1%
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseDateParam(raw: string | null): string | undefined {
  if (!raw) return undefined;
  // Permissive — accept any string. The forecast hash includes it
  // verbatim; bad input still gives deterministic output.
  return raw;
}

function parsePositiveNumber(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function serializeTargeting(t: unknown): string {
  if (!isObject(t)) return '';
  // Deterministic stringify (recursive sort) so the same targeting
  // produces the same hash regardless of key insertion order. Mirrors
  // the helper from sales-guaranteed/server.ts (commit `c626f750` —
  // the determinism-bug fix lineage).
  return JSON.stringify(deepSort(t));
}

function deepSort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepSort);
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = deepSort(v[k]);
    }
    return out;
  }
  return v;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) {
      writeJson(res, 400, { code: 'invalid_request', message: 'request body must be a JSON object.' });
      return null;
    }
    return parsed;
  } catch (e) {
    writeJson(res, 400, { code: 'invalid_request', message: `malformed JSON: ${(e as Error).message}` });
    return null;
  }
}
