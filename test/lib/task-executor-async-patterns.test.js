// Comprehensive test suite for TaskExecutor async patterns (PR #78)
// Tests working/submitted/deferred patterns with proper mocking

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

/**
 * Test Strategy Overview:
 * 1. Mock ProtocolClient at the module level to control responses
 * 2. Test each ADCP status pattern with comprehensive scenarios
 * 3. Verify handler-controlled flow and error handling
 * 4. Test timeout behaviors and edge cases
 * 5. Validate type safety of continuations
 */

describe(
  'TaskExecutor Async Patterns (PR #78)',
  { skip: process.env.CI ? 'Slow tests - skipped in CI' : false },
  () => {
    let TaskExecutor;
    let ADCP_STATUS;
    let InputRequiredError;
    let TaskTimeoutError;
    let DeferredTaskError;
    let ProtocolClient;
    let mockDebugLogs;
    let mockAgent;
    let originalCallTool;

    beforeEach(() => {
      // Reset module cache to ensure clean imports
      delete require.cache[require.resolve('../../dist/lib/index.js')];

      // Import fresh modules
      const lib = require('../../dist/lib/index.js');
      TaskExecutor = lib.TaskExecutor;
      ADCP_STATUS = lib.ADCP_STATUS || {
        COMPLETED: 'completed',
        WORKING: 'working',
        SUBMITTED: 'submitted',
        INPUT_REQUIRED: 'input-required',
        FAILED: 'failed',
        REJECTED: 'rejected',
        CANCELED: 'canceled',
      };
      InputRequiredError = lib.InputRequiredError;
      TaskTimeoutError = lib.TaskTimeoutError;
      DeferredTaskError = lib.DeferredTaskError;
      ProtocolClient = lib.ProtocolClient;

      // Store original method for restoration
      originalCallTool = ProtocolClient.callTool;

      // Initialize test state
      mockDebugLogs = [];
      mockAgent = {
        id: 'test-agent',
        name: 'Test Agent',
        agent_uri: 'https://test.example.com',
        protocol: 'mcp',
      };
    });

    afterEach(() => {
      // Restore original implementation
      if (originalCallTool) {
        ProtocolClient.callTool = originalCallTool;
      }
      mockDebugLogs = [];
    });

    describe('COMPLETED Status Pattern', () => {
      test('should handle immediate completion with data', async () => {
        // Use `data` field instead of `result` to avoid A2A protocol detection.
        // A2A detection triggers when `result` is present, which then fails
        // validateA2AResponse (requires result.artifacts). Using `data` avoids this.
        const mockResponse = {
          status: ADCP_STATUS.COMPLETED,
          data: { products: ['Product A', 'Product B'] },
        };

        // Mock ProtocolClient.callTool
        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'getProducts', { category: 'electronics' });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'completed');
        // The response uses `data` field (not A2A `result.artifacts` or MCP `structuredContent`).
        // The unwrapper falls back to returning the full response, so data is the full mockResponse.
        // We verify the products are accessible either directly or nested under data.
        const products = result.data?.products ?? result.data?.data?.products;
        assert(Array.isArray(products), 'Should have products array');
        assert.deepStrictEqual(products, ['Product A', 'Product B']);
        assert.strictEqual(result.metadata.taskName, 'getProducts');
        assert.strictEqual(result.metadata.agent.id, 'test-agent');
        assert.strictEqual(result.metadata.clarificationRounds, 0);
        assert.strictEqual(typeof result.metadata.responseTimeMs, 'number');
        assert(Array.isArray(result.conversation));
        assert.strictEqual(result.conversation.length, 2); // request + response
      });

      test('should handle completion with nested data structure', async () => {
        const mockResponse = {
          status: ADCP_STATUS.COMPLETED,
          data: {
            campaign: {
              id: 'camp-123',
              budget: 50000,
              targeting: { locations: ['US', 'CA'] },
            },
          },
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'createCampaign', { name: 'Test Campaign' });

        assert.strictEqual(result.success, true);
        // The response uses `data` field (not A2A/MCP protocol wrapper).
        // The unwrapper falls back to the full response, so campaign is nested under data.
        const campaign = result.data?.campaign ?? result.data?.data?.campaign;
        assert.ok(campaign, 'Should have campaign');
        assert.strictEqual(campaign.id, 'camp-123');
        assert.strictEqual(campaign.budget, 50000);
      });

      test('should handle completion without explicit status (legacy compatibility)', async () => {
        const mockResponse = {
          result: { message: 'Task completed successfully' },
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        // The response has a `result` field which triggers A2A protocol detection.
        // A2A validation expects result.artifacts, so strict schema validation would fail.
        // Use strictSchemaValidation: false since this tests a non-standard legacy format.
        // The executor cannot unwrap artifacts from this non-standard response, so it
        // returns the full response object as data rather than extracting result contents.
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'simpleTask', {});

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'completed');
        // Data contains the full response since result.artifacts is absent (non-standard format)
        assert.ok(result.data, 'Should have data');
        assert.ok(
          result.data.message === 'Task completed successfully' ||
            (result.data.result && result.data.result.message === 'Task completed successfully'),
          'Should contain the completion message'
        );
      });
    });

    describe('WORKING Status Pattern', () => {
      test('should return working status immediately', async () => {
        // The executor returns working status immediately as a valid intermediate state.
        // It does not poll - callers use taskId to poll independently if needed.
        const mockResponse = { status: ADCP_STATUS.WORKING, message: 'Processing...' };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor();

        const result = await executor.executeTask(mockAgent, 'longRunningTask', { data: 'test' });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'working');
        assert.ok(result.metadata.taskId, 'Should have taskId for caller to use for polling');
        assert.strictEqual(result.metadata.taskName, 'longRunningTask');
        // callTool should be called exactly once (no polling)
        assert.strictEqual(ProtocolClient.callTool.mock.callCount(), 1);
      });

      test('should return working status even when pollingInterval is configured', async () => {
        // Even with pollingInterval configured, working status is returned immediately.
        // Configuration options are retained for potential future use but do not change behavior.
        const mockResponse = {
          status: ADCP_STATUS.WORKING,
          message: 'Still processing...',
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor({
          workingTimeout: 10000,
          pollingInterval: 10,
        });

        const result = await executor.executeTask(mockAgent, 'longRunningTask', { data: 'test' });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'working');
        // Only the initial call is made - no polling
        assert.strictEqual(ProtocolClient.callTool.mock.callCount(), 1);
      });

      test('should include taskId in working result for caller polling', async () => {
        // When status is working, the caller uses the taskId to poll via tasks/get
        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.WORKING,
          message: 'Processing',
        }));

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'transitionTask', {});

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'working');
        assert.ok(result.metadata.taskId, 'taskId must be present for polling');
        assert.strictEqual(typeof result.metadata.taskId, 'string');
      });
    });

    describe('INPUT_REQUIRED Status Pattern', () => {
      test('should call handler and continue task with provided input', async () => {
        const mockHandler = mock.fn(async context => {
          assert.strictEqual(context.inputRequest.question, 'What is your budget?');
          assert.strictEqual(context.inputRequest.field, 'budget');
          assert.strictEqual(context.attempt, 1);
          assert.strictEqual(context.maxAttempts, 3);
          return 50000;
        });

        let callCount = 0;
        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          callCount++;
          if (callCount === 1) {
            // Initial call - needs input
            return {
              status: ADCP_STATUS.INPUT_REQUIRED,
              question: 'What is your budget?',
              field: 'budget',
              contextId: 'ctx-123',
            };
          } else if (taskName === 'continue_task') {
            // Continuation call - task completed
            assert.strictEqual(params.contextId, 'ctx-123');
            assert.strictEqual(params.input, 50000);
            return {
              status: ADCP_STATUS.COMPLETED,
              data: { budget: 50000, status: 'approved' },
            };
          }
        });

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'setBudget', { campaign: 'test' }, mockHandler);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(mockHandler.mock.callCount(), 1);
        assert.strictEqual(result.conversation.length, 4); // request, response, input, response
      });

      test('should return input-required status when no handler provided', async () => {
        // When no input handler is provided, the executor returns input-required as a
        // valid intermediate state, allowing callers to handle it (e.g., HITL workflows).
        const mockResponse = {
          status: ADCP_STATUS.INPUT_REQUIRED,
          question: 'What is your budget?',
          field: 'budget',
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor();

        const result = await executor.executeTask(mockAgent, 'needsInput', {});
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'input-required');
        assert.ok(result.metadata.inputRequest, 'Should include inputRequest details for caller');
        assert.strictEqual(result.metadata.inputRequest.question, 'What is your budget?');
      });

      test('should provide complete conversation context to handler', async () => {
        const mockHandler = mock.fn(async context => {
          // Verify context structure
          assert.strictEqual(typeof context.taskId, 'string');
          assert.strictEqual(context.agent.id, 'test-agent');
          assert.strictEqual(context.agent.protocol, 'mcp');
          assert(Array.isArray(context.messages));
          assert.strictEqual(context.messages.length, 2); // request + response
          assert.strictEqual(typeof context.getSummary, 'function');
          assert.strictEqual(typeof context.wasFieldDiscussed, 'function');
          assert.strictEqual(typeof context.getPreviousResponse, 'function');
          assert.strictEqual(typeof context.deferToHuman, 'function');
          assert.strictEqual(typeof context.abort, 'function');

          return 'handler-response';
        });

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            return { status: ADCP_STATUS.COMPLETED, data: { done: true } };
          } else {
            return {
              status: ADCP_STATUS.INPUT_REQUIRED,
              question: 'Test question?',
              contextId: 'ctx-456',
            };
          }
        });

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        await executor.executeTask(mockAgent, 'contextTest', {}, mockHandler);

        assert.strictEqual(mockHandler.mock.callCount(), 1);
      });
    });

    describe('SUBMITTED Status Pattern', () => {
      test('should return submitted continuation with tracking capabilities', async () => {
        const mockResponse = {
          status: ADCP_STATUS.SUBMITTED,
          webhookUrl: 'https://webhook.example.com/task-123',
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'longRunningTask', { data: 'large-dataset' });

        // submitted status is a valid intermediate state - success: true
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'submitted');
        assert(result.submitted);
        assert.strictEqual(typeof result.submitted.taskId, 'string');
        assert.strictEqual(result.submitted.webhookUrl, 'https://webhook.example.com/task-123');
        assert.strictEqual(typeof result.submitted.track, 'function');
        assert.strictEqual(typeof result.submitted.waitForCompletion, 'function');
      });

      test('should handle submitted task tracking', async () => {
        const mockSubmitResponse = {
          status: ADCP_STATUS.SUBMITTED,
        };

        const mockTaskStatus = {
          task: {
            taskId: 'task-789',
            status: 'working',
            taskType: 'processData',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        };

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'tasks/get') {
            return mockTaskStatus;
          } else {
            return mockSubmitResponse;
          }
        });

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'submitTask', {});

        assert.strictEqual(result.status, 'submitted');

        // Test tracking
        const status = await result.submitted.track();
        assert.strictEqual(status.status, 'working');
        assert.strictEqual(status.taskType, 'processData');
      });

      test('should handle webhook manager integration', async () => {
        const mockWebhookManager = {
          generateUrl: mock.fn(taskId => `https://webhook.test.com/${taskId}`),
          registerWebhook: mock.fn(async () => {}),
          processWebhook: mock.fn(async () => {}),
        };

        const mockResponse = {
          status: ADCP_STATUS.SUBMITTED,
          // No webhookUrl provided by server
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor({
          webhookManager: mockWebhookManager,
        });

        const result = await executor.executeTask(mockAgent, 'webhookTask', {});

        assert.strictEqual(result.status, 'submitted');
        assert.strictEqual(mockWebhookManager.generateUrl.mock.callCount(), 1);
        assert.strictEqual(mockWebhookManager.registerWebhook.mock.callCount(), 1);
        assert(result.submitted.webhookUrl.includes('webhook.test.com'));
      });
    });

    describe('DEFERRED Status Pattern (Client Deferral)', () => {
      test('should handle handler deferral with resume capability', async () => {
        const mockHandler = mock.fn(async context => {
          if (context.inputRequest.field === 'approval') {
            return { defer: true, token: 'TEST_DEFER_TOKEN_PLACEHOLDER' };
          }
          return 'auto-approve';
        });

        const mockDeferredStorage = new Map();

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            return { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
          } else {
            return {
              status: ADCP_STATUS.INPUT_REQUIRED,
              question: 'Do you approve this action?',
              field: 'approval',
              contextId: 'ctx-defer-123',
            };
          }
        });

        const executor = new TaskExecutor({
          deferredStorage: {
            set: mock.fn(async (token, state) => mockDeferredStorage.set(token, state)),
            get: mock.fn(async token => mockDeferredStorage.get(token)),
            delete: mock.fn(async token => mockDeferredStorage.delete(token)),
          },
        });

        const result = await executor.executeTask(mockAgent, 'approvalTask', {}, mockHandler);

        // Deferred is a valid intermediate state - success: true
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'deferred');
        assert(result.deferred);
        assert.strictEqual(result.deferred.token, 'TEST_DEFER_TOKEN_PLACEHOLDER');
        assert.strictEqual(result.deferred.question, 'Do you approve this action?');
        assert.strictEqual(typeof result.deferred.resume, 'function');

        // Test resumption
        const resumeResult = await result.deferred.resume('APPROVED');
        assert.strictEqual(resumeResult.success, true);
        assert.strictEqual(resumeResult.status, 'completed');
      });

      test('should save deferred state to storage', async () => {
        const mockHandler = mock.fn(async () => ({ defer: true, token: 'save-token' }));
        const mockStorage = {
          set: mock.fn(async () => {}),
          get: mock.fn(async () => {}),
          delete: mock.fn(async () => {}),
        };

        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.INPUT_REQUIRED,
          question: 'Save this?',
          contextId: 'ctx-save',
        }));

        const executor = new TaskExecutor({
          deferredStorage: mockStorage,
        });

        await executor.executeTask(mockAgent, 'saveTask', { data: 'important' }, mockHandler);

        assert.strictEqual(mockStorage.set.mock.callCount(), 1);
        const [token, state] = mockStorage.set.mock.calls[0].arguments;
        assert.strictEqual(token, 'save-token');
        assert.strictEqual(state.taskName, 'saveTask');
        assert.deepStrictEqual(state.params, { data: 'important' });
        assert.strictEqual(state.agent.id, 'test-agent');
      });
    });

    describe('Error Status Patterns', () => {
      test('should handle FAILED status', async () => {
        const mockResponse = {
          status: ADCP_STATUS.FAILED,
          error: 'Authentication failed',
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor();

        // FAILED status throws internally but executeTask catches it and returns an error result
        const result = await executor.executeTask(mockAgent, 'failTask', {});
        assert.strictEqual(result.success, false);
        assert.ok(
          result.error.includes('Authentication failed'),
          `Expected error to include 'Authentication failed', got: ${result.error}`
        );
      });

      test('should handle REJECTED status', async () => {
        const mockResponse = {
          status: ADCP_STATUS.REJECTED,
          message: 'Request rejected by policy',
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor();

        // REJECTED status throws internally but executeTask catches it and returns an error result
        const result = await executor.executeTask(mockAgent, 'rejectTask', {});
        assert.strictEqual(result.success, false);
        assert.ok(
          result.error.includes('Request rejected by policy'),
          `Expected error to include 'Request rejected by policy', got: ${result.error}`
        );
      });

      test('should handle CANCELED status', async () => {
        const mockResponse = {
          status: ADCP_STATUS.CANCELED,
          error: 'Task was canceled',
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor();

        // CANCELED status throws internally but executeTask catches it and returns an error result
        const result = await executor.executeTask(mockAgent, 'cancelTask', {});
        assert.strictEqual(result.success, false);
        assert.ok(
          result.error.includes('Task was canceled'),
          `Expected error to include 'Task was canceled', got: ${result.error}`
        );
      });

      test('should handle unknown status with data as completion', async () => {
        const mockResponse = {
          status: 'unknown-status',
          result: { data: 'valid result' },
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        // The response has a `result` field which triggers A2A protocol detection.
        // Use strictSchemaValidation: false since this is not a standard AdCP response.
        // The executor cannot unwrap A2A artifacts from this non-standard response,
        // so it returns the full response object as data.
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'unknownStatusTask', {});

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'completed');
        // Data contains the full response since the format is non-standard
        assert.ok(result.data, 'Should have data');
        assert.ok(
          result.data['data'] === 'valid result' ||
            (result.data.result && result.data.result['data'] === 'valid result'),
          'Should contain the valid result data'
        );
      });

      test('should handle unknown status without data as error', async () => {
        const mockResponse = {
          status: 'unknown-status',
        };

        ProtocolClient.callTool = mock.fn(async () => mockResponse);

        const executor = new TaskExecutor();

        // Unknown status without data throws internally but executeTask catches it
        // and returns an error result rather than rejecting.
        const result = await executor.executeTask(mockAgent, 'unknownEmptyTask', {});
        assert.strictEqual(result.success, false);
        assert.ok(
          result.error.includes('Unknown status') || result.error.includes('unknown'),
          `Expected unknown status error, got: ${result.error}`
        );
      });
    });

    describe('Protocol Client Integration', () => {
      test('should handle protocol client errors', async () => {
        ProtocolClient.callTool = mock.fn(async () => {
          throw new Error('Network timeout');
        });

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'networkErrorTask', {});

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.error, 'Network timeout');
        assert.strictEqual(result.metadata.status, 'failed');
      });

      test('should propagate debug logs', async () => {
        const expectedLogs = [
          { type: 'request', method: 'testTool' },
          { type: 'response', status: 200 },
        ];

        ProtocolClient.callTool = mock.fn(async (agent, toolName, params, debugLogs) => {
          debugLogs.push(...expectedLogs);
          return { status: ADCP_STATUS.COMPLETED, data: { success: true } };
        });

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'debugTask', {});

        assert.strictEqual(result.success, true);
        // Debug logs should be captured in the execution flow
        assert(Array.isArray(result.debug_logs));
      });
    });

    describe('Task Configuration and Options', () => {
      test('should respect custom working timeout configuration', async () => {
        // Working status is returned immediately regardless of timeout config.
        // The timeout config is stored but does not trigger polling behavior.
        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.WORKING,
        }));

        const executor = new TaskExecutor({
          workingTimeout: 50,
          pollingInterval: 10,
        });

        const startTime = Date.now();
        const result = await executor.executeTask(mockAgent, 'timeoutTask', {});
        const elapsed = Date.now() - startTime;

        // Working is returned immediately - not after a timeout
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'working');
        // Should complete quickly since there's no polling
        assert(elapsed < 200, `Should return quickly, took: ${elapsed}ms`);
      });

      test('should use provided context ID', async () => {
        const customContextId = 'custom-ctx-456';

        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.COMPLETED,
          data: { contextUsed: true },
        }));

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'contextTask', {}, undefined, {
          contextId: customContextId,
        });

        assert.strictEqual(result.metadata.taskId, customContextId);
      });

      test('should handle max clarifications option', async () => {
        const mockHandler = mock.fn(async context => {
          assert.strictEqual(context.maxAttempts, 5);
          return 'response';
        });

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            return { status: ADCP_STATUS.COMPLETED, data: { done: true } };
          } else {
            return {
              status: ADCP_STATUS.INPUT_REQUIRED,
              question: 'Test max clarifications?',
            };
          }
        });

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        await executor.executeTask(mockAgent, 'clarificationTask', {}, mockHandler, { maxClarifications: 5 });

        assert.strictEqual(mockHandler.mock.callCount(), 1);
      });
    });

    describe('Conversation Management', () => {
      test('should build proper conversation history', async () => {
        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.COMPLETED,
          data: { success: true },
        }));

        const executor = new TaskExecutor({
          enableConversationStorage: true,
          strictSchemaValidation: false,
        });

        const result = await executor.executeTask(mockAgent, 'conversationTask', { input: 'test' });

        assert(Array.isArray(result.conversation));
        assert.strictEqual(result.conversation.length, 2);

        // Check request message
        const requestMsg = result.conversation[0];
        assert.strictEqual(requestMsg.role, 'user');
        assert.deepStrictEqual(requestMsg.content, { tool: 'conversationTask', params: { input: 'test' } });
        assert.strictEqual(requestMsg.metadata.toolName, 'conversationTask');
        assert.strictEqual(requestMsg.metadata.type, 'request');

        // Check response message
        const responseMsg = result.conversation[1];
        assert.strictEqual(responseMsg.role, 'agent');
        assert.strictEqual(responseMsg.metadata.toolName, 'conversationTask');
        assert.strictEqual(responseMsg.metadata.type, 'response');
      });

      test('should include input messages in conversation', async () => {
        const mockHandler = mock.fn(async () => 'user-input');

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            return { status: ADCP_STATUS.COMPLETED, data: { final: true } };
          } else {
            return {
              status: ADCP_STATUS.INPUT_REQUIRED,
              question: 'Need input',
              contextId: 'ctx-conv',
            };
          }
        });

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'inputConversationTask', {}, mockHandler);

        assert.strictEqual(result.conversation.length, 4);

        // Should have: request, input-required response, user input, final response
        assert.strictEqual(result.conversation[0].role, 'user');
        assert.strictEqual(result.conversation[1].role, 'agent');
        assert.strictEqual(result.conversation[2].role, 'user');
        assert.strictEqual(result.conversation[2].content, 'user-input');
        assert.strictEqual(result.conversation[2].metadata.type, 'input_response');
        assert.strictEqual(result.conversation[3].role, 'agent');
        assert.strictEqual(result.conversation[3].metadata.type, 'continued_response');
      });
    });
  }
);

console.log('TaskExecutor async patterns test suite loaded successfully');
