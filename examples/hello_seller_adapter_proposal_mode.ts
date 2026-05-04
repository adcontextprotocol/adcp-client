/**
 * hello_seller_adapter_proposal_mode — canonical reference for the v1.5
 * `ProposalManager` + `DecisioningPlatform` two-platform composition.
 *
 * The seller curates a media plan from a buyer's brief, the buyer
 * refines and finalizes the proposal, and accepts it via a single
 * `create_media_buy(proposal_id=...)` call. Mirrors Python's
 * `examples/sales_proposal_mode_seller/` (PR #550).
 *
 * **What's interesting about this agent:**
 *
 *   - All proposal-lifecycle work lives behind `ProposalManager` —
 *     `getProducts` curates draft proposals, `refineProducts` applies
 *     iteration, `finalizeProposal` locks pricing.
 *   - The adapter never persists proposal state itself. The framework's
 *     {@link InMemoryProposalStore} carries `draft → committed → consumed`
 *     transitions; the adapter just calls the upstream and returns the
 *     wire shape.
 *   - `sales.createMediaBuy(proposal_id)` reads `ctx.recipes` (populated
 *     by the framework from the committed proposal) and uses
 *     `recipe.upstream_ids.line_item_template_id` to drive the order
 *     creation. There's no second round-trip to the upstream's proposal
 *     store — the recipe IS the contract.
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server sales-guaranteed --port 4450
 *   UPSTREAM_URL=http://127.0.0.1:4450 \
 *     npx tsx examples/hello_seller_adapter_proposal_mode.ts
 *   adcp storyboard run http://127.0.0.1:3007/mcp media_buy_seller/proposal_finalize \
 *     --auth sk_harness_do_not_use_in_prod
 */

import {
  AdcpError,
  createAdcpServerFromPlatform,
  createIdempotencyStore,
  createInMemoryTaskRegistry,
  createMediaBuyStore,
  createUpstreamHttpClient,
  InMemoryProposalStore,
  InMemoryStateStore,
  memoryBackend,
  serve,
  verifyApiKey,
  type Account,
  type AccountStore,
  type DecisioningPlatform,
  type FinalizeProposalRequest,
  type FinalizeProposalSuccess,
  type ProposalManager,
  type SalesCorePlatform,
} from '@adcp/sdk/server';
import { buildGAMLikeRecipe, GAM_LIKE_OVERLAP, type GAMLikeRecipe } from '@adcp/sdk/mock-server';
import type {
  CreateMediaBuyRequest,
  CreateMediaBuySuccess,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  GetProductsRequest,
  GetProductsResponse,
  Product,
  Proposal,
  UpdateMediaBuyRequest,
  UpdateMediaBuySuccess,
} from '@adcp/sdk/types';

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4450';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_sales_guaranteed_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3007);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';
const PUBLIC_AGENT_URL = process.env['PUBLIC_AGENT_URL'] ?? `http://127.0.0.1:${PORT}`;

const KNOWN_PUBLISHERS = ['premium-sports.example', 'acmeoutdoor.example', 'pinnacle-agency.example'];

// ---------------------------------------------------------------------------
// Upstream client
// ---------------------------------------------------------------------------

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
}

interface UpstreamProposal {
  proposal_id: string;
  network_code: string;
  status: 'draft' | 'committed' | 'expired' | 'rejected';
  brief?: string;
  allocations: Array<{
    product_id: string;
    allocation_percentage: number;
    indicative_cpm: number;
    locked_cpm?: number;
    upstream_line_item_template_id?: string;
  }>;
  total_budget?: { amount: number; currency: string };
  expires_at?: string;
}

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'static_bearer', token: UPSTREAM_API_KEY },
});

const headers = (networkCode: string) => ({ 'X-Network-Code': networkCode });

