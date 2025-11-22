// Integration tests for handler-controlled flow patterns
// Tests complex handler scenarios and real-world usage patterns

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

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
      // Fresh imports
      delete require.cache[require.resolve('../../dist/lib/index.js')];
      const lib = require('../../dist/lib/index.js');

      TaskExecutor = lib.TaskExecutor;
      // Import ProtocolClient from internal path (not part of public API)
      const protocolsModule = require('../../dist/lib/protocols/index.js');
      ProtocolClient = protocolsModule.ProtocolClient;
      createFieldHandler = lib.createFieldHandler;
      autoApproveHandler = lib.autoApproveHandler;
      deferAllHandler = lib.deferAllHandler;
      createConditionalHandler = lib.createConditionalHandler;

      originalCallTool = ProtocolClient.callTool;

      mockAgent = {
        id: 'handler-test-agent',
        name: 'Handler Test Agent',
        agent_uri: 'https://handler.test.com',
        protocol: 'mcp',
        requiresAuth: false,
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
          if (taskName === 'continue_task') {
            assert.strictEqual(params.input, 'auto-approved');
            return { status: 'completed', result: { approved: true } };
          } else {
            return {
              status: 'input-required',
              question: 'Do you approve this action?',
              field: 'approval',
            };
          }
        });

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'approvalTask', {}, autoApproveHandler);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data.approved, true);
      });

      test('should use deferAllHandler to defer all requests', async () => {
        const mockStorage = new Map();
        const storageInterface = {
          set: mock.fn(async (key, value) => mockStorage.set(key, value)),
          get: mock.fn(async key => mockStorage.get(key)),
          delete: mock.fn(async key => mockStorage.delete(key)),
        };

        ProtocolClient.callTool = mock.fn(async () => ({
          status: 'input-required',
          question: 'This should be deferred',
          field: 'defer_me',
        }));

        const executor = new TaskExecutor({
          deferredStorage: storageInterface,
        });

        const result = await executor.executeTask(mockAgent, 'deferTask', {}, deferAllHandler);

        assert.strictEqual(result.success, false);
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

        let inputCount = 0;
        const expectedInputs = ['budget', 'targeting', 'approval'];

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            const expectedField = expectedInputs[inputCount - 1];
            const expectedValue = fieldValues[expectedField];
            assert.deepStrictEqual(params.input, expectedValue);

            if (inputCount < expectedInputs.length) {
              // Still need more input
              return {
                status: 'input-required',
                question: `What about ${expectedInputs[inputCount]}?`,
                field: expectedInputs[inputCount],
              };
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
            return {
              status: 'input-required',
              question: `What is the ${expectedInputs[inputCount]}?`,
              field: expectedInputs[inputCount],
            };
          }
        });

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'multiInputTask', {}, fieldHandler);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data.budget, 75000);
        assert.deepStrictEqual(result.data.targeting, ['US', 'CA', 'UK']);
        assert.strictEqual(result.data.approved, true);
      });

      test('should handle missing field values in createFieldHandler', async () => {
        const partialFieldValues = {
          budget: 50000,
          // missing 'approval' field
        };

        const fieldHandler = createFieldHandler(partialFieldValues);

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            if (params.input === 50000) {
              // Budget was provided, now ask for approval (not in field values)
              return {
                status: 'input-required',
                question: 'Do you approve?',
                field: 'approval',
              };
            } else {
              // This should not happen with field handler - missing field should cause error
              throw new Error('Field handler should not provide value for missing field');
            }
          } else {
            return {
              status: 'input-required',
              question: 'What is your budget?',
              field: 'budget',
            };
          }
        });

        const executor = new TaskExecutor();

        // Should eventually fail or timeout when field handler can't provide missing field
        await assert.rejects(executor.executeTask(mockAgent, 'missingFieldTask', {}, fieldHandler), error => {
          // Depending on implementation, might timeout or throw specific error
          return true;
        });
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
          if (taskName === 'continue_task') {
            stepCount++;
            if (stepCount === 1) {
              // After budget, ask for approval
              assert.strictEqual(params.input, 100000);
              return {
                status: 'input-required',
                question: 'Do you approve?',
                field: 'approval',
              };
            } else {
              // After approval, complete
              assert.strictEqual(params.input, 'APPROVED');
              return {
                status: 'completed',
                result: { budget: 100000, status: 'APPROVED' },
              };
            }
          } else {
            return {
              status: 'input-required',
              question: 'What is your budget?',
              field: 'budget',
            };
          }
        });

        const executor = new TaskExecutor();
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
          if (taskName === 'continue_task') {
            assert.strictEqual(params.input, 'default-response');
            return { status: 'completed', result: { handled: 'default' } };
          } else {
            return {
              status: 'input-required',
              question: 'Unknown field?',
              field: 'unknown_field',
            };
          }
        });

        const executor = new TaskExecutor();
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
          assert.strictEqual(context.agent.protocol, 'mcp');
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
          if (taskName === 'continue_task') {
            assert.strictEqual(params.input, 'context-verified');
            return { status: 'completed', result: { context: 'verified' } };
          } else {
            return {
              status: 'input-required',
              question: 'Test question with context?',
              field: 'context_test',
              contextId: 'ctx-context-test',
            };
          }
        });

        const executor = new TaskExecutor();
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
            assert.strictEqual(budgetDiscussed, false); // First time asking for budget
            return 75000;
          } else if (context.inputRequest.field === 'approval') {
            assert.strictEqual(budgetDiscussed, true); // Budget was discussed before
            assert.strictEqual(approvalDiscussed, false); // First time asking for approval

            // Get previous budget response
            const previousBudget = context.getPreviousResponse('budget');
            assert.strictEqual(previousBudget, 75000);

            return 'APPROVED';
          }

          return 'unknown';
        });

        let stepCount = 0;
        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            stepCount++;
            if (stepCount === 1) {
              // After budget, ask for approval
              return {
                status: 'input-required',
                question: 'Do you approve?',
                field: 'approval',
              };
            } else {
              // Complete after approval
              return {
                status: 'completed',
                result: { budget: params.input === 75000 ? 75000 : params.input },
              };
            }
          } else {
            return {
              status: 'input-required',
              question: 'What is your budget?',
              field: 'budget',
            };
          }
        });

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'historyTask', {}, historyTestHandler);

        assert.strictEqual(result.success, true);
        assert.strictEqual(historyTestHandler.mock.callCount(), 2);
      });
    });

    describe('Handler Error Scenarios', () => {
      test('should handle handler throwing errors', async () => {
        const errorHandler = mock.fn(async context => {
          throw new Error('Handler processing failed');
        });

        ProtocolClient.callTool = mock.fn(async () => ({
          status: 'input-required',
          question: 'This will cause handler error',
          field: 'error_field',
        }));

        const executor = new TaskExecutor();

        await assert.rejects(executor.executeTask(mockAgent, 'errorHandlerTask', {}, errorHandler), error => {
          assert(error.message.includes('Handler processing failed'));
          return true;
        });
      });

      test('should handle handler returning invalid responses', async () => {
        const invalidHandler = mock.fn(async context => {
          return undefined; // Invalid response
        });

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            // Should receive undefined as input
            assert.strictEqual(params.input, undefined);
            return { status: 'completed', result: { handled: 'undefined' } };
          } else {
            return {
              status: 'input-required',
              question: 'Handler will return undefined',
              field: 'invalid_field',
            };
          }
        });

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'invalidHandlerTask', {}, invalidHandler);

        // Should handle undefined gracefully
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data.handled, 'undefined');
      });

      test('should handle async handler promises properly', async () => {
        const asyncHandler = mock.fn(async context => {
          // Simulate async work
          await new Promise(resolve => setTimeout(resolve, 10));
          return `async-result-for-${context.inputRequest.field}`;
        });

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            assert.strictEqual(params.input, 'async-result-for-async_field');
            return { status: 'completed', result: { async: true } };
          } else {
            return {
              status: 'input-required',
              question: 'Async handler test?',
              field: 'async_field',
            };
          }
        });

        const executor = new TaskExecutor();
        const startTime = Date.now();
        const result = await executor.executeTask(mockAgent, 'asyncHandlerTask', {}, asyncHandler);
        const elapsed = Date.now() - startTime;

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data.async, true);
        assert(elapsed >= 100, 'Should wait for async handler');
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
          if (taskName === 'continue_task') {
            currentStep++;
            if (currentStep < workflowSteps.length) {
              // Continue to next step
              const nextStep = workflowSteps[currentStep];
              return {
                status: 'input-required',
                question: nextStep.question,
                field: nextStep.field,
              };
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
            return {
              status: 'input-required',
              question: firstStep.question,
              field: firstStep.field,
            };
          }
        });

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'createCampaign', {}, campaignHandler);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data.campaign_id, 'camp_holiday_2024');
        assert.strictEqual(result.data.total_steps, 5);
        assert.strictEqual(result.metadata.clarificationRounds, 5);
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
          if (taskName === 'continue_task') {
            if (params.input === 250000) {
              // High budget, needs manager approval
              return {
                status: 'input-required',
                question: 'Budget over $200k requires manager approval',
                field: 'manager_approval',
              };
            } else if (params.input === 'ESCALATE_TO_DIRECTOR') {
              // Escalated, needs director approval
              return {
                status: 'input-required',
                question: 'Manager escalated to director approval',
                field: 'manager_approval',
              };
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
            return {
              status: 'input-required',
              question: 'What is your campaign budget?',
              field: 'budget',
            };
          }
        });

        const executor = new TaskExecutor();
        const result = await executor.executeTask(mockAgent, 'approvalWorkflow', {}, approvalHandler);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data.budget, 250000);
        assert.strictEqual(result.data.approval_level, 'director');
        assert.strictEqual(result.data.escalations, 2);
      });
    });
  }
);

console.log('🎯 Handler-controlled flow integration tests loaded successfully');
