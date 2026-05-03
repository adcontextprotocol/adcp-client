/**
 * hello_si_adapter_brand — worked starting point for an AdCP Sponsored
 * Intelligence agent (protocol `sponsored_intelligence`) that wraps an
 * upstream brand-agent platform via HTTP.
 *
 * Fork this. Replace `upstream` with calls to your real backend
 * (Salesforce Agentforce, OpenAI Assistants brand mode, custom brand
 * chat). The AdCP-facing platform methods stay the same.
 *
 * **Status**: SI is a *protocol* in AdCP 3.0, not a specialism. Spec change
 * to add it to `AdCPSpecialism` is tracked at adcontextprotocol/adcp#3961
 * for 3.1. Until then the SDK dispatches off the
 * `platform.sponsoredIntelligence` field's presence — which auto-derives
 * `'sponsored_intelligence'` into the wire-side `supported_protocols`
 * via `detectProtocols`.
 *
 * FORK CHECKLIST
 *   1. Replace every `// SWAP:` marker with calls to your backend.
 *   2. Replace `DEFAULT_LISTING_BRAND` with `ctx.authInfo`-derived per-tenant
 *      binding (the env-driven default is a multi-brand footgun in production).
 *   3. Production brand engines almost always own full transcript state in
 *      their own backend (Postgres, Redis, vector DB). The auto-hydrated
 *      `req.session` covers fixture/mock cases and the
 *      "what-was-the-original-scope" lookup; do NOT model full transcripts
 *      into ctx_metadata — you'll hit the 16KB blob cap.
 *   4. Validate: `node --test test/examples/hello-si-adapter-brand.test.js`
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server sponsored-intelligence --port 4504
 *   UPSTREAM_URL=http://127.0.0.1:4504 \
 *     npx tsx examples/hello_si_adapter_brand.ts
 *   curl http://127.0.0.1:4504/_debug/traffic
 *
 * Production:
 *   UPSTREAM_URL=https://my-brand-platform.example/api UPSTREAM_API_KEY=… \
 *     PUBLIC_AGENT_URL=https://my-agent.example.com \
 *     npx tsx examples/hello_si_adapter_brand.ts
 */

import {
  createAdcpServerFromPlatform,
  definePlatform,
  defineSponsoredIntelligencePlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  createUpstreamHttpClient,
  memoryBackend,
  AdcpError,
  type AccountStore,
  type Account,
} from '@adcp/sdk/server';
import type {
  SIGetOfferingRequest,
  SIGetOfferingResponse,
  SIInitiateSessionRequest,
  SIInitiateSessionResponse,
  SISendMessageRequest,
  SISendMessageResponse,
  SITerminateSessionRequest,
  SITerminateSessionResponse,
  SIUIElement,
  SISessionStatus,
} from '@adcp/sdk';

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4504';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_si_brand_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3004);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';
// Default brand used when a tool call lacks `account` resolution context.
// SWAP: production should derive this from `ctx.authInfo` (per-API-key
// tenant binding). Env-driven default is a multi-brand footgun.
const DEFAULT_LISTING_BRAND = process.env['DEFAULT_LISTING_BRAND'] ?? 'brand_acme_outdoor';

// ---------------------------------------------------------------------------
// Upstream client — SWAP for production.
// ---------------------------------------------------------------------------

interface UpstreamProduct {
  sku: string;
  name: string;
  display_price: string;
  list_price?: string;
  thumbnail_url: string;
  pdp_url: string;
  inventory_status: string;
}

interface UpstreamOffering {
  offering_id: string;
  brand_id: string;
  name: string;
  summary: string;
  tagline?: string;
  hero_image_url: string;
  landing_page_url: string;
  price_hint: string;
  expires_at: string;
  available: boolean;
  products: UpstreamProduct[];
  total_matching: number;
  offering_query_id?: string;
  offering_query_expires_at?: string;
  offering_query_ttl_seconds?: number;
}

/** Upstream component vocabulary — `kind` field discriminates. AdCP uses
 *  `type` (rename) on `SIUIElement`. */
interface UpstreamComponent {
  kind: string;
  [k: string]: unknown;
}