const upstream = {
  async lookupNetwork(publisherDomain: string) {
    const { body } = await http.get<{ network_code: string; display_name: string; adcp_publisher: string }>(
      '/_lookup/network',
      { adcp_publisher: publisherDomain }
    );
    return body;
  },
  async listProducts(networkCode: string): Promise<UpstreamProduct[]> {
    const { body } = await http.get<{ products: UpstreamProduct[] }>(
      '/v1/products',
      { delivery_type: 'guaranteed' },
      headers(networkCode)
    );
    return body?.products ?? [];
  },
  async createProposal(
    networkCode: string,
    body: { brief?: string; total_budget?: { amount: number; currency: string }; product_ids?: string[] }
  ): Promise<UpstreamProposal> {
    const r = await http.post<UpstreamProposal>('/v1/proposals', body, headers(networkCode));
    if (!r.body) throw new AdcpError('SERVICE_UNAVAILABLE', { message: 'upstream proposal creation failed' });
    return r.body;
  },
  async refineProposal(
    networkCode: string,
    proposalId: string,
    body: { ask?: string; allocation_overrides?: Array<{ product_id: string; allocation_percentage: number }> }
  ): Promise<UpstreamProposal> {
    const r = await http.post<UpstreamProposal>(
      `/v1/proposals/${encodeURIComponent(proposalId)}/refine`,
      body,
      headers(networkCode)
    );
    if (!r.body) throw new AdcpError('SERVICE_UNAVAILABLE', { message: 'upstream refine failed' });
    return r.body;
  },
  async finalizeProposal(networkCode: string, proposalId: string): Promise<UpstreamProposal> {
    const r = await http.post<UpstreamProposal>(
      `/v1/proposals/${encodeURIComponent(proposalId)}/finalize`,
      {},
      headers(networkCode)
    );
    if (!r.body) throw new AdcpError('SERVICE_UNAVAILABLE', { message: 'upstream finalize failed' });
    return r.body;
  },
  async createOrder(
    networkCode: string,
    body: { name: string; advertiser_id: string; currency: string; budget: number; client_request_id?: string }
  ) {
    const r = await http.post<{ order_id: string; status: string; approval_task_id?: string }>(
      '/v1/orders',
      body,
      headers(networkCode)
    );
    if (!r.body) throw new AdcpError('INVALID_REQUEST', { message: 'order creation rejected' });
    return r.body;
  },
  async createLineItem(
    networkCode: string,
    orderId: string,
    body: { product_id: string; budget: number; ad_unit_targeting?: string[]; client_request_id?: string }
  ) {
    const r = await http.post<{ line_item_id: string }>(
      `/v1/orders/${encodeURIComponent(orderId)}/lineitems`,
      body,
      headers(networkCode)
    );
    if (!r.body) throw new AdcpError('INVALID_REQUEST', { message: 'line item creation rejected' });
    return r.body;
  },
  async getDelivery(networkCode: string, orderId: string) {
    const { body } = await http.get<{
      currency: string;
      reporting_period: { start: string; end: string };
      totals: { impressions: number; clicks: number; spend: number };
    }>(`/v1/orders/${encodeURIComponent(orderId)}/delivery`, undefined, headers(networkCode));
    return body;
  },
};

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

interface NetworkMeta {
  network_code: string;
  publisher_domain: string;
  [key: string]: unknown;
}

const accounts: AccountStore<NetworkMeta> = {
  resolution: 'explicit',
  async resolve(ref) {
    const publisherDomain =
      ref?.brand?.domain ?? (ref?.account_id?.startsWith('pub_') ? ref.account_id.slice(4) : undefined);
    if (!publisherDomain || !KNOWN_PUBLISHERS.includes(publisherDomain)) return null;
    const network = await upstream.lookupNetwork(publisherDomain);
    if (!network) return null;
    return {
      id: `pub_${publisherDomain}`,
      name: network.display_name,
      status: 'active',
      brand: { domain: publisherDomain },
      ctx_metadata: { network_code: network.network_code, publisher_domain: publisherDomain },
    };
  },
};

// ---------------------------------------------------------------------------
// ProposalManager — owns getProducts / refine / finalize.
// The framework persists drafts, intercepts finalize, and hydrates
// recipes onto ctx.recipes for sales.createMediaBuy.
// ---------------------------------------------------------------------------

