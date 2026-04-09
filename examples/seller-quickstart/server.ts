/**
 * Seller Agent Quickstart
 *
 * A minimal MCP server that implements the full media_buy_seller storyboard.
 * Every response is hardcoded — replace with your real inventory, pricing,
 * and delivery logic.
 *
 * Run:
 *   npx tsx examples/seller-quickstart/server.ts
 *
 * Verify:
 *   npx @adcp/client storyboard run http://localhost:3000/mcp media_buy_seller --json
 *
 * Explore:
 *   npx @adcp/client http://localhost:3000/mcp
 */

import {
  createTaskCapableServer,
  capabilitiesResponse,
  productsResponse,
  mediaBuyResponse,
  taskToolResponse,
  serve,
  GetProductsRequestSchema,
  CreateMediaBuyRequestSchema,
  GetMediaBuysRequestSchema,
  GetMediaBuyDeliveryRequestSchema,
  SyncAccountsRequestSchema,
  SyncGovernanceRequestSchema,
  ListCreativeFormatsRequestSchema,
  SyncCreativesRequestSchema,
} from '@adcp/client';
import type { Product, GetAdCPCapabilitiesResponse, ServeContext } from '@adcp/client';

// ---------------------------------------------------------------------------
// Product catalog — replace with your real inventory
// ---------------------------------------------------------------------------
const PRODUCTS: Product[] = [
  {
    product_id: 'sports_preroll_q2',
    name: 'Sports Pre-Roll Video Q2',
    description: 'Premium 15s/30s pre-roll on live sports and highlights content.',
    publisher_properties: [{ publisher_domain: 'example-publisher.com', selection_type: 'all' }],
    channels: ['olv'],
    format_ids: [{ agent_url: 'http://localhost:3000/mcp', id: 'ssai_30s' }],
    delivery_type: 'guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'cpm_guaranteed',
        pricing_model: 'cpm',
        fixed_price: 18.0,
        currency: 'USD',
        min_spend_per_package: 5000,
      },
    ],
  },
  {
    product_id: 'lifestyle_display_q2',
    name: 'Lifestyle Display 300x250',
    description: 'Standard IAB display on outdoor and lifestyle editorial pages.',
    publisher_properties: [{ publisher_domain: 'example-publisher.com', selection_type: 'all' }],
    channels: ['display'],
    format_ids: [{ agent_url: 'http://localhost:3000/mcp', id: 'display_300x250', width: 300, height: 250 }],
    delivery_type: 'guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'cpm_standard',
        pricing_model: 'cpm',
        fixed_price: 8.0,
        currency: 'USD',
        min_spend_per_package: 1000,
      },
    ],
  },
];

