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

  sync_audiences(step, context, options) {
    // Delegate to sample_request for delete/discovery patterns
    const sampleAudiences = step.sample_request?.audiences as Array<Record<string, unknown>> | undefined;
    if (sampleAudiences?.[0]?.delete || (step.sample_request && !step.sample_request.audiences)) {
      return injectContext({ ...step.sample_request, account: context.account ?? resolveAccount(options) }, context);
    }
    return {
      account: context.account ?? resolveAccount(options),
      audiences: [
        {
          audience_id: context.audience_id ?? `test-audience-${Date.now()}`,
          name: 'E2E Test Audience',
          add: [
            {
              external_id: 'user-001',
              hashed_email: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
          ],
        },
      ],
    };
  },

  // ── Brand & Rights ───────────────────────────────────────

  get_brand_identity(step, context, options) {
    const brand = resolveBrand(options);
    return {
      brand_id: context.brand_id ?? (step.sample_request?.brand_id as string) ?? brand.brand_id ?? brand.domain,
    };
  },

  get_rights(step, context, options) {
    const brand = resolveBrand(options);
    return {
      query: 'available rights for advertising',
      uses: ['ai_generated_image'],
      brand_id: context.brand_id ?? (step.sample_request?.brand_id as string) ?? brand.brand_id ?? brand.domain,
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

  create_media_buy(step, context, options) {
    const product = selectProduct(context);
    const pricingOption = selectPricingOption(product);

    const now = Date.now();
    const defaultStart = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const defaultEnd = new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString();

    // Respect sample_request dates when they're future-dated — needed for
    // storyboards that test replay semantics where initial + replay must
    // produce byte-for-byte identical canonical payloads. Two calls
    // generated 5ms apart with `Date.now()` would hash differently,
    // triggering IDEMPOTENCY_CONFLICT on replay. Stale sample dates
    // (authored before the run date) fall back to the dynamic default.
    const sampleStart =
      typeof step.sample_request?.start_time === 'string' ? step.sample_request.start_time : undefined;
    const sampleEnd = typeof step.sample_request?.end_time === 'string' ? step.sample_request.end_time : undefined;
    const startTime = sampleStart && Date.parse(sampleStart) >= now ? sampleStart : defaultStart;
    const endTime = sampleEnd && Date.parse(sampleEnd) >= now ? sampleEnd : defaultEnd;

    // Merge any hand-authored package fields from sample_request (targeting_overlay,
    // measurement_terms, creative_assignments, performance_standards, etc.) so
    // scenario-specific behaviors are exercised. Context-derived identifiers
    // (product_id, pricing_option_id) still win so storyboards share context.
    const samplePackages = (step.sample_request?.packages as Array<Record<string, unknown>> | undefined) ?? [];
    const baseSample = samplePackages[0]
      ? (injectContext({ ...samplePackages[0] }, context) as Record<string, unknown>)
      : {};

    const pkg: Record<string, unknown> = {
      ...baseSample,
      product_id: product?.product_id ?? context.product_id ?? baseSample.product_id ?? 'test-product',
      budget:
        (baseSample.budget as number | undefined) ??
        options.budget ??
        Math.max(1000, (pricingOption?.min_spend_per_package as number) ?? 1000),
      pricing_option_id:
        pricingOption?.pricing_option_id ?? context.pricing_option_id ?? baseSample.pricing_option_id ?? 'default',
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
    // If the storyboard provides a sample_request, honor it — these requests
    // are hand-authored to exercise specific seller behaviors (creative
    // assignment, targeting overlay swaps, pause/resume/cancel, etc.) and the
    // builder should not override the intent.
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }

    const request: Record<string, unknown> = {
      media_buy_id: context.media_buy_id ?? 'unknown',
    };

    if (step.id.includes('pause')) {
      request.paused = true;
    } else if (step.id.includes('resume')) {
      request.paused = false;
    } else if (step.id.includes('cancel')) {
      request.canceled = true;
    } else {
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

  // provide_performance_feedback intentionally has no builder — storyboard
  // sample_request is authoritative because the spec's oneOf requires a
  // performance_index variant that only the storyboard author knows the
  // shape of. A synthesized payload here would emit non-spec fields
  // (feedback/satisfaction/notes) and get rejected with INVALID_REQUEST.

  // ── Catalogs & Events ─────────────────────────────────

  sync_catalogs(step, context, options) {
    // Prefer the fixture's sample_request — it's the authoritative request
    // shape for the storyboard step. The fallback's hardcoded feed_format
    // ('json') is NOT in the spec's 5-literal union and its `type` is
    // missing entirely, so any agent running the generated Zod schema
    // rejects the fallback with -32602 on both fields.
    if (step.sample_request) {
      return injectContext({ ...step.sample_request, account: context.account ?? resolveAccount(options) }, context);
    }
    return {
      account: context.account ?? resolveAccount(options),
      catalogs: [
        {
          catalog_id: `test-catalog-${Date.now()}`,
          name: 'E2E Test Catalog',
          type: 'product',
          feed_url: 'https://test-assets.adcontextprotocol.org/feeds/test-catalog.json',
          feed_format: 'custom',
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

  report_usage(step, context, options) {
    // Prefer the fixture's sample_request — creative-ad-server and other
    // specialisms carry per-usage-entry fields (vendor_cost, currency,
    // pricing_option_id) that the hardcoded fallback here omits, causing
    // agents running the generated Zod schema to reject every step.
    if (step.sample_request) {
      return injectContext({ ...step.sample_request, account: context.account ?? resolveAccount(options) }, context);
    }
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
          account: context.account ?? resolveAccount(options),
          creative_id: context.creative_id ?? 'test-creative',
          impressions: 10000,
          vendor_cost: 500,
          currency: 'USD',
        },
      ],
    };
  },

  // ── Creative ───────────────────────────────────────────

  list_creative_formats() {
    return {};
  },

  build_creative(step, context, options) {
    // Hand-authored sample_request can exercise slot-specific briefs, target
    // format overrides, or multi-format requests — honor it when present.
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
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

  sync_creatives(step, context, options) {
    // Honor hand-authored sample_request for scenarios that require specific
    // creative shapes (delete/patch flows, format-scoped uploads, etc).
    if (step.sample_request) {
      return injectContext({ ...step.sample_request, account: context.account ?? resolveAccount(options) }, context);
    }
    const formats = (context.formats as Array<Record<string, unknown>> | undefined) ?? [];
    const now = Date.now();

    // Send one creative per discovered format so downstream steps
    // (e.g., build_video_tag) can find creatives in every format.
    const creatives =
      formats.length > 0
        ? formats.map((fmt, i) => ({
            creative_id: `test-creative-${now}-${i}`,
            name: `E2E Test Creative ${i + 1}`,
            format_id: fmt.format_id ?? context.format_id ?? { agent_url: 'unknown', id: 'unknown' },
            assets: buildAssetsForFormat(fmt),
          }))
        : [
            {
              creative_id: `test-creative-${now}`,
              name: 'E2E Test Creative',
              format_id: context.format_id ?? { agent_url: 'unknown', id: 'unknown' },
              assets: {
                primary: {
                  url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/hero-master.jpg',
                  width: 1200,
                  height: 628,
                  format: 'image/jpeg',
                },
              },
            },
          ];

    return {
      account: context.account ?? resolveAccount(options),
      creatives,
    };
  },

  list_creatives(_step, context, options) {
    return {
      account: context.account ?? resolveAccount(options),
    };
  },

  // ── Signals ────────────────────────────────────────────

  get_signals(step, context, options) {
    if (options.brief) return { signal_spec: options.brief };
    if (step.sample_request?.signal_ids) {
      return injectContext({ signal_ids: step.sample_request.signal_ids }, context);
    }
    return {};
  },

  activate_signal(step, context, _options) {
    const signal = selectSignal(context);
    const destinations = step.sample_request?.destinations as Array<Record<string, unknown>> | undefined;
    const request: Record<string, unknown> = {
      signal_agent_segment_id: signal?.signal_agent_segment_id ?? context.signal_id ?? 'test-signal',
      pricing_option_id:
        (signal?.pricing_options as Array<Record<string, unknown>> | undefined)?.[0]?.pricing_option_id ??
        context.pricing_option_id,
    };
    if (destinations) {
      request.destinations = (injectContext({ destinations }, context) as Record<string, unknown>).destinations;
    }
    return request;
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
              url: 'https://governance.test.example',
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

  list_content_standards() {
    return {};
  },

  get_content_standards(_step, context, _options) {
    return {
      standards_id: context.content_standards_id ?? 'unknown',
    };
  },

  calibrate_content(step, context, _options) {
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
    return {
      standards_id: context.content_standards_id ?? 'unknown',
      artifact: {
        property_rid: 'test-publisher.example',
        artifact_id: context.creative_id ?? 'test-creative',
        assets: {},
      },
    };
  },

  sync_plans(step, context, options) {
    // Governance storyboards define scenario-specific plans in sample_request
    // (e.g., custom_policies for conditions, reallocation_threshold for denied).
    // Delegate to sample_request when present.
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
    const now = Date.now();
    const startDate = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const endDate = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString();
    return {
      plans: [
        {
          plan_id: `test-plan-${Date.now()}`,
          brand: resolveBrand(options),
          objectives: 'E2E test campaign — maximize reach across digital channels',
          budget: { total: options.budget ?? 10000, currency: 'USD', reallocation_unlimited: true },
          flight: { start: startDate, end: endDate },
          approved_sellers: null,
        },
      ],
    };
  },

  check_governance(step, context, options) {
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
    return {
      plan_id: context.plan_id ?? 'unknown',
      caller: resolveBrand(options).domain,
      payload: {
        type: 'media_buy',
        account: context.account ?? resolveAccount(options),
        total_budget: options.budget ?? 10000,
      },
    };
  },

  get_account_financials(_step, context, options) {
    return {
      account: context.account ?? resolveAccount(options),
    };
  },

  create_content_standards(step, context, _options) {
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
    return {
      name: 'E2E Test Content Standards',
      rules: [{ category: 'brand_safety', description: 'No violent imagery', severity: 'must' }],
    };
  },

  update_content_standards(step, context, _options) {
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
    return {
      standards_id: context.content_standards_id ?? 'unknown',
      add_rules: [{ category: 'quality', description: 'High resolution assets', severity: 'should' }],
    };
  },

  validate_content_delivery(step, context, _options) {
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
    return {
      standards_id: context.content_standards_id ?? 'unknown',
      records: [
        {
          record_id: 'delivery_001',
          artifact: {
            property_rid: 'test-publisher.example',
            artifact_id: context.creative_id ?? 'test-creative',
            assets: {},
          },
        },
      ],
    };
  },

  acquire_rights(step, context, options) {
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
    return {
      rights_id: context.rights_id ?? 'unknown',
      pricing_option_id: 'standard',
      buyer: { domain: resolveBrand(options).domain },
      campaign: {
        description: 'E2E storyboard test campaign',
        uses: ['commercial'],
      },
      revocation_webhook: {
        url: 'https://test.example/webhooks/revocation',
        authentication: {
          schemes: ['Bearer'],
          credentials: 'test-revocation-webhook-secret-token',
        },
      },
    };
  },

  update_rights(step, context, _options) {
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
    return {
      rights_grant_id: context.rights_grant_id ?? 'unknown',
    };
  },

  creative_approval(step, context, _options) {
    if (step.sample_request) {
      return injectContext({ ...step.sample_request }, context);
    }
    return {
      rights_grant_id: context.rights_grant_id ?? 'unknown',
      creative: { creative_id: context.creative_id ?? 'test-creative' },
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
        consent_granted: true,
        user: { principal: resolveAuthPrincipal(options) ?? 'e2e-test-principal' },
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
      reason: 'user_exit',
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

/**
 * Build placeholder assets appropriate for a format's type.
 * Uses the format name to guess whether it's video, native, or display.
 */
function buildAssetsForFormat(format: Record<string, unknown>): Record<string, unknown> {
  const name = String(format.name ?? format.format_id ?? '').toLowerCase();
  const type = String(format.type ?? '').toLowerCase();

  if (type === 'video' || name.includes('video') || name.includes('vast')) {
    return {
      video: {
        url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/trail-pro-30s.mp4',
        duration: 30,
        format: 'video/mp4',
      },
    };
  }

  if (type === 'native' || name.includes('native')) {
    return {
      image: {
        url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/hero-master.jpg',
        width: 1200,
        height: 628,
        format: 'image/jpeg',
      },
      headline: {
        content: 'Trail Pro 3000 — Built for the Summit',
      },
    };
  }

  // Default: display image
  return {
    primary: {
      url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/hero-master.jpg',
      width: 1200,
      height: 628,
      format: 'image/jpeg',
    },
  };
}