interface UpstreamTurn {
  turn_id: string;
  conversation_id: string;
  user_message: string | null;
  assistant_message: string;
  components: UpstreamComponent[];
  close_recommended: { type: 'txn_ready' | 'done'; payload?: Record<string, unknown> } | null;
  created_at: string;
  conversation_status?: 'active' | 'closed';
  session_ttl_seconds?: number;
}

interface UpstreamConversation {
  conversation_id: string;
  brand_id: string;
  status: 'active' | 'closed';
  offering_id: string | null;
  offering_query_id: string | null;
  shown_product_skus: string[];
  intent: string;
  turns: UpstreamTurn[];
  close: {
    reason: 'txn_ready' | 'done' | 'user_left' | 'idle_timeout' | 'host_closed';
    closed_at: string;
    transaction_handoff: {
      checkout_url?: string;
      checkout_token?: string;
      expires_at?: string;
      payload?: Record<string, unknown>;
    } | null;
  } | null;
  session_ttl_seconds: number;
  created_at: string;
  updated_at: string;
}

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'static_bearer', token: UPSTREAM_API_KEY },
});

const upstream = {
  // SWAP: AdCP-side brand identifier → upstream brand_id. Real platforms
  // typically expose this through a directory service or per-API-key
  // tenant binding; the mock has a public discovery endpoint.
  async lookupBrand(brandIdentifier: string): Promise<string | null> {
    const { body } = await http.get<{ brand_id?: string }>('/_lookup/brand', { adcp_brand: brandIdentifier });
    return body?.brand_id ?? null;
  },

  // SWAP: GET offering details. `include_products=true` causes the upstream
  // to mint an offering_query_id; pass that to startConversation so the
  // brand can resolve "the second one" against the products actually shown.
  async getOffering(
    brandId: string,
    offeringId: string,
    opts: { includeProducts?: boolean; productLimit?: number } = {}
  ): Promise<UpstreamOffering | null> {
    const params: Record<string, string> = {};
    if (opts.includeProducts) params['include_products'] = 'true';
    if (opts.productLimit !== undefined) params['product_limit'] = String(opts.productLimit);
    const { body } = await http.get<UpstreamOffering>(
      `/v1/brands/${encodeURIComponent(brandId)}/offerings/${encodeURIComponent(offeringId)}`,
      params
    );
    return body;
  },

  // SWAP: start a conversation. `client_request_id` carries the AdCP
  // idempotency_key — replay protection lives in the upstream.
  async startConversation(
    brandId: string,
    body: {
      intent: string;
      offering_id?: string;
      offering_query_id?: string;
      identity?: unknown;
      client_request_id?: string;
    }
  ): Promise<UpstreamConversation> {
    const r = await http.post<UpstreamConversation>(`/v1/brands/${encodeURIComponent(brandId)}/conversations`, body);
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'conversation creation rejected by upstream' });
    }
    return r.body;
  },

  // SWAP: send a turn. Mismatched body on reused client_request_id → 409.
  async sendTurn(
    brandId: string,
    conversationId: string,
    body: { message?: string; action_response?: unknown; client_request_id?: string }
  ): Promise<UpstreamTurn> {
    const r = await http.post<UpstreamTurn>(
      `/v1/brands/${encodeURIComponent(brandId)}/conversations/${encodeURIComponent(conversationId)}/turns`,
      body
    );
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'turn rejected by upstream' });
    }
    return r.body;
  },

  // SWAP: close a conversation. Naturally idempotent on conversation_id
  // (mirrors AdCP's omission of `idempotency_key` on terminate).
  async closeConversation(
    brandId: string,
    conversationId: string,
    body: { reason: 'txn_ready' | 'done' | 'user_left' | 'idle_timeout' | 'host_closed'; summary?: string }
  ): Promise<UpstreamConversation> {
    const r = await http.post<UpstreamConversation>(
      `/v1/brands/${encodeURIComponent(brandId)}/conversations/${encodeURIComponent(conversationId)}/close`,
      body
    );
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'close rejected by upstream' });
    }
    return r.body;
  },
};

