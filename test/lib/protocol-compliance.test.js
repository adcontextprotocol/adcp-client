// Protocol Compliance Tests - Tests message format validation for A2A and MCP protocols
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import protocol functions
const { callA2ATool } = require('../../dist/lib/protocols/a2a.js');

/**
 * Protocol Compliance Testing Strategy
 * 
 * Purpose: Validate that our protocol implementations generate correctly formatted messages
 * that conform to A2A and MCP specifications, without requiring external servers.
 * 
 * Approach:
 * 1. Mock at the SDK transport level (not HTTP level)
 * 2. Capture actual messages being sent to SDK clients
 * 3. Validate message structure against protocol schemas
 * 4. Test edge cases and error conditions
 */

describe('A2A Protocol Compliance', () => {
  
  // Mock the A2A SDK to capture and validate actual messages being sent
  let capturedMessages = [];
  let mockA2AClient;

  // Reset mocks before each test
  function setupA2AMocks() {
    capturedMessages = [];
    
    // Create a mock A2A client that captures sendMessage calls
    mockA2AClient = {
      sendMessage: async (payload) => {
        capturedMessages.push(payload);
        
        // Return a valid success response to simulate server acceptance
        return {
          jsonrpc: "2.0",
          id: "test-id",
          result: {
            kind: "task",
            id: "task-123",
            contextId: "ctx-123",
            status: {
              state: "completed",
              timestamp: new Date().toISOString()
            }
          }
        };
      }
    };

    // Mock the A2AClient.fromCardUrl method
    const originalA2AClient = require('@a2a-js/sdk/client').A2AClient;
    originalA2AClient.fromCardUrl = async () => mockA2AClient;
  }

  describe('Message Structure Validation', () => {
    
    test('should generate correctly formatted A2A message with required fields', async () => {
      setupA2AMocks();
      
      const agentUrl = 'https://test-agent.example.com';
      const toolName = 'get_products';
      const parameters = { category: 'electronics', limit: 10 };
      
      await callA2ATool(agentUrl, toolName, parameters);
      
      // Verify exactly one message was sent
      assert.strictEqual(capturedMessages.length, 1);
      
      const sentMessage = capturedMessages[0];
      
      // Test required top-level structure
      assert.ok(sentMessage.message, 'Message should have a message property');
      
      const message = sentMessage.message;
      
      // Validate critical A2A message fields that were missing in the bug
      assert.strictEqual(message.kind, 'message', 'Message must have kind: "message"');
      assert.ok(message.messageId, 'Message must have messageId');
      assert.strictEqual(message.role, 'user', 'Message must have role: "user"');
      assert.ok(Array.isArray(message.parts), 'Message must have parts array');
      
      // Validate parts structure 
      assert.strictEqual(message.parts.length, 1, 'Should have exactly one part');
      const part = message.parts[0];
      
      assert.strictEqual(part.kind, 'data', 'Part must have kind: "data"');
      assert.ok(part.data, 'Part must have data property');
      assert.strictEqual(part.data.skill, toolName, 'Part data must have correct skill');
      assert.deepStrictEqual(part.data.input, parameters, 'Part data must use "input" not "parameters"');
    });

    test('should reject attempt to use deprecated "parameters" field', async () => {
      setupA2AMocks();
      
      // This test ensures we don't regress to using "parameters" instead of "input"
      const agentUrl = 'https://test-agent.example.com';
      const toolName = 'get_products';
      const parameters = { category: 'electronics' };
      
      await callA2ATool(agentUrl, toolName, parameters);
      
      const sentMessage = capturedMessages[0];
      const part = sentMessage.message.parts[0];
      
      // Verify we're using "input" not "parameters"
      assert.ok(part.data.input, 'Should use "input" field');
      assert.strictEqual(part.data.parameters, undefined, 'Should not have deprecated "parameters" field');
      assert.deepStrictEqual(part.data.input, parameters, 'Input should contain the parameters data');
    });

    test('should validate messageId format and uniqueness', async () => {
      setupA2AMocks();
      
      const agentUrl = 'https://test-agent.example.com';
      const toolName = 'test_skill';
      
      // Send two messages
      await callA2ATool(agentUrl, toolName, {});
      await callA2ATool(agentUrl, toolName, {});
      
      assert.strictEqual(capturedMessages.length, 2);
      
      const message1Id = capturedMessages[0].message.messageId;
      const message2Id = capturedMessages[1].message.messageId;
      
      // Verify messageId format (should start with 'msg_')
      assert.ok(message1Id.startsWith('msg_'), 'MessageId should start with "msg_"');
      assert.ok(message2Id.startsWith('msg_'), 'MessageId should start with "msg_"');
      
      // Verify uniqueness
      assert.notStrictEqual(message1Id, message2Id, 'MessageIds should be unique');
      
      // Verify length is reasonable (timestamp + random string)
      assert.ok(message1Id.length > 15, 'MessageId should be sufficiently long');
    });

    test('should handle empty parameters correctly', async () => {
      setupA2AMocks();
      
      await callA2ATool('https://test.com', 'skill_without_params', {});
      
      const sentMessage = capturedMessages[0];
      const part = sentMessage.message.parts[0];
      
      assert.deepStrictEqual(part.data.input, {}, 'Empty parameters should result in empty input object');
      assert.strictEqual(part.data.skill, 'skill_without_params', 'Skill name should be preserved');
    });

    test('should handle complex nested parameters', async () => {
      setupA2AMocks();
      
      const complexParams = {
        criteria: {
          category: 'electronics',
          price: { min: 100, max: 500 },
          tags: ['mobile', 'smartphone']
        },
        options: {
          includeImages: true,
          sortBy: 'price',
          limit: 25
        }
      };
      
      await callA2ATool('https://test.com', 'complex_search', complexParams);
      
      const sentMessage = capturedMessages[0];
      const part = sentMessage.message.parts[0];
      
      assert.deepStrictEqual(part.data.input, complexParams, 'Complex nested parameters should be preserved exactly');
    });
  });

  describe('Authentication Integration', () => {
    
    test('should pass authentication token to SDK client correctly', async () => {
      // This test verifies auth token integration without testing HTTP details
      const authToken = 'TEST_BEARER_TOKEN_PLACEHOLDER';
      let capturedFetchImpl;
      
      // Mock A2AClient.fromCardUrl to capture the fetchImpl
      const originalA2AClient = require('@a2a-js/sdk/client').A2AClient;
      originalA2AClient.fromCardUrl = async (cardUrl, options) => {
        capturedFetchImpl = options?.fetchImpl;
        return mockA2AClient;
      };
      
      setupA2AMocks();
      
      await callA2ATool('https://test.com', 'test_skill', {}, authToken);
      
      // Verify fetchImpl was provided when auth token exists
      assert.ok(capturedFetchImpl, 'Should provide fetchImpl when auth token provided');
      assert.strictEqual(typeof capturedFetchImpl, 'function', 'fetchImpl should be a function');
    });

    test('should not provide fetchImpl when no auth token', async () => {
      let capturedOptions;
      
      const originalA2AClient = require('@a2a-js/sdk/client').A2AClient;
      originalA2AClient.fromCardUrl = async (cardUrl, options) => {
        capturedOptions = options;
        return mockA2AClient;
      };
      
      setupA2AMocks();
      
      await callA2ATool('https://test.com', 'test_skill', {}); // No auth token
      
      // Verify no fetchImpl provided when no auth token
      assert.ok(!capturedOptions?.fetchImpl, 'Should not provide fetchImpl when no auth token');
    });
  });

  describe('Error Response Handling', () => {
    
    test('should properly detect JSON-RPC errors in response', async () => {
      // Mock client to return JSON-RPC error
      const errorClient = {
        sendMessage: async () => ({
          jsonrpc: "2.0",
          id: "test-id",
          error: {
            code: -32602,
            message: "Invalid params: missing required field 'kind' in message",
            data: { field: 'kind', expected: 'message' }
          }
        })
      };
      
      const originalA2AClient = require('@a2a-js/sdk/client').A2AClient;
      originalA2AClient.fromCardUrl = async () => errorClient;
      
      await assert.rejects(
        async () => {
          await callA2ATool('https://test.com', 'test_skill', {});
        },
        {
          message: /A2A agent returned error: Invalid params: missing required field 'kind' in message/
        },
        'Should throw error when server returns JSON-RPC error'
      );
    });

    test('should handle nested result errors', async () => {
      // Mock client to return error nested in result
      const errorClient = {
        sendMessage: async () => ({
          jsonrpc: "2.0",
          id: "test-id",
          result: {
            error: {
              code: -32600,
              message: "Malformed request: 'parameters' field not supported, use 'input' instead"
            }
          }
        })
      };
      
      const originalA2AClient = require('@a2a-js/sdk/client').A2AClient;
      originalA2AClient.fromCardUrl = async () => errorClient;
      
      await assert.rejects(
        async () => {
          await callA2ATool('https://test.com', 'test_skill', {});
        },
        {
          message: /A2A agent returned error: Malformed request: 'parameters' field not supported, use 'input' instead/
        },
        'Should throw error when server returns nested error in result'
      );
    });
  });

  describe('Debug Logging Integration', () => {
    
    test('should capture debug logs with actual payload information', async () => {
      setupA2AMocks();
      
      const debugLogs = [];
      const testParams = { test: 'data' };
      
      await callA2ATool('https://test.com', 'debug_test', testParams, null, debugLogs);
      
      // Should have request and response debug logs
      assert.ok(debugLogs.length >= 2, 'Should have debug logs for request and response');
      
      // Find request log
      const requestLog = debugLogs.find(log => log.type === 'info' && log.message.includes('Calling skill'));
      assert.ok(requestLog, 'Should have request debug log');
      assert.ok(requestLog.actualPayload, 'Should include actual payload in debug log');
      assert.strictEqual(requestLog.actualPayload.message.parts[0].data.skill, 'debug_test');
      assert.deepStrictEqual(requestLog.actualPayload.message.parts[0].data.input, testParams);
      
      // Find response log
      const responseLog = debugLogs.find(log => log.type === 'success' && log.message.includes('Response received'));
      assert.ok(responseLog, 'Should have response debug log');
      assert.ok(responseLog.response, 'Should include response data in debug log');
    });
  });
});

