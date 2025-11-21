// Unit tests for response unwrapper
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import the unwrapper utilities
const { unwrapProtocolResponse, isAdcpError, isAdcpSuccess } = require('../../dist/lib/utils/index.js');

describe('Response Unwrapper', () => {

  describe('unwrapProtocolResponse', () => {
    test('should unwrap MCP structuredContent response', () => {
      const mcpResponse = {
        structuredContent: {
          packages: [
            { package_id: 'pkg1', budget: 10000 }
          ],
          media_buy_id: 'mb123'
        },
        content: [
          { type: 'text', text: 'Media buy created successfully' }
        ]
      };

      const result = unwrapProtocolResponse(mcpResponse);

      assert.deepStrictEqual(result, {
        packages: [{ package_id: 'pkg1', budget: 10000 }],
        media_buy_id: 'mb123'
      });
    });

    test('should unwrap A2A result.artifacts response', () => {
      const a2aResponse = {
        result: {
          artifacts: [{
            parts: [{
              data: {
                products: [
                  { product_id: 'prod1', name: 'Test Product' }
                ]
              }
            }]
          }]
        }
      };

      const result = unwrapProtocolResponse(a2aResponse);

      assert.deepStrictEqual(result, {
        products: [{ product_id: 'prod1', name: 'Test Product' }]
      });
    });

    test('should convert A2A error to AdCP error format', () => {
      const a2aErrorResponse = {
        error: {
          code: 400,
          message: 'Invalid request parameters'
        }
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
        content: [
          { type: 'text', text: 'Tool execution failed' }
        ]
      };

      const result = unwrapProtocolResponse(mcpErrorResponse);

      assert.ok(result.errors);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.errors[0].code, 'mcp_error');
      assert.strictEqual(result.errors[0].message, 'Tool execution failed');
    });

    test('should parse stringified JSON in MCP text content', () => {
      const mcpResponse = {
        content: [
          { type: 'text', text: '{"packages":[{"package_id":"pkg1"}],"media_buy_id":"mb123"}' }
        ]
      };

      const result = unwrapProtocolResponse(mcpResponse);

      assert.deepStrictEqual(result, {
        packages: [{ package_id: 'pkg1' }],
        media_buy_id: 'mb123'
      });
    });

    test('should throw error for null or undefined response', () => {
      assert.throws(() => unwrapProtocolResponse(null), /Protocol response is null or undefined/);
      assert.throws(() => unwrapProtocolResponse(undefined), /Protocol response is null or undefined/);
    });

    test('should return plain object if already unwrapped', () => {
      const adcpResponse = {
        packages: [{ package_id: 'pkg1' }],
        media_buy_id: 'mb123'
      };

      const result = unwrapProtocolResponse(adcpResponse);

      assert.deepStrictEqual(result, adcpResponse);
    });
  });

  describe('isAdcpError', () => {
    test('should return true for error responses', () => {
      const errorResponse = {
        errors: [
          { code: 'invalid_request', message: 'Missing required field' }
        ]
      };

      assert.strictEqual(isAdcpError(errorResponse), true);
    });

    test('should return false for success responses', () => {
      const successResponse = {
        packages: [{ package_id: 'pkg1' }],
        media_buy_id: 'mb123'
      };

      assert.strictEqual(isAdcpError(successResponse), false);
    });

    test('should return false for empty errors array', () => {
      const response = {
        errors: []
      };

      assert.strictEqual(isAdcpError(response), false);
    });
  });

  describe('isAdcpSuccess', () => {
    test('should validate create_media_buy success response', () => {
      const successResponse = {
        packages: [{ package_id: 'pkg1' }],
        media_buy_id: 'mb123',
        buyer_ref: 'buyer-ref-123'
      };

      assert.strictEqual(isAdcpSuccess(successResponse, 'create_media_buy'), true);
    });

    test('should fail validation for create_media_buy without required fields', () => {
      const invalidResponse = {
        packages: [{ package_id: 'pkg1' }]
        // Missing media_buy_id
      };

      assert.strictEqual(isAdcpSuccess(invalidResponse, 'create_media_buy'), false);
    });

    test('should validate update_media_buy success response', () => {
      const successResponse = {
        affected_packages: [{ package_id: 'pkg1' }]
      };

      assert.strictEqual(isAdcpSuccess(successResponse, 'update_media_buy'), true);
    });

    test('should fail validation for update_media_buy without required fields', () => {
      const invalidResponse = {
        packages: [{ package_id: 'pkg1' }]
        // Missing affected_packages
      };

      assert.strictEqual(isAdcpSuccess(invalidResponse, 'update_media_buy'), false);
    });

    test('should validate get_products success response', () => {
      const successResponse = {
        products: [{ product_id: 'prod1' }]
      };

      assert.strictEqual(isAdcpSuccess(successResponse, 'get_products'), true);
    });

    test('should fail validation for error responses', () => {
      const errorResponse = {
        errors: [{ code: 'error', message: 'Something went wrong' }]
      };

      assert.strictEqual(isAdcpSuccess(errorResponse, 'get_products'), false);
    });
  });
});