// ---------------------------------------------------------------------------
// Translation tables — upstream ↔ AdCP renames are deliberate per the SI mock
// design. Keeping them as small named functions makes the seams explicit.
// ---------------------------------------------------------------------------

/** AdCP `SITerminateSessionRequest.reason` → upstream close reason. The SI
 *  mock rejects AdCP values directly (loud rename gap by design). */
function adcpReasonToUpstream(
  reason: SITerminateSessionRequest['reason']
): 'txn_ready' | 'done' | 'user_left' | 'idle_timeout' | 'host_closed' {
  switch (reason) {
    case 'handoff_transaction':
      return 'txn_ready';
    case 'handoff_complete':
      return 'done';
    case 'user_exit':
      return 'user_left';
    case 'session_timeout':
      return 'idle_timeout';
    case 'host_terminated':
      return 'host_closed';
  }
}

/** Project an upstream component (`{ kind, ... }`) onto an AdCP `SIUIElement`
 *  (`{ type, data }`). Each type has its own per-data shape required by
 *  the spec — `product_card` needs `title` + `price`, `action_button`
 *  needs `label` + `action`, etc. We project per-type rather than a flat
 *  spread so wire-validation passes. */
function projectComponent(c: UpstreamComponent): SIUIElement {
  switch (c.kind) {
    case 'product_card': {
      // Upstream → AdCP renames inside data: name → title, display_price →
      // price, list_price → subtitle (or badge if you prefer), thumbnail_url →
      // image_url. AdCP requires title + price.
      const data: Record<string, unknown> = {
        title: typeof c['name'] === 'string' ? c['name'] : '(unnamed product)',
        price: typeof c['display_price'] === 'string' ? c['display_price'] : '',
      };
      if (typeof c['thumbnail_url'] === 'string') data['image_url'] = c['thumbnail_url'];
      if (typeof c['list_price'] === 'string') data['subtitle'] = c['list_price'];
      if (typeof c['inventory_status'] === 'string') data['badge'] = c['inventory_status'];
      return { type: 'product_card', data };
    }
    case 'action_button': {
      const data: Record<string, unknown> = {
        label: typeof c['label'] === 'string' ? c['label'] : 'OK',
        action: typeof c['action'] === 'string' ? c['action'] : 'noop',
      };
      if (c['payload'] !== undefined) data['payload'] = c['payload'];
      return { type: 'action_button', data };
    }
    case 'text':
    case 'link':
    case 'image':
    case 'carousel':
    case 'app_handoff':
    case 'integration_actions': {
      // Pass-through: the upstream produces the spec-correct data shape
      // for these kinds, or the data shape is permissive enough that
      // additional properties don't fail wire validation.
      const { kind: _k, ...data } = c;
      void _k;
      return { type: c.kind, data };
    }
    default: {
      // Unknown upstream kind → safe fallback to `text` so wire validation
      // doesn't reject a legitimate response. Production adapters should
      // log + map every upstream-specific kind explicitly.
      return { type: 'text', data: { text: `[unsupported upstream kind: ${c.kind}]` } };
    }
  }
}

/** Project an upstream `close_recommended` hint onto AdCP
 *  `session_status: 'pending_handoff'` + `handoff: { type, ... }` on a
 *  `si_send_message` response. The brand emits the hint mid-conversation;
 *  this adapter chooses the eager projection (surface as pending_handoff
 *  immediately) over lazy (wait for terminate). Either is spec-valid. */
function projectCloseHint(hint: NonNullable<UpstreamTurn['close_recommended']>): {
  status: SISessionStatus;
  handoff: NonNullable<SISendMessageResponse['handoff']>;
} {
  if (hint.type === 'txn_ready') {
    const product = (hint.payload?.['product'] as Record<string, unknown> | undefined) ?? {};
    return {
      status: 'pending_handoff',
      handoff: {
        type: 'transaction',
        intent: {
          action: 'purchase',
          product,
          ...(typeof product['display_price'] === 'string'
            ? { price: { amount: parsePriceAmount(product['display_price']), currency: 'USD' } }
            : {}),
        },
      },
    };
  }
  return { status: 'pending_handoff', handoff: { type: 'complete' } };
}

