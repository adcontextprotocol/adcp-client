/**
 * Integration tests for artifact extraction across MCP and A2A protocols
 *
 * These tests verify that the TaskExecutor correctly extracts data from
 * different protocol response formats (MCP structuredContent and A2A artifacts)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor');
const { ADCP_STATUS } = require('../../dist/lib/core/ProtocolResponseParser');

describe('Artifact Extraction Tests', () => {
  let executor;

  before(() => {
    executor = new TaskExecutor();
  });

  describe('A2A Protocol Artifact Extraction', () => {
    it('should extract products from A2A artifact structure', async () => {
      const mockAgent = {
        id: 'test-a2a',
        name: 'Test A2A Agent',
        protocol: 'a2a',
        agent_uri: 'http://test.local',
      };

      // Mock A2A response structure
      const mockResponse = {
        result: {
          artifacts: [
            {
              artifactId: 'skill_result_1',
              name: 'get_products_result',
              parts: [
                {
                  kind: 'data',
                  data: {
                    products: [
                      { product_id: 'prod1', name: 'Product 1' },
                      { product_id: 'prod2', name: 'Product 2' },
                    ],
                    message: 'Found 2 products',
                  },
                },
              ],
            },
          ],
        },
      };

      // Test the extraction logic directly
      const extractedData = executor.extractResponseData(mockResponse, []);

      assert.ok(extractedData, 'Should extract data');
      assert.ok(extractedData.products, 'Should have products');
      assert.strictEqual(extractedData.products.length, 2, 'Should have 2 products');
      assert.strictEqual(extractedData.products[0].product_id, 'prod1');
      assert.strictEqual(extractedData.message, 'Found 2 products');
    });

    it('should extract creatives from A2A artifact structure', async () => {
      const mockResponse = {
        result: {
          artifacts: [
            {
              artifactId: 'skill_result_1',
              name: 'list_creatives_result',
              parts: [
                {
                  kind: 'data',
                  data: {
                    success: true,
                    creatives: [
                      { creative_id: 'c1', name: 'Creative 1', format: 'video' },
                      { creative_id: 'c2', name: 'Creative 2', format: 'display' },
                    ],
                    total_count: 2,
                  },
                },
              ],
            },
          ],
        },
      };

      const debugLogs = [];
      const extractedData = executor.extractResponseData(mockResponse, debugLogs);

      assert.ok(extractedData.creatives, 'Should have creatives');
      assert.strictEqual(extractedData.creatives.length, 2);
      assert.strictEqual(extractedData.total_count, 2);

      // Check debug logs
      const extractionLog = debugLogs.find(log => log.message.includes('Extracting data from A2A artifact'));
      assert.ok(extractionLog, 'Should log artifact extraction');
      assert.ok(extractionLog.details, 'Should have details');
      assert.strictEqual(extractionLog.details.artifactCount, 1);
      assert.ok(extractionLog.details.dataKeys.includes('creatives'));
    });

    it('should extract formats from A2A artifact structure', async () => {
      const mockResponse = {
        result: {
          artifacts: [
            {
              artifactId: 'skill_result_1',
              name: 'list_creative_formats_result',
              parts: [
                {
                  kind: 'data',
                  data: {
                    formats: [
                      { format_id: 'video_1920x1080', name: 'HD Video' },
                      { format_id: 'display_300x250', name: 'Medium Rectangle' },
                    ],
                    adcp_version: '1.6.0',
                  },
                },
              ],
            },
          ],
        },
      };

      const extractedData = executor.extractResponseData(mockResponse, []);

      assert.ok(extractedData.formats, 'Should have formats');
      assert.strictEqual(extractedData.formats.length, 2);
      assert.strictEqual(extractedData.adcp_version, '1.6.0');
    });

    it('should handle A2A artifacts with multiple parts', async () => {
      const mockResponse = {
        result: {
          artifacts: [
            {
              artifactId: 'multi_part_result',
              name: 'complex_result',
              parts: [
                {
                  kind: 'data',
                  data: { products: [{ product_id: 'p1' }] },
                },
                {
                  kind: 'text',
                  text: 'Additional context',
                },
              ],
            },
          ],
        },
      };

      // Should extract from first part only
      const extractedData = executor.extractResponseData(mockResponse, []);

      assert.ok(extractedData.products, 'Should extract from first part');
      assert.strictEqual(extractedData.products.length, 1);
    });

    it('should handle empty A2A artifacts gracefully', async () => {
      const mockResponse = {
        result: {
          artifacts: [],
        },
      };

      const debugLogs = [];
      const extractedData = executor.extractResponseData(mockResponse, debugLogs);

      // Should return the result object since no artifacts
      assert.ok(extractedData.artifacts);
      assert.strictEqual(extractedData.artifacts.length, 0);

      // Should log the fallback
      const fallbackLog = debugLogs.find(log => log.message.includes('Returning A2A result directly'));
      assert.ok(fallbackLog, 'Should log fallback to result');
    });

    it('should extract AdCP response from HITL multi-artifact structure', async () => {
      // Real-world HITL response with 3 artifacts
      const mockResponse = {
        result: {
          artifacts: [
            {
              artifactId: 'start_of_hitl-create_media_buy-ba544893-c44f-44dd-855d-d4484095586e',
              parts: [
                {
                  kind: 'data',
                  data: {
                    status: 'pending_human',
                    data: null,
                  },
                },
              ],
            },
            {
              artifactId: 'end_of_hitl-create_media_buy-ba544893-c44f-44dd-855d-d4484095586e',
              parts: [
                {
                  kind: 'text',
                  text: '✅ Media Buy Created Successfully',
                },
                {
                  kind: 'data',
                  data: {
                    buyer_ref: 'harley-test-1763691443',
                    media_buy_id: '123',
                    packages: [
                      { buyer_ref: 'harley-pkg-1-1763691443', package_id: '1' },
                      { buyer_ref: 'harley-pkg-2-1763691443', package_id: '2' },
                    ],
                  },
                },
              ],
            },
            {
              artifactId: '38610840-956b-4d78-a762-aeff2230ea5b',
              parts: [
                {
                  kind: 'text',
                  text: '✅ Media Buy Created Successfully',
                },
                {
                  kind: 'data',
                  data: {
                    id: 'adk-c7f309cf-acfe-44b2-a253-3dd1d85562f7',
                    name: 'create_media_buy',
                    response: {
                      buyer_ref: 'harley-test-1763691443',
                      media_buy_id: '123',
                      packages: [
                        { buyer_ref: 'harley-pkg-1-1763691443', package_id: '1' },
                        { buyer_ref: 'harley-pkg-2-1763691443', package_id: '2' },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
      };

      const debugLogs = [];
      const extractedData = executor.extractResponseData(mockResponse, debugLogs);

      // Should extract the AdCP response from end_of_hitl artifact
      assert.ok(extractedData.media_buy_id, 'Should have media_buy_id');
      assert.strictEqual(extractedData.media_buy_id, '123');
      assert.ok(extractedData.packages, 'Should have packages');
      assert.strictEqual(extractedData.packages.length, 2);
      assert.strictEqual(extractedData.buyer_ref, 'harley-test-1763691443');

      // Should NOT return the pending_human status from first artifact
      assert.strictEqual(extractedData.status, undefined);
    });

    it('should extract data from framework-wrapped responses (e.g., ADK FunctionResponse)', async () => {
      // Mock A2A response with ADK FunctionResponse wrapper
      // ADK wraps responses in { id, name, response: {...} } format
      const mockResponse = {
        result: {
          artifacts: [
            {
              artifactId: 'skill_result_1',
              name: 'list_creative_formats',
              parts: [
                {
                  kind: 'data',
                  data: {
                    // Framework wrapper (ADK FunctionResponse)
                    id: 'call_abc123',
                    name: 'list_creative_formats',
                    response: {
                      // Actual ADCP data nested inside
                      formats: [
                        { format_id: 'video_1920x1080', name: 'HD Video', width: 1920, height: 1080 },
                        { format_id: 'display_300x250', name: 'Medium Rectangle', width: 300, height: 250 },
                      ],
                      adcp_version: '1.6.0',
                    },
                  },
                },
              ],
            },
          ],
        },
      };

      const debugLogs = [];
      const extractedData = executor.extractResponseData(mockResponse, debugLogs);

      // Should extract the nested data from the 'response' field, not the wrapper
      assert.ok(extractedData.formats, 'Should have formats from nested response');
      assert.strictEqual(extractedData.formats.length, 2, 'Should have 2 formats');
      assert.strictEqual(extractedData.formats[0].format_id, 'video_1920x1080');
      assert.strictEqual(extractedData.adcp_version, '1.6.0');

      // Should NOT have wrapper fields
      assert.strictEqual(extractedData.id, undefined, 'Should not have wrapper id field');
      assert.strictEqual(extractedData.name, undefined, 'Should not have wrapper name field');

      // Check debug logs for wrapper detection
      const wrapperLog = debugLogs.find(log => log.message.includes('Extracting data from framework wrapper'));
      assert.ok(wrapperLog, 'Should log framework wrapper detection');
      assert.ok(wrapperLog.details, 'Should have wrapper details');
      assert.strictEqual(wrapperLog.details.wrapperId, 'call_abc123');
      assert.strictEqual(wrapperLog.details.wrapperName, 'list_creative_formats');
      assert.ok(wrapperLog.details.hasFormats, 'Should detect formats in nested data');
      assert.strictEqual(wrapperLog.details.formatsCount, 2);
    });
  });

  describe('MCP Protocol Extraction', () => {
    it('should extract products from MCP structuredContent', async () => {
      const mockResponse = {
        content: [
          {
            type: 'text',
            text: 'Here are the products',
          },
        ],
        structuredContent: {
          products: [
            { product_id: 'prod1', name: 'Product 1' },
            { product_id: 'prod2', name: 'Product 2' },
          ],
        },
      };

      const debugLogs = [];
      const extractedData = executor.extractResponseData(mockResponse, debugLogs);

      assert.ok(extractedData.products, 'Should have products');
      assert.strictEqual(extractedData.products.length, 2);

      // Check debug logs
      const extractionLog = debugLogs.find(log => log.message.includes('Extracting data from MCP structuredContent'));
      assert.ok(extractionLog, 'Should log MCP extraction');
    });

    it('should extract creatives from MCP structuredContent', async () => {
      const mockResponse = {
        structuredContent: {
          creatives: [{ creative_id: 'c1', name: 'Creative 1' }],
          total_count: 1,
        },
      };

      const extractedData = executor.extractResponseData(mockResponse, []);

      assert.ok(extractedData.creatives, 'Should have creatives');
      assert.strictEqual(extractedData.total_count, 1);
    });

    it('should extract formats from MCP structuredContent', async () => {
      const mockResponse = {
        structuredContent: {
          formats: [{ format_id: 'f1', name: 'Format 1' }],
          adcp_version: '1.6.0',
        },
      };

      const extractedData = executor.extractResponseData(mockResponse, []);

      assert.ok(extractedData.formats);
      assert.strictEqual(extractedData.formats.length, 1);
    });
  });

  describe('Protocol-Agnostic Behavior', () => {
    it('should extract the same data from both protocol formats', async () => {
      const expectedProducts = [
        { product_id: 'p1', name: 'Product 1' },
        { product_id: 'p2', name: 'Product 2' },
      ];

      // A2A format
      const a2aResponse = {
        result: {
          artifacts: [
            {
              parts: [
                {
                  data: { products: expectedProducts },
                },
              ],
            },
          ],
        },
      };

      // MCP format
      const mcpResponse = {
        structuredContent: {
          products: expectedProducts,
        },
      };

      const a2aData = executor.extractResponseData(a2aResponse, []);
      const mcpData = executor.extractResponseData(mcpResponse, []);

      // Both should extract the same products
      assert.deepStrictEqual(a2aData.products, mcpData.products);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle responses with only response.data field', async () => {
      const mockResponse = {
        data: {
          products: [{ product_id: 'p1' }],
        },
      };

      const debugLogs = [];
      const extractedData = executor.extractResponseData(mockResponse, debugLogs);

      assert.ok(extractedData.products);

      const dataLog = debugLogs.find(log => log.message.includes('Extracting data from response.data field'));
      assert.ok(dataLog, 'Should log data field extraction');
    });

    it('should fallback to full response when no standard structure found', async () => {
      const mockResponse = {
        custom_field: 'value',
        other_data: 123,
      };

      const debugLogs = [];
      const extractedData = executor.extractResponseData(mockResponse, debugLogs);

      assert.deepStrictEqual(extractedData, mockResponse);

      const fallbackLog = debugLogs.find(log => log.message.includes('No standard data structure found'));
      assert.ok(fallbackLog, 'Should log fallback');
      assert.ok(fallbackLog.details.responseKeys.includes('custom_field'));
    });

    it('should handle null/undefined responses gracefully', async () => {
      const nullData = executor.extractResponseData(null, []);
      const undefinedData = executor.extractResponseData(undefined, []);

      assert.strictEqual(nullData, null);
      assert.strictEqual(undefinedData, undefined);
    });

    it('should work without debug logs array', async () => {
      const mockResponse = {
        structuredContent: {
          products: [{ product_id: 'p1' }],
        },
      };

      // Should not throw when debugLogs is undefined
      const extractedData = executor.extractResponseData(mockResponse);

      assert.ok(extractedData.products);
    });
  });

  describe('Debug Logging', () => {
    it('should include artifact details in debug logs', async () => {
      const mockResponse = {
        result: {
          artifacts: [
            {
              parts: [{ data: { key1: 'value1', key2: 'value2' } }, { data: { key3: 'value3' } }],
            },
          ],
        },
      };

      const debugLogs = [];
      executor.extractResponseData(mockResponse, debugLogs);

      const extractionLog = debugLogs[0];
      assert.ok(extractionLog.details);
      assert.strictEqual(extractionLog.details.artifactCount, 1);
      assert.strictEqual(extractionLog.details.partCount, 2);
      assert.ok(Array.isArray(extractionLog.details.dataKeys));
      assert.ok(extractionLog.details.dataKeys.includes('key1'));
      assert.ok(extractionLog.details.dataKeys.includes('key2'));
    });

    it('should include timestamp in debug logs', async () => {
      const mockResponse = {
        structuredContent: { data: 'test' },
      };

      const debugLogs = [];
      executor.extractResponseData(mockResponse, debugLogs);

      assert.ok(debugLogs[0].timestamp);
      assert.ok(new Date(debugLogs[0].timestamp).getTime() > 0);
    });
  });
});
