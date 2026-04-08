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
  brand: { domain: 'acmeoutdoor.com' },
  account: { brand: { domain: 'acmeoutdoor.com' }, operator: 'acmeoutdoor.com' },
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
    test('includes measurement_period', () => {
      const result = buildRequest(step('provide_performance_feedback'), { media_buy_id: 'mb-1' }, DEFAULT_OPTIONS);
      assert.ok(result.measurement_period, 'should have measurement_period');
      assert.ok(result.measurement_period.start, 'should have start');
      assert.ok(result.measurement_period.end, 'should have end');
    });

    test('includes media_buy_id from context', () => {
      const result = buildRequest(step('provide_performance_feedback'), { media_buy_id: 'mb-1' }, DEFAULT_OPTIONS);
      assert.strictEqual(result.media_buy_id, 'mb-1');
    });
  });

  describe('get_brand_identity', () => {
    test('includes brand from options', () => {
      const result = buildRequest(step('get_brand_identity'), {}, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result.brand, { domain: 'acmeoutdoor.com' });
    });
  });

  describe('get_rights', () => {
    test('includes brand from options', () => {
      const result = buildRequest(step('get_rights'), {}, DEFAULT_OPTIONS);
      assert.deepStrictEqual(result.brand, { domain: 'acmeoutdoor.com' });
    });
  });

  describe('sync_catalogs', () => {
    test('builds valid catalog request', () => {
      const result = buildRequest(step('sync_catalogs'), {}, DEFAULT_OPTIONS);
      assert.ok(result.account, 'should have account');
      assert.ok(Array.isArray(result.catalogs), 'should have catalogs array');
      assert.ok(result.catalogs[0].catalog_id, 'should have catalog_id');
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

  describe('hasRequestBuilder', () => {
    test('returns true for tasks with builders', () => {
      const tasks = [
        'create_media_buy', 'get_products', 'get_brand_identity', 'get_rights',
        'sync_catalogs', 'report_usage', 'provide_performance_feedback',
        'sync_event_sources', 'log_event',
      ];
      for (const task of tasks) {
        assert.ok(hasRequestBuilder(task), `should have builder for ${task}`);
      }
    });

    test('returns false for unknown tasks', () => {
      assert.ok(!hasRequestBuilder('nonexistent_task'));
    });
  });
});
