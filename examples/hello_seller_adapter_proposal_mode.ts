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
  type GetProductsPayload,
  type ProposalManager,
  type SalesCorePlatform,
} from '@adcp/sdk/server';
import { buildGAMLikeRecipe, GAM_LIKE_OVERLAP, type GAMLikeRecipe } from '@adcp/sdk/mock-server';
import type {
  AccountReference,
  CreateMediaBuyRequest,
  CreateMediaBuySuccess,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  GetProductsRequest,
  GetProductsResponse,
  UpdateMediaBuyRequest,
  UpdateMediaBuySuccess,
} from '@adcp/sdk/types';

// Wire `Product` and `Proposal` aren't directly re-exported from
// `@adcp/sdk/types` — derive from the response array (same pattern as
// `hello_seller_adapter_guaranteed.ts`).
type Product = NonNullable<GetProductsResponse['products']>[number];
type Proposal = NonNullable<GetProductsResponse['proposals']>[number];
type Package = CreateMediaBuySuccess['packages'][number];

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
    if (!r.body) {
      throw new AdcpError('PROPOSAL_NOT_FOUND', {
        message: `Proposal ${JSON.stringify(proposalId)} not found.`,
        field: 'refine[0].proposal_id',
        recovery: 'correctable',
      });
    }
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

// AccountReference is a discriminated union — narrow before reading.
function publisherDomainFromRef(ref: AccountReference | undefined): string | undefined {
  if (!ref) return undefined;
  if ('brand' in ref) return ref.brand.domain;
  // The {account_id} arm — adopters who store accounts pre-resolved at
  // sync_accounts time would look up by id; this demo only accepts
  // `pub_<domain>`-shaped ids as a self-rehydration trick.
  if (ref.account_id.startsWith('pub_')) return ref.account_id.slice(4);
  return undefined;
}

