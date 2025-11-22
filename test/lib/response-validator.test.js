/**
 * Tests for ResponseValidator
 *
 * Validates that the ResponseValidator correctly identifies valid/invalid
 * responses from both MCP and A2A protocols
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { ResponseValidator } = require('../../dist/lib/core/ResponseValidator');

describe('ResponseValidator Tests', () => {
  const validator = new ResponseValidator();

  // Helper function to create a valid Product object for tests
  const createValidProduct = (overrides = {}) => ({
    product_id: 'p1',
    name: 'Test Product',
    description: 'A test product for unit tests',
    publisher_properties: [
      {
        publisher_domain: 'example.com',
        selection_type: 'all',
      },
    ],
    format_ids: [
      {
        agent_url: 'https://creatives.adcontextprotocol.org',
        id: 'display_300x250',
      },
    ],
    delivery_type: 'guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'cpm_usd',
        pricing_model: 'cpm',
        rate: 10.0,
        currency: 'USD',
        is_fixed: true,
      },
    ],
    delivery_measurement: {
      provider: 'Test Measurement Provider',
    },
    ...overrides,
  });

  // Helper function to create a valid Creative object for tests
  const createValidCreative = (overrides = {}) => ({
    creative_id: 'c1',
    name: 'Test Creative',
    format_id: {
      agent_url: 'https://creatives.adcontextprotocol.org',
      id: 'display_300x250',
    },
    status: 'approved',
    created_date: '2025-01-01T00:00:00Z',
    updated_date: '2025-01-01T00:00:00Z',
    ...overrides,
  });

  describe('MCP Response Validation', () => {
    it('should validate valid MCP response with structuredContent', () => {
      const response = {
        structuredContent: {
          products: [createValidProduct()],
        },
      };

      const result = validator.validate(response);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.protocol, 'mcp');
      assert.strictEqual(result.errors.length, 0);
    });

    it('should validate MCP response with content array', () => {
      const response = {
        content: [{ type: 'text', text: 'Hello' }],
      };

      const result = validator.validate(response);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.protocol, 'mcp');
    });

    it('should detect MCP error responses', () => {
      const response = {
        isError: true,
        content: [{ type: 'text', text: 'Error occurred' }],
      };

      const result = validator.validate(response);

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.protocol, 'mcp');
      assert.ok(result.errors.some(e => e.includes('isError: true')));
    });

    it('should warn on MCP response without content or structuredContent', () => {
      const response = {
        someField: 'value',
      };

      const result = validator.validate(response);

      assert.ok(result.warnings.length > 0);
    });
  });

  describe('A2A Response Validation', () => {
    it('should validate valid A2A response', () => {
      const response = {
        result: {
          artifacts: [
            {
              artifactId: 'result_1',
              parts: [
                {
                  kind: 'data',
                  data: { products: [createValidProduct()] },
                },
              ],
            },
          ],
        },
      };

      const result = validator.validate(response);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.protocol, 'a2a');
      assert.strictEqual(result.errors.length, 0);
    });

    it('should detect A2A JSON-RPC errors', () => {
      const response = {
        error: {
          code: -32603,
          message: 'Internal error',
        },
        jsonrpc: '2.0',
        id: 1,
      };

      const result = validator.validate(response);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('JSON-RPC error')));
    });

    it('should error on A2A response missing artifacts', () => {
      const response = {
        result: {},
      };

      const result = validator.validate(response);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('missing result.artifacts')));
    });

    it('should error on A2A response with non-array artifacts', () => {
      const response = {
        result: {
          artifacts: 'not an array',
        },
      };

      const result = validator.validate(response);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('must be an array')));
    });

    it('should warn on A2A response with empty artifacts', () => {
      const response = {
        result: {
          artifacts: [],
        },
      };

      const result = validator.validate(response);

      assert.ok(result.warnings.some(w => w.includes('artifacts array is empty')));
    });

    it('should error on A2A artifact missing parts', () => {
      const response = {
        result: {
          artifacts: [{}],
        },
      };

      const result = validator.validate(response);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('missing parts')));
    });
  });

  describe('Expected Fields Validation', () => {
    it('should validate expected fields in MCP response', () => {
      const response = {
        structuredContent: {
          products: [createValidProduct()],
        },
      };

      const result = validator.validate(response, null, {
        expectedFields: ['products'],
      });

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should error on missing expected fields', () => {
      const response = {
        structuredContent: {
          other_field: 'value',
        },
      };

      const result = validator.validate(response, null, {
        expectedFields: ['products'],
      });

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Missing expected field: products')));
    });

    it('should warn on empty arrays for expected fields', () => {
      const response = {
        structuredContent: {
          products: [],
        },
      };

      const result = validator.validate(response, null, {
        expectedFields: ['products'],
      });

      assert.ok(result.warnings.some(w => w.includes('products is an empty array')));
    });

    it('should validate expected fields in A2A response', () => {
      const response = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  data: {
                    creatives: [{ creative_id: 'c1' }],
                  },
                },
              ],
            },
          ],
        },
      };

      const result = validator.validate(response, null, {
        expectedFields: ['creatives'],
      });

      assert.strictEqual(result.valid, true);
    });
  });

  describe('Tool-Specific Validation', () => {
    it('should validate get_products response', () => {
      const response = {
        structuredContent: {
          products: [createValidProduct()],
        },
      };

      const result = validator.validate(response, 'get_products');

      assert.strictEqual(result.valid, true);
    });

    it('should error on get_products without products field', () => {
      const response = {
        structuredContent: {
          data: 'something',
        },
      };

      const result = validator.validate(response, 'get_products', {
        expectedFields: ['products'],
      });

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('Missing expected field: products')));
    });

    it('should validate list_creative_formats response', () => {
      const response = {
        structuredContent: {
          formats: [
            {
              format_id: {
                agent_url: 'https://creatives.adcontextprotocol.org',
                id: 'display_300x250',
              },
              name: 'IAB Medium Rectangle',
              type: 'display',
              renders: [
                {
                  role: 'primary',
                  dimensions: {
                    width: 300,
                    height: 250,
                    unit: 'px',
                  },
                },
              ],
            },
          ],
        },
      };

      const result = validator.validate(response, 'list_creative_formats');

      assert.strictEqual(result.valid, true);
    });

    it('should validate list_creatives response', () => {
      const response = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    creatives: [createValidCreative()],
                    query_summary: {
                      total_matching: 1,
                      returned: 1,
                    },
                    pagination: {
                      limit: 50,
                      offset: 0,
                      has_more: false,
                    },
                  },
                },
              ],
            },
          ],
        },
      };

      const result = validator.validate(response, 'list_creatives');

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.protocol, 'a2a');
    });
  });

  describe('Strict Mode', () => {
    it('should fail in strict mode with warnings', () => {
      const response = {
        structuredContent: {
          products: [], // Empty array triggers warning
        },
      };

      const result = validator.validate(response, 'get_products', {
        strict: true,
        expectedFields: ['products'],
      });

      assert.strictEqual(result.valid, false);
      assert.ok(result.warnings.length > 0);
    });

    it('should pass in non-strict mode with warnings', () => {
      const response = {
        structuredContent: {
          products: [],
        },
      };

      const result = validator.validate(response, 'get_products', {
        strict: false,
        expectedFields: ['products'],
      });

      assert.strictEqual(result.valid, true);
      assert.ok(result.warnings.length > 0);
    });
  });

  describe('Helper Methods', () => {
    it('validateOrThrow should throw on invalid response', () => {
      const response = {
        error: { message: 'Failed' },
      };

      assert.throws(() => {
        validator.validateOrThrow(response, 'get_products');
      }, /Response validation failed/);
    });

    it('validateOrThrow should not throw on valid response', () => {
      const response = {
        structuredContent: {
          products: [createValidProduct()],
        },
      };

      assert.doesNotThrow(() => {
        validator.validateOrThrow(response, 'get_products');
      });
    });

    it('isValidProtocolResponse should detect valid responses', () => {
      assert.strictEqual(validator.isValidProtocolResponse({ structuredContent: {} }), true);

      assert.strictEqual(validator.isValidProtocolResponse({ result: { artifacts: [] } }), true);

      assert.strictEqual(validator.isValidProtocolResponse({ data: {} }), true);
    });

    it('isValidProtocolResponse should reject invalid responses', () => {
      assert.strictEqual(validator.isValidProtocolResponse(null), false);
      assert.strictEqual(validator.isValidProtocolResponse(undefined), false);
      assert.strictEqual(validator.isValidProtocolResponse('string'), false);
      assert.strictEqual(validator.isValidProtocolResponse({ random: 'data' }), false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null response', () => {
      const result = validator.validate(null);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('null or undefined')));
    });

    it('should handle undefined response', () => {
      const result = validator.validate(undefined);

      assert.strictEqual(result.valid, false);
    });

    it('should handle response with unknown protocol', () => {
      const response = {
        custom_field: 'value',
      };

      const result = validator.validate(response);

      assert.strictEqual(result.protocol, 'unknown');
      assert.ok(result.warnings.length > 0);
    });
  });
});