describe('Schema Validation Utilities', () => {
  
  /**
   * These tests would validate helper functions for protocol schema compliance.
   * In a full implementation, you would create utilities to validate messages
   * against JSON schemas derived from the A2A and MCP specifications.
   */
  
  test('should validate A2A message schema compliance', () => {
    // This would test a utility function that validates A2A messages
    const validMessage = {
      message: {
        messageId: 'msg_123_abc',
        role: 'user',
        kind: 'message',
        parts: [{
          kind: 'data',
          data: {
            skill: 'test_skill',
            input: { param: 'value' }
          }
        }]
      }
    };
    
    // In real implementation: assert.ok(validateA2AMessageSchema(validMessage));
    assert.ok(validMessage.message.kind === 'message', 'Placeholder validation - should implement full schema validation');
  });

  test('should identify common A2A message format errors', () => {
    const invalidMessages = [
      // Missing kind field
      {
        message: {
          messageId: 'msg_123',
          role: 'user',
          parts: [{ kind: 'data', data: { skill: 'test', input: {} } }]
        }
      },
      // Using deprecated 'parameters' instead of 'input'
      {
        message: {
          messageId: 'msg_123',
          role: 'user',
          kind: 'message',
          parts: [{ kind: 'data', data: { skill: 'test', parameters: {} } }]
        }
      },
      // Invalid part kind
      {
        message: {
          messageId: 'msg_123',
          role: 'user',
          kind: 'message',
          parts: [{ kind: 'invalid', data: { skill: 'test', input: {} } }]
        }
      }
    ];
    
    // In real implementation, each should fail schema validation
    invalidMessages.forEach((msg, index) => {
      // Placeholder checks - replace with real schema validation
      if (index === 0) assert.strictEqual(msg.message.kind, undefined, 'Should detect missing kind');
      if (index === 1) assert.ok(msg.message.parts[0].data.parameters !== undefined, 'Should detect deprecated parameters field');
      if (index === 2) assert.strictEqual(msg.message.parts[0].kind, 'invalid', 'Should detect invalid part kind');
    });
  });
});

/**
 * Additional Test Categories to Implement:
 * 
 * 1. MCP Protocol Compliance Tests:
 *    - Similar structure for MCP message validation
 *    - Test MCP initialize, tool calls, notifications
 *    - Validate against MCP JSON-RPC schemas
 * 
 * 2. Cross-Protocol Consistency Tests:
 *    - Ensure similar operations produce expected results across A2A and MCP
 *    - Test error handling consistency
 * 
 * 3. Integration Contract Tests:
 *    - Test against protocol test servers/mocks
 *    - Validate end-to-end message round trips
 * 
 * 4. Performance and Load Tests:
 *    - Test message generation performance
 *    - Test concurrent protocol operations
 * 
 * 5. Security Tests:
 *    - Test authentication integration
 *    - Test parameter sanitization
 *    - Test against injection attacks
 */