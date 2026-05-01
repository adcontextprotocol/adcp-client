import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
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

type OrderStatus = 'draft' | 'pending_approval' | 'approved' | 'delivering' | 'completed' | 'canceled' | 'rejected';
type LineItemStatus = 'pending_creatives' | 'ready' | 'paused' | 'delivering' | 'completed';
type TaskStatus = 'submitted' | 'working' | 'completed' | 'rejected';

interface OrderState {
  order_id: string;
  network_code: string;
  name: string;
  status: OrderStatus;
  advertiser_id: string;
  currency: string;
  budget?: number;
  approval_task_id?: string;
  rejection_reason?: string;
  /** Line-item children, keyed by line_item_id. */
  line_items: Map<string, LineItemState>;
  /** Conversions ingested via /conversions/ — count + dedup-key set. */
  conversions: { count: number; dedup_keys: Set<string>; total_value: number };
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

interface TaskState {
  task_id: string;
  order_id: string;
  status: TaskStatus;
  /** Number of times the task has been polled. Used to auto-promote
   * `submitted → working → completed` so adapters exercise the polling
   * pattern without the matrix run dragging. */
  poll_count: number;
  result?: { outcome: 'approved' | 'rejected'; reviewer_note: string };
  created_at: string;
  updated_at: string;
}

export async function bootSalesGuaranteed(options: BootOptions): Promise<BootResult> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const networks = options.networks ?? NETWORKS;
  const adUnits = options.adUnits ?? AD_UNITS;
  const products = options.products ?? PRODUCTS;