// In-memory state — replace with your database
interface ConfirmedPackage {
  package_id: string;
  buyer_ref?: string;
  product_id: string;
  pricing_option_id: string;
  budget: number;
}
const mediaBuys = new Map<string, { status: string; packages: ConfirmedPackage[] }>();

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------
function createSellerAgent({ taskStore }: ServeContext) {
  const server = createTaskCapableServer('Seller Quickstart', '1.0.0', {
    taskStore,
    instructions: 'Sell-side platform that handles briefs, products, media buys, creatives, and delivery reporting.',
  });

  // --- get_adcp_capabilities ---
  server.tool('get_adcp_capabilities', {}, async () => {
    const capabilities: GetAdCPCapabilitiesResponse = {
      adcp: { major_versions: [3] },
      supported_protocols: ['media_buy'],
      media_buy: {
        features: {
          inline_creative_management: false,
          property_list_filtering: false,
          content_standards: false,
        },
      },
    };
    return capabilitiesResponse(capabilities);
  });

  // --- sync_accounts ---
  server.tool('sync_accounts', SyncAccountsRequestSchema.shape, async (args) => {
    const accounts = (args.accounts ?? []).map((acct) => ({
      account_id: `acct_${Date.now()}`,
      brand: acct.brand,
      operator: acct.operator,
      action: 'created' as const,
      status: 'active' as const,
      account_scope: 'operator_brand' as const,
      payment_terms: acct.payment_terms ?? ('net_30' as const),
    }));
    return taskToolResponse({ accounts }, `Created ${accounts.length} account(s)`);
  });

  // --- sync_governance ---
  server.tool('sync_governance', SyncGovernanceRequestSchema.shape, async (args) => {
    const accounts = (args.accounts ?? []).map((entry) => ({
      account: entry.account,
      status: 'synced' as const,
      governance_agents: entry.governance_agents.map((ga) => ({
        url: ga.url,
        categories: ga.categories,
      })),
    }));
    return taskToolResponse({ accounts }, 'Governance agents registered');
  });

  // --- get_products ---
  server.tool('get_products', GetProductsRequestSchema.shape, async () => {
    return productsResponse({ products: PRODUCTS, sandbox: true });
  });

  // --- create_media_buy ---
  server.tool('create_media_buy', CreateMediaBuyRequestSchema.shape, async (args) => {
    const mediaBuyId = `mb_${Date.now()}`;
    const confirmedPackages = (args.packages ?? []).map((pkg, i) => ({
      package_id: `pkg_${i}_${Date.now()}`,
      buyer_ref: pkg.buyer_ref,
      product_id: pkg.product_id,
      pricing_option_id: pkg.pricing_option_id,
      budget: pkg.budget,
    }));

    mediaBuys.set(mediaBuyId, {
      status: 'active',
      packages: confirmedPackages,
    });

    return mediaBuyResponse({
      media_buy_id: mediaBuyId,
      packages: confirmedPackages,
    });
  });

  // --- get_media_buys ---
  server.tool('get_media_buys', GetMediaBuysRequestSchema.shape, async (args) => {
    const ids = args.media_buy_ids ?? [];
    const buys = ids.map((id) => {
      const buy = mediaBuys.get(id);
      return {
        media_buy_id: id,
        status: (buy?.status ?? 'active') as 'active',
        currency: 'USD',
        packages: (buy?.packages ?? []).map((pkg) => ({ ...pkg })),
        valid_actions: ['pause', 'cancel', 'sync_creatives'] as Array<
          'pause' | 'cancel' | 'sync_creatives'
        >,
      };
    });
    return taskToolResponse(
      { media_buys: buys },
      `Retrieved ${buys.length} media buy(s)`
    );
  });

  // --- list_creative_formats ---
  server.tool('list_creative_formats', ListCreativeFormatsRequestSchema.shape, async () => {
    return taskToolResponse({
      formats: [
        {
          format_id: { agent_url: 'http://localhost:3000/mcp', id: 'ssai_30s' },
          name: 'SSAI Video 30s',
        },
        {
          format_id: { agent_url: 'http://localhost:3000/mcp', id: 'display_300x250' },
          name: 'Display 300x250',
        },
      ],
    });
  });

  // --- sync_creatives ---
  server.tool('sync_creatives', SyncCreativesRequestSchema.shape, async (args) => {
    const items = (args.creatives ?? []).map((c) => ({
      creative_id: c.creative_id,
      action: 'created' as const,
    }));
    // Both "creatives" (schema) and "results" (storyboard validation) fields
    return taskToolResponse(
      { creatives: items, results: items, sandbox: true },
      `Synced ${items.length} creative(s)`
    );
  });

  // --- get_media_buy_delivery ---
  server.tool('get_media_buy_delivery', GetMediaBuyDeliveryRequestSchema.shape, async (args) => {
    const ids = args.media_buy_ids ?? [];
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);

    const deliveries = ids.map((id) => ({
      media_buy_id: id,
      status: 'active' as const,
      totals: { impressions: 12_450, spend: 224.10 },
      by_package: [],
    }));

    return taskToolResponse({
      reporting_period: {
        start: yesterday.toISOString(),
        end: now.toISOString(),
      },
      media_buy_deliveries: deliveries,
      // Storyboard validation expects "media_buys" alias
      media_buys: deliveries,
    });
  });

  return server;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
serve(createSellerAgent, { port: 3000 });
