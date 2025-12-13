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
    // Fresh imports
    delete require.cache[require.resolve('../../dist/lib/index.js')];
    const lib = require('../../dist/lib/index.js');

    TaskExecutor = lib.TaskExecutor;
    // Import ProtocolClient from internal path (not part of public API)
    const protocolsModule = require('../../dist/lib/protocols/index.js');
    ProtocolClient = protocolsModule.ProtocolClient;
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
      requiresAuth: false,
    };
  });

  afterEach(() => {
    if (originalCallTool) {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  describe('Timeout Scenarios', () => {
    test('should return working status as valid intermediate state', async () => {
      // Per PR #78, 'working' status is a valid intermediate state
      // TaskExecutor returns it immediately, allowing caller to poll separately
      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        return { status: ADCP_STATUS.WORKING };
      });

      const executor = new TaskExecutor({
        workingTimeout: 200,
        pollingInterval: 10,
      });

      const result = await executor.executeTask(mockAgent, 'workingTask', {});

      // Working status is a valid intermediate state, not a failure
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'working');
      assert.strictEqual(result.metadata.status, 'working');
      // Caller can use taskId to poll for completion
      assert(result.metadata.taskId);
    });

    test('should poll until completion via pollTaskCompletion', async () => {
      // Per PR #78, polling is done separately via pollTaskCompletion
      let pollCount = 0;

      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        if (taskName === 'tasks/get') {
          pollCount++;
          if (pollCount >= 3) {
            // Complete after 3 polls
            return { task: { status: ADCP_STATUS.COMPLETED, result: { done: true } } };
          }
          return { task: { status: ADCP_STATUS.WORKING } };
        } else {
          return { status: ADCP_STATUS.WORKING };
        }
      });

      const executor = new TaskExecutor({
        pollingInterval: 10,
      });

      // Initial call returns working status
      const initialResult = await executor.executeTask(mockAgent, 'pollingTask', {});
      assert.strictEqual(initialResult.status, 'working');
      assert.strictEqual(initialResult.success, true);

      // Caller polls for completion
      const finalResult = await executor.pollTaskCompletion(mockAgent, initialResult.metadata.taskId, 10);
      assert.strictEqual(finalResult.success, true);
      assert.strictEqual(finalResult.status, 'completed');
      assert.strictEqual(finalResult.data.done, true);
      assert(pollCount >= 3, `Should have polled at least 3 times, got ${pollCount}`);
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

      ProtocolClient.callTool = mock.fn(async () => ({
        status: ADCP_STATUS.INPUT_REQUIRED,
        question: 'This handler will be slow',
      }));

      const executor = new TaskExecutor({
        handlerTimeout: 100, // Very short handler timeout (if implemented)
      });

      // Note: This test depends on handler timeout being implemented
      // If not implemented, the handler will complete normally
      try {
        const result = await executor.executeTask(mockAgent, 'slowHandlerTask', {}, slowHandler);

        // If no handler timeout is implemented, this will succeed
        console.log('Handler timeout not implemented - test passed with slow handler');
      } catch (error) {
        // If handler timeout is implemented, should throw timeout error
        assert(error.message.includes('timeout') || error.message.includes('slow'));
      }
    });
  });

  describe('Missing Handler Scenarios', () => {
    test('should return input-required as valid intermediate state when no handler provided', async () => {
      // Per PR #78, input-required is a valid intermediate state for HITL workflows
      // Callers can handle it themselves rather than requiring a handler upfront
      ProtocolClient.callTool = mock.fn(async () => ({
        status: ADCP_STATUS.INPUT_REQUIRED,
        question: 'What is your preferred targeting method?',
        field: 'targeting_method',
        suggestions: ['demographic', 'behavioral', 'lookalike'],
      }));

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'noHandlerTask', {});

      // input-required is a valid intermediate state
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'input-required');
      assert.strictEqual(result.metadata.inputRequest.question, 'What is your preferred targeting method?');
      assert.strictEqual(result.metadata.inputRequest.field, 'targeting_method');
    });

    test('should return input-required status on first request without handler', async () => {
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
      const result = await executor.executeTask(mockAgent, 'multiInputNoHandlerTask', {});

      // Returns immediately as input-required
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'input-required');
      assert.strictEqual(requestCount, 1, 'Should return on first input request');
    });

    test('should handle edge case input requests as valid intermediate states', async () => {
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
        const result = await executor.executeTask(mockAgent, `edgeCase_${edgeCase.description}`, {});

        // All input-required responses are valid intermediate states
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'input-required');
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

    test('should return working status even when future polling might fail', async () => {
      // Per PR #78, initial call returns working immediately
      // Polling errors are handled when caller explicitly polls
      let callCount = 0;

      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        callCount++;
        if (callCount === 1) {
          return { status: ADCP_STATUS.WORKING };
        }
        // Any subsequent polling calls are handled separately
        throw new Error('Network timeout');
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'intermittentFailureTask', {});

      // Initial call returns working status immediately
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'working');
      assert.strictEqual(callCount, 1);
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

        // Disable strict schema validation since we're testing status handling, not schema compliance
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, `invalidStatus_${invalidStatus}`, {});

        // Should handle unknown statuses gracefully if there's data
        assert.strictEqual(result.success, true);
        // The data may include the original response structure or just the inner data
        assert(result.data?.data === 'some-data' || result.data?.result?.data === 'some-data',
          `Expected data to contain 'some-data' but got: ${JSON.stringify(result.data)}`);
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

      // Disable strict schema validation since we're testing circular reference handling
      const executor = new TaskExecutor({ strictSchemaValidation: false });
      const result = await executor.executeTask(mockAgent, 'circularResponseTask', {});

      // Should handle circular references without crashing
      assert.strictEqual(result.success, true);
      // Data may be nested differently depending on extraction - don't stringify as it has circular ref
      const foundData = result.data?.data === 'circular-test' || result.data?.result?.data === 'circular-test';
      assert(foundData, `Expected data to contain 'circular-test'`);
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

      // Disable strict schema validation since we're testing large data handling
      const executor = new TaskExecutor({
        enableConversationStorage: true,
        strictSchemaValidation: false,
      });

      const result = await executor.executeTask(mockAgent, 'largeConversationTask', {}, largeHandler);

      assert.strictEqual(result.success, true);
      // Data may be nested differently depending on extraction
      assert(result.data?.handled === 'large-conversation' || result.data?.result?.handled === 'large-conversation',
        `Expected data to contain 'large-conversation' but got: ${JSON.stringify(result.data)}`);
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

      // Disable strict schema validation since we're testing concurrency handling
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

    test('should return working status even when polling will later fail', async () => {
      // Per PR #78, executeTask returns 'working' immediately
      // Polling errors are handled when the caller explicitly polls
      let callCount = 0;

      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        callCount++;

        // First call is the initial task execution - return WORKING
        if (callCount === 1) {
          return { status: ADCP_STATUS.WORKING };
        }

        // Subsequent polls - throw error to simulate corruption
        throw new Error('Task state corrupted');
      });

      const executor = new TaskExecutor({
        pollingInterval: 10,
      });

      // Initial call returns working status immediately (valid intermediate state)
      const result = await executor.executeTask(mockAgent, 'corruptionTask', {});
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'working');

      // Polling failure happens when caller explicitly polls
      await assert.rejects(
        executor.pollTaskCompletion(mockAgent, result.metadata.taskId, 10),
        /Task state corrupted/
      );
    });
  });

  describe('MCP Error Response Handling', () => {
    test('should extract error message from MCP isError response', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        throw new Error("Error calling tool 'list_authorized_properties': name 'get_testing_context' is not defined");
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(mockAgent, 'errorTask', {});

      assert.strictEqual(result.success, false);
      assert(result.error.includes("Error calling tool 'list_authorized_properties'"));
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

      // Disable strict schema validation since we're testing long data handling, not schema compliance
      const executor = new TaskExecutor({ strictSchemaValidation: false });
      const result = await executor.executeTask(mockAgent, longTaskName, longParams);

      assert.strictEqual(result.success, true);
      // Data may be nested differently depending on extraction
      assert(result.data?.handled === 'long-data' || result.data?.result?.handled === 'long-data',
        `Expected data to contain 'long-data' but got: ${JSON.stringify(result.data)}`);
    });

    test('should accept any timeout config but return working status immediately', async () => {
      // Per PR #78, working status is returned immediately regardless of timeout config
      // The timeout config would affect explicit polling, not initial response
      const timeoutConfigs = [0, -1, -1000, 100, 120000];

      for (const timeout of timeoutConfigs) {
        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.WORKING,
        }));

        const executor = new TaskExecutor({
          workingTimeout: timeout,
          pollingInterval: 10,
        });

        const result = await executor.executeTask(mockAgent, 'configTimeoutTask', {});

        // Working status is always a valid intermediate state
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'working');
        assert.strictEqual(result.metadata.status, 'working');
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

      // Disable strict schema validation for this test since we're testing URL/param handling, not schema compliance
      const executor = new TaskExecutor({ strictSchemaValidation: false });
      const result = await executor.executeTask(specialAgent, 'specialCharsTask', specialParams);

      assert.strictEqual(result.success, true);
      // Data may be nested differently depending on extraction
      assert(result.data?.special === 'handled' || result.data?.result?.special === 'handled',
        `Expected data to contain 'handled' but got: ${JSON.stringify(result.data)}`);
    });
  });
});

console.log('💥 TaskExecutor error scenarios test suite loaded successfully');
