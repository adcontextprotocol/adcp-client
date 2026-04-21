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

    test('brief takes priority over signal_ids', () => {
      const s = step('get_signals', {
        sample_request: {
          signal_ids: [{ source: 'catalog', data_provider_domain: 'x.example', id: 'seg1' }],
        },
      });
      const options = { ...DEFAULT_OPTIONS, brief: 'override brief' };
      const result = buildRequest(s, {}, options);
      assert.strictEqual(result.signal_spec, 'override brief');
      assert.strictEqual(result.signal_ids, undefined);
    });

    test('returns empty object when no brief and no signal_ids', () => {
      const result = buildRequest(step('get_signals'), {}, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result, {});
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

    test('omits destinations when sample_request has none', () => {
      const result = buildRequest(step('activate_signal'), {}, DEFAULT_OPTIONS);
      assert.strictEqual(result.destinations, undefined);
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
