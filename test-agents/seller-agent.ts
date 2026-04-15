/**
 * Seller agent — built strictly from skills/build-seller-agent/SKILL.md
 * SSP-style: non-guaranteed display + video, auction pricing, instant activation
 */

import {
  createAdcpServer,
  serve,
  adcpError,
  InMemoryStateStore,
  registerTestController,
  TestControllerError,
} from '@adcp/client';
import type { ServeContext, TestControllerStore } from '@adcp/client';

// ---------------------------------------------------------------------------
// Product catalog
// ---------------------------------------------------------------------------

// Use plain objects instead of Product type — avoids requiring every optional field
const PRODUCTS = [
  {
    product_id: 'prod-display-300x250',
    name: 'Display Banner 300x250',
    description: 'Standard IAB display banner across premium news sites',
    publisher_properties: [{ publisher_domain: 'example-news.com', selection_type: 'all' }],
    channels: ['display'],
    format_ids: [{ agent_url: 'https://creatives.example.com/mcp', id: 'display-300x250' }],
    delivery_type: 'non_guaranteed',
    pricing_options: [{
      pricing_option_id: 'cpm-display',
      pricing_model: 'cpm',
      floor_price: 5.0,
      currency: 'USD',
      min_spend_per_package: 500,
    }],
  },
  {
    product_id: 'prod-video-preroll',
    name: 'Pre-Roll Video 15s',
    description: 'Skippable pre-roll on premium video content',
    publisher_properties: [{ publisher_domain: 'example-news.com', selection_type: 'all' }],
    channels: ['olv'],
    format_ids: [{ agent_url: 'https://creatives.example.com/mcp', id: 'video-preroll' }],
    delivery_type: 'non_guaranteed',
    pricing_options: [{
      pricing_option_id: 'cpm-video',
      pricing_model: 'cpm',
      floor_price: 12.0,
      currency: 'USD',
      min_spend_per_package: 1000,
    }],
  },
];

const FORMATS = [
  { format_id: { agent_url: 'https://creatives.example.com/mcp', id: 'display-300x250' }, name: 'Display Banner 300x250' },
  { format_id: { agent_url: 'https://creatives.example.com/mcp', id: 'video-preroll' }, name: 'Video Pre-Roll 15s' },
];

// ---------------------------------------------------------------------------
// Shared state (created before server so resolveAccount + test controller can use it)
// ---------------------------------------------------------------------------