  const orders = new Map<string, OrderState>();
  const creatives = new Map<string, CreativeState>();
  const tasks = new Map<string, TaskState>();
  // Idempotency table — keyed `<network_code>::<resource_kind>::<client_request_id>`.
  const idempotency = new Map<string, string>();

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
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== apiKey) {
      writeJson(res, 401, { code: 'unauthorized', message: 'Missing or invalid bearer credential.' });
      return;
    }
    const networkHeader = req.headers['x-network-code'];
    const networkCode = Array.isArray(networkHeader) ? networkHeader[0] : networkHeader;
    if (!networkCode) {
      writeJson(res, 403, {
        code: 'network_required',
        message: 'X-Network-Code header is required on every request.',
      });
      return;
    }
    const network = networks.find(n => n.network_code === networkCode);
    if (!network) {
      writeJson(res, 403, { code: 'unknown_network', message: `Unknown network: ${networkCode}` });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/v1/inventory') return handleListInventory(network, res);
    if (method === 'GET' && path === '/v1/products') return handleListProducts(url, network, res);
    if (method === 'GET' && path === '/v1/creatives') return handleListCreatives(network, res);
    if (method === 'POST' && path === '/v1/creatives') return handleCreateCreative(req, network, res);

    if (method === 'GET' && path === '/v1/orders') return handleListOrders(network, res);
    if (method === 'POST' && path === '/v1/orders') return handleCreateOrder(req, network, res);

    const orderMatch = path.match(/^\/v1\/orders\/([^/]+)(\/.*)?$/);
    if (orderMatch && orderMatch[1]) {
      const orderId = decodeURIComponent(orderMatch[1]);
      const subPath = orderMatch[2] ?? '/';
      const order = orders.get(orderId);
      if (!order || order.network_code !== network.network_code) {
        writeJson(res, 404, { code: 'order_not_found', message: `Order ${orderId} not found.` });
        return;
      }
      if (method === 'GET' && subPath === '/') return handleGetOrder(order, res);
      if (method === 'GET' && subPath === '/lineitems') return handleListLineItems(order, res);
      if (method === 'POST' && subPath === '/lineitems') return handleCreateLineItem(req, order, res);
      const liAttachMatch = subPath.match(/^\/lineitems\/([^/]+)\/creative-attach$/);
      if (method === 'POST' && liAttachMatch && liAttachMatch[1]) {
        return handleAttachCreative(req, order, decodeURIComponent(liAttachMatch[1]), res);
      }
      if (method === 'GET' && subPath === '/delivery') return handleGetDelivery(order, res);
      if (method === 'POST' && subPath === '/conversions') return handleIngestConversions(req, order, res);
    }

    const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)$/);
    if (method === 'GET' && taskMatch && taskMatch[1]) {
      return handleGetTask(decodeURIComponent(taskMatch[1]), network, res);
    }

    writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
  }

  // ────────────────────────────────────────────────────────────
  // Inventory + Products + Creatives
  // ────────────────────────────────────────────────────────────
  function handleListInventory(network: MockNetwork, res: ServerResponse): void {
    const visible = adUnits.filter(au => au.network_code === network.network_code);
    writeJson(res, 200, { ad_units: visible });
  }

  function handleListProducts(url: URL, network: MockNetwork, res: ServerResponse): void {
    let visible = products.filter(p => p.network_code === network.network_code);
    const deliveryType = url.searchParams.get('delivery_type');
    const channel = url.searchParams.get('channel');
    if (deliveryType) visible = visible.filter(p => p.delivery_type === deliveryType);
    if (channel) visible = visible.filter(p => p.channel === channel);
    writeJson(res, 200, { products: visible });
  }

  function handleListCreatives(network: MockNetwork, res: ServerResponse): void {
    const list = Array.from(creatives.values()).filter(c => c.network_code === network.network_code);
    writeJson(res, 200, { creatives: list.map(stripBodyFingerprint) });
  }

  async function handleCreateCreative(req: IncomingMessage, network: MockNetwork, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { name, format_id, advertiser_id, snippet, client_request_id } = body as Record<string, unknown>;
    if (typeof name !== 'string' || typeof format_id !== 'string' || typeof advertiser_id !== 'string') {
      writeJson(res, 400, { code: 'invalid_request', message: 'name, format_id, advertiser_id are required.' });
      return;
    }
    const fingerprint = JSON.stringify({ name, format_id, advertiser_id, snippet });
    const replay = checkIdempotentReplay(network.network_code, 'creative', client_request_id, fingerprint);
    if (replay.kind === 'conflict') {
      writeJson(res, 409, { code: 'idempotency_conflict', message: replay.message });
      return;
    }
    if (replay.kind === 'replay') {
      const existing = creatives.get(replay.id);
      if (existing) {
        writeJson(res, 200, stripBodyFingerprint(existing));
        return;
      }
    }
    const id = `cr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const cr: CreativeState = {
      creative_id: id,
      network_code: network.network_code,
      name,
      format_id,
      advertiser_id,
      snippet: typeof snippet === 'string' ? snippet : undefined,
      status: 'active',
      body_fingerprint: fingerprint,
      created_at: new Date().toISOString(),
    };
    creatives.set(id, cr);
    if (typeof client_request_id === 'string' && client_request_id.length > 0) {
      idempotency.set(`${network.network_code}::creative::${client_request_id}`, id);
    }
    writeJson(res, 201, stripBodyFingerprint(cr));
  }

  // ────────────────────────────────────────────────────────────
  // Orders + state machine
  // ────────────────────────────────────────────────────────────
  function handleListOrders(network: MockNetwork, res: ServerResponse): void {
    const list = Array.from(orders.values()).filter(o => o.network_code === network.network_code);
    writeJson(res, 200, { orders: list.map(serializeOrder) });
  }

  async function handleCreateOrder(req: IncomingMessage, network: MockNetwork, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { name, advertiser_id, currency, budget, client_request_id } = body as Record<string, unknown>;
    if (
      typeof name !== 'string' ||
      typeof advertiser_id !== 'string' ||
      typeof currency !== 'string' ||
      typeof budget !== 'number'
    ) {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'name, advertiser_id, currency, budget are all required.',
      });
      return;
    }
    const fingerprint = JSON.stringify({ name, advertiser_id, currency, budget });
    const replay = checkIdempotentReplay(network.network_code, 'order', client_request_id, fingerprint);
    if (replay.kind === 'conflict') {
      writeJson(res, 409, { code: 'idempotency_conflict', message: replay.message });
      return;
    }
    if (replay.kind === 'replay') {
      const existing = orders.get(replay.id);
      if (existing) {
        writeJson(res, 200, serializeOrder(existing));
        return;
      }
    }
    const id = `ord_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const taskId = `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const order: OrderState = {
      order_id: id,
      network_code: network.network_code,
      name,
      status: 'pending_approval',
      advertiser_id,
      currency,
      budget,
      approval_task_id: taskId,
      line_items: new Map(),
      conversions: { count: 0, dedup_keys: new Set(), total_value: 0 },
      body_fingerprint: fingerprint,
      created_at: now,
      updated_at: now,
    };
    orders.set(id, order);
    tasks.set(taskId, {
      task_id: taskId,
      order_id: id,
      status: 'submitted',
      poll_count: 0,
      created_at: now,
      updated_at: now,
    });
    if (typeof client_request_id === 'string' && client_request_id.length > 0) {
      idempotency.set(`${network.network_code}::order::${client_request_id}`, id);
    }
    writeJson(res, 201, serializeOrder(order));
  }

  function handleGetOrder(order: OrderState, res: ServerResponse): void {
    // Auto-promote pending_approval orders by checking the task. Real
    // platforms rely on a human review workflow; the mock advances on
    // poll counts so adapters exercise the polling pattern without the
    // matrix run dragging.
    if (order.status === 'pending_approval' && order.approval_task_id) {
      const task = tasks.get(order.approval_task_id);
      if (task && task.status === 'completed' && task.result?.outcome === 'approved') {
        order.status = 'approved';
        order.updated_at = new Date().toISOString();
        order.approval_task_id = undefined;
        // Promote any pending line items that have creatives → delivering.
        for (const li of order.line_items.values()) {
          if (li.creative_ids.length > 0 && li.status === 'pending_creatives') {
            li.status = 'delivering';
          }
        }
      } else if (task && task.status === 'rejected') {
        order.status = 'rejected';
        order.rejection_reason = task.result?.reviewer_note ?? 'Order rejected by IO review.';
        order.updated_at = new Date().toISOString();
        order.approval_task_id = undefined;
      }
    }
    if (order.status === 'approved') {
      // After approval, naturally transition to delivering on first GET.
      // Mirrors GAM's auto-activation once IO is signed.
      order.status = 'delivering';
      order.updated_at = new Date().toISOString();
    }
    writeJson(res, 200, serializeOrder(order));
  }

  function handleListLineItems(order: OrderState, res: ServerResponse): void {
    writeJson(res, 200, {
      line_items: Array.from(order.line_items.values()).map(stripBodyFingerprint),
    });
  }

  async function handleCreateLineItem(req: IncomingMessage, order: OrderState, res: ServerResponse): Promise<void> {
    if (order.status === 'completed' || order.status === 'canceled' || order.status === 'rejected') {
      writeJson(res, 422, {
        code: 'invalid_state_transition',
        message: `Cannot add line items to an order in terminal status: ${order.status}.`,
      });
      return;
    }
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { product_id, budget, ad_unit_targeting, client_request_id } = body as Record<string, unknown>;
    if (typeof product_id !== 'string' || typeof budget !== 'number') {
      writeJson(res, 400, { code: 'invalid_request', message: 'product_id and budget are required.' });
      return;
    }
    const targeting = Array.isArray(ad_unit_targeting)
      ? (ad_unit_targeting.filter(x => typeof x === 'string') as string[])
      : [];
    const fingerprint = JSON.stringify({ order_id: order.order_id, product_id, budget, ad_unit_targeting: targeting });
    const replay = checkIdempotentReplay(order.network_code, 'lineitem', client_request_id, fingerprint);
    if (replay.kind === 'conflict') {
      writeJson(res, 409, { code: 'idempotency_conflict', message: replay.message });
      return;
    }
    if (replay.kind === 'replay') {
      const existing = order.line_items.get(replay.id);
      if (existing) {
        writeJson(res, 200, stripBodyFingerprint(existing));
        return;
      }
    }
    const id = `li_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const li: LineItemState = {
      line_item_id: id,
      order_id: order.order_id,
      product_id,
      status: 'pending_creatives',
      budget,
      ad_unit_targeting: targeting,
      creative_ids: [],
      body_fingerprint: fingerprint,
      created_at: new Date().toISOString(),
    };
    order.line_items.set(id, li);
    if (typeof client_request_id === 'string' && client_request_id.length > 0) {
      idempotency.set(`${order.network_code}::lineitem::${client_request_id}`, id);
    }
    writeJson(res, 201, stripBodyFingerprint(li));
  }

  function handleAttachCreative(
    req: IncomingMessage,
    order: OrderState,
    lineItemId: string,
    res: ServerResponse
  ): void {
    void readJsonObject(req, res).then(body => {
      if (!body) return;
      const li = order.line_items.get(lineItemId);
      if (!li) {
        writeJson(res, 404, { code: 'line_item_not_found', message: `Line item ${lineItemId} not found.` });
        return;
      }
      const { creative_id } = body as Record<string, unknown>;
      if (typeof creative_id !== 'string') {
        writeJson(res, 400, { code: 'invalid_request', message: 'creative_id is required.' });
        return;
      }
      if (!li.creative_ids.includes(creative_id)) li.creative_ids.push(creative_id);
      // Promote the line item to delivering if the order is already approved.
      if (order.status === 'delivering' || order.status === 'approved') {
        li.status = 'delivering';
      } else {
        li.status = 'ready';
      }
      writeJson(res, 200, stripBodyFingerprint(li));
    });
  }

  // ────────────────────────────────────────────────────────────
  // Approval task polling — auto-progress submitted → working → completed
  // ────────────────────────────────────────────────────────────
  function handleGetTask(taskId: string, network: MockNetwork, res: ServerResponse): void {
    const task = tasks.get(taskId);
    if (!task) {
      writeJson(res, 404, { code: 'task_not_found', message: `Task ${taskId} not found.` });
      return;
    }
    const order = orders.get(task.order_id);
    if (!order || order.network_code !== network.network_code) {
      writeJson(res, 404, { code: 'task_not_found', message: `Task ${taskId} not found.` });
      return;
    }
    task.poll_count++;
    if (task.status === 'submitted' && task.poll_count >= 1) {
      task.status = 'working';
      task.updated_at = new Date().toISOString();
    } else if (task.status === 'working' && task.poll_count >= 2) {
      task.status = 'completed';
      task.result = { outcome: 'approved', reviewer_note: 'IO signed; approved for delivery.' };
      task.updated_at = new Date().toISOString();
    }
    writeJson(res, 200, {
      task_id: task.task_id,
      order_id: task.order_id,
      status: task.status,
      result: task.result,
      created_at: task.created_at,
      updated_at: task.updated_at,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Delivery reporting + CAPI conversion ingestion
  // ────────────────────────────────────────────────────────────
  function handleGetDelivery(order: OrderState, res: ServerResponse): void {
    // Synthesize plausible delivery numbers based on order budget and
    // status. Real platforms compute from impression logs; the mock
    // produces stable, deterministic-feeling numbers for storyboard graders.
    const isLive = order.status === 'delivering' || order.status === 'completed';
    const budget = order.budget ?? 50_000;
    const totalSpend = isLive ? Math.min(budget * 0.4, budget) : 0;
    const cpm = 35;
    const impressions = isLive ? Math.floor((totalSpend / cpm) * 1000) : 0;
    const clicks = Math.floor(impressions * 0.0042);
    const viewable = Math.floor(impressions * 0.71);
    const completions = Math.floor(impressions * 0.78);
    writeJson(res, 200, {
      order_id: order.order_id,
      currency: order.currency,
      reporting_period: {
        start: order.created_at,
        end: new Date().toISOString(),
      },
      totals: {
        impressions,
        clicks,
        spend: totalSpend,
        viewable_impressions: viewable,
        video_completions: completions,
        conversions: order.conversions.count,
      },
      line_item_breakdown: Array.from(order.line_items.values()).map(li => ({
        line_item_id: li.line_item_id,
        impressions: Math.floor(impressions / Math.max(1, order.line_items.size)),
        spend: totalSpend / Math.max(1, order.line_items.size),
      })),
    });
  }

  async function handleIngestConversions(req: IncomingMessage, order: OrderState, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { conversions } = body as Record<string, unknown>;
    if (!Array.isArray(conversions) || conversions.length === 0) {
      writeJson(res, 400, { code: 'empty_conversions', message: 'conversions must be a non-empty array.' });
      return;
    }
    let received = 0;
    let dedup = 0;
    for (const c of conversions) {
      if (!c || typeof c !== 'object') continue;
      const conv = c as Record<string, unknown>;
      if (typeof conv.event_name !== 'string' || typeof conv.event_time !== 'number') continue;
      const value = typeof conv.value === 'number' ? conv.value : 0;
      const dedupKey = typeof conv.dedup_key === 'string' ? conv.dedup_key : null;
      if (dedupKey && order.conversions.dedup_keys.has(dedupKey)) {
        dedup++;
        continue;
      }
      if (dedupKey) order.conversions.dedup_keys.add(dedupKey);
      order.conversions.count++;
      order.conversions.total_value += value;
      received++;
    }
    writeJson(res, 200, {
      order_id: order.order_id,
      events_received: received,
      events_deduplicated: dedup,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────
  function checkIdempotentReplay(
    networkCode: string,
    resourceKind: string,
    clientRequestId: unknown,
    fingerprint: string
  ): { kind: 'replay'; id: string } | { kind: 'conflict'; message: string } | { kind: 'fresh' } {
    if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) return { kind: 'fresh' };
    const key = `${networkCode}::${resourceKind}::${clientRequestId}`;
    const existingId = idempotency.get(key);
    if (!existingId) return { kind: 'fresh' };
    const stored = lookupResource(resourceKind, existingId);
    if (!stored) return { kind: 'fresh' };
    if (stored.body_fingerprint !== fingerprint) {
      return {
        kind: 'conflict',
        message: `client_request_id ${clientRequestId} was previously used with a different body. Use a fresh idempotency key for distinct requests.`,
      };
    }
    return { kind: 'replay', id: existingId };
  }

  function lookupResource(kind: string, id: string): { body_fingerprint: string } | undefined {
    if (kind === 'order') return orders.get(id);
    if (kind === 'creative') return creatives.get(id);
    if (kind === 'lineitem') {
      for (const order of orders.values()) {
        const li = order.line_items.get(id);
        if (li) return li;
      }
      return undefined;
    }
    return undefined;
  }

  function serializeOrder(order: OrderState): Record<string, unknown> {
    const { body_fingerprint, line_items, conversions, ...rest } = order;
    return rest;
  }
}

function stripBodyFingerprint<T extends { body_fingerprint?: string }>(record: T): Omit<T, 'body_fingerprint'> {
  const { body_fingerprint, ...rest } = record;
  return rest;
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    writeJson(res, 400, { code: 'invalid_json', message: 'Request body must be valid JSON.' });
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    writeJson(res, 400, { code: 'invalid_request', message: 'Body must be a JSON object.' });
    return null;
  }
  return body as Record<string, unknown>;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}
