// Comprehensive test suite for TaskExecutor async patterns (PR #78)
// Tests working/submitted/deferred patterns with proper mocking

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');

const testDurableToken = label => createHash('sha256').update(label).digest('base64url');

function a2aPausedTask({ state = 'input-required', question, field, contextId, taskId }) {
  return {
    result: {
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state,
        message: {
          kind: 'message',
          messageId: `${taskId}-clarification`,
          role: 'agent',
          parts: [{ kind: 'data', data: { status: state, question, ...(field !== undefined && { field }) } }],
        },
      },
      artifacts: [],
    },
  };
}

function atomicDeferredStorage(states = new Map()) {
  const operationRoutes = new Map();
  for (const [token, state] of states) {
    if (state.settlementOperationId) operationRoutes.set(state.settlementOperationId, token);
  }
  return {
    set: mock.fn(async (token, state) => states.set(token, state)),
    putIfAbsent: mock.fn(async (token, state) => {
      if (states.has(token)) return false;
      states.set(token, state);
      return true;
    }),
    replaceIfVersion: mock.fn(async (token, expectedVersion, state) => {
      if (states.get(token)?.continuationVersion !== expectedVersion) return false;
      states.set(token, state);
      return true;
    }),
    takeIfVersion: mock.fn(async (token, expectedVersion) => {
      const state = states.get(token);
      if (state?.continuationVersion !== expectedVersion) return undefined;
      states.delete(token);
      return state;
    }),
    putForSettlementOperationIfAbsent: mock.fn(async (operationId, token, state) => {
      if (operationRoutes.has(operationId) || states.has(token) || state.settlementOperationId !== operationId) {
        return false;
      }
      states.set(token, state);
      operationRoutes.set(operationId, token);
      return true;
    }),
    getBySettlementOperationId: mock.fn(async operationId => {
      const token = operationRoutes.get(operationId);
      const state = token ? states.get(token) : undefined;
      return token && state ? { token, state } : undefined;
    }),
    replaceForSettlementOperationIfVersion: mock.fn(
      async (operationId, currentToken, expectedVersion, replacementToken, replacementState) => {
        if (
          operationRoutes.get(operationId) !== currentToken ||
          states.get(currentToken)?.continuationVersion !== expectedVersion ||
          (replacementToken !== currentToken && states.has(replacementToken)) ||
          replacementState.settlementOperationId !== operationId
        ) {
          return false;
        }
        states.set(replacementToken, replacementState);
        operationRoutes.set(operationId, replacementToken);
        return true;
      }
    ),
    get: mock.fn(async token => states.get(token)),
    take: mock.fn(async token => {
      const state = states.get(token);
      states.delete(token);
      return state;
    }),
    delete: mock.fn(async token => states.delete(token)),
    has: mock.fn(async token => states.has(token)),
  };
}

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
        agent_uri: 'https://test.example',
        protocol: 'a2a',
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
            return a2aPausedTask({
              question: 'What is your budget?',
              field: 'budget',
              contextId: 'ctx-123',
              taskId: 'seller-task-budget',
            });
          } else {
            // Continuation call - task completed
            assert.strictEqual(taskName, 'setBudget');
            assert.deepStrictEqual(params, { input: 50000 });
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
        const mockResponse = a2aPausedTask({
          question: 'What is your budget?',
          field: 'budget',
          contextId: 'handlerless-context',
          taskId: 'seller-task-handlerless-budget',
        });
        mockResponse.result.status.message.parts.unshift({
          kind: 'data',
          data: { status: 'input-required', question: 'Stale question', field: 'stale_field' },
        });

        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () =>
          ++calls === 1 ? mockResponse : { status: ADCP_STATUS.COMPLETED, data: { accepted_budget: 100 } }
        );

        const executor = new TaskExecutor();

        const result = await executor.executeTask(mockAgent, 'needsInput', {});
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'input-required');
        assert.ok(result.metadata.inputRequest, 'Should include inputRequest details for caller');
        assert.strictEqual(result.metadata.inputRequest.question, 'What is your budget?');
        assert.deepStrictEqual(result.data, {
          status: 'input-required',
          question: 'What is your budget?',
          field: 'budget',
        });
        assert.ok(result.deferred, 'Handler-less input-required results expose a safe continuation');
        const resumed = await result.deferred.resume(100);
        assert.strictEqual(resumed.status, 'completed');
        assert.deepStrictEqual(resumed.data.data, { accepted_budget: 100 });
      });

      test('should preserve an auth-required task for handler-less credential refresh', async () => {
        const mockResponse = a2aPausedTask({
          state: 'auth-required',
          question: 'Refresh seller credentials',
          field: 'authorization',
          contextId: 'auth-refresh-context',
          taskId: 'seller-task-auth-refresh',
        });
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () =>
          ++calls === 1 ? mockResponse : { status: ADCP_STATUS.COMPLETED, data: { authenticated: true } }
        );

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'needsAuth', {});
        assert.strictEqual(result.status, 'auth-required');
        assert.strictEqual(result.metadata.status, 'auth-required');
        assert.ok(result.deferred);
        const resumed = await result.deferred.resume({ refreshed: true });
        assert.strictEqual(resumed.status, 'completed');
        assert.deepStrictEqual(resumed.data.data, { authenticated: true });
      });

      test('resumes handler-less A2A pauses on the seller context and task', async () => {
        const a2aAgent = { ...mockAgent, protocol: 'a2a' };
        let callCount = 0;
        ProtocolClient.callTool = mock.fn(async (_agent, taskName, params, options) => {
          callCount += 1;
          assert.strictEqual(taskName, 'needsInput');
          if (callCount === 1) {
            return a2aPausedTask({
              question: 'Approve?',
              contextId: 'seller-context-1',
              taskId: 'seller-task-1',
            });
          }
          assert.deepStrictEqual(params, { input: 'approved' });
          assert.deepStrictEqual(options.session, {
            contextId: 'seller-context-1',
            taskId: 'seller-task-1',
          });
          return { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
        });

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const paused = await executor.executeTask(a2aAgent, 'needsInput', {});
        const resumed = await paused.deferred.resume('approved');
        assert.strictEqual(resumed.status, 'completed');
      });

      test('persists handler-less A2A pauses for restart-safe resumption', async () => {
        const a2aAgent = { ...mockAgent, protocol: 'a2a' };
        const storage = atomicDeferredStorage();
        let callCount = 0;
        ProtocolClient.callTool = mock.fn(async (_agent, taskName, params, options) => {
          callCount += 1;
          if (callCount === 1) {
            return a2aPausedTask({
              question: 'Approve after restart?',
              contextId: 'restart-context',
              taskId: 'restart-seller-task',
            });
          }
          assert.strictEqual(taskName, 'needsInput');
          assert.deepStrictEqual(params, { input: 'approved' });
          assert.deepStrictEqual(options.session, {
            contextId: 'restart-context',
            taskId: 'restart-seller-task',
          });
          return { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
        });

        const firstExecutor = new TaskExecutor({ deferredStorage: storage, strictSchemaValidation: false });
        const paused = await firstExecutor.executeTask(a2aAgent, 'needsInput', {});
        assert.strictEqual(await storage.has(paused.deferred.token), true);

        const restartedExecutor = new TaskExecutor({
          deferredStorage: storage,
          resolveDeferredAgent: async agentId => (agentId === a2aAgent.id ? a2aAgent : undefined),
          strictSchemaValidation: false,
        });
        const resumed = await restartedExecutor.resumeDeferredTask(paused.deferred.token, 'approved');
        assert.strictEqual(resumed.status, 'completed');
        assert.strictEqual(await storage.has(paused.deferred.token), false);
      });

      test('does not resume an A2A pause that omits seller task identity', async () => {
        const a2aAgent = { ...mockAgent, protocol: 'a2a' };
        const handler = mock.fn(async () => 'approved');
        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.INPUT_REQUIRED,
          question: 'Approve?',
          contextId: 'seller-context-without-task',
        }));

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const paused = await executor.executeTask(a2aAgent, 'needsInput', {}, handler);
        assert.strictEqual(paused.status, 'input-required');
        assert.strictEqual(paused.deferred, undefined);
        assert.strictEqual(handler.mock.callCount(), 0);
        assert.strictEqual(ProtocolClient.callTool.mock.callCount(), 1);
      });

      test('unwraps a live A2A task clarification and continues its transport task ID', async () => {
        let calls = 0;
        const handler = mock.fn(async context => {
          assert.strictEqual(context.inputRequest.question, 'Approve the live task budget?');
          assert.strictEqual(context.inputRequest.field, 'budget');
          assert.deepStrictEqual(context.inputRequest.suggestions, [50_000]);
          return 50_000;
        });
        ProtocolClient.callTool = mock.fn(async (_agent, taskName, params, options) => {
          calls += 1;
          assert.strictEqual(taskName, 'create_media_buy');
          if (calls === 1) {
            return {
              result: {
                kind: 'task',
                id: 'a2a-transport-task',
                contextId: 'artifact-context',
                status: {
                  state: 'input-required',
                  message: {
                    kind: 'message',
                    messageId: 'clarification-message',
                    role: 'agent',
                    parts: [
                      {
                        kind: 'data',
                        data: {
                          question: 'Approve the live task budget?',
                          field: 'budget',
                          suggestions: [50_000],
                        },
                      },
                    ],
                  },
                },
                artifacts: [
                  {
                    artifactId: 'artifact-input-required',
                    parts: [
                      {
                        kind: 'data',
                        data: {
                          task_id: 'artifact-seller-task',
                          question: 'Stale artifact question',
                        },
                      },
                    ],
                  },
                ],
              },
            };
          }
          assert.deepStrictEqual(params, { input: 50_000 });
          assert.deepStrictEqual(options.session, {
            contextId: 'artifact-context',
            taskId: 'a2a-transport-task',
          });
          return { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
        });

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'create_media_buy', {}, handler);
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(handler.mock.callCount(), 1);
        assert.strictEqual(ProtocolClient.callTool.mock.callCount(), 2);
      });

      test('does not invent an MCP continuation tool for a returned pause', async () => {
        const mcpAgent = { ...mockAgent, protocol: 'mcp' };
        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.INPUT_REQUIRED,
          question: 'Approve?',
          context_id: 'mcp-context',
        }));

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const paused = await executor.executeTask(mcpAgent, 'needsInput', {}, async () => 'approved');
        assert.strictEqual(paused.status, 'input-required');
        assert.strictEqual(paused.deferred, undefined);
        assert.strictEqual(ProtocolClient.callTool.mock.callCount(), 1);
      });

      test('should provide complete conversation context to handler', async () => {
        const mockHandler = mock.fn(async context => {
          // Verify context structure
          assert.strictEqual(typeof context.taskId, 'string');
          assert.strictEqual(context.agent.id, 'test-agent');
          assert.strictEqual(context.agent.protocol, 'a2a');
          assert(Array.isArray(context.messages));
          assert.strictEqual(context.messages.length, 2); // request + response
          assert.strictEqual(typeof context.getSummary, 'function');
          assert.strictEqual(typeof context.wasFieldDiscussed, 'function');
          assert.strictEqual(typeof context.getPreviousResponse, 'function');
          assert.strictEqual(typeof context.deferToHuman, 'function');
          assert.strictEqual(typeof context.abort, 'function');

          return 'handler-response';
        });

        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          if (++calls === 1) {
            return a2aPausedTask({
              question: 'Test question?',
              contextId: 'ctx-456',
              taskId: 'seller-task-context',
            });
          }
          return { status: ADCP_STATUS.COMPLETED, data: { done: true } };
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
            taskType: 'submitTask',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        };

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'tasks/get' || taskName === 'tasks_get') {
            return { task: { ...mockTaskStatus.task, taskId: params.task_id } };
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
        assert.strictEqual(status.taskType, 'submitTask');
      });

      test('waitForCompletion preserves the client correlation ID and exposes the seller work ID separately', async () => {
        ProtocolClient.callTool = mock.fn(async (_agent, taskName, params) => {
          if (taskName === 'tasks/get' || taskName === 'tasks_get') {
            return {
              task: {
                taskId: params.task_id,
                status: 'completed',
                taskType: 'create_media_buy',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                result: { media_buy_id: 'buy-polled-identity' },
              },
            };
          }
          return { status: ADCP_STATUS.SUBMITTED, task_id: 'seller-work-identity' };
        });
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const submitted = await executor.executeTask(mockAgent, 'create_media_buy', {
          idempotency_key: 'poll-identity-key-0001',
        });
        const clientTaskId = submitted.metadata.taskId;

        const completed = await submitted.submitted.waitForCompletion(0);

        assert.strictEqual(completed.metadata.taskId, clientTaskId);
        assert.strictEqual(completed.metadata.serverTaskId, 'seller-work-identity');
        assert.notStrictEqual(completed.metadata.taskId, completed.metadata.serverTaskId);
      });

      test('polled typed errors retain the client request idempotency key', async () => {
        ProtocolClient.callTool = mock.fn(async (_agent, taskName, params) => {
          if (taskName === 'tasks/get' || taskName === 'tasks_get') {
            return {
              task: {
                taskId: params.task_id,
                status: 'failed',
                taskType: 'create_media_buy',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                result: {
                  adcp_error: {
                    code: 'IDEMPOTENCY_CONFLICT',
                    message: 'Payload changed',
                    recovery: 'correctable',
                  },
                },
              },
            };
          }
          return { status: ADCP_STATUS.SUBMITTED, task_id: 'seller-error-work-id' };
        });
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const submitted = await executor.executeTask(mockAgent, 'create_media_buy', {
          idempotency_key: 'poll-error-idempotency-key',
        });

        const failed = await submitted.submitted.waitForCompletion(0);
        assert.strictEqual(failed.errorInstance.idempotencyKey, 'poll-error-idempotency-key');
        assert.strictEqual(failed.metadata.taskId, submitted.metadata.taskId);
        assert.strictEqual(failed.metadata.serverTaskId, 'seller-error-work-id');
      });

      test('rejects invalid core polling intervals before polling the seller', async () => {
        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.SUBMITTED,
          task_id: 'seller-submitted-task',
        }));

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'submitTask', {});
        assert.strictEqual(result.status, 'submitted');

        const dispatchCalls = ProtocolClient.callTool.mock.callCount();
        await assert.rejects(result.submitted.waitForCompletion(Number.NaN), RangeError);
        await assert.rejects(result.submitted.waitForCompletion(-1), RangeError);
        await assert.rejects(result.submitted.waitForCompletion(2_147_483_648), RangeError);
        assert.strictEqual(ProtocolClient.callTool.mock.callCount(), dispatchCalls);
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
      test('rejects durable storage without atomic create before any seller dispatch', () => {
        assert.throws(
          () =>
            new TaskExecutor({
              deferredStorage: {
                get: async () => undefined,
                set: async () => {},
                delete: async () => {},
                has: async () => false,
                replaceIfVersion: async () => false,
                takeIfVersion: async () => undefined,
              },
            }),
          /putIfAbsent/
        );
      });

      test('rejects committed pause storage without operation routing before seller dispatch', async () => {
        const storage = atomicDeferredStorage();
        delete storage.putForSettlementOperationIfAbsent;
        delete storage.getBySettlementOperationId;
        delete storage.replaceForSettlementOperationIfVersion;
        ProtocolClient.callTool = mock.fn(async () =>
          a2aPausedTask({ question: 'Must not dispatch', taskId: 'missing-operation-route-task' })
        );
        const executor = new TaskExecutor({ deferredStorage: storage, strictSchemaValidation: false });
        await assert.rejects(
          executor.executeTask(mockAgent, 'approvalTask', {}, undefined, {}, 'v3', undefined, async () => ({
            action: 'dispatch_committed',
            requireDeferredSettlementResumeAuthorization: true,
            onResult: async result => result,
            onError: async error => {
              throw error;
            },
          })),
          error => {
            assert.match(error.cause?.message ?? '', /operation routing/);
            return true;
          }
        );
        assert.strictEqual(ProtocolClient.callTool.mock.callCount(), 0);
      });

      test('rejects weak durable bearer tokens before storage access', async () => {
        const storage = atomicDeferredStorage();
        const executor = new TaskExecutor({ deferredStorage: storage });

        await assert.rejects(executor.resumeDeferredTask('guessable-token', {}), /invalid shape/);
        assert.strictEqual(storage.get.mock.callCount(), 0);
      });

      test('does not echo bearer-style continuation tokens in resume errors', async () => {
        const secretToken = testDurableToken('resume-capability-do-not-log');
        const executor = new TaskExecutor({ deferredStorage: atomicDeferredStorage() });
        await assert.rejects(executor.resumeDeferredTask(secretToken, {}), error => {
          assert.doesNotMatch(error.message, new RegExp(secretToken));
          assert.match(error.message, /Deferred task not found/);
          return true;
        });
        const deferredError = new DeferredTaskError(secretToken);
        assert.doesNotMatch(deferredError.message, new RegExp(secretToken));
        assert.equal(deferredError.token, secretToken);
        assert.doesNotMatch(JSON.stringify(deferredError), new RegExp(secretToken));
        assert.strictEqual(Object.getOwnPropertyDescriptor(deferredError, 'token').enumerable, false);
      });

      test('rejects a persisted A2A deferral that lacks seller task identity', async () => {
        const states = new Map([
          [
            testDurableToken('legacy-identity-less-token'),
            {
              continuationVersion: 'legacy-identity-less-version',
              taskId: 'local-legacy-deferred-task',
              contextId: 'legacy-context',
              serverVersion: 'v3',
              agentId: mockAgent.id,
              taskName: 'create_media_buy',
              params: { idempotency_key: 'legacy-deferred-key' },
              messages: [],
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
            },
          ],
        ]);
        const storage = atomicDeferredStorage(states);
        ProtocolClient.callTool = mock.fn(async () => ({ status: ADCP_STATUS.COMPLETED }));
        const executor = new TaskExecutor({
          deferredStorage: storage,
          resolveDeferredAgent: async () => mockAgent,
        });

        await assert.rejects(
          executor.resumeDeferredTask(testDurableToken('legacy-identity-less-token'), { approved: true }),
          /requires a seller task ID/
        );
        assert.strictEqual(ProtocolClient.callTool.mock.callCount(), 0);
        assert.strictEqual(storage.take.mock.callCount(), 0);
        assert.strictEqual(storage.replaceIfVersion.mock.callCount(), 2);
      });

      test('should handle handler deferral with resume capability', async () => {
        const mockHandler = mock.fn(async context => {
          if (context.inputRequest.field === 'approval') {
            return { defer: true, token: testDurableToken('TEST_DEFER_TOKEN_PLACEHOLDER') };
          }
          return 'auto-approve';
        });

        const mockDeferredStorage = new Map();

        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          if (++calls === 1) {
            return a2aPausedTask({
              question: 'Do you approve this action?',
              field: 'approval',
              contextId: 'ctx-defer-123',
              taskId: 'seller-task-defer',
            });
          }
          return { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
        });

        const executor = new TaskExecutor({ deferredStorage: atomicDeferredStorage(mockDeferredStorage) });

        const result = await executor.executeTask(mockAgent, 'approvalTask', {}, mockHandler);

        // Deferred is a valid intermediate state - success: true
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'deferred');
        assert(result.deferred);
        assert.strictEqual(result.deferred.token, testDurableToken('TEST_DEFER_TOKEN_PLACEHOLDER'));
        assert.strictEqual(result.deferred.question, 'Do you approve this action?');
        assert.strictEqual(typeof result.deferred.resume, 'function');

        // Test resumption
        const resumeResult = await result.deferred.resume('APPROVED');
        assert.strictEqual(resumeResult.success, true);
        assert.strictEqual(resumeResult.status, 'completed');
      });

      test('handler deferral without durable storage keeps an exact in-process continuation', async () => {
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async (_agent, _taskName, params, options) => {
          calls += 1;
          if (calls === 1) {
            return a2aPausedTask({
              question: 'Approve in process?',
              contextId: 'in-process-context',
              taskId: 'in-process-seller-task',
            });
          }
          assert.deepStrictEqual(params, { input: { approved: true } });
          assert.deepStrictEqual(options.session, {
            contextId: 'in-process-context',
            taskId: 'in-process-seller-task',
          });
          return { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
        });
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const paused = await executor.executeTask(mockAgent, 'approvalTask', {}, async () => ({
          defer: true,
          token: 'in-process-handler-token',
        }));

        const callerInput = { approved: true };
        const resumePromise = paused.deferred.resume(callerInput);
        callerInput.approved = false;
        const resumed = await resumePromise;
        assert.strictEqual(resumed.status, 'completed');
        await assert.rejects(paused.deferred.resume({ approved: true }), /already been consumed/);
      });

      test('should save deferred state to storage', async () => {
        const mockHandler = mock.fn(async () => ({ defer: true, token: testDurableToken('save-token') }));
        const mockStorage = atomicDeferredStorage();

        ProtocolClient.callTool = mock.fn(async () =>
          a2aPausedTask({
            question: 'Save this?',
            contextId: 'ctx-save',
            taskId: 'seller-task-save',
          })
        );

        const executor = new TaskExecutor({
          deferredStorage: mockStorage,
        });

        await executor.executeTask(
          { ...mockAgent, auth_token: 'must-not-persist-agent-token' },
          'saveTask',
          { data: 'important' },
          mockHandler
        );

        assert.strictEqual(mockStorage.putIfAbsent.mock.callCount(), 1);
        const [token, state] = mockStorage.putIfAbsent.mock.calls[0].arguments;
        assert.strictEqual(token, testDurableToken('save-token'));
        assert.strictEqual(state.taskName, 'saveTask');
        assert.deepStrictEqual(state.params, { data: 'important' });
        assert.strictEqual(state.agentId, 'test-agent');
        assert.doesNotMatch(JSON.stringify(state), /must-not-persist-agent-token/);
      });

      test('rediscovers an initial committed pause by operation after a pre-handoff crash', async () => {
        const states = new Map();
        const storage = atomicDeferredStorage(states);
        const token = testDurableToken('initial-operation-route-token');
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          calls += 1;
          return a2aPausedTask({
            question: 'Approve the committed purchase?',
            contextId: 'initial-operation-route-context',
            taskId: 'initial-operation-route-task',
          });
        });
        const original = new TaskExecutor({ deferredStorage: storage, strictSchemaValidation: false });
        const paused = await original.executeTask(
          mockAgent,
          'approvalTask',
          {},
          async () => ({ defer: true, token }),
          {},
          'v3',
          undefined,
          async () => ({
            action: 'dispatch_committed',
            requireDeferredSettlementResumeAuthorization: true,
            onResult: async result => result,
            onError: async error => {
              throw error;
            },
          })
        );

        const restarted = new TaskExecutor({
          deferredStorage: storage,
          resolveDeferredAgent: async () => mockAgent,
          authorizeDeferredSettlementOperationRecovery: async (_operationId, recoveryKey) =>
            recoveryKey === 'initial-operation-owner-capability',
          strictSchemaValidation: false,
        });
        await assert.rejects(
          restarted.recoverDeferredTaskForOperation(paused.metadata.taskId, 'wrong-owner-capability', false),
          /not authorized/
        );
        const recovered = await restarted.recoverDeferredTaskForOperation(
          paused.metadata.taskId,
          'initial-operation-owner-capability',
          false
        );
        assert.strictEqual(recovered.token, token);
        assert.strictEqual(recovered.result.status, 'deferred');
        assert.strictEqual(recovered.result.deferred.token, token);
        assert.strictEqual(recovered.result.deferred.question, 'Approve the committed purchase?');
        assert.strictEqual(calls, 1, 'route discovery must not redispatch the original mutation');
      });

      test('persists and resumes an A2A deferral without inventing a seller context ID', async () => {
        const states = new Map();
        const storage = atomicDeferredStorage(states);
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async (_agent, taskName, params, options) => {
          calls += 1;
          assert.strictEqual(taskName, 'approvalTask');
          if (calls === 1) {
            return a2aPausedTask({
              question: 'Approve without context?',
              field: 'approval',
              taskId: 'seller-task-without-context',
            });
          }
          assert.deepStrictEqual(params, { input: 'APPROVED' });
          assert.deepStrictEqual(options.session, {
            contextId: undefined,
            taskId: 'seller-task-without-context',
          });
          return { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
        });

        const executor = new TaskExecutor({ deferredStorage: storage, strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'approvalTask', {}, async () => ({
          defer: true,
          token: testDurableToken('context-free-token'),
        }));

        const state = states.get(testDurableToken('context-free-token'));
        assert.strictEqual(Object.hasOwn(state, 'contextId'), false);
        assert.strictEqual(state.a2aTaskId, 'seller-task-without-context');
        const resumed = await result.deferred.resume('APPROVED');
        assert.strictEqual(resumed.status, 'completed');
      });

      test('deletes a stored continuation when resumption returns a nonresumable pause', async () => {
        const states = new Map([
          [
            testDurableToken('stale-resume-token'),
            {
              continuationVersion: 'stale-resume-version',
              taskId: 'local-deferred-task',
              contextId: 'original-context',
              a2aTaskId: 'original-seller-task',
              serverVersion: 'v3',
              agentId: mockAgent.id,
              taskName: 'approvalTask',
              params: {},
              messages: [],
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
            },
          ],
        ]);
        const storage = atomicDeferredStorage(states);
        ProtocolClient.callTool = mock.fn(async () =>
          a2aPausedTask({ question: 'New pause omitted its task identity', taskId: undefined })
        );
        const executor = new TaskExecutor({
          deferredStorage: storage,
          resolveDeferredAgent: async () => mockAgent,
          strictSchemaValidation: false,
        });

        const resumed = await executor.resumeDeferredTask(testDurableToken('stale-resume-token'), { approved: true });
        assert.strictEqual(resumed.status, 'input-required');
        assert.strictEqual(resumed.deferred, undefined);
        assert.strictEqual(storage.takeIfVersion.mock.callCount(), 1);
        await assert.rejects(
          executor.resumeDeferredTask(testDurableToken('stale-resume-token'), { approved: true }),
          /Deferred task not found/
        );
      });

      test('atomically consumes one deferred token across concurrent executors', async () => {
        const states = new Map();
        const storage = atomicDeferredStorage(states);
        let continuationCalls = 0;
        ProtocolClient.callTool = mock.fn(async (_agent, _taskName, params) => {
          if (!Object.hasOwn(params, 'input')) {
            return a2aPausedTask({ question: 'Approve once?', taskId: 'seller-atomic-task' });
          }
          continuationCalls += 1;
          return { status: ADCP_STATUS.COMPLETED, data: { approved: params.input } };
        });
        const firstExecutor = new TaskExecutor({ deferredStorage: storage, strictSchemaValidation: false });
        await firstExecutor.executeTask(mockAgent, 'approvalTask', {}, async () => ({
          defer: true,
          token: testDurableToken('atomic-resume-token'),
        }));
        const secondExecutor = new TaskExecutor({
          deferredStorage: storage,
          resolveDeferredAgent: async () => mockAgent,
          strictSchemaValidation: false,
        });

        const results = await Promise.allSettled([
          firstExecutor.resumeDeferredTask(testDurableToken('atomic-resume-token'), { choice: 'first' }),
          secondExecutor.resumeDeferredTask(testDurableToken('atomic-resume-token'), { choice: 'second' }),
        ]);

        assert.strictEqual(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.strictEqual(results.filter(result => result.status === 'rejected').length, 1);
        assert.strictEqual(continuationCalls, 1);
      });

      test('a delayed resolver cannot consume a replacement state that reuses the same token', async () => {
        const token = testDurableToken('resolver-aba-token');
        const stateA = {
          continuationVersion: 'resolver-state-a-version',
          taskId: 'local-task-a',
          contextId: 'context-a',
          a2aTaskId: 'seller-task-a',
          serverVersion: 'v3',
          agentId: mockAgent.id,
          taskName: 'approvalTask',
          params: {},
          messages: [],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
        const stateB = { ...stateA, taskId: 'local-task-b', contextId: 'context-b', a2aTaskId: 'seller-task-b' };
        const states = new Map([[token, stateA]]);
        const storage = atomicDeferredStorage(states);
        let releaseResolver;
        let resolverStarted;
        const resolverGate = new Promise(resolve => {
          releaseResolver = resolve;
        });
        const resolverEntered = new Promise(resolve => {
          resolverStarted = resolve;
        });
        ProtocolClient.callTool = mock.fn(async (_agent, _taskName, params, options) => {
          assert.deepStrictEqual(params, { input: { approved: 'for-a' } });
          assert.deepStrictEqual(options.session, { contextId: 'context-a', taskId: 'seller-task-a' });
          return { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
        });
        const executor = new TaskExecutor({
          deferredStorage: storage,
          resolveDeferredAgent: async () => {
            resolverStarted();
            await resolverGate;
            return mockAgent;
          },
          strictSchemaValidation: false,
        });

        const resumed = executor.resumeDeferredTask(token, { approved: 'for-a' });
        await resolverEntered;
        assert.strictEqual(await storage.putIfAbsent(token, stateB), false);
        releaseResolver();
        assert.strictEqual((await resumed).status, 'completed');
        assert.strictEqual(await storage.get(token), undefined);
      });

      test('persists a replacement continuation that resumes after restart', async () => {
        const states = new Map();
        const storage = atomicDeferredStorage(states);
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async (_agent, _taskName, params) => {
          calls += 1;
          if (calls === 1) {
            return a2aPausedTask({
              question: 'First approval?',
              contextId: 'seller-context-one',
              taskId: 'seller-task-one',
            });
          }
          if (calls === 2) {
            assert.deepStrictEqual(params, { input: { approved: true } });
            return a2aPausedTask({
              question: 'Second approval?',
              contextId: 'seller-context-two',
              taskId: 'seller-task-two',
            });
          }
          assert.deepStrictEqual(params, { input: { confirmed: true } });
          return { status: ADCP_STATUS.COMPLETED, data: { media_buy_id: 'buy-after-restart' } };
        });

        const firstExecutor = new TaskExecutor({ deferredStorage: storage, strictSchemaValidation: false });
        const initial = await firstExecutor.executeTask(mockAgent, 'approvalTask', {}, async () => ({
          defer: true,
          token: testDurableToken('initial-durable-token'),
        }));
        const pausedAgain = await initial.deferred.resume({ approved: true });
        assert.strictEqual(pausedAgain.status, 'input-required');
        assert.ok(pausedAgain.deferred);
        assert.notStrictEqual(pausedAgain.deferred.token, testDurableToken('initial-durable-token'));
        assert.strictEqual(states.has(testDurableToken('initial-durable-token')), false);
        const replacement = states.get(pausedAgain.deferred.token);
        assert.strictEqual(replacement.a2aTaskId, 'seller-task-two');
        assert.strictEqual(replacement.contextId, 'seller-context-two');
        assert.strictEqual(replacement.serverVersion, 'v3');

        const restartedExecutor = new TaskExecutor({
          deferredStorage: storage,
          resolveDeferredAgent: async agentId => (agentId === mockAgent.id ? mockAgent : undefined),
          strictSchemaValidation: false,
        });
        const completed = await restartedExecutor.resumeDeferredTask(pausedAgain.deferred.token, { confirmed: true });
        assert.strictEqual(completed.status, 'completed');
        assert.strictEqual(calls, 3);
      });

      test('preserves exact-route authorization across a nested committed pause', async () => {
        const states = new Map();
        const storage = atomicDeferredStorage(states);
        let currentToken = testDurableToken('committed-token-a');
        const replacements = [];
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          calls += 1;
          return a2aPausedTask({
            question: calls === 1 ? 'First approval?' : calls === 2 ? 'Second approval?' : 'Final approval?',
            contextId: `committed-context-${calls}`,
            taskId: `committed-seller-task-${calls}`,
          });
        });
        const executor = new TaskExecutor({
          deferredStorage: storage,
          authorizeDeferredSettlementResume: async (_operationId, token) => token === currentToken,
          replaceDeferredSettlementResumeToken: async (_operationId, expectedToken, replacementToken) => {
            if (expectedToken !== currentToken) return false;
            replacements.push([expectedToken, replacementToken]);
            currentToken = replacementToken;
            return true;
          },
          canRecoverDeferredSettlement: async () => true,
          recoverDeferredSettlement: async result => ({ result }),
          strictSchemaValidation: false,
        });
        await executor.executeTask(
          mockAgent,
          'approvalTask',
          {},
          async () => ({ defer: true, token: currentToken }),
          {},
          'v3',
          undefined,
          async () => ({
            action: 'dispatch_committed',
            requireDeferredSettlementResumeAuthorization: true,
            onResult: async result => result,
            onError: async error => {
              throw error;
            },
          })
        );

        const initialToken = currentToken;
        const pausedAgain = await executor.resumeDeferredTask(initialToken, { approved: true });
        const replacementToken = pausedAgain.deferred.token;
        assert.notStrictEqual(replacementToken, initialToken);
        assert.deepStrictEqual(replacements, [[initialToken, replacementToken]]);
        assert.strictEqual(currentToken, replacementToken);
        assert.strictEqual(states.get(replacementToken).settlementResumeAuthorizationRequired, true);

        await assert.rejects(executor.resumeDeferredTask(initialToken, { confirmed: true }), /not found/);
        assert.strictEqual(calls, 2, 'a stale nested token must fail before seller dispatch');

        const pausedThirdTime = await pausedAgain.deferred.resume({ confirmed: true });
        assert.strictEqual(pausedThirdTime.status, 'input-required');
        assert.strictEqual(replacements.length, 2);
        assert.strictEqual(replacements[1][0], replacementToken);
        assert.strictEqual(replacements[1][1], pausedThirdTime.deferred.token);
        assert.strictEqual(currentToken, pausedThirdTime.deferred.token);
        assert.strictEqual(calls, 3, 'the current live nested route may continue exactly once');

        currentToken = testDurableToken('coordinator-disposed-or-ambiguous');
        await assert.rejects(pausedThirdTime.deferred.resume({ final: true }), /not the current durable route/);
        assert.strictEqual(calls, 3, 'a held live closure must fail after its durable owner stops authorizing it');
      });

      test('rebinds a live committed nested pause before consuming its prior checkpoint', async () => {
        const states = new Map();
        const storage = atomicDeferredStorage(states);
        let currentToken = testDurableToken('live-committed-token-a');
        const replacements = [];
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          calls += 1;
          return a2aPausedTask({
            question: calls === 1 ? 'First live approval?' : 'Second live approval?',
            contextId: `live-committed-context-${calls}`,
            taskId: `live-committed-seller-task-${calls}`,
          });
        });
        const executor = new TaskExecutor({
          deferredStorage: storage,
          authorizeDeferredSettlementResume: async (_operationId, token) => token === currentToken,
          replaceDeferredSettlementResumeToken: async (_operationId, expectedToken, replacementToken) => {
            assert.strictEqual(states.has(expectedToken), true, 'the prior claim must still exist during route CAS');
            assert.strictEqual(states.has(replacementToken), true, 'the replacement must be durable before route CAS');
            if (expectedToken !== currentToken) return false;
            replacements.push([expectedToken, replacementToken]);
            currentToken = replacementToken;
            return true;
          },
          canRecoverDeferredSettlement: async () => true,
          recoverDeferredSettlement: async result => ({ result }),
          strictSchemaValidation: false,
        });
        const initial = await executor.executeTask(
          mockAgent,
          'approvalTask',
          {},
          async () => ({ defer: true, token: currentToken }),
          {},
          'v3',
          undefined,
          async () => ({
            action: 'dispatch_committed',
            requireDeferredSettlementResumeAuthorization: true,
            onResult: async result => result,
            onError: async error => {
              throw error;
            },
          })
        );

        const initialToken = currentToken;
        const pausedAgain = await initial.deferred.resume({ approved: true });
        const replacementToken = pausedAgain.deferred.token;
        assert.deepStrictEqual(replacements, [[initialToken, replacementToken]]);
        assert.strictEqual(currentToken, replacementToken);
        assert.strictEqual(states.has(initialToken), false);
        assert.strictEqual(states.has(replacementToken), true);
        assert.strictEqual(calls, 2);
      });

      test('recovers the indexed replacement when coordinator handoff fails after seller dispatch', async () => {
        const states = new Map();
        const storage = atomicDeferredStorage(states);
        const initialToken = testDurableToken('failed-handoff-token-a');
        let currentToken = initialToken;
        let failReplacement = true;
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          calls += 1;
          return a2aPausedTask({
            question: calls === 1 ? 'First approval?' : 'Second approval?',
            contextId: `failed-handoff-context-${calls}`,
            taskId: `failed-handoff-task-${calls}`,
          });
        });
        const executor = new TaskExecutor({
          deferredStorage: storage,
          authorizeDeferredSettlementResume: async (_operationId, token) => token === currentToken,
          replaceDeferredSettlementResumeToken: async (_operationId, expectedToken, replacementToken) => {
            if (failReplacement || currentToken !== expectedToken) return false;
            currentToken = replacementToken;
            return true;
          },
          canRecoverDeferredSettlement: async () => true,
          recoverDeferredSettlement: async result => ({ result }),
          strictSchemaValidation: false,
        });
        const initial = await executor.executeTask(
          mockAgent,
          'approvalTask',
          {},
          async () => ({ defer: true, token: initialToken }),
          {},
          'v3',
          undefined,
          async () => ({
            action: 'dispatch_committed',
            requireDeferredSettlementResumeAuthorization: true,
            onResult: async result => result,
            onError: async error => {
              throw error;
            },
          })
        );

        await assert.rejects(
          executor.resumeDeferredTask(initial.deferred.token, { approved: true }),
          /coordinator route still needs recovery/
        );
        const replacementToken = [...states.keys()].find(token => token !== initialToken);
        assert.ok(replacementToken, 'the seller-issued replacement stays durably fenced');
        await assert.rejects(
          executor.resumeDeferredTask(replacementToken, { confirmed: true }),
          /not the current durable route/
        );
        failReplacement = false;
        const recovered = await executor.resumeDeferredTask(initialToken, { approved: true });
        assert.strictEqual(recovered.status, 'input-required');
        assert.strictEqual(recovered.deferred.token, replacementToken);
        assert.strictEqual(currentToken, replacementToken);
        assert.strictEqual(calls, 2, 'recovering B must not redispatch the already-consumed input for A');
      });

      test('keeps polling-only committed pauses out of public durable-token recovery', async () => {
        const states = new Map();
        const storage = atomicDeferredStorage(states);
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          calls += 1;
          return calls <= 2
            ? a2aPausedTask({
                question: calls === 1 ? 'Approve through the guarded live owner?' : 'Confirm once more?',
                contextId: `polling-only-context-${calls}`,
                taskId: `polling-only-seller-task-${calls}`,
              })
            : { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
        });
        const executor = new TaskExecutor({ deferredStorage: storage, strictSchemaValidation: false });
        const paused = await executor.executeTask(
          mockAgent,
          'approvalTask',
          {},
          async () => ({ defer: true, token: testDurableToken('polling-only-live-token') }),
          {},
          'v3',
          undefined,
          async () => ({
            action: 'dispatch_committed',
            persistPausedContinuation: false,
            onResult: async result => result,
            onError: async error => {
              throw error;
            },
          })
        );

        assert.strictEqual(states.has(paused.deferred.token), false);
        await assert.rejects(
          executor.resumeDeferredTask(paused.deferred.token, { approved: true }),
          /Deferred task not found/
        );
        assert.strictEqual(calls, 1);
        const pausedAgain = await paused.deferred.resume({ approved: true });
        assert.strictEqual(pausedAgain.status, 'input-required');
        assert.strictEqual(states.has(pausedAgain.deferred.token), false);
        await assert.rejects(
          executor.resumeDeferredTask(pausedAgain.deferred.token, { confirmed: true }),
          /Deferred task not found/
        );
        assert.strictEqual(calls, 2);
        const completed = await pausedAgain.deferred.resume({ confirmed: true });
        assert.strictEqual(completed.status, 'completed');
        assert.strictEqual(calls, 3);
      });

      test('snapshots nested resume input before awaiting durable storage', async () => {
        const token = testDurableToken('resume-input-snapshot-token');
        const states = new Map([
          [
            token,
            {
              continuationVersion: 'resume-input-version',
              taskId: 'resume-input-local-task',
              a2aTaskId: 'resume-input-seller-task',
              serverVersion: 'v3',
              agentId: mockAgent.id,
              taskName: 'approvalTask',
              params: {},
              messages: [],
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
            },
          ],
        ]);
        const storage = atomicDeferredStorage(states);
        ProtocolClient.callTool = mock.fn(async (_agent, _taskName, params) => {
          assert.deepStrictEqual(params, { input: { approval: { accepted: true } } });
          return { status: ADCP_STATUS.COMPLETED, data: { approved: true } };
        });
        const executor = new TaskExecutor({
          deferredStorage: storage,
          resolveDeferredAgent: async () => mockAgent,
          strictSchemaValidation: false,
        });
        const callerInput = { approval: { accepted: true } };

        const resumed = executor.resumeDeferredTask(token, callerInput);
        callerInput.approval.accepted = false;
        assert.strictEqual((await resumed).status, 'completed');
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

        // FAILED status returns an error TaskResult directly
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

        // REJECTED status returns an error TaskResult directly
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

        // CANCELED status returns an error TaskResult directly
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
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.error, 'Network timeout');
        assert.strictEqual(result.metadata.status, 'failed');
      });

      test('should propagate debug logs', async () => {
        const expectedLogs = [
          { type: 'request', method: 'testTool' },
          { type: 'response', status: 200 },
        ];

        ProtocolClient.callTool = mock.fn(async (agent, toolName, params, options) => {
          options.debugLogs.push(...expectedLogs);
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

      test('should forward provided context ID to the protocol layer', async () => {
        // The caller-supplied `contextId` rides on the protocol envelope as
        // the A2A session binding — it must NOT be aliased to the local
        // correlation `taskId`, which is always a fresh UUID so retries and
        // concurrent calls don't collide. We assert both: the wire-level
        // session arg carries the contextId, and metadata.taskId is a
        // distinct client-minted UUID.
        const customContextId = 'custom-ctx-456';

        ProtocolClient.callTool = mock.fn(async () => ({
          status: ADCP_STATUS.COMPLETED,
          data: { contextUsed: true },
        }));

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'contextTask', {}, undefined, {
          contextId: customContextId,
        });

        const optionsArg = ProtocolClient.callTool.mock.calls[0].arguments[3];
        assert.deepStrictEqual(optionsArg.session, { contextId: customContextId, taskId: undefined });
        assert.notStrictEqual(result.metadata.taskId, customContextId);
        assert.match(result.metadata.taskId, /^[0-9a-f-]{36}$/, 'taskId is a fresh UUID');
      });

      test('should handle max clarifications option', async () => {
        const mockHandler = mock.fn(async context => {
          assert.strictEqual(context.maxAttempts, 5);
          return 'response';
        });

        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          if (++calls === 1) {
            return a2aPausedTask({
              question: 'Test max clarifications?',
              contextId: 'max-clarifications-context',
              taskId: 'seller-task-max-clarifications',
            });
          }
          return { status: ADCP_STATUS.COMPLETED, data: { done: true } };
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

        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          if (++calls === 1) {
            return a2aPausedTask({
              question: 'Need input',
              contextId: 'ctx-conv',
              taskId: 'seller-task-conversation',
            });
          }
          return { status: ADCP_STATUS.COMPLETED, data: { final: true } };
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
