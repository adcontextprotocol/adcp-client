/**
 * Tests for storyboard request builder.
 *
 * Validates that request builders produce schema-compliant requests
 * from various context states (full context, empty context, etc.).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { buildRequest, hasRequestBuilder } = require('../../dist/lib/testing/storyboard/request-builder.js');

const DEFAULT_OPTIONS = {
  brand: { domain: 'acmeoutdoor.example' },
  account: { brand: { domain: 'acmeoutdoor.example' }, operator: 'acmeoutdoor.example' },
};

// Fixture dates past the enricher's stale-date substitution boundary.
// The create_media_buy enricher replaces past-dated sample_request.start_time
// / end_time with dynamic defaults; these literals skip that path so
// fixture-precedence tests stay deterministic across CI wall-clock drift.
const FUTURE_START = '9999-01-01T00:00:00Z';
const FUTURE_END = '9999-02-01T00:00:00Z';

function step(task, overrides = {}) {
  return { id: `test-${task}`, title: `Test ${task}`, task, ...overrides };
}

describe('Request Builder', () => {
  describe('create_media_buy', () => {
    test('always includes pricing_option_id from discovered context', () => {
      const context = {
        products: [
          {
            product_id: 'prod-1',
            pricing_options: [{ pricing_option_id: 'opt-1', pricing_model: 'cpm' }],
          },
        ],
      };
      const result = buildRequest(step('create_media_buy'), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages[0].pricing_option_id, 'opt-1');
    });

    test('includes default pricing_option_id when no products discovered', () => {
      const result = buildRequest(step('create_media_buy'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages[0].pricing_option_id, 'default');
      assert.ok(result.packages[0].product_id, 'should have product_id');
      assert.ok(result.packages[0].budget > 0, 'should have positive budget');
    });

    test('includes pricing_option_id from context fallback', () => {
      const context = { pricing_option_id: 'ctx-opt' };
      const result = buildRequest(step('create_media_buy'), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages[0].pricing_option_id, 'ctx-opt');
    });

    test('includes start_time and end_time', () => {
      const result = buildRequest(step('create_media_buy'), {}, DEFAULT_OPTIONS);
      assert.ok(result.start_time, 'should have start_time');
      assert.ok(result.end_time, 'should have end_time');
      assert.ok(new Date(result.start_time) < new Date(result.end_time), 'start should be before end');
    });

    test('emits every package when sample_request authors multiple', () => {
      // Regression: storyboards with multi-package sample_request (e.g.,
      // sales_non_guaranteed) had packages[1+] dropped, which left
      // context_outputs like second_package_id unresolved and caused the
      // next step to be skipped with "unresolved context variables".
      const s = step('create_media_buy', {
        sample_request: {
          start_time: FUTURE_START,
          end_time: FUTURE_END,
          packages: [
            {
              product_id: 'sports_display_auction',
              budget: 10000,
              bid_price: 8.5,
              pricing_option_id: 'cpm_auction',
            },
            {
              product_id: 'outdoor_video_auction',
              budget: 15000,
              bid_price: 22.0,
              pricing_option_id: 'cpm_auction',
            },
          ],
        },
      });
      const result = buildRequest(s, {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages.length, 2, 'both packages emitted');
      assert.strictEqual(result.packages[1].product_id, 'outdoor_video_auction');
      assert.strictEqual(result.packages[1].bid_price, 22.0);
      assert.strictEqual(result.packages[1].pricing_option_id, 'cpm_auction');
    });

    test('injects context into additional packages', () => {
      const s = step('create_media_buy', {
        sample_request: {
          start_time: FUTURE_START,
          packages: [
            { product_id: 'p1', budget: 1000, pricing_option_id: 'opt' },
            { product_id: '$context.secondary_product', budget: 2000, pricing_option_id: 'opt' },
          ],
        },
      });
      const context = { secondary_product: 'resolved_product_id' };
      const result = buildRequest(s, context, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages[1].product_id, 'resolved_product_id');
    });

    test('fixture pricing_option_id wins over discovered product pricing (regression #862)', () => {
      // Storyboards that author an explicit pricing_option_id on the first
      // package are asserting against a seller that ships that identifier.
      // Discovery may return unrelated pricing_options[0] values — the
      // enricher must not override the fixture's intent.
      const context = {
        products: [
          {
            product_id: 'discovered-product',
            pricing_options: [{ pricing_option_id: 'discovered-pricing-id', pricing_model: 'cpm' }],
          },
        ],
      };
      const s = step('create_media_buy', {
        sample_request: {
          start_time: FUTURE_START,
          packages: [{ product_id: 'fixture-product', pricing_option_id: 'cpm_guaranteed', budget: 5000 }],
        },
      });
      const result = buildRequest(s, context, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages[0].pricing_option_id, 'cpm_guaranteed', 'fixture pricing_option_id wins');
      assert.strictEqual(result.packages[0].product_id, 'fixture-product', 'fixture product_id wins');
      assert.strictEqual(result.packages[0].budget, 5000, 'fixture budget wins');
    });

    test('fixture bid_price wins over discovered floor-based synthesis (regression #862)', () => {
      // Storyboards that assert bid-floor boundary behavior author explicit
      // bid_prices the seller validates. Discovery-derived floor math must
      // not silently override those values.
      const context = {
        products: [
          {
            product_id: 'auction-product',
            pricing_options: [{ pricing_option_id: 'opt', pricing_model: 'auction', floor_price: 10 }],
          },
        ],
      };
      const s = step('create_media_buy', {
        sample_request: {
          start_time: FUTURE_START,
          packages: [{ product_id: 'auction-product', pricing_option_id: 'opt', bid_price: 2.5 }],
        },
      });
      const result = buildRequest(s, context, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages[0].bid_price, 2.5, 'fixture bid_price wins over floor * 1.5');
    });

    test('discovered pricing fills gaps when fixture omits the first package package-level ids', () => {
      // Generic storyboards that ship a sample_request body without
      // per-package identifiers rely on discovery — this behavior is what
      // lets single-package storyboards run against arbitrary sellers.
      const context = {
        products: [
          {
            product_id: 'discovered',
            pricing_options: [{ pricing_option_id: 'discovered-pricing', pricing_model: 'cpm' }],
          },
        ],
      };
      const s = step('create_media_buy', {
        sample_request: {
          start_time: FUTURE_START,
          packages: [{ targeting_overlay: { geo_targets: { countries: ['US'] } } }],
        },
      });
      const result = buildRequest(s, context, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages[0].product_id, 'discovered', 'discovery fills missing product_id');
      assert.strictEqual(
        result.packages[0].pricing_option_id,
        'discovered-pricing',
        'discovery fills missing pricing_option_id'
      );
      assert.deepStrictEqual(
        result.packages[0].targeting_overlay,
        { geo_targets: { countries: ['US'] } },
        'fixture fields outside the id set pass through'
      );
    });

    test('sentinel `test-product` / `test-pricing` fixture defers to discovery (upstream universal storyboards)', () => {
      // The upstream compliance storyboards (adcontextprotocol/adcp:
      // universal/deterministic-testing.yaml, error-compliance.yaml,
      // idempotency.yaml, domains/media-buy/state-machine.yaml) ship
      // fixture `packages[0]` with `product_id: "test-product"` and
      // `pricing_option_id: "test-pricing"` expecting the runner to
      // substitute the seller's discovered identifiers. Those fixtures
      // live in the spec repo and can't be rewritten from the SDK —
      // the enricher must recognize these sentinels and defer.
      const context = {
        products: [
          {
            product_id: 'real_seller_product',
            pricing_options: [{ pricing_option_id: 'real_seller_cpm', pricing_model: 'cpm' }],
          },
        ],
      };
      const s = step('create_media_buy', {
        sample_request: {
          start_time: FUTURE_START,
          packages: [{ product_id: 'test-product', budget: 5000, pricing_option_id: 'test-pricing' }],
        },
      });
      const result = buildRequest(s, context, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages[0].product_id, 'real_seller_product', 'sentinel product_id → discovery');
      assert.strictEqual(
        result.packages[0].pricing_option_id,
        'real_seller_cpm',
        'sentinel pricing_option_id → discovery'
      );
      assert.strictEqual(result.packages[0].budget, 5000, 'non-sentinel fixture fields pass through');
    });

    test('empty fixture package object {} falls back to discovery cleanly', () => {
      // Some storyboards ship `packages: [{}]` for defaults-only scenarios
      // where every field should come from discovery / enricher synthesis.
      const context = {
        products: [
          {
            product_id: 'discovered',
            pricing_options: [{ pricing_option_id: 'discovered-pricing', pricing_model: 'cpm' }],
          },
        ],
      };
      const s = step('create_media_buy', {
        sample_request: { start_time: FUTURE_START, packages: [{}] },
      });
      const result = buildRequest(s, context, DEFAULT_OPTIONS);
      assert.strictEqual(result.packages[0].product_id, 'discovered');
      assert.strictEqual(result.packages[0].pricing_option_id, 'discovered-pricing');
      assert.ok(result.packages[0].budget > 0, 'budget synthesized from min_spend_per_package or default');
    });
  });

  describe('provide_performance_feedback', () => {
    test('has no builder so runner delegates to sample_request', () => {
      assert.ok(!hasRequestBuilder('provide_performance_feedback'));
    });
  });

  describe('get_brand_identity', () => {
    test('includes brand_id from options', () => {
      const result = buildRequest(step('get_brand_identity'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.brand_id, 'acmeoutdoor.example');
    });
  });

  describe('get_rights', () => {
    test('includes query, uses, and brand_id', () => {
      const result = buildRequest(step('get_rights'), {}, DEFAULT_OPTIONS);
      assert.ok(result.query, 'should have query');
      assert.ok(Array.isArray(result.uses), 'should have uses array');
      assert.strictEqual(result.brand_id, 'acmeoutdoor.example');
    });

    test('honors step.sample_request when present (fixture wins top-level conflicts)', () => {
      // Under #820 (fixture-authoritative), every field the author specified
      // in sample_request takes precedence over the enricher's fabrication.
      // Fields the author omitted (brand_id here) are gap-filled by the
      // enricher from resolveBrand(options) — the harness's run-scoped
      // brand. Storyboards that specifically require brand_id to NOT be
      // sent must omit it from the fixture and opt out of the enricher
      // (not possible today without authoring an explicit null, tracked
      // as a possible #820+ follow-up).
      const fixture = {
        buyer: { domain: 'pinnacle-agency.example' },
        query: 'licensed commercial rights for a regional outdoor retail campaign',
        uses: ['commercial', 'endorsement'],
      };
      const result = buildRequest(step('get_rights', { sample_request: fixture }), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.query, fixture.query, 'fixture query wins');
      assert.deepStrictEqual(result.uses, fixture.uses, 'fixture uses wins');
      assert.deepStrictEqual(result.buyer, fixture.buyer, 'fixture buyer preserved');
      assert.strictEqual(result.brand_id, 'acmeoutdoor.example', 'brand_id gap-filled from options.brand');
    });
  });

  describe('sync_audiences', () => {
    test('generated fallback works with no sample_request', () => {
      const result = buildRequest(step('sync_audiences'), {}, DEFAULT_OPTIONS);
      assert.ok(result.account, 'account injected');
      assert.ok(Array.isArray(result.audiences), 'audiences array present');
      assert.ok(result.audiences[0].audience_id, 'generated audience_id');
    });

    test('honors step.sample_request on add-shaped payloads so authored audience_id reaches the wire', () => {
      // Regression: the builder previously only delegated to sample_request
      // for delete/discovery shapes. Add-shaped payloads fell through to the
      // fallback, which overwrote the authored audience_id with a generated
      // one. Downstream delete_audience / $context.audience_id references
      // then hit AUDIENCE_NOT_FOUND because sync had registered a different
      // id (observed in compliance/cache/latest/specialisms/audience-sync
      // between create_audience and delete_audience).
      const fixture = {
        audiences: [
          {
            audience_id: 'adcp-test-audience-001',
            name: 'AdCP test audience',
            add: [
              {
                external_id: 'adcp-user-0001',
                hashed_email: 'a000000000000000000000000000000000000000000000000000000000000000',
              },
            ],
          },
        ],
      };
      const result = buildRequest(step('sync_audiences', { sample_request: fixture }), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.audiences.length, 1, 'fallback entry must not be appended');
      assert.strictEqual(result.audiences[0].audience_id, 'adcp-test-audience-001');
      assert.strictEqual(result.audiences[0].name, 'AdCP test audience', 'authored name must survive');
      assert.strictEqual(result.audiences[0].add[0].external_id, 'adcp-user-0001', 'authored identifiers must survive');
      assert.ok(result.account, 'account still injected');
    });

    test('honors step.sample_request on delete-shaped payloads', () => {
      const fixture = {
        audiences: [{ audience_id: 'adcp-test-audience-001', delete: true }],
      };
      const result = buildRequest(step('sync_audiences', { sample_request: fixture }), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.audiences[0].audience_id, 'adcp-test-audience-001');
      assert.strictEqual(result.audiences[0].delete, true);
    });

    test('honors discovery (no audiences array) sample_request', () => {
      const fixture = { context: { correlation_id: 'audience_sync--discover_audiences' } };
      const result = buildRequest(step('sync_audiences', { sample_request: fixture }), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.context.correlation_id, 'audience_sync--discover_audiences');
      assert.strictEqual(result.audiences, undefined, 'discovery call must not synthesize audiences');
    });

    test('injects context into sample_request', () => {
      const fixture = {
        audiences: [{ audience_id: '$context.audience_id', name: 'Dynamic', add: [{ external_id: 'u1' }] }],
      };
      const context = { audience_id: 'resolved-audience-id' };
      const result = buildRequest(step('sync_audiences', { sample_request: fixture }), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.audiences[0].audience_id, 'resolved-audience-id');
    });
  });

  describe('sync_catalogs', () => {
    test('builds valid catalog request', () => {
      const result = buildRequest(step('sync_catalogs'), {}, DEFAULT_OPTIONS);
      assert.ok(result.account, 'should have account');
      assert.ok(Array.isArray(result.catalogs), 'should have catalogs array');
      assert.ok(result.catalogs[0].catalog_id, 'should have catalog_id');
    });

    test('fallback catalog uses spec-valid type + feed_format', () => {
      // Regression: the hardcoded fallback used `feed_format: 'json'` which
      // isn't in the 5-literal union, and omitted `type` entirely. Every
      // agent running the generated Zod schema rejected with -32602.
      const result = buildRequest(step('sync_catalogs'), {}, DEFAULT_OPTIONS);
      const cat = result.catalogs[0];
      assert.strictEqual(cat.type, 'product', 'type must be in CatalogTypeSchema');
      assert.ok(
        ['google_merchant_center', 'facebook_catalog', 'shopify', 'linkedin_jobs', 'custom'].includes(cat.feed_format),
        `feed_format must be in FeedFormatSchema union, got "${cat.feed_format}"`
      );
    });

    test('honors step.sample_request when present', () => {
      const fixture = {
        account: { account_id: 'acct_x' },
        catalogs: [
          { catalog_id: 'menu_spring_2026', type: 'product', name: 'Spring Menu', items: [{ item_id: 'i1' }] },
        ],
      };
      const result = buildRequest(step('sync_catalogs', { sample_request: fixture }), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.catalogs[0].catalog_id, 'menu_spring_2026');
      assert.strictEqual(result.catalogs[0].type, 'product');
    });
  });

  describe('report_usage', () => {
    test('includes reporting_period', () => {
      const result = buildRequest(step('report_usage'), {}, DEFAULT_OPTIONS);
      assert.ok(result.reporting_period, 'should have reporting_period');
      assert.ok(result.reporting_period.start, 'should have start');
      assert.ok(result.reporting_period.end, 'should have end');
      assert.ok(Array.isArray(result.usage), 'should have usage array');
    });

    test('fallback usage entry has account, vendor_cost, currency', () => {
      // Regression: per-entry fields required by `usage-entry.json` were
      // missing from the fallback (used `spend: {amount, currency}` instead
      // of flat `vendor_cost` + `currency`), causing -32602 on every run.
      const result = buildRequest(step('report_usage'), {}, DEFAULT_OPTIONS);
      const entry = result.usage[0];
      assert.ok(entry.account, 'usage[0].account required');
      assert.strictEqual(typeof entry.vendor_cost, 'number', 'vendor_cost must be number');
      assert.strictEqual(typeof entry.currency, 'string', 'currency must be string');
    });

    test("fallback usage entry creative_id is 'unknown' when context lacks creative_id (#989)", () => {
      // Regression guard: was 'test-creative', which could be silently accepted
      // by pre-seeded test agents. 'unknown' triggers a clean NOT_FOUND instead.
      const result = buildRequest(step('report_usage'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.usage[0].creative_id, 'unknown');
    });

    test('uses context.creative_id for usage entry creative_id when present', () => {
      const result = buildRequest(step('report_usage'), { creative_id: 'cr-real-456' }, DEFAULT_OPTIONS);
      assert.strictEqual(result.usage[0].creative_id, 'cr-real-456');
    });

    test('honors step.sample_request when present', () => {
      const fixture = {
        account: { account_id: 'acct_x' },
        reporting_period: { start: '2026-03-01T00:00:00Z', end: '2026-03-31T23:59:59Z' },
        usage: [{ account: { account_id: 'acct_x' }, creative_id: 'c1', vendor_cost: 42, currency: 'USD' }],
      };
      const result = buildRequest(step('report_usage', { sample_request: fixture }), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.usage[0].vendor_cost, 42);
    });
  });

  describe('sync_event_sources', () => {
    test('builds valid event sources request', () => {
      const result = buildRequest(step('sync_event_sources'), {}, DEFAULT_OPTIONS);
      assert.ok(result.account, 'should have account');
      assert.ok(Array.isArray(result.event_sources), 'should have event_sources array');
      assert.ok(result.event_sources[0].event_source_id, 'should have event_source_id');
      assert.ok(Array.isArray(result.event_sources[0].event_types), 'should have event_types');
    });
  });

  describe('log_event', () => {
    test('builds valid event request with events array', () => {
      const context = { event_source_id: 'src-1' };
      const result = buildRequest(step('log_event'), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.event_source_id, 'src-1');
      assert.ok(Array.isArray(result.events), 'should have events array');
      assert.ok(result.events[0].event_id, 'should have event_id');
      assert.ok(result.events[0].event_type, 'should have event_type');
    });

    test('fallback event uses spec field names (event_time, custom_data)', () => {
      // Regression: the fallback emitted `timestamp` (spec requires
      // `event_time`) and nested `value: {amount, currency}` (spec places
      // both under `custom_data`). Framework-dispatch agents rejected with
      // -32602 invalid_type; legacy-dispatch permissively accepted it.
      const result = buildRequest(step('log_event'), {}, DEFAULT_OPTIONS);
      const event = result.events[0];
      assert.strictEqual(typeof event.event_time, 'string', 'event_time required per event.json');
      assert.strictEqual(event.timestamp, undefined, 'timestamp is not a spec field');
      assert.ok(event.custom_data, 'value + currency live under custom_data per event-custom-data.json');
      assert.strictEqual(typeof event.custom_data.value, 'number', 'custom_data.value must be number');
      assert.strictEqual(typeof event.custom_data.currency, 'string', 'custom_data.currency must be string');
    });

    test('honors step.sample_request when present', () => {
      // Storyboards (sales_catalog_driven, sales_social) author complete
      // spec-conformant sample_request blocks with event_time, content_ids,
      // and siblings. The builder must pass those through unchanged.
      const fixture = {
        event_source_id: 'amsterdam_website',
        events: [
          {
            event_id: 'evt_001',
            event_type: 'purchase',
            event_time: '2026-04-15T19:30:00Z',
            content_ids: ['ribeye_36oz'],
            value: 89.0,
            currency: 'USD',
          },
        ],
      };
      const result = buildRequest(step('log_event', { sample_request: fixture }), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.event_source_id, 'amsterdam_website');
      assert.strictEqual(result.events[0].event_time, '2026-04-15T19:30:00Z');
      assert.deepStrictEqual(result.events[0].content_ids, ['ribeye_36oz']);
      assert.strictEqual(result.events[0].value, 89.0);
    });

    test('injects context into sample_request', () => {
      const fixture = {
        event_source_id: '$context.event_source_id',
        events: [{ event_id: 'e1', event_type: 'purchase', event_time: '2026-04-15T19:30:00Z' }],
      };
      const context = { event_source_id: 'resolved-source-id' };
      const result = buildRequest(step('log_event', { sample_request: fixture }), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.event_source_id, 'resolved-source-id');
    });
  });

  describe('comply_test_controller', () => {
    test('includes account with sandbox: true', () => {
      const result = buildRequest(step('comply_test_controller'), {}, DEFAULT_OPTIONS);
      assert.ok(result.account, 'should have account');
      assert.strictEqual(result.account.sandbox, true);
    });

    test('uses sample_request with account injected', () => {
      const s = step('comply_test_controller', {
        sample_request: { scenario: 'force_account_status', target_status: 'active' },
      });
      const result = buildRequest(s, {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.scenario, 'force_account_status');
      assert.strictEqual(result.account.sandbox, true);
    });

    test('preserves context account but forces sandbox: true', () => {
      const context = { account: { account_id: 'acct-1' } };
      const result = buildRequest(step('comply_test_controller'), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.account.account_id, 'acct-1');
      assert.strictEqual(result.account.sandbox, true);
    });

    test('sandbox: true wins even when sample_request has account', () => {
      const s = step('comply_test_controller', {
        sample_request: { scenario: 'x', account: { account_id: 'a1', sandbox: false } },
      });
      const result = buildRequest(s, {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.account.sandbox, true);
    });

    // Issue #1419 — natural-key arm of AccountReference requires `operator`.
    // When context.account came from a sync_accounts response that omitted
    // operator (or was authored without it), the controller call would ship
    // a synthetic ref missing operator and fail strict-validating sellers.
    test('fills in operator when context.account is a natural-key ref missing operator (#1419)', () => {
      const context = { account: { brand: { domain: 'acme.example' } } };
      const result = buildRequest(step('comply_test_controller'), context, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result.account.brand, { domain: 'acme.example' });
      assert.strictEqual(result.account.operator, 'acme.example');
      assert.strictEqual(result.account.sandbox, true);
    });

    test('does not add operator when context.account uses the {account_id} arm (#1419)', () => {
      const context = { account: { account_id: 'acct-1' } };
      const result = buildRequest(step('comply_test_controller'), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.account.account_id, 'acct-1');
      assert.strictEqual(result.account.operator, undefined);
      assert.strictEqual(result.account.sandbox, true);
    });
  });

  describe('get_signals', () => {
    test('uses brief from options as signal_spec', () => {
      const options = { ...DEFAULT_OPTIONS, brief: 'EV buyers near dealerships' };
      const result = buildRequest(step('get_signals'), {}, options);
      assert.strictEqual(result.signal_spec, 'EV buyers near dealerships');
    });

    test('includes signal_ids from sample_request', () => {
      const s = step('get_signals', {
        sample_request: {
          signal_ids: [{ source: 'catalog', data_provider_domain: 'tridentauto.example', id: 'likely_ev_buyers' }],
        },
      });
      const result = buildRequest(s, {}, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result.signal_ids, [
        { source: 'catalog', data_provider_domain: 'tridentauto.example', id: 'likely_ev_buyers' },
      ]);
      assert.strictEqual(result.signal_spec, undefined);
    });

    test('fixture signal_ids coexist with options.brief (both present; author-authored fields preserved)', () => {
      // Under #820 (fixture-authoritative), the author's signal_ids are
      // preserved; the enricher's `signal_spec` derived from `options.brief`
      // is additive. `anyOf: [signal_spec, signal_ids]` accepts either or
      // both, so the downstream agent receives a richer query (authored
      // exact signal_ids plus the caller's natural-language brief).
      const s = step('get_signals', {
        sample_request: {
          signal_ids: [{ source: 'catalog', data_provider_domain: 'x.example', id: 'seg1' }],
        },
      });
      const options = { ...DEFAULT_OPTIONS, brief: 'override brief' };
      const result = buildRequest(s, {}, options);
      assert.strictEqual(result.signal_spec, 'override brief', 'enricher gap-fills signal_spec from options.brief');
      assert.deepStrictEqual(
        result.signal_ids,
        [{ source: 'catalog', data_provider_domain: 'x.example', id: 'seg1' }],
        'fixture signal_ids are preserved (author wins)'
      );
    });

    test('falls back to a minimal discovery signal_spec when no brief and no signal_ids', () => {
      // The get-signals-request schema requires anyOf [signal_spec, signal_ids];
      // an empty object fails strict JSON-schema validation. With no brief
      // and no authored signal_ids, emit a synthetic signal_spec so the
      // request stays schema-conforming.
      const result = buildRequest(step('get_signals'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(typeof result.signal_spec, 'string');
      assert.ok(result.signal_spec.length > 0);
      assert.strictEqual(result.signal_ids, undefined);
    });

    test('injects context placeholders in signal_ids', () => {
      const s = step('get_signals', {
        sample_request: {
          signal_ids: [{ source: 'catalog', data_provider_domain: '$context.provider_domain', id: 'seg1' }],
        },
      });
      const context = { provider_domain: 'resolved.example' };
      const result = buildRequest(s, context, DEFAULT_OPTIONS);
      assert.strictEqual(result.signal_ids[0].data_provider_domain, 'resolved.example');
    });
  });

  describe('activate_signal', () => {
    test('uses agent destinations from sample_request', () => {
      const s = step('activate_signal', {
        sample_request: {
          destinations: [{ type: 'agent', agent_url: 'https://sa.example' }],
        },
      });
      const result = buildRequest(s, {}, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result.destinations, [{ type: 'agent', agent_url: 'https://sa.example' }]);
    });

    test('uses platform destinations from sample_request', () => {
      const s = step('activate_signal', {
        sample_request: {
          destinations: [{ type: 'platform', platform: 'the-trade-desk', account: 'ttd-123' }],
        },
      });
      const result = buildRequest(s, {}, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result.destinations, [
        { type: 'platform', platform: 'the-trade-desk', account: 'ttd-123' },
      ]);
    });

    test('defaults destinations to a placeholder agent when sample_request omits them', () => {
      // ActivateSignalRequest requires `destinations`, so the fallback must
      // supply one to round-trip through the schema.
      const result = buildRequest(step('activate_signal'), {}, DEFAULT_OPTIONS);
      assert.ok(Array.isArray(result.destinations) && result.destinations.length > 0);
      assert.strictEqual(result.destinations[0].type, 'agent');
    });

    test('uses signal from context', () => {
      const context = {
        signals: [
          {
            signal_agent_segment_id: 'seg-1',
            pricing_options: [{ pricing_option_id: 'po-1' }],
          },
        ],
      };
      const result = buildRequest(step('activate_signal'), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.signal_agent_segment_id, 'seg-1');
      assert.strictEqual(result.pricing_option_id, 'po-1');
    });

    test('injects context placeholders in destinations', () => {
      const s = step('activate_signal', {
        sample_request: {
          destinations: [{ type: 'agent', agent_url: '$context.seller_url' }],
        },
      });
      const context = { seller_url: 'https://resolved.example' };
      const result = buildRequest(s, context, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result.destinations, [{ type: 'agent', agent_url: 'https://resolved.example' }]);
    });
  });

  describe('sync_governance', () => {
    test('fallback credentials satisfy schema minLength of 32', () => {
      // Regression: the hardcoded 'test-governance-token' is 21 chars,
      // shorter than the schema's minLength: 32, so strict-validation
      // agents rejected every sync_governance step with -32602.
      const result = buildRequest(step('sync_governance'), {}, DEFAULT_OPTIONS);
      const credentials = result.accounts[0].governance_agents[0].authentication.credentials;
      assert.ok(credentials.length >= 32, `credentials must be >= 32 chars, got ${credentials.length}`);
    });

    test('honors step.sample_request when present', () => {
      // Regression: the builder never consulted sample_request, so
      // governance storyboards authoring `url: $context.governance_agent_url`
      // silently lost that binding and downstream check_governance steps
      // asserted against the wrong URL.
      const fixture = {
        accounts: [
          {
            account: { account_id: 'acct_gov' },
            governance_agents: [
              {
                url: '$context.governance_agent_url',
                authentication: {
                  schemes: ['Bearer'],
                  credentials: 'gov-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                },
              },
            ],
          },
        ],
      };
      const result = buildRequest(
        step('sync_governance', { sample_request: fixture }),
        { governance_agent_url: 'https://gov.resolved.example' },
        DEFAULT_OPTIONS
      );
      assert.strictEqual(
        result.accounts[0].governance_agents[0].url,
        'https://gov.resolved.example',
        '$context placeholder should resolve'
      );
    });
  });

  describe('si_get_offering', () => {
    test('fallback uses intent for prose and omits non-spec fields', () => {
      // Regression: the builder passed the prose string as `context`
      // (which is an object per spec) and included `identity`, which
      // is not part of si-get-offering-request.json.
      const result = buildRequest(step('si_get_offering'), {}, DEFAULT_OPTIONS);
      assert.ok(result.offering_id, 'offering_id required');
      assert.strictEqual(typeof result.intent, 'string', 'intent carries the prose string');
      assert.ok(
        result.context === undefined || typeof result.context === 'object',
        'context must be an object or omitted, never a string'
      );
      assert.strictEqual(result.identity, undefined, 'identity is not in si_get_offering request schema');
    });

    test('honors step.sample_request when present', () => {
      const fixture = {
        offering_id: 'custom-offering',
        intent: 'Looking for mens size 12 hiking boots',
        include_products: true,
      };
      const result = buildRequest(step('si_get_offering', { sample_request: fixture }), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.offering_id, 'custom-offering');
      assert.strictEqual(result.intent, fixture.intent);
      assert.strictEqual(result.include_products, true);
    });
  });

  describe('si_initiate_session', () => {
    test('fallback uses intent for prose string and anonymous identity', () => {
      // Regression: the builder put the prose string into `context`
      // (an object per spec) rather than `intent` (the required field
      // per si-initiate-session-request.json), and used a non-spec
      // `{ principal, device_id }` identity shape.
      const result = buildRequest(step('si_initiate_session'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(typeof result.intent, 'string', 'intent is required and carries the prose handoff');
      assert.ok(result.identity, 'identity is required');
      assert.strictEqual(result.identity.consent_granted, false, 'default is anonymous (no PII consent)');
      assert.ok(
        typeof result.identity.anonymous_session_id === 'string',
        'anonymous identity must carry an anonymous_session_id'
      );
      assert.ok(
        result.context === undefined || typeof result.context === 'object',
        'context must be an object or omitted, never a string'
      );
    });

    test('honors step.sample_request when present', () => {
      const fixture = {
        intent: 'Help me pick a running shoe',
        identity: { consent_granted: false, anonymous_session_id: 'anon-123' },
        placement: 'chatgpt_search',
      };
      const result = buildRequest(step('si_initiate_session', { sample_request: fixture }), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.intent, fixture.intent);
      assert.deepStrictEqual(result.identity, fixture.identity);
      assert.strictEqual(result.placement, 'chatgpt_search');
    });
  });

  describe('get_media_buys', () => {
    test('omits media_buy_ids when context.media_buy_id is absent (broad-list path)', () => {
      const result = buildRequest(step('get_media_buys'), {}, DEFAULT_OPTIONS);
      assert.ok(
        !Object.prototype.hasOwnProperty.call(result, 'media_buy_ids'),
        'media_buy_ids must be absent so agent receives a broad-list request'
      );
    });

    test('injects media_buy_ids when context.media_buy_id is present', () => {
      const result = buildRequest(step('get_media_buys'), { media_buy_id: 'buy-42' }, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result.media_buy_ids, ['buy-42']);
    });

    test('always includes account from harness — fixture raw account cannot override (#1487)', () => {
      // Regression guard: fixture-authored account without sandbox:true must not win
      // over the harness-resolved account. FIXTURE_AWARE_ENRICHERS path keeps the
      // harness account authoritative so namespace routing matches create_media_buy.
      const fixtureAccount = { account_id: 'prod-acct', sandbox: false };
      const result = buildRequest(
        step('get_media_buys', { sample_request: { account: fixtureAccount } }),
        {},
        DEFAULT_OPTIONS
      );
      assert.ok(result.account, 'account must be present');
      assert.notDeepStrictEqual(
        result.account,
        fixtureAccount,
        'harness-resolved account must win over fixture raw account'
      );
    });

    test('uses context.account when set, ignoring fixture account (#1487)', () => {
      const contextAccount = { account_id: 'sandbox-acct-123', sandbox: true };
      const result = buildRequest(
        step('get_media_buys', { sample_request: { account: { account_id: 'prod-acct' } } }),
        { media_buy_id: 'buy-7', account: contextAccount },
        DEFAULT_OPTIONS
      );
      assert.deepStrictEqual(result.account, contextAccount);
      assert.deepStrictEqual(result.media_buy_ids, ['buy-7']);
    });
  });

  describe('get_media_buy_delivery', () => {
    test('omits media_buy_ids when context.media_buy_id is absent', () => {
      const result = buildRequest(step('get_media_buy_delivery'), {}, DEFAULT_OPTIONS);
      assert.ok(
        !Object.prototype.hasOwnProperty.call(result, 'media_buy_ids'),
        'media_buy_ids must be absent when no context ID is available'
      );
    });

    test('injects media_buy_ids when context.media_buy_id is present', () => {
      const result = buildRequest(step('get_media_buy_delivery'), { media_buy_id: 'buy-99' }, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result.media_buy_ids, ['buy-99']);
    });

    test('get_media_buy_delivery — harness account wins over fixture raw account (#1487)', () => {
      // Mirror of get_media_buys regression guard — same FIXTURE_AWARE fix applies.
      const fixtureAccount = { account_id: 'prod-acct', sandbox: false };
      const result = buildRequest(
        step('get_media_buy_delivery', { sample_request: { account: fixtureAccount } }),
        {},
        DEFAULT_OPTIONS
      );
      assert.ok(result.account, 'account must be present');
      assert.notDeepStrictEqual(
        result.account,
        fixtureAccount,
        'harness-resolved account must win over fixture raw account'
      );
    });

    test('get_media_buy_delivery — uses context.account when set, ignoring fixture account (#1487)', () => {
      const contextAccount = { account_id: 'sandbox-acct-456', sandbox: true };
      const result = buildRequest(
        step('get_media_buy_delivery', { sample_request: { account: { account_id: 'prod-acct' } } }),
        { media_buy_id: 'buy-11', account: contextAccount },
        DEFAULT_OPTIONS
      );
      assert.deepStrictEqual(result.account, contextAccount);
      assert.deepStrictEqual(result.media_buy_ids, ['buy-11']);
    });
  });

  describe('update_media_buy', () => {
    test('preserves storyboard sample_request fields when fixture-aware path runs (#1505)', () => {
      // Regression: update_media_buy must spread fixture fields (packages,
      // targeting_overlay, idempotency_key) so hand-authored intent flows through.
      const fixturePackages = [
        {
          package_id: 'pkg_1',
          targeting_overlay: {
            property_list: { agent_url: 'https://gov.example', list_id: 'no_match_v1' },
          },
        },
      ];
      const result = buildRequest(
        step('update_media_buy', {
          sample_request: {
            account: { account_id: 'prod-acct' },
            media_buy_id: 'buy-7',
            packages: fixturePackages,
            idempotency_key: 'fixture-key',
          },
        }),
        {},
        DEFAULT_OPTIONS
      );
      assert.deepStrictEqual(result.packages, fixturePackages);
      assert.strictEqual(result.media_buy_id, 'buy-7');
      assert.strictEqual(result.idempotency_key, 'fixture-key');
    });

    test('harness account wins over fixture account so update writes match create namespace (#1505)', () => {
      // Regression: before this fix, update_media_buy was NOT in
      // FIXTURE_AWARE_ENRICHERS, so the generic merge let the storyboard's
      // raw account override the harness-resolved one. That routed update
      // writes to a different partition than create, which surfaced as
      // stale targeting_overlay on the subsequent get_media_buys.
      const fixtureAccount = { account_id: 'prod-acct', sandbox: false };
      const result = buildRequest(
        step('update_media_buy', {
          sample_request: { account: fixtureAccount, media_buy_id: 'buy-7' },
        }),
        {},
        DEFAULT_OPTIONS
      );
      assert.ok(result.account, 'account must be present');
      assert.notDeepStrictEqual(
        result.account,
        fixtureAccount,
        'harness-resolved account must win over fixture raw account'
      );
    });

    test('uses context.account when set so create→update→get all share namespace (#1505)', () => {
      const contextAccount = { account_id: 'sandbox-acct-1', sandbox: true };
      const result = buildRequest(
        step('update_media_buy', {
          sample_request: { account: { account_id: 'prod-acct' }, media_buy_id: 'buy-7' },
        }),
        { account: contextAccount, media_buy_id: 'buy-7' },
        DEFAULT_OPTIONS
      );
      assert.deepStrictEqual(result.account, contextAccount);
    });

    test('legacy keyword inference still applies when no sample_request provided', () => {
      // pause / resume / cancel inference is the fallback for storyboards
      // without an authored sample_request — must continue to work.
      const pauseResult = buildRequest(
        step('update_media_buy', { id: 'pause_buy' }),
        { media_buy_id: 'b' },
        DEFAULT_OPTIONS
      );
      assert.strictEqual(pauseResult.paused, true);

      const cancelResult = buildRequest(
        step('update_media_buy', { id: 'cancel_buy' }),
        { media_buy_id: 'b' },
        DEFAULT_OPTIONS
      );
      assert.strictEqual(cancelResult.canceled, true);
    });
  });

  describe('calibrate_content (#989)', () => {
    test("artifact.artifact_id is 'unknown' when context lacks creative_id", () => {
      // Regression guard: was 'test-creative', which could be silently accepted
      // by pre-seeded test agents. 'unknown' triggers a clean NOT_FOUND instead.
      const result = buildRequest(step('calibrate_content'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.artifact.artifact_id, 'unknown');
    });

    test('uses context.creative_id for artifact.artifact_id when present', () => {
      const result = buildRequest(step('calibrate_content'), { creative_id: 'cr-real-789' }, DEFAULT_OPTIONS);
      assert.strictEqual(result.artifact.artifact_id, 'cr-real-789');
    });
  });

  describe('validate_content_delivery (#989)', () => {
    test("records[].artifact.artifact_id is 'unknown' when context lacks creative_id", () => {
      // Regression guard: was 'test-creative', which could be silently accepted
      // by pre-seeded test agents. 'unknown' triggers a clean NOT_FOUND instead.
      const result = buildRequest(step('validate_content_delivery'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.records[0].artifact.artifact_id, 'unknown');
    });

    test('uses context.creative_id for records[].artifact.artifact_id when present', () => {
      const result = buildRequest(step('validate_content_delivery'), { creative_id: 'cr-real-abc' }, DEFAULT_OPTIONS);
      assert.strictEqual(result.records[0].artifact.artifact_id, 'cr-real-abc');
    });
  });

  describe('creative_approval (#989)', () => {
    test("creative_id is 'unknown' when context lacks creative_id", () => {
      // Regression guard: was 'test-creative', which could be silently accepted
      // by pre-seeded test agents. 'unknown' triggers a clean NOT_FOUND instead.
      const result = buildRequest(step('creative_approval'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.creative_id, 'unknown');
    });

    test('uses context.creative_id when present', () => {
      const result = buildRequest(step('creative_approval'), { creative_id: 'cr-real-xyz' }, DEFAULT_OPTIONS);
      assert.strictEqual(result.creative_id, 'cr-real-xyz');
    });
  });

  describe('get_content_standards (#989)', () => {
    test("emits 'unknown' placeholder when context lacks a real id", () => {
      // `standards_id` is required by GetContentStandardsRequestSchema (no .optional()).
      // Returning {} would break the schema round-trip test. The 'unknown' placeholder
      // triggers a clean NOT_FOUND, surfacing the authoring gap — different from
      // get_media_buys where the id field is optional and {} is valid (see #983).
      const result = buildRequest(step('get_content_standards'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.standards_id, 'unknown');
    });

    test('injects context.content_standards_id when present', () => {
      const context = { content_standards_id: 'cs-abc-123' };
      const result = buildRequest(step('get_content_standards'), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.standards_id, 'cs-abc-123');
    });

    test('fixture sample_request standards_id wins over context injection', () => {
      const context = { content_standards_id: 'cs-from-context' };
      const fixture = { standards_id: 'cs-from-fixture' };
      const result = buildRequest(step('get_content_standards', { sample_request: fixture }), context, DEFAULT_OPTIONS);
      assert.strictEqual(result.standards_id, 'cs-from-fixture');
    });
  });

  describe('hasRequestBuilder', () => {
    test('returns true for tasks with builders', () => {
      const tasks = [
        'create_media_buy',
        'get_products',
        'get_brand_identity',
        'get_rights',
        'sync_catalogs',
        'report_usage',
        'sync_event_sources',
        'log_event',
        'comply_test_controller',
        'get_signals',
        'activate_signal',
      ];
      for (const task of tasks) {
        assert.ok(hasRequestBuilder(task), `should have builder for ${task}`);
      }
    });

    test('returns false for unknown tasks', () => {
      assert.ok(!hasRequestBuilder('nonexistent_task'));
    });

    test('returns false for property-list tools so the runner delegates to sample_request', () => {
      const tasks = [
        'create_property_list',
        'get_property_list',
        'update_property_list',
        'list_property_lists',
        'delete_property_list',
        'validate_property_delivery',
      ];
      for (const task of tasks) {
        assert.ok(
          !hasRequestBuilder(task),
          `${task} must not have a hardcoded builder — it would re-inject the deprecated top-level brand field (see issue #577)`
        );
      }
    });
  });
});
