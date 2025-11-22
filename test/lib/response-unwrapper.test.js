// Unit tests for response unwrapper
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import the unwrapper utilities
const { unwrapProtocolResponse, isAdcpError, isAdcpSuccess } = require('../../dist/lib/utils/index.js');
const { createTestProduct, createTestCreative, createTestFormat } = require('./test-fixtures');

describe('Response Unwrapper', () => {
  describe('unwrapProtocolResponse', () => {
    test('should unwrap MCP structuredContent response', () => {
      const mcpResponse = {
        structuredContent: {
          packages: [{ package_id: 'pkg1', budget: 10000 }],
          media_buy_id: 'mb123',
          buyer_ref: 'ref-123',
        },
        content: [{ type: 'text', text: 'Media buy created successfully' }],
      };

      const result = unwrapProtocolResponse(mcpResponse, undefined, 'mcp');

      // Should extract both data and text message
      assert.strictEqual(result.media_buy_id, 'mb123');
      assert.ok(result.packages);
      assert.strictEqual(result.packages[0].package_id, 'pkg1');
      assert.strictEqual(result._message, 'Media buy created successfully');
    });

    test('should unwrap A2A result.artifacts response with validation', () => {
      const a2aResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [
                      createTestProduct({ product_id: 'prod1', name: 'Test Product' }),
                    ],
                  },
                },
              ],
            },
          ],
        },
      };

      const result = unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a');

      assert.ok(result.products);
      assert.strictEqual(result.products.length, 1);
      assert.strictEqual(result.products[0].product_id, 'prod1');
      assert.strictEqual(result.products[0].name, 'Test Product');
    });

    test('should convert A2A error to AdCP error format', () => {
      const a2aErrorResponse = {
        error: {
          code: 400,
          message: 'Invalid request parameters',
        },
      };

      const result = unwrapProtocolResponse(a2aErrorResponse);

      assert.ok(result.errors);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.errors[0].code, '400');
      assert.strictEqual(result.errors[0].message, 'Invalid request parameters');
    });

    test('should convert MCP error to AdCP error format', () => {
      const mcpErrorResponse = {
        isError: true,
        content: [{ type: 'text', text: 'Tool execution failed' }],
      };

      const result = unwrapProtocolResponse(mcpErrorResponse);

      assert.ok(result.errors);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.errors[0].code, 'mcp_error');
      assert.strictEqual(result.errors[0].message, 'Tool execution failed');
    });

    test('should parse stringified JSON in MCP text content', () => {
      const mcpResponse = {
        content: [{ type: 'text', text: '{"packages":[{"package_id":"pkg1"}],"media_buy_id":"mb123"}' }],
      };

      const result = unwrapProtocolResponse(mcpResponse);

      assert.deepStrictEqual(result, {
        packages: [{ package_id: 'pkg1' }],
        media_buy_id: 'mb123',
      });
    });

    test('should throw error for null or undefined response', () => {
      assert.throws(() => unwrapProtocolResponse(null), /Protocol response is null or undefined/);
      assert.throws(() => unwrapProtocolResponse(undefined), /Protocol response is null or undefined/);
    });

    test('should throw error for unrecognized format', () => {
      const unknownFormat = {
        someField: 'value',
      };

      assert.throws(
        () => unwrapProtocolResponse(unknownFormat),
        /Unable to extract AdCP response/
      );
    });

    test('should extract text messages from A2A TextParts', () => {
      const a2aResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'text',
                  text: 'Found 2 products',
                },
                {
                  kind: 'data',
                  data: {
                    products: [
                      createTestProduct({ product_id: 'p1' }),
                      createTestProduct({ product_id: 'p2' }),
                    ],
                  },
                },
              ],
            },
          ],
        },
      };

      const result = unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a');

      assert.ok(result.products);
      assert.strictEqual(result._message, 'Found 2 products');
    });

    test('should extract text messages from MCP content array', () => {
      const mcpResponse = {
        content: [
          {
            type: 'text',
            text: 'Query completed successfully',
          },
        ],
        structuredContent: {
          products: [
            createTestProduct({ product_id: 'p1' }),
          ],
        },
      };

      const result = unwrapProtocolResponse(mcpResponse, 'get_products', 'mcp');

      assert.ok(result.products);
      assert.strictEqual(result._message, 'Query completed successfully');
    });

    test('should take last artifact in conversational protocol', () => {
      const a2aResponse = {
        result: {
          artifacts: [
            {
              artifactId: 'intermediate',
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'old', name: 'Old Product' })],
                  },
                },
              ],
            },
            {
              artifactId: 'final',
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'new', name: 'New Product' })],
                  },
                },
              ],
            },
          ],
        },
      };

      const result = unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a');

      assert.strictEqual(result.products[0].product_id, 'new', 'Should take last artifact');
      assert.strictEqual(result.products[0].name, 'New Product');
    });

    test('should throw error when A2A artifact has no DataPart', () => {
      const a2aResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'text',
                  text: 'Only text, no data',
                },
              ],
            },
          ],
        },
      };

      assert.throws(
        () => unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a'),
        /must have a DataPart/
      );
    });

    test('should throw error when A2A artifacts array is empty', () => {
      const a2aResponse = {
        result: {
          artifacts: [],
        },
      };

      assert.throws(
        () => unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a'),
        /must have at least one artifact/
      );
    });

    test('should combine multiple text messages with newlines', () => {
      const a2aResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'text',
                  text: 'Line 1',
                },
                {
                  kind: 'text',
                  text: 'Line 2',
                },
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'p1' })],
                  },
                },
              ],
            },
          ],
        },
      };

      const result = unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a');

      assert.strictEqual(result._message, 'Line 1\nLine 2');
    });
  });

  describe('isAdcpError', () => {
    test('should return true for error responses', () => {
      const errorResponse = {
        errors: [{ code: 'invalid_request', message: 'Missing required field' }],
      };

      assert.strictEqual(isAdcpError(errorResponse), true);
    });

    test('should return false for success responses', () => {
      const successResponse = {
        packages: [{ package_id: 'pkg1' }],
        media_buy_id: 'mb123',
      };

      assert.strictEqual(isAdcpError(successResponse), false);
    });

    test('should return false for empty errors array', () => {
      const response = {
        errors: [],
      };

      assert.strictEqual(isAdcpError(response), false);
    });
  });

  describe('isAdcpSuccess', () => {
    test('should validate create_media_buy success response', () => {
      const successResponse = {
        packages: [{ package_id: 'pkg1' }],
        media_buy_id: 'mb123',
        buyer_ref: 'buyer-ref-123',
      };

      assert.strictEqual(isAdcpSuccess(successResponse, 'create_media_buy'), true);
    });

    test('should fail validation for create_media_buy without required fields', () => {
      const invalidResponse = {
        packages: [{ package_id: 'pkg1' }],
        // Missing media_buy_id
      };

      assert.strictEqual(isAdcpSuccess(invalidResponse, 'create_media_buy'), false);
    });

    test('should validate update_media_buy success response', () => {
      const successResponse = {
        affected_packages: [{ package_id: 'pkg1' }],
      };

      assert.strictEqual(isAdcpSuccess(successResponse, 'update_media_buy'), true);
    });

    test('should fail validation for update_media_buy without required fields', () => {
      const invalidResponse = {
        packages: [{ package_id: 'pkg1' }],
        // Missing affected_packages
      };

      assert.strictEqual(isAdcpSuccess(invalidResponse, 'update_media_buy'), false);
    });

    test('should validate get_products success response', () => {
      const successResponse = {
        products: [{ product_id: 'prod1' }],
      };

      assert.strictEqual(isAdcpSuccess(successResponse, 'get_products'), true);
    });

    test('should fail validation for error responses', () => {
      const errorResponse = {
        errors: [{ code: 'error', message: 'Something went wrong' }],
      };

      assert.strictEqual(isAdcpSuccess(errorResponse, 'get_products'), false);
    });
  });
});
