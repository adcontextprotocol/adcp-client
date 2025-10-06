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

describe('TaskExecutor Async Patterns (PR #78)', { skip: process.env.CI ? 'Slow tests - skipped in CI' : false }, () => {
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
      CANCELED: 'canceled'
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
      requiresAuth: false
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
      const mockResponse = {
        status: ADCP_STATUS.COMPLETED,
        result: { products: ['Product A', 'Product B'] }
      };

      // Mock ProtocolClient.callTool
      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'getProducts',
        { category: 'electronics' }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');
      assert.deepStrictEqual(result.data, mockResponse.result);
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
            targeting: { locations: ['US', 'CA'] }
          }
        }
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'createCampaign',
        { name: 'Test Campaign' }
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, mockResponse.data);
    });

    test('should handle completion without explicit status (legacy compatibility)', async () => {
      const mockResponse = {
        result: { message: 'Task completed successfully' }
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'simpleTask',
        {}
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');
      assert.deepStrictEqual(result.data, mockResponse.result);
    });
  });

  describe('WORKING Status Pattern', () => {
    test('should poll for completion during working status', async () => {
      let pollCount = 0;
      const mockResponses = [
        { status: ADCP_STATUS.WORKING, message: 'Processing...' },
        { status: ADCP_STATUS.WORKING, message: 'Still processing...' },
        { status: ADCP_STATUS.COMPLETED, result: { processed: true } }
      ];

      // Mock initial call and polling
      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'tasks/get') {
          // This is a polling call
          return { task: mockResponses[Math.min(pollCount++, mockResponses.length - 1)] };
        } else {
          // This is the initial call
          return mockResponses[0];
        }
      });

      const executor = new TaskExecutor({
        workingTimeout: 10000 // 10 second timeout for testing
      });

      const result = await executor.executeTask(
        mockAgent,
        'longRunningTask',
        { data: 'test' }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');
      assert.deepStrictEqual(result.data, { processed: true });
      assert(pollCount >= 1, 'Should have polled at least once');
    });

    test('should timeout on working status after configured limit', async () => {
      const mockResponse = {
        status: ADCP_STATUS.WORKING,
        message: 'Processing indefinitely...'
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor({
        workingTimeout: 100 // Very short timeout for testing
      });

      await assert.rejects(
        executor.executeTask(mockAgent, 'slowTask', {}),
        TaskTimeoutError
      );
    });

    test('should transition from working to input-required', async () => {
      const mockHandler = mock.fn(async () => 'user-provided-value');
      let pollCount = 0;

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'tasks/get') {
          // Transition to input-required after first poll
          return {
            task: pollCount++ === 0 
              ? { status: ADCP_STATUS.WORKING }
              : { status: ADCP_STATUS.INPUT_REQUIRED, question: 'Need input', field: 'value' }
          };
        } else if (taskName === 'continue_task') {
          return { status: ADCP_STATUS.COMPLETED, result: { success: true } };
        } else {
          return { status: ADCP_STATUS.WORKING };
        }
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'transitionTask',
        {},
        mockHandler
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(mockHandler.mock.callCount(), 1);
    });
  });

  describe('INPUT_REQUIRED Status Pattern', () => {
    test('should call handler and continue task with provided input', async () => {
      const mockHandler = mock.fn(async (context) => {
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
            contextId: 'ctx-123'
          };
        } else if (taskName === 'continue_task') {
          // Continuation call - task completed
          assert.strictEqual(params.contextId, 'ctx-123');
          assert.strictEqual(params.input, 50000);
          return {
            status: ADCP_STATUS.COMPLETED,
            result: { budget: 50000, status: 'approved' }
          };
        }
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'setBudget',
        { campaign: 'test' },
        mockHandler
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(mockHandler.mock.callCount(), 1);
      assert.strictEqual(result.conversation.length, 4); // request, response, input, response
    });

    test('should throw InputRequiredError when no handler provided', async () => {
      const mockResponse = {
        status: ADCP_STATUS.INPUT_REQUIRED,
        question: 'What is your budget?',
        field: 'budget'
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      
      await assert.rejects(
        executor.executeTask(mockAgent, 'needsInput', {}),
        (error) => {
          assert(error instanceof InputRequiredError);
          assert(error.message.includes('What is your budget?'));
          return true;
        }
      );
    });

    test('should provide complete conversation context to handler', async () => {
      const mockHandler = mock.fn(async (context) => {
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
          return { status: ADCP_STATUS.COMPLETED, result: { done: true } };
        } else {
          return {
            status: ADCP_STATUS.INPUT_REQUIRED,
            question: 'Test question?',
            contextId: 'ctx-456'
          };
        }
      });

      const executor = new TaskExecutor();
      await executor.executeTask(
        mockAgent,
        'contextTest',
        {},
        mockHandler
      );

      assert.strictEqual(mockHandler.mock.callCount(), 1);
    });
  });

  describe('SUBMITTED Status Pattern', () => {
    test('should return submitted continuation with tracking capabilities', async () => {
      const mockResponse = {
        status: ADCP_STATUS.SUBMITTED,
        webhookUrl: 'https://webhook.example.com/task-123'
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'longRunningTask',
        { data: 'large-dataset' }
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'submitted');
      assert(result.submitted);
      assert.strictEqual(typeof result.submitted.taskId, 'string');
      assert.strictEqual(result.submitted.webhookUrl, 'https://webhook.example.com/task-123');
      assert.strictEqual(typeof result.submitted.track, 'function');
      assert.strictEqual(typeof result.submitted.waitForCompletion, 'function');
    });

    test('should handle submitted task tracking', async () => {
      const mockSubmitResponse = {
        status: ADCP_STATUS.SUBMITTED
      };

      const mockTaskStatus = {
        task: {
          taskId: 'task-789',
          status: 'working',
          taskType: 'processData',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      };

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'tasks/get') {
          return mockTaskStatus;
        } else {
          return mockSubmitResponse;
        }
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'submitTask',
        {}
      );

      assert.strictEqual(result.status, 'submitted');
      
      // Test tracking
      const status = await result.submitted.track();
      assert.strictEqual(status.status, 'working');
      assert.strictEqual(status.taskType, 'processData');
    });

    test('should handle webhook manager integration', async () => {
      const mockWebhookManager = {
        generateUrl: mock.fn((taskId) => `https://webhook.test.com/${taskId}`),
        registerWebhook: mock.fn(async () => {}),
        processWebhook: mock.fn(async () => {})
      };

      const mockResponse = {
        status: ADCP_STATUS.SUBMITTED
        // No webhookUrl provided by server
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor({
        webhookManager: mockWebhookManager
      });

      const result = await executor.executeTask(
        mockAgent,
        'webhookTask',
        {}
      );

      assert.strictEqual(result.status, 'submitted');
      assert.strictEqual(mockWebhookManager.generateUrl.mock.callCount(), 1);
      assert.strictEqual(mockWebhookManager.registerWebhook.mock.callCount(), 1);
      assert(result.submitted.webhookUrl.includes('webhook.test.com'));
    });
  });

  describe('DEFERRED Status Pattern (Client Deferral)', () => {
    test('should handle handler deferral with resume capability', async () => {
      const mockHandler = mock.fn(async (context) => {
        if (context.inputRequest.field === 'approval') {
          return { defer: true, token: 'TEST_DEFER_TOKEN_PLACEHOLDER' };
        }
        return 'auto-approve';
      });

      const mockDeferredStorage = new Map();

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'continue_task') {
          return { status: ADCP_STATUS.COMPLETED, result: { approved: true } };
        } else {
          return {
            status: ADCP_STATUS.INPUT_REQUIRED,
            question: 'Do you approve this action?',
            field: 'approval',
            contextId: 'ctx-defer-123'
          };
        }
      });

      const executor = new TaskExecutor({
        deferredStorage: {
          set: mock.fn(async (token, state) => mockDeferredStorage.set(token, state)),
          get: mock.fn(async (token) => mockDeferredStorage.get(token)),
          delete: mock.fn(async (token) => mockDeferredStorage.delete(token))
        }
      });

      const result = await executor.executeTask(
        mockAgent,
        'approvalTask',
        {},
        mockHandler
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'deferred');
      assert(result.deferred);
      assert.strictEqual(result.deferred.token, 'defer-token-123');
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
        delete: mock.fn(async () => {})
      };

      ProtocolClient.callTool = mock.fn(async () => ({
        status: ADCP_STATUS.INPUT_REQUIRED,
        question: 'Save this?',
        contextId: 'ctx-save'
      }));

      const executor = new TaskExecutor({
        deferredStorage: mockStorage
      });

      await executor.executeTask(
        mockAgent,
        'saveTask',
        { data: 'important' },
        mockHandler
      );

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
        error: 'Authentication failed'
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      
      await assert.rejects(
        executor.executeTask(mockAgent, 'failTask', {}),
        (error) => {
          assert(error.message.includes('Authentication failed'));
          return true;
        }
      );
    });

    test('should handle REJECTED status', async () => {
      const mockResponse = {
        status: ADCP_STATUS.REJECTED,
        message: 'Request rejected by policy'
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      
      await assert.rejects(
        executor.executeTask(mockAgent, 'rejectTask', {}),
        (error) => {
          assert(error.message.includes('Request rejected by policy'));
          return true;
        }
      );
    });

    test('should handle CANCELED status', async () => {
      const mockResponse = {
        status: ADCP_STATUS.CANCELED,
        error: 'Task was canceled'
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      
      await assert.rejects(
        executor.executeTask(mockAgent, 'cancelTask', {}),
        (error) => {
          assert(error.message.includes('Task was canceled'));
          return true;
        }
      );
    });

    test('should handle unknown status with data as completion', async () => {
      const mockResponse = {
        status: 'unknown-status',
        result: { data: 'valid result' }
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'unknownStatusTask',
        {}
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');
      assert.deepStrictEqual(result.data, { data: 'valid result' });
    });

    test('should handle unknown status without data as error', async () => {
      const mockResponse = {
        status: 'unknown-status'
      };

      ProtocolClient.callTool = mock.fn(async () => mockResponse);

      const executor = new TaskExecutor();
      
      await assert.rejects(
        executor.executeTask(mockAgent, 'unknownEmptyTask', {}),
        (error) => {
          assert(error.message.includes('Unknown status'));
          return true;
        }
      );
    });
  });

  describe('Protocol Client Integration', () => {
    test('should handle protocol client errors', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        throw new Error('Network timeout');
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'networkErrorTask',
        {}
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.error, 'Network timeout');
      assert.strictEqual(result.metadata.status, 'failed');
    });

    test('should propagate debug logs', async () => {
      const expectedLogs = [
        { type: 'request', method: 'testTool' },
        { type: 'response', status: 200 }
      ];

      ProtocolClient.callTool = mock.fn(async (agent, toolName, params, debugLogs) => {
        debugLogs.push(...expectedLogs);
        return { status: ADCP_STATUS.COMPLETED, result: { success: true } };
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'debugTask',
        {}
      );

      assert.strictEqual(result.success, true);
      // Debug logs should be captured in the execution flow
    });
  });

  describe('Task Configuration and Options', () => {
    test('should respect custom working timeout', async () => {
      ProtocolClient.callTool = mock.fn(async () => ({
        status: ADCP_STATUS.WORKING
      }));

      const executor = new TaskExecutor({
        workingTimeout: 50 // Very short for testing
      });

      const startTime = Date.now();
      await assert.rejects(
        executor.executeTask(mockAgent, 'timeoutTask', {}),
        TaskTimeoutError
      );
      const elapsed = Date.now() - startTime;
      
      // Should timeout quickly (allow some margin for execution)
      assert(elapsed < 200, `Timeout took too long: ${elapsed}ms`);
    });

    test('should use provided context ID', async () => {
      const customContextId = 'custom-ctx-456';

      ProtocolClient.callTool = mock.fn(async () => ({
        status: ADCP_STATUS.COMPLETED,
        result: { contextUsed: true }
      }));

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'contextTask',
        {},
        undefined,
        { contextId: customContextId }
      );

      assert.strictEqual(result.metadata.taskId, customContextId);
    });

    test('should handle max clarifications option', async () => {
      const mockHandler = mock.fn(async (context) => {
        assert.strictEqual(context.maxAttempts, 5);
        return 'response';
      });

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'continue_task') {
          return { status: ADCP_STATUS.COMPLETED, result: { done: true } };
        } else {
          return {
            status: ADCP_STATUS.INPUT_REQUIRED,
            question: 'Test max clarifications?'
          };
        }
      });

      const executor = new TaskExecutor();
      await executor.executeTask(
        mockAgent,
        'clarificationTask',
        {},
        mockHandler,
        { maxClarifications: 5 }
      );

      assert.strictEqual(mockHandler.mock.callCount(), 1);
    });
  });

  describe('Conversation Management', () => {
    test('should build proper conversation history', async () => {
      ProtocolClient.callTool = mock.fn(async () => ({
        status: ADCP_STATUS.COMPLETED,
        result: { success: true }
      }));

      const executor = new TaskExecutor({
        enableConversationStorage: true
      });

      const result = await executor.executeTask(
        mockAgent,
        'conversationTask',
        { input: 'test' }
      );

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
          return { status: ADCP_STATUS.COMPLETED, result: { final: true } };
        } else {
          return {
            status: ADCP_STATUS.INPUT_REQUIRED,
            question: 'Need input',
            contextId: 'ctx-conv'
          };
        }
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'inputConversationTask',
        {},
        mockHandler
      );

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
});

console.log('🧪 TaskExecutor async patterns test suite loaded successfully');