import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  BRANDS,
  DEFAULT_API_KEY,
  OFFERINGS,
  SEED_NOW,
  type MockBrand,
  type MockOffering,
  type MockProduct,
} from './seed-data';

export interface BootOptions {
  port: number;
  apiKey?: string;
  brands?: MockBrand[];
  offerings?: MockOffering[];
}

export interface BootResult {
  url: string;
  close: () => Promise<void>;
}

type ConversationStatus = 'active' | 'closed';

interface MockTurn {
  turn_id: string;
  conversation_id: string;
  /** Adapter sends `client_request_id` (translated from AdCP idempotency_key)
   * on POST /turns; same key replayed returns the same turn rather than
   * generating a duplicate. */
  body_fingerprint: string;
  user_message: string | null;
  assistant_message: string;
  components: Array<Record<string, unknown>>;
  /** Brand-side hint to the adapter that the next state should be a
   * close. Adapter decides whether to surface this as AdCP
   * `session_status: 'pending_handoff'` + `handoff: {...}` to the host. */
  close_recommended: { type: 'transaction' | 'complete'; payload?: Record<string, unknown> } | null;
  created_at: string;
}

interface MockConversation {
  conversation_id: string;
  brand_id: string;
  status: ConversationStatus;
  /** Offering context resolved at conversation start. The brand stores this
   * server-side so subsequent turns can reference 'the second one' etc. */
  offering_id: string | null;
  intent: string;
  turns: MockTurn[];
  /** Set when the conversation was closed. Includes the reason and any
   * transaction handoff payload. */
  close: {
    reason: string;
    closed_at: string;
    transaction_handoff: Record<string, unknown> | null;
  } | null;
  created_at: string;
  updated_at: string;
}

