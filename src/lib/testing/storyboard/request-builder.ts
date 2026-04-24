/**
 * Request enrichers for storyboard steps.
 *
 * Contract (see issue #820):
 *   - `sample_request` (when authored) is the authoritative base payload.
 *     The runner injects context placeholders into it and passes it through
 *     to the agent under test.
 *   - An enricher fills top-level fields the fixture didn't specify —
 *     typically discovery-derived identifiers (`product_id`, `format_id`,
 *     `account`, `media_buy_id`) or envelope fields that only the harness
 *     knows.
 *   - For conflicts at the top level, the fixture wins — storyboard authors'
 *     intent is not silently overridden.
 *
 * A short list of tasks need to splice discovery-derived fields INTO
 * nested structures in the fixture (e.g. `create_media_buy` injects
 * `product_id` into `packages[0]`) and can't be expressed by a top-level
 * overlay. Those enrichers declare themselves fixture-aware via
 * `FIXTURE_AWARE_ENRICHERS` below and the runner uses their output as-is.
 *
 * `sample_request` from YAML, when a task has no enricher, is used directly
 * after context injection — preserves the "no handler, fixture is the wire
 * payload" pattern.
 */

import { resolveBrand, resolveAccount } from '../client';
import type { TestOptions } from '../types';
import type { StoryboardContext, StoryboardStep } from './types';
import { injectContext, type RunnerVariables } from './context';

type RequestEnricher = (
  step: StoryboardStep,
  context: StoryboardContext,
  options: TestOptions
) => Record<string, unknown>;

/** Legacy alias kept for external consumers pinned to the old terminology. */
type RequestBuilder = RequestEnricher;

/**
 * Placeholder `format_id` used when neither `list_creative_formats` discovery
 * nor accumulated `context.format_id` supplied one. Schema
 * (core/format-id.json) requires `agent_url` in URI form, so a bare
 * `"unknown"` string fails validation. `example.com` is reserved for
 * documentation per RFC 2606 — an obvious fixture that strict JSON-schema
 * validators accept and that downstream handlers resolve to a clean
 * format-not-found error rather than an unrelated crash. Frozen so a
 * builder that accidentally spread-mutates the shared constant hits a
 * TypeError instead of silently corrupting sibling calls.
 */
const UNKNOWN_FORMAT_ID = Object.freeze({ agent_url: 'https://unknown.example.com/', id: 'unknown' });

/**
 * Placeholder `caller` URL for tasks whose schema names the CALLER-AGENT's
 * URL (not the brand or the seller). `check_governance.caller` is the canonical
 * case: governance agents bind this field to agent identity for rate limiting,
 * audit trails, and (with `signed-requests`) JWS issuer correlation — emitting
 * the brand domain here names the wrong entity and will confuse strict
 * governance agents. Storyboards that care about a specific caller identity
 * author sample_request; this is the fallback when neither fixture nor
 * harness-supplied agent URL is present.
 */
const FALLBACK_CALLER_AGENT_URL = 'https://e2e-orchestrator.adcontextprotocol.org/';

/**
 * Tasks whose enricher must see `sample_request` to produce the final
 * payload — typically because it needs to splice discovery-derived fields
 * INTO nested structures the fixture owns (arrays, object trees). For
 * these, the runner uses the enricher's output verbatim and does not
 * layer the fixture on top; the enricher is responsible for fixture
 * precedence internally.
 */
const FIXTURE_AWARE_ENRICHERS = new Set<string>([
  'create_media_buy', // merges discovery-derived product_id / pricing_option_id INTO fixture packages[0]
  'comply_test_controller', // forces account.sandbox: true regardless of fixture
]);