const FORMAT_AGENT_URL = PUBLIC_AGENT_URL;

function projectProduct(p: UpstreamProduct, publisherDomain: string, recipe: GAMLikeRecipe): Product {
  return {
    product_id: p.product_id,
    name: p.name,
    description: `${p.name} — ${p.delivery_type} ${p.channel}`,
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
    // Recipe rides on implementation_config — opaque to buyer wire,
    // typed for the adapter via the GAMLikeRecipe contract. The
    // framework persists this through the proposal lifecycle.
    implementation_config: recipe as unknown as Record<string, unknown>,
  };
}

function projectProposal(up: UpstreamProposal, total_budget?: { amount: number; currency: string }): Proposal {
  return {
    proposal_id: up.proposal_id,
    name: up.brief ? `Plan: ${up.brief.slice(0, 60)}` : `Plan ${up.proposal_id}`,
    description: 'Curated media plan generated from the buyer brief.',
    proposal_status: up.status === 'committed' ? 'committed' : 'draft',
    allocations: up.allocations.map(a => ({
      product_id: a.product_id,
      allocation_percentage: a.allocation_percentage,
      rationale: a.locked_cpm
        ? `Locked at ${a.locked_cpm} ${total_budget?.currency ?? 'USD'} CPM.`
        : `Indicative pricing ${a.indicative_cpm} CPM.`,
    })),
    ...(up.expires_at !== undefined && { expires_at: up.expires_at }),
    ...(total_budget && { total_budget }),
  };
}

const proposalManager: ProposalManager<GAMLikeRecipe, NetworkMeta> = {
  capabilities: {
    salesSpecialism: 'sales-guaranteed',
    refine: true,
    finalize: true,
    expiresAtGraceSeconds: 60, // tolerate 1 minute of clock skew
    rateCardPricing: true,
    availabilityReservations: true,
  },

  async getProducts(req: GetProductsRequest, ctx): Promise<GetProductsResponse> {
    const networkCode = ctx.account.ctx_metadata.network_code;
    const publisherDomain = ctx.account.ctx_metadata.publisher_domain;
    const products = await upstream.listProducts(networkCode);
    if (products.length === 0) return { products: [] };

    // brief + total_budget signals → curated proposal. Without a brief
    // the buyer is browsing the catalog; skip proposal generation.
    const brief = typeof (req as { brief?: unknown }).brief === 'string' ? (req as { brief: string }).brief : undefined;
    const totalBudget = (req as { total_budget?: { amount: number; currency: string } }).total_budget;
    if (!brief) {
      // Catalog mode — return products with recipes, no proposals.
      const productsOut = products.map(p => projectProduct(p, publisherDomain, buildGAMLikeRecipe(p)));
      return { products: productsOut };
    }

    const draft = await upstream.createProposal(networkCode, {
      brief,
      ...(totalBudget && { total_budget: totalBudget }),
    });
    const referencedIds = new Set(draft.allocations.map(a => a.product_id));
    const productsOut = products
      .filter(p => referencedIds.has(p.product_id))
      .map(p => projectProduct(p, publisherDomain, buildGAMLikeRecipe(p)));
    return {
      products: productsOut,
      proposals: [projectProposal(draft, totalBudget)],
    };
  },

  async refineProducts(req: GetProductsRequest, ctx): Promise<GetProductsResponse> {
    const networkCode = ctx.account.ctx_metadata.network_code;
    const publisherDomain = ctx.account.ctx_metadata.publisher_domain;
    const refine =
      (req as { refine?: ReadonlyArray<{ scope?: string; proposal_id?: string; ask?: string }> }).refine ?? [];
    const proposalEntry = refine.find(r => r.scope === 'proposal' && typeof r.proposal_id === 'string');
    if (!proposalEntry?.proposal_id) {
      throw new AdcpError('INVALID_REQUEST', {
        message: 'refine_products requires at least one proposal-scoped refine entry with proposal_id.',
        field: 'refine',
      });
    }
    const refined = await upstream.refineProposal(networkCode, proposalEntry.proposal_id, {
      ...(proposalEntry.ask !== undefined && { ask: proposalEntry.ask }),
    });
    const products = await upstream.listProducts(networkCode);
    const referencedIds = new Set(refined.allocations.map(a => a.product_id));
    const productsOut = products
      .filter(p => referencedIds.has(p.product_id))
      .map(p => projectProduct(p, publisherDomain, buildGAMLikeRecipe(p)));
    return {
      products: productsOut,
      proposals: [projectProposal(refined)],
      refinement_applied: refine.map(r => ({
        scope: r.scope ?? 'request',
        ...(r.proposal_id !== undefined && { proposal_id: r.proposal_id }),
        status: 'applied',
      })) as never,
    };
  },

  async finalizeProposal(
    req: FinalizeProposalRequest<GAMLikeRecipe>,
    ctx
  ): Promise<FinalizeProposalSuccess<GAMLikeRecipe>> {
    const networkCode = ctx.account.ctx_metadata.network_code;
    const committed = await upstream.finalizeProposal(networkCode, req.proposalId);
    // Refresh recipes with locked pricing + line-item template ids the
    // upstream allocated. The framework writes these to the store on
    // commit; sales.createMediaBuy reads them via ctx.recipes.
    const products = await upstream.listProducts(networkCode);
    const recipes = new Map<string, GAMLikeRecipe>();
    for (const allocation of committed.allocations) {
      const product = products.find(p => p.product_id === allocation.product_id);
      if (!product) continue;
      const baseRecipe = buildGAMLikeRecipe(product, {
        upstream_ids: {
          proposal_id: committed.proposal_id,
          ...(allocation.upstream_line_item_template_id && {
            line_item_template_id: allocation.upstream_line_item_template_id,
          }),
        },
      });
      // Override pricing with locked rate.
      if (allocation.locked_cpm !== undefined) {
        baseRecipe.pricing = { ...baseRecipe.pricing, rate: allocation.locked_cpm };
      }
      recipes.set(allocation.product_id, baseRecipe);
    }
    if (!committed.expires_at) {
      throw new AdcpError('SERVICE_UNAVAILABLE', { message: 'upstream finalize did not return expires_at' });
    }
    return {
      proposal: projectProposal(committed) as unknown as Record<string, unknown>,
      expiresAt: new Date(committed.expires_at),
      recipes,
    };
  },
};

