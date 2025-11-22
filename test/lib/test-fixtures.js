/**
 * Test fixtures for AdCP types
 * These provide minimal valid objects matching AdCP schemas
 */

/**
 * Create a minimal valid Product for testing
 */
function createTestProduct(overrides = {}) {
  return {
    product_id: 'test-product-1',
    name: 'Test Product',
    description: 'A test product',
    publisher_properties: [{
      publisher_domain: 'test.com',
      selection_type: 'all',
    }],
    format_ids: [{ agent_url: 'https://test.com', id: 'fmt-1' }],
    delivery_type: 'guaranteed',
    pricing_options: [{
      pricing_option_id: 'po-1',
      pricing_model: 'cpm',
      rate: 10.0,
      currency: 'USD',
      is_fixed: true,
    }],
    delivery_measurement: {
      provider: 'test-provider',
    },
    ...overrides,
  };
}

/**
 * Create a minimal valid Creative for testing
 */
function createTestCreative(overrides = {}) {
  return {
    creative_id: 'test-creative-1',
    buyer_ref: 'test-ref',
    format_id: { agent_url: 'https://test.com', id: 'fmt-1' },
    ...overrides,
  };
}

/**
 * Create a minimal valid Format for testing
 */
function createTestFormat(overrides = {}) {
  return {
    format_id: 'test-format-1',
    name: 'Test Format',
    width: 300,
    height: 250,
    ad_types: ['banner'],
    ...overrides,
  };
}

module.exports = {
  createTestProduct,
  createTestCreative,
  createTestFormat,
};
