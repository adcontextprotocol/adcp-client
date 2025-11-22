// Unit tests for response unwrapper
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import the unwrapper utilities
const { unwrapProtocolResponse, isAdcpError, isAdcpSuccess } = require('../../dist/lib/utils/index.js');
const { createTestProduct, createTestCreative, createTestFormat, createTestPackage } = require('./test-fixtures');

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
                    products: [createTestProduct({ product_id: 'prod1', name: 'Test Product' })],
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

    test('should unwrap nested response field in A2A data part', () => {
      // Some agents wrap AdCP responses in an extra { response: { ... } } layer
      const a2aResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    response: {
                      products: [createTestProduct({ product_id: 'prod1', name: 'Test Product' })],
                    },
                  },
                },
              ],
            },
          ],
        },
      };

      const result = unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a');

      // Should unwrap the nested response field
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

      assert.throws(() => unwrapProtocolResponse(unknownFormat), /Unable to extract AdCP response/);
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
                    products: [createTestProduct({ product_id: 'p1' }), createTestProduct({ product_id: 'p2' })],
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
          products: [createTestProduct({ product_id: 'p1' })],
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

      assert.throws(() => unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a'), /must have a DataPart/);
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

    test('should handle A2A artifacts without status field gracefully', () => {
      // Per @a2a-js/sdk TypeScript definitions:
      // - Artifact interface has fields: artifactId, description?, extensions?, metadata?, name?, parts[]
      // - Task interface has status field (with state property)
      // - Artifacts do NOT have a status field
      //
      // This test verifies that if an agent erroneously returns artifacts with status fields,
      // the unwrapper handles it correctly by ignoring the status and extracting the data.
      const a2aResponseWithStatus = {
        result: {
          artifacts: [
            {
              artifactId: 'art-1',
              status: 'completed', // This should not exist per spec
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'prod1', name: 'Test Product' })],
                  },
                },
              ],
            },
          ],
        },
      };

      // Should not throw and should extract the data correctly
      const result = unwrapProtocolResponse(a2aResponseWithStatus, 'get_products', 'a2a');

      assert.ok(result.products);
      assert.strictEqual(result.products.length, 1);
      assert.strictEqual(result.products[0].product_id, 'prod1');
      assert.strictEqual(result.products[0].name, 'Test Product');

      // Status field should not affect the extraction
      assert.strictEqual(result.status, undefined, 'Status should not be in the unwrapped result');
    });

    test('should correctly determine artifact completion from Task status, not artifact status', () => {
      // This test verifies that we rely on Task.status.state, not hypothetical Artifact.status
      const a2aCompletedTaskResponse = {
        result: {
          kind: 'task',
          id: 'task-123',
          contextId: 'ctx-456',
          status: {
            state: 'completed', // Task status indicates completion
            timestamp: '2025-01-22T12:00:00Z',
          },
          artifacts: [
            {
              artifactId: 'art-1',
              // No status field - artifacts don't have status per spec
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'prod1', name: 'Test Product' })],
                  },
                },
              ],
            },
          ],
        },
      };

      const result = unwrapProtocolResponse(a2aCompletedTaskResponse, 'get_products', 'a2a');

      assert.ok(result.products);
      assert.strictEqual(result.products.length, 1);
      assert.strictEqual(result.products[0].product_id, 'prod1');

      // The unwrapper should work regardless of Task status
      // Task status indicates overall task state, not individual artifact state
    });

    test('should handle very large artifact arrays (performance test)', () => {
      // Create 100+ artifacts to test performance
      const largeArtifactArray = [];
      for (let i = 0; i < 150; i++) {
        largeArtifactArray.push({
          artifactId: `art-${i}`,
          parts: [
            {
              kind: 'data',
              data: {
                products: [createTestProduct({ product_id: `prod${i}`, name: `Product ${i}` })],
              },
            },
          ],
        });
      }

      const a2aResponse = {
        result: {
          artifacts: largeArtifactArray,
        },
      };

      // Should take last artifact per conversational protocol
      const result = unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a');

      assert.ok(result.products);
      assert.strictEqual(result.products[0].product_id, 'prod149', 'Should take last artifact');
      assert.strictEqual(result.products[0].name, 'Product 149');
    });

    test('should throw error for malformed DataParts (missing data field)', () => {
      const a2aResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  // Missing data field
                },
              ],
            },
          ],
        },
      };

      assert.throws(
        () => unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a'),
        /must have a DataPart with AdCP data/
      );
    });

    test('should reject intermediate A2A status "working"', () => {
      const a2aWorkingResponse = {
        result: {
          status: {
            state: 'working',
            timestamp: '2025-01-22T12:00:00Z',
          },
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'prod1' })],
                  },
                },
              ],
            },
          ],
        },
      };

      assert.throws(
        () => unwrapProtocolResponse(a2aWorkingResponse, 'get_products', 'a2a'),
        /Cannot unwrap A2A response with intermediate status: working/
      );
    });

    test('should reject intermediate A2A status "submitted"', () => {
      const a2aSubmittedResponse = {
        result: {
          status: {
            state: 'submitted',
            timestamp: '2025-01-22T12:00:00Z',
          },
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'prod1' })],
                  },
                },
              ],
            },
          ],
        },
      };

      assert.throws(
        () => unwrapProtocolResponse(a2aSubmittedResponse, 'get_products', 'a2a'),
        /Cannot unwrap A2A response with intermediate status: submitted/
      );
    });

    test('should reject intermediate A2A status "input-required"', () => {
      const a2aInputRequiredResponse = {
        result: {
          status: {
            state: 'input-required',
            timestamp: '2025-01-22T12:00:00Z',
          },
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'prod1' })],
                  },
                },
              ],
            },
          ],
        },
      };

      assert.throws(
        () => unwrapProtocolResponse(a2aInputRequiredResponse, 'get_products', 'a2a'),
        /Cannot unwrap A2A response with intermediate status: input-required/
      );
    });

    test('should include text snippet in error for unparseable MCP JSON', () => {
      const mcpResponse = {
        content: [{ type: 'text', text: 'This is not JSON, just plain text that should be included in error' }],
      };

      const result = unwrapProtocolResponse(mcpResponse);

      assert.ok(result.errors);
      assert.strictEqual(result.errors.length, 1);
      assert.ok(result.errors[0].message.includes('This is not JSON'));
    });

    test('should truncate long text snippet in error message', () => {
      const longText = 'x'.repeat(200); // 200 character string
      const mcpResponse = {
        content: [{ type: 'text', text: longText }],
      };

      const result = unwrapProtocolResponse(mcpResponse);

      assert.ok(result.errors);
      assert.strictEqual(result.errors.length, 1);
      // Should be truncated to 100 chars + "..."
      assert.ok(result.errors[0].message.includes('...'));
      assert.ok(result.errors[0].message.length < 200);
    });

    test('should fail Zod validation for invalid product data', () => {
      const a2aResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [
                      {
                        // Missing required fields like product_id, name, etc.
                        invalid_field: 'should fail validation',
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      };

      assert.throws(
        () => unwrapProtocolResponse(a2aResponse, 'get_products', 'a2a'),
        /Response validation failed for get_products/
      );
    });

    test('should fail Zod validation for missing required create_media_buy fields', () => {
      const a2aResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    packages: [createTestPackage({ package_id: 'pkg1' })],
                    // Missing media_buy_id
                  },
                },
              ],
            },
          ],
        },
      };

      assert.throws(
        () => unwrapProtocolResponse(a2aResponse, 'create_media_buy', 'a2a'),
        /Response validation failed for create_media_buy/
      );
    });
  });

  describe('Protocol Auto-Detection Edge Cases', () => {
    test('should throw error for empty response object', () => {
      const emptyResponse = {};

      assert.throws(
        () => unwrapProtocolResponse(emptyResponse),
        /Unable to extract AdCP response from protocol wrapper/
      );
    });

    test('should throw error for response with only unrelated fields', () => {
      const unrelatedResponse = {
        someField: 'value',
        anotherField: 123,
        randomData: { nested: 'object' },
      };

      assert.throws(
        () => unwrapProtocolResponse(unrelatedResponse),
        /Unable to extract AdCP response from protocol wrapper/
      );
    });

    test('should prioritize MCP when response has both MCP and A2A fields (ambiguous)', () => {
      // This is an ambiguous response with both protocol indicators
      const ambiguousResponse = {
        // MCP fields
        structuredContent: {
          products: [createTestProduct({ product_id: 'mcp-prod', name: 'MCP Product' })],
        },
        // A2A fields
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'a2a-prod', name: 'A2A Product' })],
                  },
                },
              ],
            },
          ],
        },
      };

      const result = unwrapProtocolResponse(ambiguousResponse);

      // Auto-detection should prioritize MCP (isMCPResponse is checked first)
      assert.strictEqual(result.products[0].product_id, 'mcp-prod');
      assert.strictEqual(result.products[0].name, 'MCP Product');
    });

    test('should detect A2A when only A2A fields present', () => {
      const a2aOnlyResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [createTestProduct({ product_id: 'a2a-only', name: 'A2A Only' })],
                  },
                },
              ],
            },
          ],
        },
      };

      const result = unwrapProtocolResponse(a2aOnlyResponse);

      assert.strictEqual(result.products[0].product_id, 'a2a-only');
      assert.strictEqual(result.products[0].name, 'A2A Only');
    });

    test('should detect MCP when only MCP fields present', () => {
      const mcpOnlyResponse = {
        structuredContent: {
          products: [createTestProduct({ product_id: 'mcp-only', name: 'MCP Only' })],
        },
      };

      const result = unwrapProtocolResponse(mcpOnlyResponse);

      assert.strictEqual(result.products[0].product_id, 'mcp-only');
      assert.strictEqual(result.products[0].name, 'MCP Only');
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
        packages: [createTestPackage({ package_id: 'pkg1' })],
        media_buy_id: 'mb123',
        buyer_ref: 'buyer-ref-123',
      };

      assert.strictEqual(isAdcpSuccess(successResponse, 'create_media_buy'), true);
    });

    test('should fail validation for create_media_buy without required fields', () => {
      const invalidResponse = {
        packages: [createTestPackage({ package_id: 'pkg1' })],
        // Missing media_buy_id
      };

      assert.strictEqual(isAdcpSuccess(invalidResponse, 'create_media_buy'), false);
    });

    test('should validate update_media_buy success response', () => {
      const successResponse = {
        media_buy_id: 'mb123',
        buyer_ref: 'buyer-ref-123',
        affected_packages: [createTestPackage({ package_id: 'pkg1' })],
      };

      assert.strictEqual(isAdcpSuccess(successResponse, 'update_media_buy'), true);
    });

    test('should fail validation for update_media_buy without required fields', () => {
      const invalidResponse = {
        packages: [createTestPackage({ package_id: 'pkg1' })],
        // Missing affected_packages
      };

      assert.strictEqual(isAdcpSuccess(invalidResponse, 'update_media_buy'), false);
    });

    test('should validate get_products success response', () => {
      const successResponse = {
        products: [createTestProduct({ product_id: 'prod1' })],
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