const REQUEST_ENRICHERS: Record<string, RequestEnricher> = {
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
    // Honor hand-authored sample_request so storyboards can register a
    // specific audience_id that downstream steps reference. Without this,
    // add-shaped sample_request blocks (authored with audience_id + add[])
    // fell through to the generated fallback id, and a later delete_audience
    // or context-substitution step would hit AUDIENCE_NOT_FOUND because the
    // sync had registered a different id. Matches the pattern used by
    // sync_event_sources, sync_catalogs, and sync_creatives.
    if (step.sample_request) {
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
    // Honor hand-authored sample_request so storyboards can specify
    // scenario-specific query text, uses, countries, or buyer_brand.
    // Peer builders (sync_plans, check_governance, list_creative_formats,
    // create_content_standards, etc.) follow the same pattern.
    //
    // Without this, any get_rights step hits the wire with the generic
    // fallback and a brand_id derived from the caller's domain — which
    // rights-holder rosters reject as unknown, so rights[0] is undefined,
    // $context.rights_id doesn't resolve, and downstream acquire_rights
    // steps fail with rights_not_found instead of the error the
    // storyboard is actually asserting (e.g., GOVERNANCE_DENIED).
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

    // Merge hand-authored package fields from sample_request (targeting_overlay,
    // measurement_terms, creative_assignments, performance_standards, etc.) so
    // scenario-specific behaviors are exercised. The fixture wins on every
    // field it authors — storyboards that name a specific `product_id` +
    // `pricing_option_id` are asserting against a seller that ships those
    // identifiers, and discovery-derived values must never override them.
    // Discovery fills the gaps for generic storyboards that omit the first
    // package's identifiers. Additional packages pass through as-authored
    // with context injection only.
    const samplePackages = (step.sample_request?.packages as Array<Record<string, unknown>> | undefined) ?? [];
    const baseSample = samplePackages[0]
      ? (injectContext({ ...samplePackages[0] }, context) as Record<string, unknown>)
      : {};

    const firstPkg: Record<string, unknown> = {
      ...baseSample,
      product_id:
        (baseSample.product_id as string | undefined) ?? product?.product_id ?? context.product_id ?? 'test-product',
      budget:
        (baseSample.budget as number | undefined) ??
        options.budget ??
        Math.max(1000, (pricingOption?.min_spend_per_package as number) ?? 1000),
      pricing_option_id:
        (baseSample.pricing_option_id as string | undefined) ??
        pricingOption?.pricing_option_id ??
        context.pricing_option_id ??
        'default',
    };

    // Synthesize a bid_price for auction/cpm pricing only when the fixture
    // didn't author one. Storyboards that test auction flows (e.g.
    // sales-non-guaranteed) author explicit bid_prices the seller validates
    // against floor_price; discovery-synthesized values would silently
    // override intentional bid-floor-boundary tests.
    if (
      baseSample.bid_price === undefined &&
      (pricingOption?.pricing_model === 'auction' || pricingOption?.pricing_model === 'cpm')
    ) {
      const floor = Number(pricingOption?.floor_price) || 5;
      firstPkg.bid_price = Math.round(floor * 1.5 * 100) / 100;
    }

    const additionalPkgs = samplePackages
      .slice(1)
      .map(p => injectContext({ ...p }, context) as Record<string, unknown>);

    return {
      account: context.account ?? resolveAccount(options),
      brand: resolveBrand(options),
      start_time: startTime,
      end_time: endTime,
      packages: [firstPkg, ...additionalPkgs],
    };
  },

  update_media_buy(step, context, options) {
    // If the storyboard provides a sample_request, honor it — these requests
    // are hand-authored to exercise specific seller behaviors (creative
    // assignment, targeting overlay swaps, pause/resume/cancel, etc.) and the
    // builder should not override the intent.

    // `account` is required per bundled/media-buy/update-media-buy-request.json —
    // sellers enforce governance and account resolution against it.
    const request: Record<string, unknown> = {
      account: context.account ?? resolveAccount(options),
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
          package_id: (context.package_id as string | undefined) ?? 'unknown',
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

  log_event(step, context, _options) {
    // Storyboards routinely ship spec-conformant event payloads with
    // event_time, content_ids, and custom_data siblings that only the
    // author knows. Honor sample_request when present.
    return {
      event_source_id: context.event_source_id ?? 'test-source',
      events: [
        {
          event_id: `evt-${Date.now()}`,
          event_type: 'purchase',
          event_time: new Date().toISOString(),
          custom_data: { value: 49.99, currency: 'USD' },
        },
      ],
    };
  },

  report_usage(step, context, options) {
    // Prefer the fixture's sample_request — creative-ad-server and other
    // specialisms carry per-usage-entry fields (vendor_cost, currency,
    // pricing_option_id) that the hardcoded fallback here omits, causing
    // agents running the generated Zod schema to reject every step.
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

  list_creative_formats(step, context) {
    // Mirror the pattern used by peer builders (build_creative, sync_creatives,
    // etc.): honor hand-authored sample_request so storyboards can exercise
    // format_ids filters and other query params. Without this, any step that
    // declares `format_ids: ["..."]` in sample_request hits the wire as an
    // empty request and the agent returns unfiltered results — failing
    // round-trip / substitution-observer assertions silently.
    return {};
  },

  build_creative(step, context, options) {
    // Hand-authored sample_request can exercise slot-specific briefs, target
    // format overrides, or multi-format requests — honor it when present.
    const format = selectFormat(context);
    return {
      target_format_id: format?.format_id ?? context.format_id ?? UNKNOWN_FORMAT_ID,
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
        format_id: format?.format_id ?? context.format_id ?? UNKNOWN_FORMAT_ID,
        name: 'E2E Test Creative',
        assets: {},
      },
    };
  },

  sync_creatives(step, context, options) {
    // Honor hand-authored sample_request for scenarios that require specific
    // creative shapes (delete/patch flows, format-scoped uploads, etc).
    const formats = (context.formats as Array<Record<string, unknown>> | undefined) ?? [];
    const now = Date.now();

    // Send one creative per discovered format so downstream steps
    // (e.g., build_video_tag) can find creatives in every format.
    const creatives =
      formats.length > 0
        ? formats.map((fmt, i) => ({
            creative_id: `test-creative-${now}-${i}`,
            name: `E2E Test Creative ${i + 1}`,
            format_id: fmt.format_id ?? context.format_id ?? UNKNOWN_FORMAT_ID,
            assets: buildAssetsForFormat(fmt),
          }))
        : [
            {
              creative_id: `test-creative-${now}`,
              name: 'E2E Test Creative',
              format_id: context.format_id ?? UNKNOWN_FORMAT_ID,
              assets: {
                primary: {
                  asset_type: 'image',
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
    // `anyOf: [{required: [signal_spec]}, {required: [signal_ids]}]` — the
    // schema rejects an empty object. Default to a discovery-style
    // `signal_spec` so storyboards that omit `options.brief` still send a
    // conforming request. A real test should author sample_request or pass
    // options.brief; this is the minimally valid fallback.
    return { signal_spec: 'E2E fallback signal discovery' };
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
    request.destinations = destinations
      ? (injectContext({ destinations }, context) as Record<string, unknown>).destinations
      : [{ type: 'agent', agent_url: 'https://test.example/signals' }];
    return request;
  },

  // ── Capabilities ───────────────────────────────────────

  get_adcp_capabilities() {
    return {};
  },

  // ── Governance ─────────────────────────────────────────

  sync_governance(step, context, options) {
    return {
      accounts: [
        {
          account: context.account ?? resolveAccount(options),
          governance_agents: [
            {
              url: 'https://governance.test.example',
              authentication: {
                schemes: ['Bearer'],
                credentials: 'test-governance-token-padded-to-meet-min-length-32',
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
    return {
      standards_id: context.content_standards_id ?? 'unknown',
      artifact: {
        property_rid: 'test-publisher.example',
        artifact_id: context.creative_id ?? 'test-creative',
        assets: [],
      },
    };
  },

  sync_plans(step, context, options) {
    // Governance storyboards define scenario-specific plans in sample_request
    // (e.g., custom_policies for conditions, reallocation_threshold for denied).
    // Delegate to sample_request when present.
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
    // `caller` names the CALLER-AGENT's URL, not the brand — governance agents
    // use it for agent identity (rate limits, audit, JWS issuer correlation).
    // The brand belongs inside `payload`, where governance rules about the
    // advertised entity are evaluated. Using the fallback harness-orchestrator
    // URL keeps the semantics honest when no sample_request is authored.
    return {
      plan_id: context.plan_id ?? 'unknown',
      caller: FALLBACK_CALLER_AGENT_URL,
      payload: {
        type: 'media_buy',
        account: context.account ?? resolveAccount(options),
        brand: resolveBrand(options),
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
    // `anyOf: [{required: [policies]}, {required: [registry_policy_ids]}]` —
    // one must be present. Emit a minimal inline bespoke policy rather than
    // pinning a registry id the agent may not carry; storyboards that want
    // real governance coverage author sample_request.
    //
    // Contamination safeguards for the rare case a fallback hits a shared
    // sandbox: `enforcement: "should"` keeps this from hardening into a deny
    // rule against real content, and the ephemeral `policy_id` (timestamped
    // + "e2e-fallback-" prefix) guarantees uniqueness per run so a stale
    // policy can't be matched by accident.
    return {
      scope: {
        languages_any: ['en'],
        description: 'E2E fallback content standards — replace via sample_request for real governance coverage',
      },
      policies: [
        {
          policy_id: `e2e-fallback-${Date.now()}`,
          enforcement: 'should',
          policy: 'E2E fallback policy — storyboard author did not supply sample_request.',
        },
      ],
    };
  },

  update_content_standards(step, context, _options) {
    return {
      standards_id: context.content_standards_id ?? 'unknown',
    };
  },

  validate_content_delivery(step, context, _options) {
    return {
      standards_id: context.content_standards_id ?? 'unknown',
      records: [
        {
          record_id: 'delivery_001',
          artifact: {
            property_rid: 'test-publisher.example',
            artifact_id: context.creative_id ?? 'test-creative',
            assets: [],
          },
        },
      ],
    };
  },

  acquire_rights(step, context, options) {
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
    return {
      rights_id: context.rights_id ?? 'unknown',
    };
  },

  creative_approval(step, context, _options) {
    return {
      rights_id: context.rights_id ?? 'unknown',
      creative_id: context.creative_id ?? 'test-creative',
      creative_url:
        (context.creative_url as string | undefined) ??
        'https://test-assets.adcontextprotocol.org/acme-outdoor/hero-master.jpg',
    };
  },

  // ── Sponsored Intelligence ─────────────────────────────

  si_get_offering(step, context, options) {
    return {
      offering_id: options.si_offering_id ?? 'e2e-test-offering',
      intent: options.si_context ?? 'E2E testing - checking SI offering availability',
    };
  },

  si_initiate_session(step, context, options) {
    // `intent` is required and represents the user's ask. Default to a
    // semantically plausible one so agents that dispatch on intent still
    // behave sensibly; storyboards override via sample_request when
    // testing intent-specific paths.
    return {
      offering_id: context.offering_id ?? options.si_offering_id ?? 'e2e-test-offering',
      offering_token: context.offering_token,
      identity: {
        consent_granted: false,
        anonymous_session_id: `e2e-anon-${Date.now()}`,
      },
      intent: options.si_context ?? 'Browse available offerings',
      placement: 'e2e-test',
      supported_capabilities: {
        modalities: { conversational: true, rich_media: true },
      },
    };
  },

  si_send_message(step, context, _options) {
    return {
      session_id: context.session_id ?? 'unknown',
      message: 'Tell me more about this product.',
    };
  },

  si_terminate_session(step, context, _options) {
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
 * Enrich a storyboard step's request payload.
 *
 * Contract (issue #820):
 *   - `sample_request`, when authored, is the authoritative base. The runner
 *     injects context placeholders into it before calling here.
 *   - An enricher (if registered for the task) produces fields that should
 *     fill gaps the fixture left unset — discovery-derived identifiers,
 *     envelope fields the author couldn't know at YAML-authoring time.
 *   - Top-level merge: fixture wins on key conflicts. Fixture-aware
 *     enrichers (see `FIXTURE_AWARE_ENRICHERS`) skip the generic merge and
 *     return the final payload themselves.
 *
 * Returns `{}` when the task has no enricher and no `sample_request` — the
 * runner's load-time validator prevents this for mutating tasks, so the
 * empty return is reachable only for read tasks that have no fixture and
 * no registered enricher (rare).
 */
/**
 * Envelope fields that live on every AdCP request and are owned by the
 * storyboard author — `context.correlation_id`, runner-supplied
 * `idempotency_key` aliases, webhook pointers, per-request extensions.
 * Fixture-aware enrichers (`create_media_buy`, `comply_test_controller`)
 * build their body from scratch and don't re-copy these fields, so the
 * outer `enrichRequest` overlays them from sample_request after the
 * enricher runs. Non-fixture-aware enrichers get these via the generic
 * top-level merge below.
 *
 * If a future fixture-aware enricher starts emitting an envelope field
 * itself (e.g. a scenario where the enricher needs to inject a specific
 * `idempotency_key` independent of the fixture), the `=== undefined`
 * guard below keeps the enricher's value — intentional, not a bug.
 * Fixture envelope fields only flow through for fields the enricher
 * didn't set.
 */
const ENVELOPE_FIELDS = ['context', 'ext', 'push_notification_config', 'idempotency_key'] as const;

export function enrichRequest(
  step: StoryboardStep,
  context: StoryboardContext,
  options: TestOptions,
  runnerVars?: RunnerVariables
): Record<string, unknown> {
  const enricher = REQUEST_ENRICHERS[step.task];
  const fixture =
    step.sample_request !== undefined
      ? (injectContext({ ...(step.sample_request as Record<string, unknown>) }, context, runnerVars) as Record<
          string,
          unknown
        >)
      : undefined;

  if (!enricher) return fixture ?? {};

  const enriched = enricher(step, context, options);

  // Fixture-aware enrichers already did the body merge internally and know
  // the array/nested shapes better than a generic top-level overlay can.
  // Envelope fields still flow through from sample_request.
  if (FIXTURE_AWARE_ENRICHERS.has(step.task)) {
    if (!fixture) return enriched;
    const out: Record<string, unknown> = { ...enriched };
    for (const field of ENVELOPE_FIELDS) {
      if (fixture[field] !== undefined && out[field] === undefined) out[field] = fixture[field];
    }
    return out;
  }

  // Generic fixture-authoritative merge: fixture keys overlay enricher keys.
  return fixture ? { ...enriched, ...fixture } : enriched;
}

/** True iff a request enricher is registered for this task. */
export function hasRequestEnricher(taskName: string): boolean {
  return taskName in REQUEST_ENRICHERS;
}

// ────────────────────────────────────────────────────────────
// Legacy aliases — pre-#820 terminology. Kept for one release so
// external consumers (repo greps found none, but public exports may
// have downstream users) migrate at their own pace.
// ────────────────────────────────────────────────────────────

/** @deprecated Renamed to `enrichRequest`. Same behavior. */
export const buildRequest = enrichRequest;

/** @deprecated Renamed to `hasRequestEnricher`. Same behavior. */
export const hasRequestBuilder = hasRequestEnricher;

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
        asset_type: 'video',
        url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/trail-pro-30s.mp4',
        width: 1920,
        height: 1080,
        duration_ms: 30000,
        container_format: 'video/mp4',
      },
    };
  }

  if (type === 'native' || name.includes('native')) {
    return {
      image: {
        asset_type: 'image',
        url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/hero-master.jpg',
        width: 1200,
        height: 628,
        format: 'image/jpeg',
      },
      headline: {
        asset_type: 'text',
        content: 'Trail Pro 3000 — Built for the Summit',
      },
    };
  }

  // Default: display image
  return {
    primary: {
      asset_type: 'image',
      url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/hero-master.jpg',
      width: 1200,
      height: 628,
      format: 'image/jpeg',
    },
  };
}