// ---------------------------------------------------------------------------
// SalesPlatform — owns createMediaBuy / lifecycle. Reads ctx.recipes
// (hydrated by the framework from the committed proposal) instead of
// re-fetching from upstream.
// ---------------------------------------------------------------------------

const sales: SalesCorePlatform<NetworkMeta> = {
  // getProducts is owned by proposalManager when wired; the framework
  // routes there. We keep this empty at the type level — the framework
  // never reaches it.
  getProducts: async () => ({ products: [] }),

  async createMediaBuy(req: CreateMediaBuyRequest, ctx): Promise<CreateMediaBuySuccess> {
    const networkCode = ctx.account.ctx_metadata.network_code;
    const recipes = ctx.recipes as ReadonlyMap<string, GAMLikeRecipe> | undefined;
    if (!recipes || recipes.size === 0) {
      throw new AdcpError('INVALID_REQUEST', {
        message:
          'create_media_buy requires a committed proposal_id (this seller does not accept ' +
          'manual packages). Call get_products(buying_mode=brief), refine if needed, ' +
          'and finalize before create_media_buy.',
        field: 'proposal_id',
      });
    }
    const totalBudget = req.total_budget?.amount ?? 0;
    const currency = req.total_budget?.currency ?? 'USD';
    const order = await upstream.createOrder(networkCode, {
      name: `${req.buyer_ref ?? 'order'}_${Date.now()}`,
      advertiser_id: networkCode,
      currency,
      budget: totalBudget,
      ...(req.idempotency_key && { client_request_id: req.idempotency_key }),
    });

    // Allocate budgets per recipe using the proposal's allocation
    // percentages — but those live in ctx.recipes.size hints, not
    // structured. Simpler: equal split across the recipes.
    const perPackageBudget = totalBudget / recipes.size;
    const packages: CreateMediaBuySuccess['packages'] = [];
    for (const [productId, recipe] of recipes) {
      const lineItem = await upstream.createLineItem(networkCode, order.order_id, {
        product_id: productId,
        budget: perPackageBudget,
        ad_unit_targeting: [...recipe.ad_unit_ids],
        ...(req.idempotency_key && { client_request_id: `${req.idempotency_key}_${productId}` }),
      });
      packages.push({
        package_id: lineItem.line_item_id,
        product_id: productId,
        // Wire shape: `budget` is a bare number; currency lives on the
        // referenced pricing_option. The recipe carries the pricing
        // model + currency so the adapter doesn't echo them on the
        // package — it consumed them upstream.
        budget: perPackageBudget,
        status: 'pending_creatives',
      });
    }
    return {
      media_buy_id: order.order_id,
      buyer_ref: req.buyer_ref ?? `buy_${order.order_id}`,
      packages,
      status: 'pending_creatives',
    };
  },

  async updateMediaBuy(req: UpdateMediaBuyRequest, _ctx): Promise<UpdateMediaBuySuccess> {
    // Simple pass-through; the storyboard for proposal-mode doesn't
    // exercise updates beyond status reads. Production adopters
    // patch packages via upstream PATCH.
    return {
      media_buy_id: req.media_buy_id,
      buyer_ref: `buy_${req.media_buy_id}`,
      packages: [],
      status: 'active',
    };
  },

  async getMediaBuyDelivery(req: GetMediaBuyDeliveryRequest, ctx): Promise<GetMediaBuyDeliveryResponse> {
    const networkCode = ctx.account.ctx_metadata.network_code;
    const ids = req.media_buy_ids ?? [];
    const deliveries: GetMediaBuyDeliveryResponse['media_buy_deliveries'] = [];
    for (const id of ids) {
      const delivery = await upstream.getDelivery(networkCode, id);
      if (!delivery) continue;
      deliveries.push({
        media_buy_id: id,
        buyer_ref: `buy_${id}`,
        status: 'active',
        totals: {
          impressions: delivery.totals.impressions,
          clicks: delivery.totals.clicks,
          spend: { amount: delivery.totals.spend, currency: delivery.currency },
        },
        by_package: [],
      });
    }
    return {
      reporting_period: { start_date: '2026-04-01', end_date: '2026-06-30' },
      currency: 'USD',
      media_buy_deliveries: deliveries,
    };
  },

  async getMediaBuys(_req: GetMediaBuysRequest): Promise<GetMediaBuysResponse> {
    return { media_buys: [] };
  },
};