function parsePriceAmount(displayPrice: string): number {
  // Upstream display_price is "$129" / "$89.99" — strip non-numeric and parse.
  const numeric = displayPrice.replace(/[^0-9.]/g, '');
  const value = Number(numeric);
  return Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// AdCP-side adapter — typed against SponsoredIntelligencePlatform.
// ---------------------------------------------------------------------------

interface SiBrandMeta {
  /** Resolved upstream brand_id, cached on the Account by accounts.resolve. */
  brand_id: string;
  /** AdCP-side brand identifier — preserved for logging / debugging. */
  brand_identifier: string;
  [key: string]: unknown;
}

// SI isn't yet a specialism (adcp#3961). The platform field's presence
// is the declaration; framework auto-derives 'sponsored_intelligence'
// into supported_protocols from the four SI tools getting registered.
// Build with `definePlatform` so the empty-`specialisms[]` flows through
// `RequiredPlatformsFor`'s `[S] extends [never]` short-circuit cleanly.

const accounts: AccountStore<SiBrandMeta> = {
  resolve: async ref => {
    if (!ref) {
      // No-account tools (the SI surface tools all carry account context
      // via session_id correlation, but `resolve(undefined)` may still
      // fire on capability discovery). Default-listing-brand fallback so
      // ctx.account is non-null at runtime.
      return {
        id: DEFAULT_LISTING_BRAND,
        name: DEFAULT_LISTING_BRAND,
        status: 'active',
        ctx_metadata: { brand_id: DEFAULT_LISTING_BRAND, brand_identifier: '' },
      };
    }
    if ('account_id' in ref) {
      // SWAP: production lookup keyed by your seller-assigned account_id.
      return null;
    }
    const brandIdentifier = ref.brand.domain;
    const brandId = await upstream.lookupBrand(brandIdentifier);
    if (!brandId) return null;
    return {
      id: brandId,
      name: brandIdentifier,
      status: 'active',
      ctx_metadata: { brand_id: brandId, brand_identifier: brandIdentifier },
    };
  },
};

const sponsoredIntelligence = defineSponsoredIntelligencePlatform<SiBrandMeta>({
  getOffering: async (req: SIGetOfferingRequest, ctx): Promise<SIGetOfferingResponse> => {
    const brandId = ctx.account?.ctx_metadata.brand_id ?? DEFAULT_LISTING_BRAND;
    const offering = await upstream.getOffering(brandId, req.offering_id, {
      includeProducts: req.include_products === true,
      ...(req.product_limit !== undefined ? { productLimit: req.product_limit } : {}),
    });
    if (!offering) {
      throw new AdcpError('NOT_FOUND', {
        message: `Offering ${req.offering_id} not found in brand ${brandId}.`,
        field: 'offering_id',
      });
    }
    // Project upstream → AdCP. The rename pattern: hero_image_url → image_url,
    // landing_page_url → landing_url, sku → product_id, thumbnail_url →
    // image_url, pdp_url → url, inventory_status → availability_summary,
    // offering_query_id → offering_token.
    const matching = req.include_products
      ? offering.products.map(p => ({
          product_id: p.sku,
          name: p.name,
          price: p.display_price,
          ...(p.list_price ? { original_price: p.list_price } : {}),
          image_url: p.thumbnail_url,
          availability_summary: p.inventory_status,
          url: p.pdp_url,
        }))
      : undefined;
    return {
      available: offering.available,
      ...(offering.offering_query_id !== undefined ? { offering_token: offering.offering_query_id } : {}),
      ...(offering.offering_query_ttl_seconds !== undefined
        ? { ttl_seconds: offering.offering_query_ttl_seconds }
        : {}),
      checked_at: new Date().toISOString(),
      offering: {
        offering_id: offering.offering_id,
        title: offering.name,
        summary: offering.summary,
        ...(offering.tagline !== undefined ? { tagline: offering.tagline } : {}),
        expires_at: offering.expires_at,
        price_hint: offering.price_hint,
        image_url: offering.hero_image_url,
        landing_url: offering.landing_page_url,
      },
      ...(matching ? { matching_products: matching } : {}),
      total_matching: offering.total_matching,
    };
  },

  initiateSession: async (req: SIInitiateSessionRequest, ctx): Promise<SIInitiateSessionResponse> => {
    const brandId = ctx.account?.ctx_metadata.brand_id ?? DEFAULT_LISTING_BRAND;
    const conversation = await upstream.startConversation(brandId, {
      intent: req.intent,
      ...(req.offering_id !== undefined ? { offering_id: req.offering_id } : {}),
      ...(req.offering_token !== undefined ? { offering_query_id: req.offering_token } : {}),
      ...(req.identity !== undefined ? { identity: req.identity } : {}),
      client_request_id: req.idempotency_key,
    });
    const initial = conversation.turns[0];
    return {
      // conversation_id → session_id (rename only — the brand-side and
      // AdCP-side identifiers are the same opaque token).
      session_id: conversation.conversation_id,
      ...(initial
        ? {
            response: {
              message: initial.assistant_message,
              ui_elements: initial.components.map(projectComponent),
            },
          }
        : {}),
      session_status: conversation.status === 'active' ? 'active' : 'terminated',
      session_ttl_seconds: conversation.session_ttl_seconds,
    };
  },

  sendMessage: async (req: SISendMessageRequest, ctx): Promise<SISendMessageResponse> => {
    const brandId = ctx.account?.ctx_metadata.brand_id ?? DEFAULT_LISTING_BRAND;
    // `req.session` is auto-hydrated by the framework when a prior
    // initiateSession landed via this same SDK instance — useful for
    // recalling original intent / offering scope without a separate
    // store call. Production brand engines own full transcripts in
    // their own backend; the upstream call below replays through the
    // brand's session-keyed API which is the source of truth for
    // transcript state.
    const turn = await upstream.sendTurn(brandId, req.session_id, {
      ...(typeof req.message === 'string' ? { message: req.message } : {}),
      ...(req.action_response !== undefined ? { action_response: req.action_response } : {}),
      client_request_id: req.idempotency_key,
    });
    // Eager close-hint projection: surface `pending_handoff` mid-conversation
    // when the brand signals txn_ready / done. The host then calls
    // `si_terminate_session` to formally close.
    const closeProjection = turn.close_recommended ? projectCloseHint(turn.close_recommended) : null;
    return {
      session_id: turn.conversation_id,
      response: {
        message: turn.assistant_message,
        ui_elements: turn.components.map(projectComponent),
      },
      session_status: closeProjection?.status ?? (turn.conversation_status === 'closed' ? 'terminated' : 'active'),
      ...(closeProjection ? { handoff: closeProjection.handoff } : {}),
    };
  },

  terminateSession: async (req: SITerminateSessionRequest, ctx): Promise<SITerminateSessionResponse> => {
    const brandId = ctx.account?.ctx_metadata.brand_id ?? DEFAULT_LISTING_BRAND;
    const conversation = await upstream.closeConversation(brandId, req.session_id, {
      reason: adcpReasonToUpstream(req.reason),
      ...(req.termination_context?.summary ? { summary: req.termination_context.summary } : {}),
    });
    const handoff = conversation.close?.transaction_handoff ?? null;
    return {
      session_id: conversation.conversation_id,
      terminated: conversation.status === 'closed',
      session_status: 'terminated',
      ...(handoff
        ? {
            acp_handoff: {
              ...(handoff.checkout_url ? { checkout_url: handoff.checkout_url } : {}),
              ...(handoff.checkout_token ? { checkout_token: handoff.checkout_token } : {}),
              ...(handoff.expires_at ? { expires_at: handoff.expires_at } : {}),
              ...(handoff.payload ? { payload: handoff.payload } : {}),
            },
          }
        : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = definePlatform<Record<string, never>, SiBrandMeta>({
  capabilities: { specialisms: [] as const, config: {} },
  accounts,
  sponsoredIntelligence,
});
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-si-adapter-brand',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<SiBrandMeta> | undefined;
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

console.log(`sponsored-intelligence adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
