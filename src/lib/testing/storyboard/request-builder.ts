/**
 * Request builder for storyboard steps.
 *
 * Builds valid requests from discovered context rather than using
 * raw sample_request YAML payloads. Each task has a builder that
 * constructs a minimal valid request from the accumulated context
 * (discovered products, accounts, formats, etc.) and TestOptions.
 *
 * sample_request from YAML is used only as documentation and as a
 * fallback when no builder exists for a task.
 */

import { resolveBrand, resolveAccount, resolveAuthPrincipal } from '../client';
import type { TestOptions } from '../types';
import type { StoryboardContext, StoryboardStep } from './types';
import { injectContext } from './context';

type RequestBuilder = (
  step: StoryboardStep,
  context: StoryboardContext,
  options: TestOptions
) => Record<string, unknown>;

const REQUEST_BUILDERS: Record<string, RequestBuilder> = {
  // ── Account & Audience ─────────────────────────────────

  sync_accounts(_step, _context, options) {
    return {
      accounts: [
        {
          brand: resolveBrand(options),
          operator: resolveBrand(options).domain,
          billing: 'operator',
          payment_terms: 'net_30',
        },
      ],
    };
  },

  list_accounts(_step, _context, options) {
    return {
      brand: resolveBrand(options),
    };
  },

  sync_audiences(_step, context, options) {
    return {
      account: context.account ?? resolveAccount(options),
      audiences: [
        {
          audience_id: `test-audience-${Date.now()}`,
          name: 'E2E Test Audience',
          identifiers: [
            {
              type: 'hashed_email',
              value: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
          ],
        },
      ],
    };
  },

  // ── Brand & Rights ───────────────────────────────────────

  get_brand_identity(_step, context, options) {
    const brand = resolveBrand(options);
    return {
      brand_id: context.brand_id ?? brand.brand_id ?? brand.domain,
    };
  },

  get_rights(_step, context, options) {
    const brand = resolveBrand(options);
    return {
      query: 'available rights for advertising',
      uses: ['ai_generated_image'],
      brand_id: context.brand_id ?? brand.brand_id ?? brand.domain,
    };
  },

  // ── Product Discovery ──────────────────────────────────

  get_products(step, context, options) {
    // If the step is a "refine" step, build a refine request
    if (step.sample_request?.buying_mode === 'refine' && context.products) {
      return {
        buying_mode: 'refine',
        refine: [
          {
            scope: 'request',
            ask: 'Only guaranteed packages with premium placement.',
          },
        ],
        brand: resolveBrand(options),
        account: context.account ?? resolveAccount(options),
      };
    }

    return {
      buying_mode: 'brief',
      brief: options.brief || 'Show me all available advertising products across all channels',
      brand: resolveBrand(options),
    };
  },

  // ── Media Buy ──────────────────────────────────────────

  create_media_buy(_step, context, options) {
    const product = selectProduct(context);
    const pricingOption = selectPricingOption(product);

    const now = Date.now();
    const startTime = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const endTime = new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString();

    const pkg: Record<string, unknown> = {
      product_id: product?.product_id ?? context.product_id ?? 'test-product',
      budget: options.budget ?? Math.max(1000, (pricingOption?.min_spend_per_package as number) ?? 1000),
      pricing_option_id: pricingOption?.pricing_option_id ?? context.pricing_option_id ?? 'default',
    };

    // Add bid_price for auction-based pricing
    if (pricingOption?.pricing_model === 'auction' || pricingOption?.pricing_model === 'cpm') {
      const floor = Number(pricingOption?.floor_price) || 5;
      pkg.bid_price = Math.round(floor * 1.5 * 100) / 100;
    }

    return {
      account: context.account ?? resolveAccount(options),
      brand: resolveBrand(options),
      start_time: startTime,
      end_time: endTime,
      packages: [pkg],
    };
  },

  update_media_buy(step, context, _options) {
    const request: Record<string, unknown> = {
      media_buy_id: context.media_buy_id ?? 'unknown',
    };

    // Detect the intent from sample_request or step ID
    if (step.sample_request?.action) {
      request.action = step.sample_request.action;
    } else if (step.id.includes('pause')) {
      request.action = 'pause';
    } else if (step.id.includes('resume')) {
      request.action = 'resume';
    } else if (step.id.includes('cancel')) {
      request.action = 'cancel';
    } else {
      // Default: update budget
      request.packages = [
        {
          package_id: context.package_id,
          budget: 2000,
        },
      ];
    }

    return request;
  },

  get_media_buys(_step, context, _options) {
    return {
      media_buy_ids: [context.media_buy_id ?? 'unknown'],
    };
  },

  get_media_buy_delivery(_step, context, _options) {
    return {
      media_buy_ids: [context.media_buy_id ?? 'unknown'],
    };
  },

  provide_performance_feedback(_step, context, _options) {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return {
      media_buy_id: context.media_buy_id ?? 'unknown',
      measurement_period: {
        start: weekAgo.toISOString(),
        end: now.toISOString(),
      },
      feedback: {
        satisfaction: 'positive',
        notes: 'E2E test feedback',
      },
    };
  },

  // ── Catalogs & Events ─────────────────────────────────

  sync_catalogs(_step, context, options) {
    return {
      account: context.account ?? resolveAccount(options),
      catalogs: [
        {
          catalog_id: `test-catalog-${Date.now()}`,
          name: 'E2E Test Catalog',
          feed_url: 'https://test-assets.adcontextprotocol.org/feeds/test-catalog.json',
          feed_format: 'json',
        },
      ],
    };
  },

  sync_event_sources(_step, context, options) {
    return {
      account: context.account ?? resolveAccount(options),
      event_sources: [
        {
          event_source_id: `test-source-${Date.now()}`,
          name: 'E2E Test Event Source',
          event_types: ['purchase', 'add_to_cart'],
        },
      ],
    };
  },

  log_event(_step, context, _options) {
    return {
      event_source_id: context.event_source_id ?? 'test-source',
      events: [
        {
          event_id: `evt-${Date.now()}`,
          event_type: 'purchase',
          timestamp: new Date().toISOString(),
          value: { amount: 49.99, currency: 'USD' },
        },
      ],
    };
  },

  report_usage(_step, context, options) {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return {
      account: context.account ?? resolveAccount(options),
      reporting_period: {
        start: monthAgo.toISOString(),
        end: now.toISOString(),
      },
      usage: [
        {
          creative_id: context.creative_id ?? 'test-creative',
          impressions: 10000,
          spend: { amount: 500, currency: 'USD' },
        },
      ],
    };
  },

  // ── Creative ───────────────────────────────────────────

  list_creative_formats() {
    return {};
  },

  build_creative(_step, context, options) {
    const format = selectFormat(context);
    return {
      target_format_id: format?.format_id ?? context.format_id ?? { agent_url: 'unknown', id: 'unknown' },
      brand: resolveBrand(options),
      message: 'Create a test advertisement for an e-commerce brand promoting a summer sale.',
      quality: 'draft',
      include_preview: true,
    };
  },

  preview_creative(_step, context, _options) {
    const format = selectFormat(context);
    return {
      request_type: 'single',
      creative_manifest: {
        format_id: format?.format_id ?? context.format_id ?? { agent_url: 'unknown', id: 'unknown' },
        name: 'E2E Test Creative',
        assets: {},
      },
    };
  },

  sync_creatives(_step, context, options) {
    const format = selectFormat(context);
    const formatId = format?.format_id ?? context.format_id ?? { agent_url: 'unknown', id: 'unknown' };

    // Build assets as a record (not array) — keyed by asset role
    const assets: Record<string, unknown> = {
      primary: {
        url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/hero-master.jpg',
        width: 1200,
        height: 628,
        format: 'image/jpeg',
      },
    };

    return {
      account: context.account ?? resolveAccount(options),
      creatives: [
        {
          creative_id: `test-creative-${Date.now()}`,
          name: 'E2E Test Creative',
          format_id: formatId,
          assets,
        },
      ],
    };
  },

  list_creatives(_step, context, options) {
    return {
      account: context.account ?? resolveAccount(options),
    };
  },

  // ── Signals ────────────────────────────────────────────

  get_signals(_step, _context, options) {
    return options.brief ? { signal_spec: options.brief } : {};
  },

  activate_signal(step, context, _options) {
    const signal = selectSignal(context);
    // Use step-specific destinations when the storyboard defines them (e.g., agent vs platform)
    const destinations = step.sample_request?.destinations ?? [
      { type: 'platform', platform: 'dv360', account: 'test-dv360-account' },
      { type: 'platform', platform: 'trade-desk', account: 'test-ttd-account' },
    ];
    return {
      signal_agent_segment_id: signal?.signal_agent_segment_id ?? context.signal_id ?? 'test-signal',
      pricing_option_id:
        (signal?.pricing_options as Array<Record<string, unknown>> | undefined)?.[0]?.pricing_option_id ??
        context.pricing_option_id,
      destinations,
    };
  },

  // ── Capabilities ───────────────────────────────────────

  get_adcp_capabilities() {
    return {};
  },

  // ── Governance ─────────────────────────────────────────

  sync_governance(_step, context, options) {
    return {
      accounts: [
        {
          account: context.account ?? resolveAccount(options),
          governance_agents: [
            {
              url: 'https://governance.test.example.com',
              authentication: {
                schemes: ['Bearer'],
                credentials: 'test-governance-token',
              },
              categories: ['budget_authority', 'brand_policy'],
            },
          ],
        },
      ],
    };
  },

  create_property_list(_step, _context, options) {
    return {
      name: options.property_list_name ?? `E2E Test List ${Date.now()}`,
      description: 'Property list created by storyboard testing',
      base_properties: {
        include: [{ identifier_type: 'domain', identifier_value: 'test.example.com' }],
      },
      filters: {
        garm_categories: { exclude: ['adult', 'arms'] },
      },
      brand_manifest: { name: resolveBrand(options).domain, url: `https://${resolveBrand(options).domain}` },
    };
  },

  get_property_list(_step, context, _options) {
    return {
      list_id: context.property_list_id ?? 'unknown',
      resolve: true,
    };
  },

  update_property_list(_step, context, _options) {
    return {
      list_id: context.property_list_id ?? 'unknown',
      description: 'Updated by storyboard testing',
      base_properties: {
        include: [
          { identifier_type: 'domain', identifier_value: 'test.example.com' },
          { identifier_type: 'domain', identifier_value: 'updated.example.com' },
        ],
      },
    };
  },

  list_property_lists() {
    return {};
  },

  delete_property_list(_step, context, _options) {
    return {
      list_id: context.property_list_id ?? 'unknown',
    };
  },

  list_content_standards() {
    return {};
  },

  get_content_standards(_step, context, _options) {
    return {
      content_standards_id: context.content_standards_id ?? 'unknown',
    };
  },

  sync_plans(_step, context, options) {
    return {
      account: context.account ?? resolveAccount(options),
      plans: [
        {
          plan_id: `test-plan-${Date.now()}`,
          name: 'E2E Test Plan',
          budget: { total: options.budget ?? 10000, currency: 'USD' },
        },
      ],
    };
  },

  // ── Sponsored Intelligence ─────────────────────────────

  si_get_offering(_step, _context, options) {
    return {
      offering_id: options.si_offering_id ?? 'e2e-test-offering',
      context: options.si_context ?? 'E2E testing - checking SI offering availability',
      identity: {
        principal: resolveAuthPrincipal(options) ?? 'e2e-test-principal',
        device_id: 'e2e-test-device',
      },
    };
  },

  si_initiate_session(_step, context, options) {
    return {
      offering_id: context.offering_id ?? options.si_offering_id ?? 'e2e-test-offering',
      offering_token: context.offering_token,
      identity: {
        principal: resolveAuthPrincipal(options) ?? 'e2e-test-principal',
        device_id: 'e2e-test-device',
      },
      context: options.si_context ?? 'E2E test session',
      placement: 'e2e-test',
      supported_capabilities: {
        modalities: { conversational: true, rich_media: true },
      },
    };
  },

  si_send_message(_step, context, _options) {
    return {
      session_id: context.session_id ?? 'unknown',
      message: 'Tell me more about this product.',
    };
  },

  si_terminate_session(_step, context, _options) {
    return {
      session_id: context.session_id ?? 'unknown',
    };
  },

  // ── Test Controller ────────────────────────────────────

  comply_test_controller(step, context, options) {
    // The test controller requires account.sandbox: true to be set.
    const account = { ...(context.account ?? resolveAccount(options)), sandbox: true };
    if (step.sample_request) {
      return { ...injectContext({ ...step.sample_request }, context), account };
    }
    return {
      account,
      scenario: context.controller_scenario ?? 'list_scenarios',
    };
  },
};

/**
 * Build a request for a storyboard step.
 *
 * Priority:
 * 1. User-provided --request override (from StoryboardRunOptions)
 * 2. Request builder for the task (builds from context + options)
 * 3. sample_request from YAML with context injection (fallback)
 * 4. Empty object
 */
export function buildRequest(
  step: StoryboardStep,
  context: StoryboardContext,
  options: TestOptions
): Record<string, unknown> {
  const builder = REQUEST_BUILDERS[step.task];
  if (builder) {
    return builder(step, context, options);
  }

  // No builder — fall through to sample_request (handled by runner)
  return {};
}

/**
 * Check if a request builder exists for a task.
 */
export function hasRequestBuilder(taskName: string): boolean {
  return taskName in REQUEST_BUILDERS;
}

// ────────────────────────────────────────────────────────────
// Selection helpers: pick the best item from discovered data
// ────────────────────────────────────────────────────────────

function selectProduct(context: StoryboardContext): Record<string, unknown> | undefined {
  const products = context.products as Array<Record<string, unknown>> | undefined;
  if (!products?.length) return undefined;

  // Prefer products with guaranteed delivery and pricing options
  const withPricing = products.filter(p => {
    const opts = p.pricing_options as unknown[] | undefined;
    return opts && opts.length > 0;
  });

  return withPricing[0] ?? products[0];
}

function selectPricingOption(product: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!product) return undefined;
  const options = product.pricing_options as Array<Record<string, unknown>> | undefined;
  if (!options?.length) return undefined;

  // Prefer fixed pricing (cpm, flat) over auction
  const fixed = options.filter(o => o.pricing_model === 'cpm' || o.pricing_model === 'flat');
  return fixed[0] ?? options[0];
}

function selectFormat(context: StoryboardContext): Record<string, unknown> | undefined {
  const formats = context.formats as Array<Record<string, unknown>> | undefined;
  if (!formats?.length) return undefined;
  return formats[0];
}

function selectSignal(context: StoryboardContext): Record<string, unknown> | undefined {
  const signals = context.signals as Array<Record<string, unknown>> | undefined;
  if (!signals?.length) return undefined;
  return signals[0];
}