export async function bootSponsoredIntelligence(options: BootOptions): Promise<BootResult> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const brands = options.brands ?? BRANDS;
  const offerings = options.offerings ?? OFFERINGS;

  const conversations = new Map<string, MockConversation>();
  // client_request_id idempotency for POST /conversations and POST /turns.
  // Keyed by `<brand_id>::<scope>::<key>` where scope = "init" or
  // "<conversation_id>".
  const idempotency = new Map<string, string>();

  const traffic = new Map<string, number>();
  const bump = (routeTemplate: string): void => {
    traffic.set(routeTemplate, (traffic.get(routeTemplate) ?? 0) + 1);
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, { apiKey, brands, offerings, conversations, idempotency, traffic, bump }).catch(err => {
      const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
      writeJson(res, 500, {
        code: 'internal_error',
        message: err?.message ?? 'unexpected error',
        request_id: requestId,
      });
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
}

interface HandlerCtx {
  apiKey: string;
  brands: MockBrand[];
  offerings: MockOffering[];
  conversations: Map<string, MockConversation>;
  idempotency: Map<string, string>;
  traffic: Map<string, number>;
  bump: (routeTemplate: string) => void;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/_debug/traffic') {
    writeJson(res, 200, { traffic: Object.fromEntries(ctx.traffic) });
    return;
  }

  // Discovery — adapter resolves AdCP-side brand identifier to upstream
  // brand_id at runtime. No auth required (discovery happens before the
  // agent has a brand context).
  if (method === 'GET' && path === '/_lookup/brand') {
    ctx.bump('GET /_lookup/brand');
    const adcpBrand = url.searchParams.get('adcp_brand');
    if (!adcpBrand) {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'adcp_brand query parameter is required.',
      });
      return;
    }
    const match = ctx.brands.find(b => b.adcp_brand === adcpBrand);
    if (!match) {
      writeJson(res, 404, {
        code: 'brand_not_found',
        message: `No upstream brand registered for adcp_brand=${adcpBrand}.`,
      });
      return;
    }
    writeJson(res, 200, {
      adcp_brand: match.adcp_brand,
      brand_id: match.brand_id,
      display_name: match.display_name,
    });
    return;
  }

  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== ctx.apiKey) {
    writeJson(res, 401, { code: 'unauthorized', message: 'Missing or invalid bearer credential.' });
    return;
  }

  const brandMatch = path.match(/^\/v1\/brands\/([^/]+)(\/.*)?$/);
  if (!brandMatch || !brandMatch[1]) {
    writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
    return;
  }
  const brandId = decodeURIComponent(brandMatch[1]);
  const subPath = brandMatch[2] ?? '/';
  const brand = ctx.brands.find(b => b.brand_id === brandId);
  if (!brand) {
    writeJson(res, 404, { code: 'brand_not_found', message: `Brand ${brandId} not found.` });
    return;
  }

  const offMatch = subPath.match(/^\/offerings\/([^/]+)$/);
  if (method === 'GET' && offMatch && offMatch[1]) {
    ctx.bump('GET /v1/brands/{brand}/offerings/{id}');
    return handleGetOffering(decodeURIComponent(offMatch[1]), url, ctx, brand, res);
  }

  if (method === 'POST' && subPath === '/conversations') {
    ctx.bump('POST /v1/brands/{brand}/conversations');
    return handleStartConversation(req, ctx, brand, res);
  }

  const turnsMatch = subPath.match(/^\/conversations\/([^/]+)\/turns$/);
  if (method === 'POST' && turnsMatch && turnsMatch[1]) {
    ctx.bump('POST /v1/brands/{brand}/conversations/{id}/turns');
    return handleSendTurn(decodeURIComponent(turnsMatch[1]), req, ctx, brand, res);
  }

  const closeMatch = subPath.match(/^\/conversations\/([^/]+)\/close$/);
  if (method === 'POST' && closeMatch && closeMatch[1]) {
    ctx.bump('POST /v1/brands/{brand}/conversations/{id}/close');
    return handleCloseConversation(decodeURIComponent(closeMatch[1]), req, ctx, brand, res);
  }

  const convMatch = subPath.match(/^\/conversations\/([^/]+)$/);
  if (method === 'GET' && convMatch && convMatch[1]) {
    ctx.bump('GET /v1/brands/{brand}/conversations/{id}');
    return handleGetConversation(decodeURIComponent(convMatch[1]), ctx, brand, res);
  }

  writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
}

function handleGetOffering(offeringId: string, url: URL, ctx: HandlerCtx, brand: MockBrand, res: ServerResponse): void {
  const offering = ctx.offerings.find(o => o.offering_id === offeringId);
  if (!offering) {
    writeJson(res, 404, { code: 'offering_not_found', message: `Offering ${offeringId} not found.` });
    return;
  }
  if (!brand.visible_offering_ids.includes(offeringId)) {
    writeJson(res, 404, {
      code: 'offering_not_in_brand',
      message: `Offering ${offeringId} is not owned by brand ${brand.brand_id}.`,
    });
    return;
  }
  const includeProducts = url.searchParams.get('include_products') === 'true';
  const limitParam = url.searchParams.get('product_limit');
  const limit = limitParam ? Math.max(0, Number(limitParam)) : offering.products.length;
  const products = includeProducts ? offering.products.slice(0, limit) : [];
  writeJson(res, 200, {
    offering_id: offering.offering_id,
    brand_id: offering.brand_id,
    name: offering.name,
    summary: offering.summary,
    tagline: offering.tagline,
    hero_image_url: offering.hero_image_url,
    landing_page_url: offering.landing_page_url,
    price_hint: offering.price_hint,
    expires_at: offering.expires_at,
    available: true,
    products,
    total_matching: offering.products.length,
    privacy_policy: {
      url: brand.privacy_policy_url,
      version: brand.privacy_policy_version,
    },
  });
}