const accounts: AccountStore<NetworkMeta> = {
  resolution: 'explicit',
  async resolve(ref) {
    const publisherDomain = publisherDomainFromRef(ref);
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
  /** `list_accounts` projection. AdCP 3.0.9 §accounts/overview requires every
   *  seller agent (any `sales-*` specialism, including `sales-proposal-mode`)
   *  to advertise at least one of `list_accounts` / `sync_accounts`. This
   *  adapter's proposal flow doesn't need buyer-driven account sync, so we
   *  expose the read-only list. Production deployments swap for a paginated
   *  query against their account ledger. */
  async list() {
    const items: Array<Account<NetworkMeta>> = [];
    for (const domain of KNOWN_PUBLISHERS) {
      const network = await upstream.lookupNetwork(domain);
      if (!network) continue;
      items.push({
        id: `pub_${domain}`,
        name: network.display_name,
        status: 'active',
        brand: { domain },
        ctx_metadata: { network_code: network.network_code, publisher_domain: domain },
      });
    }
    return { items };
  },
};

// ---------------------------------------------------------------------------
// ProposalManager — owns getProducts / refine / finalize.
// The framework persists drafts, intercepts finalize, and hydrates
// recipes onto ctx.recipes for sales.createMediaBuy.
// ---------------------------------------------------------------------------

const FORMAT_AGENT_URL = PUBLIC_AGENT_URL;

function projectProduct(p: UpstreamProduct, publisherDomain: string, recipe: GAMLikeRecipe): Product {
  // The wire `Product` shape doesn't enumerate `implementation_config`
  // — adapters attach it on the wire and the framework reads it back
  // via cast in the dispatch helpers. We do the same on the way out.
  const product: Product = {
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
  };
  // Attach the recipe via cast so strict TS doesn't reject the field
  // that's not in the generated `Product` interface.
  (product as { implementation_config?: GAMLikeRecipe }).implementation_config = recipe;
  return product;
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
    ...(up.status === 'committed' && {
      insertion_order: {
        io_id: `io_${up.proposal_id}`,
        requires_signature: false,
        terms: {
          publisher: up.network_code,
          ...(total_budget && { total_budget }),
        },
      },
    }),
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

  async getProducts(req: GetProductsRequest, ctx): Promise<GetProductsPayload> {
    const networkCode = ctx.account.ctx_metadata.network_code;
    const publisherDomain = ctx.account.ctx_metadata.publisher_domain;
    const products = await upstream.listProducts(networkCode);
    if (products.length === 0) return { products: [], cache_scope: 'account' };

    // brief + total_budget signals → curated proposal. Without a brief
    // the buyer is browsing the catalog; skip proposal generation.
    const brief = typeof (req as { brief?: unknown }).brief === 'string' ? (req as { brief: string }).brief : undefined;
    const totalBudget = (req as { total_budget?: { amount: number; currency: string } }).total_budget;
    if (!brief) {
      // Catalog mode — return products with recipes, no proposals.
      const productsOut = products.map(p => projectProduct(p, publisherDomain, buildGAMLikeRecipe(p)));
      return { products: productsOut, cache_scope: 'account' };
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
      cache_scope: 'account',
    };
  },

  async refineProducts(req: GetProductsRequest, ctx): Promise<GetProductsPayload> {
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
      cache_scope: 'account',
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
  getProducts: async () => ({ products: [], cache_scope: 'account' }),

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
      name: `prop_buy_${Date.now()}`,
      advertiser_id: networkCode,
      currency,
      budget: totalBudget,
      client_request_id: req.idempotency_key,
    });

    // Equal-split allocation across the recipes. Production adapters
    // would honor the proposal's stored allocation percentages — those
    // live in `ctx.recipes`'s carrier object on the framework side; the
    // simpler split keeps the demo tight.
    const perPackageBudget = totalBudget / recipes.size;
    const packages: Package[] = [];
    for (const [productId, recipe] of recipes) {
      const lineItem = await upstream.createLineItem(networkCode, order.order_id, {
        product_id: productId,
        budget: perPackageBudget,
        ad_unit_targeting: [...recipe.ad_unit_ids],
        client_request_id: `${req.idempotency_key}_${productId}`,
      });
      packages.push({
        package_id: lineItem.line_item_id,
        product_id: productId,
        budget: perPackageBudget,
      });
    }
    return {
      media_buy_id: order.order_id,
      status: 'completed',
      media_buy_status: 'pending_creatives',
      packages,
    };
  },

  async updateMediaBuy(buyId: string, _patch: UpdateMediaBuyRequest, _ctx): Promise<UpdateMediaBuySuccess> {
    // Pass-through; the proposal-mode demo doesn't drive update logic.
    // Production adapters branch on the patch shape and PATCH the
    // upstream order, returning `affected_packages[]` for the modified
    // package set.
    return {
      media_buy_id: buyId,
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
        status: 'active',
        totals: {
          impressions: delivery.totals.impressions,
          clicks: delivery.totals.clicks,
          spend: delivery.totals.spend,
        },
        by_package: [],
      });
    }
    return {
      status: 'completed',
      reporting_period: { start: '2026-04-01T00:00:00Z', end: '2026-06-30T23:59:59Z' },
      currency: 'USD',
      media_buy_deliveries: deliveries,
    };
  },

  async getMediaBuys(_req: GetMediaBuysRequest): Promise<GetMediaBuysResponse> {
    return { status: 'completed', media_buys: [] };
  },
};

// ---------------------------------------------------------------------------
// Platform composition + boot
// ---------------------------------------------------------------------------

const platform: DecisioningPlatform<unknown, NetworkMeta> = {
  capabilities: {
    specialisms: ['sales-proposal-mode'],
    channels: ['olv', 'ctv', 'display'],
    pricingModels: ['cpm'],
    config: undefined,
    // Declare the comply_test_controller surface so the conformance runner
    // grades missing scenarios as `not_applicable` rather than `failed`. The
    // framework auto-derives the `scenarios` list from the `complyTest`
    // adapter set wired below.
    compliance_testing: {
      scenarios: ['force_media_buy_status', 'simulate_delivery'],
    },
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
      // ─── TEST-ONLY: comply_test_controller wiring ──────────────────────
      // DELETE THIS BLOCK BEFORE DEPLOYING. The conformance runner uses
      // `comply_test_controller` to seed media-buy fixtures and force
      // state transitions across cascade scenarios in the broader
      // `sales_proposal_mode` storyboard suite (delivery_reporting,
      // invalid_transitions, pending_creatives_to_start). The
      // `proposal_finalize` storyboard itself doesn't invoke the
      // controller, but the surface is wired here for parity with the
      // other reference seller adapters.
      //
      // No `sandboxGate` here — the framework gate inside
      // `createAdcpServerFromPlatform` admits via the resolved account's
      // `mode === 'sandbox'`. Production refs flow through the live path
      // with the field unset (default `'live'`), so the framework gate
      // refuses dispatch for them.
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

/* eslint-disable no-console */
console.log(`hello-seller-adapter-proposal-mode on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
/* eslint-enable no-console */

void GAM_LIKE_OVERLAP; // imported for type re-export discoverability