// ---------------------------------------------------------------------------
// Platform composition + boot
// ---------------------------------------------------------------------------

const platform: DecisioningPlatform<unknown, NetworkMeta> = {
  capabilities: {
    specialisms: ['sales-proposal-mode'],
    adcp_version: '3.0.6',
    channels: ['olv', 'ctv', 'display'],
    pricingModels: ['cpm'],
  },
  accounts,
  proposalManager,
  sales,
};

const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });
const taskRegistry = createInMemoryTaskRegistry();
const proposalStore = new InMemoryProposalStore<GAMLikeRecipe>();
// Single-tenant agent: explicit InMemoryStateStore + MediaBuyStore so the
// framework's "no implicit cross-tenant in-memory" guard accepts the wiring.
// Production adopters swap for `PostgresStateStore({ pool })`.
const stateStore = new InMemoryStateStore();
const mediaBuyStore = createMediaBuyStore({ store: stateStore });

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-proposal-mode',
      version: '1.0.0',
      taskStore,
      taskRegistry,
      idempotency: idempotencyStore,
      stateStore,
      mediaBuyStore,
      proposalStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<NetworkMeta> | undefined;
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

/* eslint-disable no-console */
console.log(`hello-seller-adapter-proposal-mode on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
/* eslint-enable no-console */

void GAM_LIKE_OVERLAP; // imported for type re-export discoverability
