/**
 * Tests for validateResponseSchema utility
 *
 * Validates that response schema validation catches:
 * - Missing required fields (#371)
 * - Invalid enum values (#372)
 * - Correct parameter usage (#373)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateResponseSchema } = require('../../dist/lib/testing/client');
const { TOOL_RESPONSE_SCHEMAS } = require('../../dist/lib/utils/response-schemas');

// --- Fixtures ---

const validProduct = {
  product_id: 'p1',
  name: 'Test Product',
  description: 'A test product',
  publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
  format_ids: [{ agent_url: 'https://example.com', id: 'fmt1' }],
  delivery_type: 'guaranteed',
  pricing_options: [{ pricing_option_id: 'po1', pricing_model: 'cpm', rate: 10, currency: 'USD' }],
};

const validCreateMediaBuySuccess = {
  media_buy_id: 'mb1',
  packages: [{ package_id: 'pkg1' }],
};

const validMediaBuy = {
  media_buy_id: 'mb1',
  status: 'active',
  currency: 'USD',
  total_budget: 1000,
  packages: [{ package_id: 'pkg1' }],
};

const validDeployment = {
  type: 'platform',
  platform: 'dv360',
  is_live: false,
};

const validSignalPricingOption = {
  pricing_option_id: 'spo1',
  model: 'cpm',
  cpm: 2.5,
  currency: 'USD',
};

const validSignal = {
  signal_agent_segment_id: 'seg-001',
  name: 'Tech Enthusiasts',
  description: 'Users interested in technology',
  signal_type: 'marketplace',
  data_provider: 'Test Provider',
  coverage_percentage: 15.5,
  deployments: [validDeployment],
  pricing_options: [validSignalPricingOption],
};

// --- Tests ---

describe('validateResponseSchema', () => {
  // ---- get_products (#371) ----
  describe('get_products — required fields (#371)', () => {
    it('passes for valid response', () => {
      const result = validateResponseSchema('get_products', { products: [validProduct] });
      assert.strictEqual(result.passed, true);
    });

    it('passes for empty products array', () => {
      const result = validateResponseSchema('get_products', { products: [] });
      assert.strictEqual(result.passed, true);
    });

    it('fails when product_id is missing', () => {
      const { product_id, ...without } = validProduct;
      const result = validateResponseSchema('get_products', { products: [without] });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('product_id'), `Expected product_id error, got: ${result.error}`);
    });

    it('fails when name is missing', () => {
      const { name, ...without } = validProduct;
      const result = validateResponseSchema('get_products', { products: [without] });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('name'), `Expected name error, got: ${result.error}`);
    });

    it('fails when products array is missing', () => {
      const result = validateResponseSchema('get_products', {});
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('products'), `Expected products error, got: ${result.error}`);
    });

    it('fails when products is null', () => {
      const result = validateResponseSchema('get_products', { products: null });
      assert.strictEqual(result.passed, false);
    });

    it('fails when products is not an array', () => {
      const result = validateResponseSchema('get_products', { products: 'not-an-array' });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- create_media_buy (#371) ----
  describe('create_media_buy — required fields (#371)', () => {
    it('passes for valid success response', () => {
      const result = validateResponseSchema('create_media_buy', validCreateMediaBuySuccess);
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('fails when media_buy_id is missing', () => {
      const { media_buy_id, ...without } = validCreateMediaBuySuccess;
      const result = validateResponseSchema('create_media_buy', without);
      assert.strictEqual(result.passed, false);
    });

    it('passes for valid error response', () => {
      const result = validateResponseSchema('create_media_buy', {
        errors: [{ code: 'validation_error', message: 'Bad request' }],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('fails for error response with incomplete error object', () => {
      const result = validateResponseSchema('create_media_buy', {
        errors: [{ message: 'Missing code field' }],
      });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- get_media_buys (#372) ----
  describe('get_media_buys — required fields and enum validation (#371, #372)', () => {
    it('passes for valid status enum values', () => {
      for (const status of ['pending_activation', 'active', 'paused', 'completed', 'rejected', 'canceled']) {
        const data = { media_buys: [{ ...validMediaBuy, status }] };
        const result = validateResponseSchema('get_media_buys', data);
        assert.strictEqual(result.passed, true, `Expected pass for status "${status}": ${result.error || ''}`);
      }
    });

    it('fails for invalid status enum value', () => {
      const data = { media_buys: [{ ...validMediaBuy, status: 'totally_bogus_status' }] };
      const result = validateResponseSchema('get_media_buys', data);
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('status'), `Expected status error, got: ${result.error}`);
    });

    it('fails when currency is missing', () => {
      const { currency, ...without } = validMediaBuy;
      const result = validateResponseSchema('get_media_buys', { media_buys: [without] });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('currency'), `Expected currency error, got: ${result.error}`);
    });

    it('fails when packages is missing', () => {
      const { packages, ...without } = validMediaBuy;
      const result = validateResponseSchema('get_media_buys', { media_buys: [without] });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- get_signals (#371, #372) ----
  describe('get_signals — required fields and enum validation', () => {
    it('passes for valid response', () => {
      const result = validateResponseSchema('get_signals', { signals: [validSignal] });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for empty signals array', () => {
      const result = validateResponseSchema('get_signals', { signals: [] });
      assert.strictEqual(result.passed, true);
    });

    it('fails when signal_agent_segment_id is missing', () => {
      const { signal_agent_segment_id, ...without } = validSignal;
      const result = validateResponseSchema('get_signals', { signals: [without] });
      assert.strictEqual(result.passed, false);
      assert.ok(
        result.error.includes('signal_agent_segment_id'),
        `Expected signal_agent_segment_id error, got: ${result.error}`
      );
    });

    it('fails when signal_type is missing', () => {
      const { signal_type, ...without } = validSignal;
      const result = validateResponseSchema('get_signals', { signals: [without] });
      assert.strictEqual(result.passed, false);
    });

    it('fails for invalid signal_type enum value', () => {
      const result = validateResponseSchema('get_signals', {
        signals: [{ ...validSignal, signal_type: 'bogus_type' }],
      });
      assert.strictEqual(result.passed, false);
    });

    it('passes for all valid signal_type enum values', () => {
      for (const signal_type of ['marketplace', 'custom', 'owned']) {
        const result = validateResponseSchema('get_signals', {
          signals: [{ ...validSignal, signal_type }],
        });
        assert.strictEqual(
          result.passed,
          true,
          `Expected pass for signal_type "${signal_type}": ${result.error || ''}`
        );
      }
    });

    it('fails when data_provider is missing', () => {
      const { data_provider, ...without } = validSignal;
      const result = validateResponseSchema('get_signals', { signals: [without] });
      assert.strictEqual(result.passed, false);
    });

    it('fails when deployments is missing', () => {
      const { deployments, ...without } = validSignal;
      const result = validateResponseSchema('get_signals', { signals: [without] });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- activate_signal ----
  describe('activate_signal — required fields', () => {
    it('passes for valid success response', () => {
      const result = validateResponseSchema('activate_signal', {
        deployments: [validDeployment],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for valid error response', () => {
      const result = validateResponseSchema('activate_signal', {
        errors: [{ code: 'invalid_signal', message: 'Signal not found' }],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('fails when deployments has invalid structure', () => {
      const result = validateResponseSchema('activate_signal', {
        deployments: [{ type: 'platform' }],
      });
      assert.strictEqual(result.passed, false);
    });
  });

  // ---- sync_audiences ----
  describe('sync_audiences — match breakdown and effective_match_rate', () => {
    const validAudienceResult = {
      audience_id: 'existing_customers',
      action: 'updated',
      status: 'ready',
      uploaded_count: 5000,
      matched_count: 18750,
    };

    it('passes for valid response without match breakdown', () => {
      const result = validateResponseSchema('sync_audiences', {
        audiences: [validAudienceResult],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for response with effective_match_rate and match_breakdown', () => {
      const result = validateResponseSchema('sync_audiences', {
        audiences: [
          {
            ...validAudienceResult,
            effective_match_rate: 0.75,
            match_breakdown: [
              { id_type: 'hashed_email', submitted: 25000, matched: 17500, match_rate: 0.7 },
              { id_type: 'hashed_phone', submitted: 15000, matched: 12000, match_rate: 0.8 },
              { id_type: 'rampid', submitted: 8000, matched: 7200, match_rate: 0.9 },
            ],
          },
        ],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for valid error response', () => {
      const result = validateResponseSchema('sync_audiences', {
        errors: [{ code: 'validation_error', message: 'Invalid audience data' }],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('passes for audience with failed action', () => {
      const result = validateResponseSchema('sync_audiences', {
        audiences: [
          {
            audience_id: 'bad_audience',
            action: 'failed',
            errors: [{ code: 'invalid_format', message: 'Bad hash' }],
          },
        ],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });
  });

  // ---- get_signals with governance metadata ----
  describe('get_signals — governance metadata on signal definitions', () => {
    it('passes for signal with restricted_attributes and policy_categories', () => {
      const result = validateResponseSchema('get_signals', {
        signals: [
          {
            ...validSignal,
            restricted_attributes: ['health_data'],
            policy_categories: ['pharmaceutical_advertising'],
          },
        ],
      });
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });
  });

  // ---- Schema registry completeness ----
  describe('schema registry', () => {
    it('has schemas for all tools used in compliance scenarios', () => {
      const scenarioTools = [
        'get_products',
        'create_media_buy',
        'get_media_buys',
        'list_creative_formats',
        'get_signals',
        'activate_signal',
        'sync_audiences',
      ];
      for (const tool of scenarioTools) {
        assert.ok(TOOL_RESPONSE_SCHEMAS[tool], `Missing schema for scenario tool: ${tool}`);
      }
    });
  });

  // ---- Unknown tool ----
  describe('unknown tool', () => {
    it('passes with warning for unregistered tool', () => {
      const result = validateResponseSchema('unknown_tool', {});
      assert.strictEqual(result.passed, true);
      assert.ok(result.details.includes('No response schema'));
      assert.ok(result.warnings?.length > 0, 'Expected a warning for unregistered tool');
      assert.ok(result.warnings[0].includes('unknown_tool'));
    });
  });
});
