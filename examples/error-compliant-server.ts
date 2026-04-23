/**
 * Example: AdCP-Compliant MCP Server
 *
 * Demonstrates building a server using @adcp/client response builders
 * for type-safe responses. Run with:
 *
 *   npx tsx examples/error-compliant-server.ts
 *
 * Then test with:
 *
 *   npx @adcp/client@latest comply http://localhost:3456/mcp
 */

import {
  createTaskCapableServer,
  adcpError,
  capabilitiesResponse,
  productsResponse,
  mediaBuyResponse,
  deliveryResponse,
  serve,
  GetProductsRequestSchema,
  CreateMediaBuyRequestSchema,
  GetMediaBuyDeliveryRequestSchema,
} from '@adcp/client';
import type { Product, GetAdCPCapabilitiesResponse } from '@adcp/client';

// CreateMediaBuyRequestSchema requires account/brand per spec, but a lenient
// version lets intentionally-incomplete requests reach the handler so it can
// return proper AdCP structured errors instead of generic MCP validation errors.
const LenientCreateMediaBuyInput = CreateMediaBuyRequestSchema.extend({
  account: CreateMediaBuyRequestSchema.shape.account.optional(),
  brand: CreateMediaBuyRequestSchema.shape.brand.optional(),
});

// ---------------------------------------------------------------------------
// Product catalog — typed as Product[] so the compiler enforces the schema
// ---------------------------------------------------------------------------
const PRODUCTS: Product[] = [
  {
    product_id: 'prod_display_300x250',
    name: 'Display Banner 300x250',
    description: 'Standard IAB display banner ad unit served across premium news and lifestyle sites.',
    publisher_properties: [{ publisher_domain: 'example-publisher.com', selection_type: 'all' }],
    channels: ['display'],
    format_ids: [
      { agent_url: 'https://creatives.adcontextprotocol.org', id: 'display_static', width: 300, height: 250 },
    ],
    delivery_type: 'non_guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'po_cpm',
        pricing_model: 'cpm',
        fixed_price: 5.0,
        currency: 'USD',
        min_spend_per_package: 500,
      },
    ],
  },
  {
    product_id: 'prod_video_pre_roll',
    name: 'Pre-Roll Video 15s',
    description: 'Skippable pre-roll video ads served on premium video content.',
    publisher_properties: [{ publisher_domain: 'example-publisher.com', selection_type: 'all' }],
    channels: ['olv'],
    format_ids: [{ agent_url: 'https://creatives.adcontextprotocol.org', id: 'video_hosted' }],
    delivery_type: 'non_guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'po_cpm',
        pricing_model: 'cpm',
        fixed_price: 12.0,
        currency: 'USD',
        min_spend_per_package: 1000,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Rate limit state (module-scoped — persists across per-request server instances)
// ---------------------------------------------------------------------------
let requestCount = 0;
const RATE_LIMIT = 50;
const RATE_WINDOW_MS = 60_000;
let windowStart = Date.now();

function checkRateLimit() {
  const now = Date.now();
  if (now - windowStart > RATE_WINDOW_MS) {
    requestCount = 0;
    windowStart = now;
  }
  requestCount++;
  if (requestCount > RATE_LIMIT) {
    return adcpError('RATE_LIMITED', {
      message: 'Request rate exceeded',
      retry_after: Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000),
      details: { limit: RATE_LIMIT, remaining: 0, window_seconds: RATE_WINDOW_MS / 1000, scope: 'global' },
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server factory (McpServer.connect() can only be called once per instance)
// ---------------------------------------------------------------------------
function createAgentServer() {
  const server = createTaskCapableServer('Example AdCP Agent', '1.0.0');

  // --- get_adcp_capabilities ---
  server.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => {
    const limited = checkRateLimit();
    if (limited) return limited;

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

  // --- get_products ---
  server.registerTool('get_products', { inputSchema: GetProductsRequestSchema.shape }, async () => {
    const limited = checkRateLimit();
    if (limited) return limited;

    return productsResponse({ products: PRODUCTS });
  });

  // --- create_media_buy ---
  server.registerTool(
    'create_media_buy',
    { inputSchema: LenientCreateMediaBuyInput.shape },
    async ({ buyer_ref, start_time, end_time, packages }) => {
      const limited = checkRateLimit();
      if (limited) return limited;

      if (new Date(end_time) <= new Date(start_time)) {
        return adcpError('INVALID_REQUEST', {
          message: 'end_time must be after start_time',
          field: 'end_time',
          suggestion: 'Set end_time to a date after start_time',
        });
      }

      if (packages) {
        for (let i = 0; i < packages.length; i++) {
          const pkg = packages[i]!;

          if (pkg.budget < 0) {
            return adcpError('INVALID_REQUEST', {
              message: 'Budget must be non-negative',
              field: `packages[${i}].budget`,
              suggestion: 'Set budget to 0 or greater',
            });
          }

          const product = PRODUCTS.find(p => p.product_id === pkg.product_id);
          if (!product) {
            return adcpError('PRODUCT_NOT_FOUND', {
              message: `Product '${pkg.product_id}' not found`,
              field: `packages[${i}].product_id`,
              suggestion: 'Use get_products to discover available products',
            });
          }

          const pricing = product.pricing_options.find(po => po.pricing_option_id === pkg.pricing_option_id);
          if (
            pricing &&
            'min_spend_per_package' in pricing &&
            pricing.min_spend_per_package != null &&
            pkg.budget < pricing.min_spend_per_package
          ) {
            return adcpError('BUDGET_TOO_LOW', {
              message: `Budget ${pkg.budget} is below minimum ${pricing.min_spend_per_package} for ${product.name}`,
              field: `packages[${i}].budget`,
              suggestion: `Increase budget to at least ${pricing.min_spend_per_package}`,
              details: { minimum_budget: pricing.min_spend_per_package, currency: 'USD' },
            });
          }
        }
      }

      const mediaBuyId = `mb_${Date.now()}`;

      return mediaBuyResponse({
        media_buy_id: mediaBuyId,
        buyer_ref,
        packages: (packages ?? []).map((pkg, i) => ({
          package_id: `pkg_${i}_${Date.now()}`,
          buyer_ref: pkg.buyer_ref,
          product_id: pkg.product_id,
          pricing_option_id: pkg.pricing_option_id,
          budget: pkg.budget,
        })),
      });
    }
  );

  // --- get_media_buy_delivery ---
  server.registerTool(
    'get_media_buy_delivery',
    { inputSchema: GetMediaBuyDeliveryRequestSchema.shape },
    async ({ media_buy_ids }) => {
      const limited = checkRateLimit();
      if (limited) return limited;

      const ids = media_buy_ids ?? [];
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);

      return deliveryResponse({
        reporting_period: {
          start: yesterday.toISOString(),
          end: now.toISOString(),
        },
        media_buy_deliveries: ids.map(id => ({
          media_buy_id: id,
          status: 'active' as const,
          totals: { impressions: 0, spend: 0 },
          by_package: [],
        })),
      });
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
serve(createAgentServer, { port: 3456 });