async function handleStartConversation(
  req: IncomingMessage,
  ctx: HandlerCtx,
  brand: MockBrand,
  res: ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    writeJson(res, 400, { code: 'invalid_json', message: 'Request body must be valid JSON.' });
    return;
  }
  if (!isObject(body)) {
    writeJson(res, 400, { code: 'invalid_request', message: 'Body must be an object.' });
    return;
  }
  const { intent, offering_id, identity, client_request_id } = body as Record<string, unknown>;
  if (typeof intent !== 'string' || intent.length === 0) {
    writeJson(res, 400, { code: 'invalid_request', message: 'intent (string) is required.' });
    return;
  }
  if (offering_id !== undefined && typeof offering_id !== 'string') {
    writeJson(res, 400, { code: 'invalid_request', message: 'offering_id must be a string when provided.' });
    return;
  }
  if (offering_id && !brand.visible_offering_ids.includes(offering_id)) {
    writeJson(res, 404, {
      code: 'offering_not_in_brand',
      message: `Offering ${offering_id} is not owned by brand ${brand.brand_id}.`,
    });
    return;
  }

  const fingerprint = JSON.stringify({ brand: brand.brand_id, intent, offering_id: offering_id ?? null, identity });

  if (typeof client_request_id === 'string' && client_request_id.length > 0) {
    const idemKey = `${brand.brand_id}::init::${client_request_id}`;
    const existing = ctx.idempotency.get(idemKey);
    if (existing) {
      const conv = ctx.conversations.get(existing);
      if (conv) {
        writeJson(res, 200, serializeConversation(conv, brand));
        return;
      }
    }
  }

  const offering = offering_id ? (ctx.offerings.find(o => o.offering_id === offering_id) ?? null) : null;
  const greeting = offering
    ? `Welcome — happy to help you find the right ${offering.name.toLowerCase()}.`
    : `Hi from ${brand.display_name}. What are you looking for today?`;
  const initialTurn: MockTurn = {
    turn_id: `turn_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    conversation_id: '',
    body_fingerprint: fingerprint,
    user_message: null,
    assistant_message: greeting,
    components: offering && offering.products[0] ? [productCardComponent(offering.products[0])] : [],
    close_recommended: null,
    created_at: SEED_NOW,
  };
  const conversationId = `conv_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  initialTurn.conversation_id = conversationId;
  const conversation: MockConversation = {
    conversation_id: conversationId,
    brand_id: brand.brand_id,
    status: 'active',
    offering_id: offering?.offering_id ?? null,
    intent,
    turns: [initialTurn],
    close: null,
    created_at: SEED_NOW,
    updated_at: SEED_NOW,
  };
  ctx.conversations.set(conversationId, conversation);
  if (typeof client_request_id === 'string' && client_request_id.length > 0) {
    ctx.idempotency.set(`${brand.brand_id}::init::${client_request_id}`, conversationId);
  }
  writeJson(res, 201, serializeConversation(conversation, brand));
}

