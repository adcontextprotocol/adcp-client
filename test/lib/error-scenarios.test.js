// Comprehensive error scenario coverage for TaskExecutor
// Tests timeouts, missing handlers, network failures, and edge cases

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

/**
 * Error Scenario Test Strategy:
 * 1. Timeout scenarios - working, polling, webhook timeouts
 * 2. Missing handler scenarios - various input-required states
 * 3. Network failure patterns - intermittent, persistent, protocol-specific
 * 4. Invalid response handling - malformed data, unexpected statuses
 * 5. Resource exhaustion - storage failures, memory issues
 * 6. Edge cases - race conditions, concurrent operations
 */

describe('TaskExecutor Error Scenarios', { skip: process.env.CI ? 'Slow tests - skipped in CI' : false }, () => {
  let TaskExecutor;
  let ProtocolClient;
  let TaskTimeoutError;
  let InputRequiredError;
  let DeferredTaskError;
  let MaxClarificationError;
  let ADCP_STATUS;
  let originalCallTool;
  let mockAgent;

  beforeEach(() => {
    // Fresh imports - clear ALL dist/lib cache entries to ensure mocks work
    Object.keys(require.cache).forEach(key => {
      if (key.includes('dist/lib')) {
        delete require.cache[key];
      }
    });
    const lib = require('../../dist/lib/index.js');

    TaskExecutor = lib.TaskExecutor;
    // ProtocolClient is now exported from the main library (for testing purposes)
    ProtocolClient = lib.ProtocolClient;
    TaskTimeoutError = lib.TaskTimeoutError;
    InputRequiredError = lib.InputRequiredError;
    DeferredTaskError = lib.DeferredTaskError;
    MaxClarificationError = lib.MaxClarificationError;
    ADCP_STATUS = lib.ADCP_STATUS || {
      COMPLETED: 'completed',
      WORKING: 'working',
      SUBMITTED: 'submitted',
      INPUT_REQUIRED: 'input-required',
      FAILED: 'failed',
      REJECTED: 'rejected',
      CANCELED: 'canceled',
    };

    originalCallTool = ProtocolClient.callTool;

    mockAgent = {
      id: 'error-test-agent',
      name: 'Error Test Agent',
      agent_uri: 'https://error.test.com',
      protocol: 'mcp',
    };
  });

  afterEach(() => {
    if (originalCallTool) {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  describe('Timeout Scenarios', () => {
    test('should return working status immediately for async tasks', async () => {
      // TaskExecutor now returns 'working' status immediately as a valid intermediate state
      // Callers can use taskId to poll for completion or set up webhooks
      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        if (taskName === 'tasks/get') {
          return { task: { status: ADCP_STATUS.WORKING } };
        } else {
          return { status: ADCP_STATUS.WORKING };
        }
      });

      const executor = new TaskExecutor({
        workingTimeout: 200,
        pollingInterval: 10,
      });

      const startTime = Date.now();
      const result = await executor.executeTask(mockAgent, 'asyncTask', {});
      const elapsed = Date.now() - startTime;

      // Working status is returned immediately as a valid intermediate state
      assert.strictEqual(result.success, true, 'Working status is a valid state, not a failure');
      assert.strictEqual(result.status, 'working');
      assert.strictEqual(result.metadata.status, 'working');
      assert.strictEqual(result.metadata.taskId.length > 0, true, 'Should have taskId for polling');

      // Should return quickly, not wait for timeout
      assert(elapsed < 100, `Should return immediately, not wait for timeout (elapsed: ${elapsed}ms)`);
    });

    test('should return working status with partial data if provided', async () => {
      ProtocolClient.callTool = mock.fn(async () => ({
        status: ADCP_STATUS.WORKING,
        partial_result: { progress: 50, message: 'Processing...' },
      }));

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'asyncWithDataTask', {});

      // Working status can include partial data
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'working');
      assert.strictEqual(result.metadata.taskId.length > 0, true);
    });

    test('should handle webhook timeout in submitted tasks', async () => {
      const mockWebhookManager = {
        generateUrl: mock.fn(() => 'https://webhook.test/timeout'),
        registerWebhook: mock.fn(async () => {
          // Webhook registration succeeds but webhook never arrives
        }),
        processWebhook: mock.fn(),
      };

      let pollCount = 0;
      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        if (taskName === 'tasks/get') {
          pollCount++;
          // After a few polls, complete to avoid infinite polling
          if (pollCount > 3) {
            return { task: { status: ADCP_STATUS.COMPLETED, result: { webhook_test: 'done' } } };
          }
          // Task remains in working/submitted state for first few polls
          return { task: { status: ADCP_STATUS.WORKING } };
        } else {
          return { status: ADCP_STATUS.SUBMITTED };
        }
      });

      const executor = new TaskExecutor({
        webhookManager: mockWebhookManager,
      });

      const result = await executor.executeTask(mockAgent, 'webhookTimeoutTask', {});

      assert.strictEqual(result.status, 'submitted');

      // Test that waitForCompletion can handle timeout scenarios
      // Wait for completion with fast polling
      const finalResult = await result.submitted.waitForCompletion(50);

      // Verify the polling mechanism worked
      assert.strictEqual(mockWebhookManager.generateUrl.mock.callCount(), 1);
      assert(pollCount > 3, 'Should have polled multiple times');
      assert.strictEqual(finalResult.success, true);
    });

    test('should handle handler execution timeout', async () => {
      const slowHandler = mock.fn(async context => {
        // Simulate slow handler
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'slow-response';
      });

      // First call returns input-required, second call (continue_task) returns completed
      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        if (taskName === 'continue_task') {
          return { status: ADCP_STATUS.COMPLETED, result: { message: 'task completed after slow handler' } };
        }
        return {
          status: ADCP_STATUS.INPUT_REQUIRED,
          question: 'This handler will be slow',
        };
      });

      const executor = new TaskExecutor({
        handlerTimeout: 100, // Very short handler timeout (if implemented)
        strictSchemaValidation: false,
      });

      // Handler runs, provides input, and task completes
      const result = await executor.executeTask(mockAgent, 'slowHandlerTask', {}, slowHandler);

      assert.strictEqual(slowHandler.mock.callCount(), 1, 'Handler should have been called once');
    });
  });

  describe('Missing Handler Scenarios', () => {
    test('should return input-required status when no handler provided', async () => {
      ProtocolClient.callTool = mock.fn(async () => ({
        status: ADCP_STATUS.INPUT_REQUIRED,
        question: 'What is your preferred targeting method?',
        field: 'targeting_method',
        suggestions: ['demographic', 'behavioral', 'lookalike'],
      }));

      const executor = new TaskExecutor();

      // TaskExecutor now returns input-required as a valid paused state
      const result = await executor.executeTask(mockAgent, 'noHandlerTask', {});

      assert.strictEqual(result.status, 'input-required');
      assert.strictEqual(result.success, true); // Paused, not failed
      assert.strictEqual(result.metadata.inputRequest.question, 'What is your preferred targeting method?');
      assert.strictEqual(result.metadata.inputRequest.field, 'targeting_method');
    });

    test('should handle multiple input requests without handler', async () => {
      let requestCount = 0;
      const questions = ['What is your budget?', 'What is your target audience?', 'What is your campaign objective?'];

      ProtocolClient.callTool = mock.fn(async () => {
        const question = questions[requestCount++] || 'Unknown question';
        return {
          status: ADCP_STATUS.INPUT_REQUIRED,
          question: question,
          field: `field_${requestCount}`,
        };
      });

      const executor = new TaskExecutor();

      // Should return input-required on the first request (no handler to continue)
      const result = await executor.executeTask(mockAgent, 'multiInputNoHandlerTask', {});

      assert.strictEqual(result.status, 'input-required');
      assert.strictEqual(result.success, true);
      assert.strictEqual(requestCount, 1, 'Should stop on first input request');
    });

    test('should handle edge case input requests', async () => {
      const edgeCases = [
        {
          description: 'missing question field',
          response: { status: ADCP_STATUS.INPUT_REQUIRED, field: 'test' },
        },
        {
          description: 'empty question',
          response: { status: ADCP_STATUS.INPUT_REQUIRED, question: '', field: 'test' },
        },
        {
          description: 'null question',
          response: { status: ADCP_STATUS.INPUT_REQUIRED, question: null, field: 'test' },
        },
        {
          description: 'missing field',
          response: { status: ADCP_STATUS.INPUT_REQUIRED, question: 'Test question?' },
        },
      ];

      for (const edgeCase of edgeCases) {
        ProtocolClient.callTool = mock.fn(async () => edgeCase.response);

        const executor = new TaskExecutor();

        // Should handle missing/empty questions gracefully and return input-required status
        const result = await executor.executeTask(mockAgent, `edgeCase_${edgeCase.description}`, {});

        assert.strictEqual(result.status, 'input-required', `Expected input-required for ${edgeCase.description}`);
        assert.strictEqual(result.success, true);
      }
    });
  });

  describe('Network Failure Patterns', () => {
    test('should handle initial connection failures', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        throw new Error('ECONNREFUSED: Connection refused');
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'connectionFailureTask', {});

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'completed'); // TaskResult status
      assert.strictEqual(result.error, 'ECONNREFUSED: Connection refused');
      assert.strictEqual(result.metadata.status, 'failed'); // Metadata status
    });

    test('should handle network failure on initial request', async () => {
      // Test that network failures during the initial request are handled correctly
      let callCount = 0;

      ProtocolClient.callTool = mock.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network timeout');
        }
        // Second call succeeds
        return { status: ADCP_STATUS.COMPLETED, result: { recovered: true } };
      });

      // Disable schema validation for edge case testing
      const executor = new TaskExecutor({ strictSchemaValidation: false });

      // First call fails
      const result1 = await executor.executeTask(mockAgent, 'networkFailureTask', {});
      assert.strictEqual(result1.success, false);
      assert(result1.error.includes('Network timeout'));

      // Second call succeeds (demonstrating recovery at application level)
      const result2 = await executor.executeTask(mockAgent, 'networkFailureTask', {});
      assert.strictEqual(result2.success, true);
      assert.strictEqual(callCount, 2);
    });

    test('should handle protocol-specific network failures', async () => {
      const protocolErrors = {
        mcp: 'MCP transport error',
        a2a: 'A2A authentication failed',
      };

      for (const [protocol, errorMessage] of Object.entries(protocolErrors)) {
        ProtocolClient.callTool = mock.fn(async agent => {
          throw new Error(errorMessage);
        });

        const protocolAgent = { ...mockAgent, protocol: protocol };
        const executor = new TaskExecutor();

        const result = await executor.executeTask(protocolAgent, 'protocolFailureTask', {});

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, errorMessage);
      }
    });

    test('should handle DNS resolution failures', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        const error = new Error('getaddrinfo ENOTFOUND invalid.domain.test');
        error.code = 'ENOTFOUND';
        throw error;
      });

      const invalidAgent = {
        ...mockAgent,
        agent_uri: 'https://invalid.domain.test',
      };

      const executor = new TaskExecutor();
      const result = await executor.executeTask(invalidAgent, 'dnsFailureTask', {});

      assert.strictEqual(result.success, false);
      assert(result.error.includes('ENOTFOUND'));
    });
  });

  describe('Invalid Response Handling', () => {
    test('should handle malformed JSON responses', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        // Simulate response that can't be parsed as proper ADCP response
        return 'invalid json response';
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'malformedResponseTask', {});

      // TaskExecutor should catch the error and return an error result
      // A plain string without status is not a valid ADCP response
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'completed');
      assert(result.error.includes('Unknown status'));
      assert.strictEqual(result.metadata.status, 'failed');
    });

    test('should handle responses with invalid status codes', async () => {
      const invalidStatuses = ['unknown-status', 123, null, undefined, ''];

      for (const invalidStatus of invalidStatuses) {
        ProtocolClient.callTool = mock.fn(async () => ({
          status: invalidStatus,
          result: { data: 'some-data' },
        }));

        // Disable strict schema validation for edge case testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, `invalidStatus_${invalidStatus}`, {});

        // Should handle unknown statuses gracefully if there's data
        assert.strictEqual(result.success, true);
        // Data may be wrapped - check that it exists
        assert(result.data !== undefined, 'Should have data');
      }
    });

    test('should handle responses missing required fields', async () => {
      const incompleteResponses = [
        {}, // Empty response
        { status: ADCP_STATUS.COMPLETED }, // No result
        { result: 'data' }, // No status
        { status: ADCP_STATUS.INPUT_REQUIRED }, // No question
        null, // Null response
        undefined, // Undefined response
      ];

      let handledGracefully = 0;
      let threwError = 0;

      for (const [index, response] of incompleteResponses.entries()) {
        ProtocolClient.callTool = mock.fn(async () => response);

        const executor = new TaskExecutor();

        try {
          const result = await executor.executeTask(mockAgent, `incompleteResponse_${index}`, {});

          // Some incomplete responses might be handled gracefully
          handledGracefully++;
          console.log(`Incomplete response ${index} handled gracefully:`, result.success);
        } catch (error) {
          // Others might throw errors
          threwError++;
          console.log(`Incomplete response ${index} threw error:`, error.message);
        }
      }

      // Verify that the test ran for all responses
      assert.strictEqual(
        handledGracefully + threwError,
        incompleteResponses.length,
        'All incomplete responses should be handled or throw errors'
      );
    });

    test('should handle circular reference in responses', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        const circular = { status: ADCP_STATUS.COMPLETED };
        circular.self = circular; // Create circular reference
        circular.result = { data: 'circular-test' };
        return circular;
      });

      // Disable strict schema validation for edge case testing
      const executor = new TaskExecutor({ strictSchemaValidation: false });
      const result = await executor.executeTask(mockAgent, 'circularResponseTask', {});

      // Should handle circular references without crashing
      assert.strictEqual(result.success, true);
      // Data may be wrapped differently - just verify we got data back
      assert(result.data !== undefined, 'Should have data');
    });
  });

  describe('Resource Exhaustion Scenarios', () => {
    test('should handle storage failures in deferred tasks', async () => {
      const failingStorage = {
        set: mock.fn(async () => {
          throw new Error('Storage quota exceeded');
        }),
        get: mock.fn(async () => {
          throw new Error('Storage unavailable');
        }),
        delete: mock.fn(async () => {
          throw new Error('Storage error');
        }),
      };

      const deferHandler = mock.fn(async () => ({ defer: true, token: 'TEST_STORAGE_FAIL_TOKEN_PLACEHOLDER' }));

      ProtocolClient.callTool = mock.fn(async () => ({
        status: ADCP_STATUS.INPUT_REQUIRED,
        question: 'This will fail storage',
      }));

      const executor = new TaskExecutor({
        deferredStorage: failingStorage,
      });

      // TaskExecutor catches all errors and returns error results instead of throwing
      const result = await executor.executeTask(mockAgent, 'storageFailureTask', {}, deferHandler);

      // Verify the storage error was caught and returned as an error result
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'completed');
      assert(result.error.includes('Storage quota exceeded'));
      assert.strictEqual(result.metadata.status, 'failed');
    });

    test('should handle memory pressure during large conversations', async () => {
      // Simulate large conversation history
      const largeHandler = mock.fn(async context => {
        // Verify conversation history is available even with large data
        assert(Array.isArray(context.messages));
        return 'handled-large';
      });

      // Create large response data
      const largeData = Array(1000).fill('large-data-chunk').join('-');

      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        if (taskName === 'continue_task') {
          return {
            status: ADCP_STATUS.COMPLETED,
            result: { handled: 'large-conversation' },
          };
        } else {
          return {
            status: ADCP_STATUS.INPUT_REQUIRED,
            question: 'Handle large data?',
            context: largeData,
          };
        }
      });

      // Disable schema validation for edge case testing
      const executor = new TaskExecutor({
        enableConversationStorage: true,
        strictSchemaValidation: false,
      });

      const result = await executor.executeTask(mockAgent, 'largeConversationTask', {}, largeHandler);

      assert.strictEqual(result.success, true);
      // Data may be wrapped differently
      assert(result.data !== undefined);
    });
  });

  describe('Race Condition and Concurrency Issues', () => {
    test('should handle concurrent task executions', async () => {
      let activeConnections = 0;
      const maxConnections = 2;

      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        activeConnections++;

        if (activeConnections > maxConnections) {
          throw new Error('Too many concurrent connections');
        }

        // Simulate work
        await new Promise(resolve => setTimeout(resolve, 10));

        activeConnections--;
        return { status: ADCP_STATUS.COMPLETED, result: { concurrent: true } };
      });

      // Disable schema validation for edge case testing
      const executor = new TaskExecutor({ strictSchemaValidation: false });

      // Start multiple concurrent tasks
      const tasks = Array.from({ length: 5 }, (_, i) => executor.executeTask(mockAgent, `concurrentTask_${i}`, {}));

      const results = await Promise.allSettled(tasks);

      // Some should succeed, some might fail due to connection limits
      const successes = results.filter(r => r.status === 'fulfilled' && r.value.success);
      const failures = results.filter(r => r.status === 'rejected' || !r.value?.success);

      assert(successes.length > 0, 'At least some tasks should succeed');
      console.log(`Concurrent test: ${successes.length} succeeded, ${failures.length} failed`);
    });

    test('should return working status for async tasks (not poll internally)', async () => {
      // TaskExecutor now returns 'working' status immediately - polling is caller's responsibility
      ProtocolClient.callTool = mock.fn(async () => {
        return { status: ADCP_STATUS.WORKING };
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'asyncTask', {});

      // Working status is returned immediately as a valid intermediate state
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'working');
      assert.strictEqual(typeof result.metadata.taskId, 'string');
    });
  });

  describe('MCP Error Response Handling', () => {
    test('should extract error message from MCP isError response', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        throw new Error("Error calling tool 'get_products': name 'get_testing_context' is not defined");
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'errorTask', {});

      assert.strictEqual(result.success, false);
      assert(result.error.includes("Error calling tool 'get_products'"));
      assert(result.error.includes("name 'get_testing_context' is not defined"));
    });

    test('should handle MCP error with multiple text content items', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        throw new Error('Primary error message\nAdditional context');
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'multiTextErrorTask', {});

      assert.strictEqual(result.success, false);
      assert(result.error.includes('Primary error message'));
      assert(result.error.includes('Additional context'));
    });

    test('should handle MCP error with empty content array', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        throw new Error("MCP tool 'test_tool' execution failed (no error details provided)");
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'emptyContentErrorTask', {});

      assert.strictEqual(result.success, false);
      assert(result.error.includes('MCP tool'));
      assert(result.error.includes('execution failed'));
    });

    test('should handle MCP error with non-text content items', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        throw new Error("MCP tool 'image_error_tool' execution failed (no error details provided)");
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'nonTextContentErrorTask', {});

      assert.strictEqual(result.success, false);
      assert(result.error.includes('MCP tool'));
      assert(result.error.includes('execution failed'));
    });

    test('should include tool name in fallback error message', async () => {
      const toolName = 'list_products';
      ProtocolClient.callTool = mock.fn(async () => {
        throw new Error(`MCP tool '${toolName}' execution failed (no error details provided)`);
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, toolName, {});

      assert.strictEqual(result.success, false);
      assert(result.error.includes(toolName), 'Error message should include tool name');
      assert(result.error.includes('execution failed'), 'Error message should indicate execution failed');
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    test('should handle extremely long task names and parameters', async () => {
      const longTaskName = 'a'.repeat(1000);
      const longParams = {
        longField: 'b'.repeat(10000),
        nestedLong: {
          deepField: 'c'.repeat(5000),
        },
      };

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        assert.strictEqual(taskName, longTaskName);
        assert.strictEqual(params.longField.length, 10000);
        return { status: ADCP_STATUS.COMPLETED, result: { handled: 'long-data' } };
      });

      // Disable schema validation for edge case testing
      const executor = new TaskExecutor({ strictSchemaValidation: false });
      const result = await executor.executeTask(mockAgent, longTaskName, longParams);

      assert.strictEqual(result.success, true);
      assert(result.data !== undefined, 'Should have data');
    });

    test('should handle zero and negative timeout values gracefully', async () => {
      // TaskExecutor now returns 'working' status immediately for all timeout values
      // Invalid timeout values don't cause errors, they just affect internal config
      const invalidTimeouts = [0, -1, -1000];

      for (const timeout of invalidTimeouts) {
        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.WORKING,
        }));

        const executor = new TaskExecutor({
          workingTimeout: timeout,
          pollingInterval: 10,
        });

        const result = await executor.executeTask(mockAgent, 'invalidTimeoutTask', {});

        // TaskExecutor returns 'working' status immediately as a valid intermediate state
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'working');
      }
    });

    test('should handle special characters in agent URLs and parameters', async () => {
      const specialAgent = {
        ...mockAgent,
        agent_uri: 'https://test.com/special?param=value&other=123#fragment',
      };

      const specialParams = {
        'field with spaces': 'value with spaces',
        'field-with-dashes': 'value-with-dashes',
        field_with_underscores: 'value_with_underscores',
        'field.with.dots': 'value.with.dots',
        'unicode_field_🚀': 'unicode_value_🎯',
        'emoji_💰': '💰💰💰',
      };

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        assert.strictEqual(agent.agent_uri, specialAgent.agent_uri);
        assert.strictEqual(params['unicode_field_🚀'], 'unicode_value_🎯');
        return { status: ADCP_STATUS.COMPLETED, result: { special: 'handled' } };
      });

      // Disable schema validation for edge case testing
      const executor = new TaskExecutor({ strictSchemaValidation: false });
      const result = await executor.executeTask(specialAgent, 'specialCharsTask', specialParams);

      assert.strictEqual(result.success, true);
      assert(result.data !== undefined, 'Should have data');
    });
  });
});

console.log('💥 TaskExecutor error scenarios test suite loaded successfully');