const stateStore = new InMemoryStateStore();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createAgent({ taskStore }: ServeContext) {
  const server = createAdcpServer({
    name: 'Example SSP Agent',
    version: '1.0.0',
    taskStore,
    stateStore,

    resolveAccount: async (ref) => {
      if ('account_id' in ref) return stateStore.get('accounts', ref.account_id);
      // Resolve by brand+operator
      const result = await stateStore.list('accounts', {
        filter: { operator: ref.operator },
      });
      return result.items[0] ?? null;
    },

    accounts: {
      syncAccounts: async (params, ctx) => {
        const results = [];
        for (const acct of params.accounts) {
          const accountId = `acct_${acct.brand.domain}_${acct.operator}`;
          const existing = await ctx.store.get('accounts', accountId);
          await ctx.store.put('accounts', accountId, {
            account_id: accountId,
            brand: acct.brand,
            operator: acct.operator,
            status: 'active',
          });
          results.push({
            account_id: accountId,
            brand: acct.brand,
            operator: acct.operator,
            action: existing ? 'updated' as const : 'created' as const,
            status: 'active' as const,
          });
        }
        return { accounts: results, context: params.context ?? undefined };
      },

      syncGovernance: async (params, ctx) => {
        const results = [];
        for (const entry of params.accounts) {
          results.push({
            account: entry.account ?? { brand: (entry as any).brand, operator: (entry as any).operator },
            status: 'synced' as const,
            governance_agents: entry.governance_agents ?? [],
          });
        }
        return { accounts: results, context: params.context ?? undefined };
      },
    },

    mediaBuy: {
      getProducts: async (params, ctx) => {
        return { products: PRODUCTS, sandbox: true, context: params.context ?? undefined };
      },

      createMediaBuy: async (params, ctx) => {
        // Validate dates
        if (typeof params.start_time === 'string' && typeof params.end_time === 'string') {
          if (new Date(params.end_time) <= new Date(params.start_time)) {
            return adcpError('INVALID_REQUEST', {
              message: 'end_time must be after start_time',
              field: 'end_time',
            });
          }
        }

        // Validate packages
        if (params.packages) {
          for (let i = 0; i < params.packages.length; i++) {
            const pkg = params.packages[i]!;
            const product = PRODUCTS.find(p => p.product_id === pkg.product_id);
            if (!product) {
              return adcpError('PRODUCT_NOT_FOUND', {
                message: `Product '${pkg.product_id}' not found`,
                field: `packages[${i}].product_id`,
                suggestion: 'Use get_products to discover available products',
              });
            }
            const pricing = product.pricing_options.find(po => po.pricing_option_id === pkg.pricing_option_id);
            if (!pricing) {
              return adcpError('INVALID_REQUEST', {
                message: `Pricing option '${pkg.pricing_option_id}' not found`,
                field: `packages[${i}].pricing_option_id`,
              });
            }
            if ('min_spend_per_package' in pricing && pricing.min_spend_per_package != null && pkg.budget < pricing.min_spend_per_package) {
              return adcpError('BUDGET_TOO_LOW', {
                message: `Budget ${pkg.budget} below minimum ${pricing.min_spend_per_package}`,
                field: `packages[${i}].budget`,
              });
            }
          }
        }

        const mediaBuyId = `mb_${Date.now()}`;
        const buy = {
          media_buy_id: mediaBuyId,
          status: 'pending_creatives' as const,
          packages: (params.packages ?? []).map((pkg, i) => ({
            package_id: `pkg_${i}_${Date.now()}`,
            product_id: pkg.product_id,
            pricing_option_id: pkg.pricing_option_id,
            budget: pkg.budget,
            buyer_ref: pkg.buyer_ref,
          })),
          context: params.context,
        };
        await ctx.store.put('media_buys', mediaBuyId, buy);
        return buy;
      },

      getMediaBuys: async (params, ctx) => {
        let buys: Record<string, unknown>[];
        if (params.media_buy_ids?.length) {
          const results = await Promise.all(
            params.media_buy_ids.map(id => ctx.store.get('media_buys', id))
          );
          buys = results.filter(Boolean) as Record<string, unknown>[];
        } else {
          const result = await ctx.store.list('media_buys');
          buys = result.items;
        }
        return {
          media_buys: buys.map(b => ({
            media_buy_id: b.media_buy_id as string,
            status: b.status as any,
            currency: 'USD',
            packages: (b.packages as any[]) ?? [],
          })),
          context: params.context,
        };
      },

      listCreativeFormats: async (params, ctx) => {
        return { formats: FORMATS, context: params.context ?? undefined };
      },

      syncCreatives: async (params, ctx) => {
        const results = [];
        for (const creative of params.creatives) {
          const existing = await ctx.store.get('creatives', creative.creative_id);
          await ctx.store.put('creatives', creative.creative_id, {
            ...creative,
            status: 'active',
          });
          results.push({
            creative_id: creative.creative_id,
            action: existing ? 'updated' as const : 'created' as const,
          });
        }
        return { creatives: results, context: params.context ?? undefined };
      },

      getMediaBuyDelivery: async (params, ctx) => {
        const ids = params.media_buy_ids ?? [];
        const now = new Date();
        const yesterday = new Date(now.getTime() - 86400000);
        return {
          reporting_period: { start: yesterday.toISOString(), end: now.toISOString() },
          media_buy_deliveries: ids.map(id => ({
            media_buy_id: id,
            status: 'active' as const,
            totals: { impressions: 0, spend: 0 },
            by_package: [],
          })),
          context: params.context,
        };
      },
    },

    capabilities: {
      features: {
        inlineCreativeManagement: false,
        propertyListFiltering: false,
        contentStandards: false,
      },
    },
  });

  // ---------------------------------------------------------------------------
  // Compliance testing
  // ---------------------------------------------------------------------------

  const controllerStore: TestControllerStore = {
    async forceAccountStatus(accountId, status) {
      const prev = await stateStore.get('accounts', accountId);
      if (!prev) throw new TestControllerError('NOT_FOUND', `Account ${accountId} not found`);
      const prevStatus = prev.status as string;
      await stateStore.patch('accounts', accountId, { status });
      return { success: true, previous_state: prevStatus, current_state: status };
    },
    async forceMediaBuyStatus(mediaBuyId, status) {
      const prev = await stateStore.get('media_buys', mediaBuyId);
      if (!prev) throw new TestControllerError('NOT_FOUND', `Media buy ${mediaBuyId} not found`);
      const prevStatus = prev.status as string;
      const terminal = ['completed', 'rejected', 'canceled'];
      if (terminal.includes(prevStatus))
        throw new TestControllerError('INVALID_TRANSITION', `Cannot transition from ${prevStatus}`, prevStatus);
      await stateStore.patch('media_buys', mediaBuyId, { status });
      return { success: true, previous_state: prevStatus, current_state: status };
    },
    async forceCreativeStatus(creativeId, status, rejectionReason) {
      const prev = await stateStore.get('creatives', creativeId);
      if (!prev) throw new TestControllerError('NOT_FOUND', `Creative ${creativeId} not found`);
      const prevStatus = prev.status as string;
      if (prevStatus === 'archived')
        throw new TestControllerError('INVALID_TRANSITION', `Cannot transition from archived`, prevStatus);
      await stateStore.patch('creatives', creativeId, { status });
      return { success: true, previous_state: prevStatus, current_state: status };
    },
    async simulateDelivery(mediaBuyId, params) {
      return { success: true, simulated: { ...params }, cumulative: { ...params } };
    },
    async simulateBudgetSpend(params) {
      return { success: true, simulated: { spend_percentage: params.spend_percentage } };
    },
  };

  registerTestController(server, controllerStore);
  return server;
}

serve(createAgent);
