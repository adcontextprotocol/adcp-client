/**
 * Tests for validateResponseSchema utility
 *
 * Validates that response schema validation catches:
 * - Missing required fields (#371)
 * - Invalid enum values (#372)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateResponseSchema } = require('../../dist/lib/testing/client');

// Minimal valid product
const validProduct = {
  product_id: 'p1',
  name: 'Test Product',
  description: 'A test product',
  publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
  format_ids: [{ agent_url: 'https://example.com', id: 'fmt1' }],
  delivery_type: 'guaranteed',
  pricing_options: [{ pricing_option_id: 'po1', pricing_model: 'cpm', rate: 10, currency: 'USD' }],
};

// Minimal valid create_media_buy success response
const validCreateMediaBuySuccess = {
  media_buy_id: 'mb1',
  buyer_ref: 'buyer-123',
  packages: [{ package_id: 'pkg1' }],
};

// Minimal valid get_media_buys response (has status enum)
const validGetMediaBuys = {
  media_buys: [
    {
      media_buy_id: 'mb1',
      status: 'active',
      currency: 'USD',
      total_budget: 1000,
      packages: [{ package_id: 'pkg1' }],
    },
  ],
};

describe('validateResponseSchema', () => {
  describe('get_products — required fields (#371)', () => {
    it('passes for valid response', () => {
      const result = validateResponseSchema('get_products', { products: [validProduct] });
      assert.strictEqual(result.passed, true);
    });

    it('fails when product_id is missing', () => {
      const { product_id, ...productWithoutId } = validProduct;
      const result = validateResponseSchema('get_products', { products: [productWithoutId] });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('product_id'), `Expected error about product_id, got: ${result.error}`);
    });

    it('fails when name is missing', () => {
      const { name, ...productWithoutName } = validProduct;
      const result = validateResponseSchema('get_products', { products: [productWithoutName] });
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('name'), `Expected error about name, got: ${result.error}`);
    });

    it('fails when products array is missing', () => {
      const result = validateResponseSchema('get_products', {});
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('products'), `Expected error about products, got: ${result.error}`);
    });
  });

  describe('create_media_buy — required fields (#371)', () => {
    it('passes for valid success response', () => {
      const result = validateResponseSchema('create_media_buy', validCreateMediaBuySuccess);
      assert.strictEqual(result.passed, true, `Expected pass, got: ${result.error || ''}`);
    });

    it('fails when media_buy_id is missing', () => {
      const { media_buy_id, ...withoutId } = validCreateMediaBuySuccess;
      const result = validateResponseSchema('create_media_buy', withoutId);
      assert.strictEqual(result.passed, false);
    });

    it('fails when buyer_ref is missing', () => {
      const { buyer_ref, ...withoutRef } = validCreateMediaBuySuccess;
      const result = validateResponseSchema('create_media_buy', withoutRef);
      assert.strictEqual(result.passed, false);
    });

    it('passes for valid error response', () => {
      const result = validateResponseSchema('create_media_buy', {
        errors: [{ code: 'validation_error', message: 'Bad request' }],
      });
      assert.strictEqual(result.passed, true, `Expected pass for error response, got: ${result.error || ''}`);
    });
  });

  describe('get_media_buys — enum validation (#372)', () => {
    it('passes for valid status enum values', () => {
      for (const status of ['pending_activation', 'active', 'paused', 'completed', 'rejected', 'canceled']) {
        const data = {
          media_buys: [{ ...validGetMediaBuys.media_buys[0], status }],
        };
        const result = validateResponseSchema('get_media_buys', data);
        assert.strictEqual(result.passed, true, `Expected pass for status "${status}": ${result.error || ''}`);
      }
    });

    it('fails for invalid status enum value', () => {
      const data = {
        media_buys: [{ ...validGetMediaBuys.media_buys[0], status: 'totally_bogus_status' }],
      };
      const result = validateResponseSchema('get_media_buys', data);
      assert.strictEqual(result.passed, false);
      assert.ok(result.error.includes('status'), `Expected error about status, got: ${result.error}`);
    });
  });

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