async function handleSendTurn(
  conversationId: string,
  req: IncomingMessage,
  ctx: HandlerCtx,
  brand: MockBrand,
  res: ServerResponse
): Promise<void> {
  const conversation = ctx.conversations.get(conversationId);
  if (!conversation || conversation.brand_id !== brand.brand_id) {
    writeJson(res, 404, {
      code: 'conversation_not_found',
      message: `Conversation ${conversationId} not found in brand ${brand.brand_id}.`,
    });
    return;
  }
  if (conversation.status !== 'active') {
    writeJson(res, 409, {
      code: 'conversation_closed',
      message: `Conversation ${conversationId} is ${conversation.status}; cannot accept new turns.`,
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    writeJson(res, 400, { code: 'invalid_json', message: 'Request body must be valid JSON.' });
    return;
  }
  if (!isObject(body)) {
    writeJson(res, 400, { code: 'invalid_request', message: 'Body must be an object.' });
    return;
  }
  const { message, action_response, client_request_id } = body as Record<string, unknown>;
  const userMessage = typeof message === 'string' ? message : null;
  if (!userMessage && !isObject(action_response)) {
    writeJson(res, 400, {
      code: 'invalid_request',
      message: 'Body must include a `message` (string) or `action_response` (object).',
    });
    return;
  }

  const fingerprint = JSON.stringify({ message: userMessage, action_response: action_response ?? null });

  if (typeof client_request_id === 'string' && client_request_id.length > 0) {
    const idemKey = `${brand.brand_id}::${conversationId}::${client_request_id}`;
    const existingTurnId = ctx.idempotency.get(idemKey);
    if (existingTurnId) {
      const replay = conversation.turns.find(t => t.turn_id === existingTurnId);
      if (replay) {
        if (replay.body_fingerprint !== fingerprint) {
          writeJson(res, 409, {
            code: 'idempotency_conflict',
            message: `client_request_id ${client_request_id} previously used with a different body.`,
          });
          return;
        }
        writeJson(res, 200, serializeTurn(replay, conversation, brand));
        return;
      }
    }
  }

  const offering = conversation.offering_id
    ? (ctx.offerings.find(o => o.offering_id === conversation.offering_id) ?? null)
    : null;
  const reply = generateReply(userMessage, action_response, offering);
  const turn: MockTurn = {
    turn_id: `turn_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    conversation_id: conversationId,
    body_fingerprint: fingerprint,
    user_message: userMessage,
    assistant_message: reply.assistant_message,
    components: reply.components,
    close_recommended: reply.close_recommended,
    created_at: SEED_NOW,
  };
  conversation.turns.push(turn);
  conversation.updated_at = SEED_NOW;
  if (typeof client_request_id === 'string' && client_request_id.length > 0) {
    ctx.idempotency.set(`${brand.brand_id}::${conversationId}::${client_request_id}`, turn.turn_id);
  }
  writeJson(res, 200, serializeTurn(turn, conversation, brand));
}

async function handleCloseConversation(
  conversationId: string,
  req: IncomingMessage,
  ctx: HandlerCtx,
  brand: MockBrand,
  res: ServerResponse
): Promise<void> {
  const conversation = ctx.conversations.get(conversationId);
  if (!conversation || conversation.brand_id !== brand.brand_id) {
    writeJson(res, 404, {
      code: 'conversation_not_found',
      message: `Conversation ${conversationId} not found in brand ${brand.brand_id}.`,
    });
    return;
  }

  let body: unknown = {};
  try {
    body = await readJson(req);
  } catch {
    writeJson(res, 400, { code: 'invalid_json', message: 'Request body must be valid JSON.' });
    return;
  }
  if (!isObject(body)) body = {};
  const { reason, summary } = body as Record<string, unknown>;
  const reasonStr = typeof reason === 'string' ? reason : 'host_terminated';

  // Idempotent close: a second close on an already-closed conversation
  // returns the same payload. session_id is the dedup boundary; AdCP
  // si_terminate_session has no idempotency_key for exactly this reason.
  if (conversation.status === 'closed') {
    writeJson(res, 200, serializeConversation(conversation, brand));
    return;
  }

  const offering = conversation.offering_id
    ? (ctx.offerings.find(o => o.offering_id === conversation.offering_id) ?? null)
    : null;
  const transactionHandoff =
    reasonStr === 'transaction'
      ? {
          checkout_url: `${offering ? offering.landing_page_url : `https://${brand.adcp_brand}/checkout`}?conv=${conversationId}`,
          checkout_token: `acp_tok_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          expires_at: '2026-04-15T13:00:00Z',
          payload: {
            conversation_summary:
              typeof summary === 'string' && summary.length > 0
                ? summary
                : `User reached transaction handoff in conversation ${conversationId}.`,
            applied_offers: conversation.offering_id ? [conversation.offering_id] : [],
          },
        }
      : null;

  conversation.status = 'closed';
  conversation.close = {
    reason: reasonStr,
    closed_at: SEED_NOW,
    transaction_handoff: transactionHandoff,
  };
  conversation.updated_at = SEED_NOW;
  writeJson(res, 200, serializeConversation(conversation, brand));
}

function handleGetConversation(conversationId: string, ctx: HandlerCtx, brand: MockBrand, res: ServerResponse): void {
  const conversation = ctx.conversations.get(conversationId);
  if (!conversation || conversation.brand_id !== brand.brand_id) {
    writeJson(res, 404, {
      code: 'conversation_not_found',
      message: `Conversation ${conversationId} not found in brand ${brand.brand_id}.`,
    });
    return;
  }
  writeJson(res, 200, serializeConversation(conversation, brand));
}

function generateReply(
  userMessage: string | null,
  actionResponse: unknown,
  offering: MockOffering | null
): {
  assistant_message: string;
  components: Array<Record<string, unknown>>;
  close_recommended: { type: 'transaction' | 'complete'; payload?: Record<string, unknown> } | null;
} {
  if (isObject(actionResponse) && (actionResponse as Record<string, unknown>).action === 'checkout') {
    return {
      assistant_message: 'Got it — sending you to checkout now.',
      components: [],
      close_recommended: {
        type: 'transaction',
        payload: { product: offering?.products[0] ?? {}, action: 'purchase' },
      },
    };
  }
  const lower = (userMessage ?? '').toLowerCase();
  if (/\b(buy|purchase|checkout|order)\b/.test(lower)) {
    return {
      assistant_message: 'Great — ready when you are. Want me to take you to checkout?',
      components: [
        { kind: 'action_button', label: 'Checkout', action: 'checkout' },
        ...(offering?.products[0] ? [productCardComponent(offering.products[0])] : []),
      ],
      close_recommended: {
        type: 'transaction',
        payload: offering?.products[0] ? { product: offering.products[0], action: 'purchase' } : { action: 'purchase' },
      },
    };
  }
  if (/\b(thanks|thank you|bye|goodbye|done|that's all)\b/.test(lower)) {
    return {
      assistant_message: 'Anytime — happy shopping!',
      components: [],
      close_recommended: { type: 'complete' },
    };
  }
  if (/\b(second|other one|next)\b/.test(lower) && offering && offering.products[1]) {
    return {
      assistant_message: `Here's a closer look at ${offering.products[1].name}.`,
      components: [productCardComponent(offering.products[1])],
      close_recommended: null,
    };
  }
  return {
    assistant_message: offering
      ? `Here's what I'd recommend from the ${offering.name}.`
      : 'Tell me a bit more about what you have in mind.',
    components: offering?.products[0] ? [productCardComponent(offering.products[0])] : [],
    close_recommended: null,
  };
}

function productCardComponent(product: MockProduct): Record<string, unknown> {
  return {
    kind: 'product_card',
    sku: product.sku,
    name: product.name,
    display_price: product.display_price,
    list_price: product.list_price,
    thumbnail_url: product.thumbnail_url,
    pdp_url: product.pdp_url,
    inventory_status: product.inventory_status,
  };
}

function serializeConversation(conv: MockConversation, brand: MockBrand): Record<string, unknown> {
  return {
    conversation_id: conv.conversation_id,
    brand_id: conv.brand_id,
    status: conv.status,
    offering_id: conv.offering_id,
    intent: conv.intent,
    turns: conv.turns.map(t => stripInternal(t)),
    close: conv.close,
    session_ttl_seconds: brand.session_ttl_seconds,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
  };
}

function serializeTurn(turn: MockTurn, conv: MockConversation, brand: MockBrand): Record<string, unknown> {
  return {
    ...stripInternal(turn),
    conversation_status: conv.status,
    session_ttl_seconds: brand.session_ttl_seconds,
  };
}

function stripInternal(turn: MockTurn): Record<string, unknown> {
  const { body_fingerprint: _bf, ...rest } = turn;
  return rest;
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

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
