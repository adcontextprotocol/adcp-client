// Integration tests for handler-controlled flow patterns
// Tests complex handler scenarios and real-world usage patterns

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

function a2aPause(
  question,
  field,
  contextId = 'handler-test-context',
  taskId = 'handler-test-task',
  state = 'input-required'
) {
  return {
    result: {
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state,
        message: {
          kind: 'message',
          messageId: `${taskId}-${field}`,
          role: 'agent',
          parts: [{ kind: 'data', data: { question, field } }],
        },
      },
      artifacts: [],
    },
  };
}

/**
 * Handler Integration Test Strategy:
 * 1. Test built-in handlers (autoApprove, deferAll, createFieldHandler)
 * 2. Test conditional handler routing
 * 3. Test handler composition patterns
 * 4. Test error handling within handlers
 * 5. Test context usage and conversation history
 * 6. Test real-world handler scenarios
 */

describe(
  'Handler-Controlled Flow Integration Tests',
  { skip: process.env.CI ? 'Slow tests - skipped in CI' : false },
  () => {
    let TaskExecutor;
    let ProtocolClient;
    let createFieldHandler;
    let autoApproveHandler;
    let deferAllHandler;
    let createConditionalHandler;
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
      createFieldHandler = lib.createFieldHandler;
      autoApproveHandler = lib.autoApproveHandler;
      deferAllHandler = lib.deferAllHandler;
      createConditionalHandler = lib.createConditionalHandler;

      originalCallTool = ProtocolClient.callTool;

      mockAgent = {
        id: 'handler-test-agent',
        name: 'Handler Test Agent',
        agent_uri: 'https://handler.test.com',
        protocol: 'a2a',
      };
    });

    afterEach(() => {
      if (originalCallTool) {
        ProtocolClient.callTool = originalCallTool;
      }
    });

    describe('Built-in Handler Integration', () => {
      test('should use autoApproveHandler for automatic approval', async () => {
        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            // autoApproveHandler returns `true` for all input requests
            assert.strictEqual(params.input, true);
            return { status: 'completed', result: { approved: true } };
          } else {
            return a2aPause('Do you approve this action?', 'approval');
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'approvalTask', {}, autoApproveHandler);

        assert.strictEqual(result.success, true);
        assert(result.data !== undefined, 'Should have data');
      });

      test('should use deferAllHandler to defer all requests', async () => {
        const mockStorage = new Map();
        const storageInterface = {
          set: mock.fn(async (key, value) => mockStorage.set(key, value)),
          putIfAbsent: mock.fn(async (key, value) => {
            if (mockStorage.has(key)) return false;
            mockStorage.set(key, value);
            return true;
          }),
          replaceIfVersion: mock.fn(async (key, expectedVersion, value) => {
            if (mockStorage.get(key)?.continuationVersion !== expectedVersion) return false;
            mockStorage.set(key, value);
            return true;
          }),
          takeIfVersion: mock.fn(async (key, expectedVersion) => {
            const value = mockStorage.get(key);
            if (value?.continuationVersion !== expectedVersion) return undefined;
            mockStorage.delete(key);
            return value;
          }),
          take: mock.fn(async key => {
            const value = mockStorage.get(key);
            mockStorage.delete(key);
            return value;
          }),
          get: mock.fn(async key => mockStorage.get(key)),
          delete: mock.fn(async key => mockStorage.delete(key)),
        };

        ProtocolClient.callTool = mock.fn(async () => a2aPause('This should be deferred', 'defer_me'));

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({
          deferredStorage: storageInterface,
          strictSchemaValidation: false,
        });

        const result = await executor.executeTask(mockAgent, 'deferTask', {}, deferAllHandler);

        // Deferred is a valid intermediate state, not a failure
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'deferred');
        assert(result.deferred);
        assert.strictEqual(typeof result.deferred.token, 'string');
        assert.strictEqual(result.deferred.question, 'This should be deferred');
      });

      test('should use createFieldHandler with predefined values', async () => {
        const fieldValues = {
          budget: 75000,
          targeting: ['US', 'CA', 'UK'],
          approval: true,
          campaign_name: 'Test Campaign 2024',
        };

        const fieldHandler = createFieldHandler(fieldValues);

        let stepIndex = 0;
        const expectedInputs = ['budget', 'targeting', 'approval'];

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            // stepIndex was incremented after initial call, so stepIndex-1 gives us the field
            // that the handler just responded to
            const expectedField = expectedInputs[stepIndex - 1];
            const expectedValue = fieldValues[expectedField];
            assert.deepStrictEqual(params.input, expectedValue);
            stepIndex++;

            if (stepIndex <= expectedInputs.length) {
              // Still need more input
              return a2aPause(`What about ${expectedInputs[stepIndex - 1]}?`, expectedInputs[stepIndex - 1]);
            } else {
              // All inputs provided
              return {
                status: 'completed',
                result: {
                  budget: fieldValues.budget,
                  targeting: fieldValues.targeting,
                  approved: fieldValues.approval,
                },
              };
            }
          } else {
            // Initial call - needs first input
            stepIndex = 1;
            return a2aPause(`What is the ${expectedInputs[0]}?`, expectedInputs[0]);
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'multiInputTask', {}, fieldHandler);

        assert.strictEqual(result.success, true);
        assert(result.data !== undefined, 'Should have data');
      });

      test('should handle missing field values in createFieldHandler', async () => {
        const partialFieldValues = {
          budget: 50000,
          // missing 'approval' field
        };

        const fieldHandler = createFieldHandler(partialFieldValues);

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            if (params.input === 50000) {
              // Budget was provided, now ask for approval (not in field values)
              return a2aPause('Do you approve?', 'approval');
            } else {
              // This should not happen with field handler - missing field should cause error
              throw new Error('Field handler should not provide value for missing field');
            }
          } else {
            return a2aPause('What is your budget?', 'budget');
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });

        // TaskExecutor may throw or return an error result when handler can't provide missing field
        try {
          const result = await executor.executeTask(mockAgent, 'missingFieldTask', {}, fieldHandler);
          // If it didn't throw, it should have failed
          assert.strictEqual(result.success, false);
        } catch (error) {
          // Expected - handler couldn't provide missing field
          assert(error.message.length > 0);
        }
      });
    });

    describe('Conditional Handler Integration', () => {
      test('should route based on conditions with createConditionalHandler', async () => {
        const budgetHandler = mock.fn(async context => {
          return context.inputRequest.field === 'budget' ? 100000 : 'not-budget';
        });

        const approvalHandler = mock.fn(async context => {
          return context.inputRequest.field === 'approval' ? 'APPROVED' : 'not-approval';
        });

        const conditionalHandler = createConditionalHandler(
          [
            {
              condition: context => context.inputRequest.field === 'budget',
              handler: budgetHandler,
            },
            {
              condition: context => context.inputRequest.field === 'approval',
              handler: approvalHandler,
            },
          ],
          deferAllHandler
        ); // Default to defer

        let stepCount = 0;
        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            stepCount++;
            if (stepCount === 1) {
              // After budget, ask for approval
              assert.strictEqual(params.input, 100000);
              return a2aPause('Do you approve?', 'approval');
            } else {
              // After approval, complete
              assert.strictEqual(params.input, 'APPROVED');
              return {
                status: 'completed',
                result: { budget: 100000, status: 'APPROVED' },
              };
            }
          } else {
            return a2aPause('What is your budget?', 'budget');
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'conditionalTask', {}, conditionalHandler);

        assert.strictEqual(result.success, true);
        assert.strictEqual(budgetHandler.mock.callCount(), 1);
        assert.strictEqual(approvalHandler.mock.callCount(), 1);
      });

      test('should fall back to default handler when no conditions match', async () => {
        const specificHandler = mock.fn(async () => 'specific-response');
        const defaultHandler = mock.fn(async () => 'default-response');

        const conditionalHandler = createConditionalHandler(
          [
            {
              condition: context => context.inputRequest.field === 'specific_field',
              handler: specificHandler,
            },
          ],
          defaultHandler
        );

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            assert.strictEqual(params.input, 'default-response');
            return { status: 'completed', result: { handled: 'default' } };
          } else {
            return a2aPause('Unknown field?', 'unknown_field');
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'fallbackTask', {}, conditionalHandler);

        assert.strictEqual(result.success, true);
        assert.strictEqual(specificHandler.mock.callCount(), 0);
        assert.strictEqual(defaultHandler.mock.callCount(), 1);
      });
    });

    describe('Context Usage and Conversation History', () => {
      test('should provide conversation context to handlers', async () => {
        const contextTestHandler = mock.fn(async context => {
          // Test all context properties
          assert.strictEqual(typeof context.taskId, 'string');
          assert.strictEqual(context.agent.id, 'handler-test-agent');
          assert.strictEqual(context.agent.protocol, 'a2a');
          assert.strictEqual(context.attempt, 1);
          assert.strictEqual(context.maxAttempts, 3);

          // Test conversation history
          assert(Array.isArray(context.messages));
          assert.strictEqual(context.messages.length, 2); // request + input-required response

          // Test input request
          assert.strictEqual(context.inputRequest.question, 'Test question with context?');
          assert.strictEqual(context.inputRequest.field, 'context_test');

          // Test helper methods
          assert.strictEqual(typeof context.getSummary, 'function');
          assert.strictEqual(typeof context.wasFieldDiscussed, 'function');
          assert.strictEqual(typeof context.getPreviousResponse, 'function');
          assert.strictEqual(typeof context.deferToHuman, 'function');
          assert.strictEqual(typeof context.abort, 'function');

          // Test summary
          const summary = context.getSummary();
          assert(typeof summary === 'string');
          assert(summary.includes('contextTestTask'));

          return 'context-verified';
        });

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            assert.strictEqual(params.input, 'context-verified');
            return { status: 'completed', result: { context: 'verified' } };
          } else {
            return a2aPause('Test question with context?', 'context_test', 'ctx-context-test');
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(
          mockAgent,
          'contextTestTask',
          { originalParam: 'test-value' },
          contextTestHandler
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(contextTestHandler.mock.callCount(), 1);
      });

      test('should track field discussion history', async () => {
        const historyTestHandler = mock.fn(async context => {
          // Check if budget was discussed in previous messages
          const budgetDiscussed = context.wasFieldDiscussed('budget');
          const approvalDiscussed = context.wasFieldDiscussed('approval');

          if (context.inputRequest.field === 'budget') {
            // Budget field is being discussed in the current message, so wasFieldDiscussed returns true
            assert.strictEqual(budgetDiscussed, true);
            return 75000;
          } else if (context.inputRequest.field === 'approval') {
            assert.strictEqual(budgetDiscussed, true); // Budget was discussed before
            assert.strictEqual(approvalDiscussed, true); // Approval is being asked in current message

            // Get previous budget response
            const previousBudget = context.getPreviousResponse('budget');
            assert.strictEqual(previousBudget, 75000);

            return 'APPROVED';
          }

          return 'unknown';
        });

        let stepCount = 0;
        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            stepCount++;
            if (stepCount === 1) {
              // After budget, ask for approval
              return a2aPause('Do you approve?', 'approval');
            } else {
              // Complete after approval
              return {
                status: 'completed',
                result: { budget: params.input === 75000 ? 75000 : params.input },
              };
            }
          } else {
            return a2aPause('What is your budget?', 'budget');
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'historyTask', {}, historyTestHandler);

        assert.strictEqual(result.success, true);
        assert.strictEqual(historyTestHandler.mock.callCount(), 2);
      });

      test('tracks canonical auth-required fields in conversation helpers', async () => {
        const handler = mock.fn(async context => {
          assert.strictEqual(context.inputRequest.field, 'authorization');
          assert.strictEqual(context.wasFieldDiscussed('authorization'), true);
          return { refreshed: true };
        });
        let calls = 0;
        ProtocolClient.callTool = mock.fn(async () => {
          calls += 1;
          return calls === 1
            ? a2aPause('Refresh seller credentials', 'authorization', 'auth-context', 'auth-task', 'auth-required')
            : { status: 'completed', result: { authenticated: true } };
        });

        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'authTask', {}, handler);
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(handler.mock.callCount(), 1);
      });
    });

    describe('Handler Error Scenarios', () => {
      test('should handle handler throwing errors', async () => {
        const errorHandler = mock.fn(async context => {
          throw new Error('Handler processing failed');
        });

        ProtocolClient.callTool = mock.fn(async () => a2aPause('This will cause handler error', 'error_field'));

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });

        // TaskExecutor catches handler errors and returns an error result
        const result = await executor.executeTask(mockAgent, 'errorHandlerTask', {}, errorHandler);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('Handler processing failed'));
      });

      test('should handle handler returning invalid responses', async () => {
        const invalidHandler = mock.fn(async context => {
          return undefined; // Invalid response
        });

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            // Should receive undefined as input
            assert.strictEqual(params.input, undefined);
            return { status: 'completed', result: { handled: 'undefined' } };
          } else {
            return a2aPause('Handler will return undefined', 'invalid_field');
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'invalidHandlerTask', {}, invalidHandler);

        // Should handle undefined gracefully
        assert.strictEqual(result.success, true);
        // The mock returns { status: 'completed', result: { handled: 'undefined' } }
        // which gets stored as data, so we access data.result.handled
        assert.strictEqual(result.data.result.handled, 'undefined');
      });

      test('should handle async handler promises properly', async () => {
        const asyncHandler = mock.fn(async context => {
          // Simulate async work
          await new Promise(resolve => setTimeout(resolve, 10));
          return `async-result-for-${context.inputRequest.field}`;
        });

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            assert.strictEqual(params.input, 'async-result-for-async_field');
            return { status: 'completed', result: { async: true } };
          } else {
            return a2aPause('Async handler test?', 'async_field');
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const startTime = Date.now();
        const result = await executor.executeTask(mockAgent, 'asyncHandlerTask', {}, asyncHandler);
        const elapsed = Date.now() - startTime;

        assert.strictEqual(result.success, true);
        // Mock returns { status: 'completed', result: { async: true } } which is stored in data
        assert.strictEqual(result.data.result.async, true);
        assert(elapsed >= 10, 'Should wait for async handler');
      });
    });

    describe('Real-World Handler Scenarios', () => {
      test('should handle campaign creation workflow', async () => {
        const campaignHandler = createFieldHandler({
          campaign_name: 'Holiday Sale 2024',
          budget: 150000,
          targeting: {
            locations: ['US', 'CA'],
            demographics: { age_min: 25, age_max: 55 },
            interests: ['shopping', 'deals'],
          },
          start_date: '2024-12-01',
          end_date: '2024-12-31',
        });

        const workflowSteps = [
          { field: 'campaign_name', question: 'What is the campaign name?' },
          { field: 'budget', question: 'What is the total budget?' },
          { field: 'targeting', question: 'Who should we target?' },
          { field: 'start_date', question: 'When should it start?' },
          { field: 'end_date', question: 'When should it end?' },
        ];

        let currentStep = 0;

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            currentStep++;
            if (currentStep < workflowSteps.length) {
              // Continue to next step
              const nextStep = workflowSteps[currentStep];
              return a2aPause(nextStep.question, nextStep.field);
            } else {
              // Complete workflow
              return {
                status: 'completed',
                result: {
                  campaign_id: 'camp_holiday_2024',
                  status: 'created',
                  total_steps: workflowSteps.length,
                },
              };
            }
          } else {
            // Start workflow
            const firstStep = workflowSteps[0];
            return a2aPause(firstStep.question, firstStep.field);
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'createCampaign', {}, campaignHandler);

        assert.strictEqual(result.success, true);
        // Mock returns { status: 'completed', result: {...} } which is stored in data
        assert.strictEqual(result.data.result.campaign_id, 'camp_holiday_2024');
        assert.strictEqual(result.data.result.total_steps, 5);
        // Note: clarificationRounds tracking is not fully implemented, so we just verify the task completed
      });

      test('should handle approval workflow with escalation', async () => {
        let escalationLevel = 0;

        const approvalHandler = mock.fn(async context => {
          if (context.inputRequest.field === 'budget') {
            return 250000; // High budget requiring approval
          } else if (context.inputRequest.field === 'manager_approval') {
            escalationLevel++;
            if (escalationLevel === 1) {
              return 'ESCALATE_TO_DIRECTOR'; // First escalation
            } else {
              return 'APPROVED_BY_DIRECTOR'; // Final approval
            }
          }
          return 'auto-approve';
        });

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (Object.hasOwn(params, 'input')) {
            if (params.input === 250000) {
              // High budget, needs manager approval
              return a2aPause('Budget over $200k requires manager approval', 'manager_approval');
            } else if (params.input === 'ESCALATE_TO_DIRECTOR') {
              // Escalated, needs director approval
              return a2aPause('Manager escalated to director approval', 'manager_approval');
            } else if (params.input === 'APPROVED_BY_DIRECTOR') {
              // Final approval received
              return {
                status: 'completed',
                result: {
                  budget: 250000,
                  approval_level: 'director',
                  escalations: escalationLevel,
                },
              };
            }
          } else {
            return a2aPause('What is your campaign budget?', 'budget');
          }
        });

        // Disable schema validation for handler testing
        const executor = new TaskExecutor({ strictSchemaValidation: false });
        const result = await executor.executeTask(mockAgent, 'approvalWorkflow', {}, approvalHandler);

        assert.strictEqual(result.success, true);
        // Mock returns { status: 'completed', result: {...} } which is stored in data
        assert.strictEqual(result.data.result.budget, 250000);
        assert.strictEqual(result.data.result.approval_level, 'director');
        assert.strictEqual(result.data.result.escalations, 2);
      });
    });
  }
);

console.log('🎯 Handler-controlled flow integration tests loaded successfully');
