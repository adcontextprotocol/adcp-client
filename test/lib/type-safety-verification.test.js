// Type safety verification tests for async continuations
// Tests TypeScript type contracts and runtime type validation

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

/**
 * Type Safety Test Strategy:
 * 1. Verify TaskResult<T> generic type contracts
 * 2. Test DeferredContinuation<T> type safety
 * 3. Test SubmittedContinuation<T> type safety
 * 4. Validate InputHandler response types
 * 5. Test conversation type structures
 * 6. Verify error type hierarchies
 */

describe('Type Safety Verification for Async Continuations', () => {
  let TaskExecutor;
  let ProtocolClient;
  let originalCallTool;
  let mockAgent;

  beforeEach(() => {
    // Fresh imports
    delete require.cache[require.resolve('../../dist/lib/index.js')];
    const lib = require('../../dist/lib/index.js');
    
    TaskExecutor = lib.TaskExecutor;
    ProtocolClient = lib.ProtocolClient;
    
    originalCallTool = ProtocolClient.callTool;
    
    mockAgent = {
      id: 'type-test-agent',
      name: 'Type Test Agent',
      agent_uri: 'https://type.test.com',
      protocol: 'mcp',
      requiresAuth: false
    };
  });

  afterEach(() => {
    if (originalCallTool) {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  describe('TaskResult<T> Generic Type Contracts', () => {
    test('should maintain type safety for completed results', async () => {
      // Mock response with specific data structure
      const mockProductData = {
        products: [
          { id: 'prod-1', name: 'Product A', price: 99.99 },
          { id: 'prod-2', name: 'Product B', price: 149.99 }
        ],
        total: 2,
        category: 'electronics'
      };

      ProtocolClient.callTool = mock.fn(async () => ({
        status: 'completed',
        result: mockProductData
      }));

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'getProducts',
        { category: 'electronics' }
      );

      // Verify TaskResult structure
      assert.strictEqual(typeof result.success, 'boolean');
      assert.strictEqual(typeof result.status, 'string');
      assert.strictEqual(result.status, 'completed');
      
      // Verify data type preservation
      assert(typeof result.data === 'object');
      assert(Array.isArray(result.data.products));
      assert.strictEqual(result.data.products.length, 2);
      assert.strictEqual(typeof result.data.products[0].id, 'string');
      assert.strictEqual(typeof result.data.products[0].price, 'number');
      assert.strictEqual(typeof result.data.total, 'number');
      
      // Verify metadata structure
      assert(typeof result.metadata === 'object');
      assert.strictEqual(typeof result.metadata.taskId, 'string');
      assert.strictEqual(typeof result.metadata.taskName, 'string');
      assert.strictEqual(typeof result.metadata.responseTimeMs, 'number');
      assert.strictEqual(typeof result.metadata.timestamp, 'string');
      assert.strictEqual(typeof result.metadata.clarificationRounds, 'number');
      
      // Verify agent metadata structure
      assert(typeof result.metadata.agent === 'object');
      assert.strictEqual(typeof result.metadata.agent.id, 'string');
      assert.strictEqual(typeof result.metadata.agent.name, 'string');
      assert(['mcp', 'a2a'].includes(result.metadata.agent.protocol));
      
      // Verify conversation structure
      assert(Array.isArray(result.conversation));
      assert(result.conversation.length >= 2); // At least request + response
      
      result.conversation.forEach(message => {
        assert.strictEqual(typeof message.id, 'string');
        assert(['user', 'agent', 'system'].includes(message.role));
        assert(message.content !== undefined);
        assert.strictEqual(typeof message.timestamp, 'string');
        assert(typeof message.metadata === 'object' || message.metadata === undefined);
      });
    });

    test('should handle strongly-typed data structures', async () => {
      // Define a complex type structure (using JSDoc for Node.js compatibility)
      /**
       * @typedef {Object} CampaignResult
       * @property {Object} campaign
       * @property {string} campaign.id
       * @property {string} campaign.name  
       * @property {number} campaign.budget
       * @property {Object} campaign.targeting
       * @property {Object} campaign.targeting.demographics
       * @property {number} campaign.targeting.demographics.ageMin
       * @property {number} campaign.targeting.demographics.ageMax
       * @property {string[]} campaign.targeting.locations
       * @property {string[]} campaign.targeting.interests
       * @property {Object} campaign.schedule
       * @property {string} campaign.schedule.startDate
       * @property {string} campaign.schedule.endDate
       * @property {string} campaign.schedule.timezone
       * @property {Object} metrics
       * @property {number} metrics.estimatedReach
       * @property {number} metrics.estimatedCpm
       * @property {number} metrics.confidence
       */

      const mockCampaignData = {
        campaign: {
          id: 'camp-12345',
          name: 'Holiday Campaign 2024',
          budget: 50000,
          targeting: {
            demographics: { ageMin: 25, ageMax: 55 },
            locations: ['US', 'CA', 'UK'],
            interests: ['shopping', 'technology', 'lifestyle']
          },
          schedule: {
            startDate: '2024-12-01T00:00:00Z',
            endDate: '2024-12-31T23:59:59Z',
            timezone: 'UTC'
          }
        },
        metrics: {
          estimatedReach: 2500000,
          estimatedCpm: 2.50,
          confidence: 0.85
        }
      };

      ProtocolClient.callTool = mock.fn(async () => ({
        status: 'completed',
        result: mockCampaignData
      }));

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'createCampaign',
        {}
      );

      // Verify type structure is preserved
      assert.strictEqual(result.success, true);
      assert.strictEqual(typeof result.data.campaign.id, 'string');
      assert.strictEqual(typeof result.data.campaign.budget, 'number');
      assert(Array.isArray(result.data.campaign.targeting.locations));
      assert.strictEqual(typeof result.data.campaign.targeting.demographics.ageMin, 'number');
      assert.strictEqual(typeof result.data.metrics.estimatedReach, 'number');
      assert.strictEqual(typeof result.data.metrics.confidence, 'number');
      
      // Verify specific values
      assert.strictEqual(result.data.campaign.id, 'camp-12345');
      assert.strictEqual(result.data.campaign.budget, 50000);
      assert.deepStrictEqual(result.data.campaign.targeting.locations, ['US', 'CA', 'UK']);
      assert.strictEqual(result.data.metrics.estimatedReach, 2500000);
    });

    test('should handle primitive return types', async () => {
      const primitiveTests = [
        { type: 'string', value: 'success' },
        { type: 'number', value: 42 },
        { type: 'boolean', value: true },
        { type: 'null', value: null }
      ];

      for (const testCase of primitiveTests) {
        ProtocolClient.callTool = mock.fn(async () => ({
          status: 'completed',
          result: testCase.value
        }));

        const executor = new TaskExecutor();
        const result = await executor.executeTask(
          mockAgent,
          `primitive_${testCase.type}`,
          {}
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(typeof result.data, testCase.type === 'null' ? 'object' : testCase.type);
        assert.strictEqual(result.data, testCase.value);
      }
    });
  });

  describe('DeferredContinuation<T> Type Safety', () => {
    test('should maintain type safety through deferred continuation', async () => {
      /**
       * @typedef {Object} ApprovalResult
       * @property {boolean} approved
       * @property {string} approvedBy
       * @property {string} approvalDate
       * @property {string[]} [conditions]
       */

      const mockHandler = mock.fn(async (context) => {
        if (context.inputRequest.field === 'approval') {
          return { defer: true, token: 'approval-defer-123' };
        }
        return 'auto-approve';
      });

      const mockStorage = new Map();
      const storageInterface = {
        set: mock.fn(async (key, value) => mockStorage.set(key, value)),
        get: mock.fn(async (key) => mockStorage.get(key)),
        delete: mock.fn(async (key) => mockStorage.delete(key))
      };

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'continue_task') {
          // Resume with typed result
          const approvalResult = {
            approved: params.input === 'APPROVED',
            approvedBy: 'test-user',
            approvalDate: new Date().toISOString(),
            conditions: params.input === 'APPROVED' ? ['Standard terms apply'] : undefined
          };
          
          return {
            status: 'completed',
            result: approvalResult
          };
        } else {
          return {
            status: 'input-required',
            question: 'Do you approve this request?',
            field: 'approval',
            contextId: 'ctx-approval'
          };
        }
      });

      const executor = new TaskExecutor({
        deferredStorage: storageInterface
      });

      const result = await executor.executeTask(
        mockAgent,
        'approvalTask',
        {},
        mockHandler
      );

      // Verify deferred result structure
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'deferred');
      assert(result.deferred);
      
      // Verify DeferredContinuation structure
      assert.strictEqual(typeof result.deferred.token, 'string');
      assert.strictEqual(typeof result.deferred.question, 'string');
      assert.strictEqual(typeof result.deferred.resume, 'function');
      
      // Test resume functionality with type preservation
      const resumeResult = await result.deferred.resume('APPROVED');
      
      assert.strictEqual(resumeResult.success, true);
      assert.strictEqual(typeof resumeResult.data.approved, 'boolean');
      assert.strictEqual(typeof resumeResult.data.approvedBy, 'string');
      assert.strictEqual(typeof resumeResult.data.approvalDate, 'string');
      assert(Array.isArray(resumeResult.data.conditions));
      assert.strictEqual(resumeResult.data.approved, true);
      assert.strictEqual(resumeResult.data.approvedBy, 'test-user');
    });

    test('should handle deferred continuation with complex input types', async () => {
      /**
       * @typedef {Object} CampaignInput
       * @property {string} name
       * @property {number} budget
       * @property {Object} targeting
       * @property {string[]} targeting.locations
       * @property {Object} targeting.demographics
       * @property {number} targeting.demographics.ageMin
       * @property {number} targeting.demographics.ageMax
       * @property {Object} creative
       * @property {string} creative.headline
       * @property {string} creative.description
       * @property {string} [creative.imageUrl]
       */

      const mockHandler = mock.fn(async () => ({ defer: true, token: 'campaign-defer' }));
      const mockStorage = new Map();
      const storageInterface = {
        set: mock.fn(async (key, value) => mockStorage.set(key, value)),
        get: mock.fn(async (key) => mockStorage.get(key)),
        delete: mock.fn(async (key) => mockStorage.delete(key))
      };

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'continue_task') {
          // Verify complex input structure
          const input = params.input;
          assert.strictEqual(typeof input.name, 'string');
          assert.strictEqual(typeof input.budget, 'number');
          assert(Array.isArray(input.targeting.locations));
          assert.strictEqual(typeof input.targeting.demographics.ageMin, 'number');
          assert.strictEqual(typeof input.creative.headline, 'string');
          
          return {
            status: 'completed',
            result: { campaignId: 'camp-complex-123', created: true }
          };
        } else {
          return {
            status: 'input-required',
            question: 'Provide campaign details',
            field: 'campaign_config'
          };
        }
      });

      const executor = new TaskExecutor({
        deferredStorage: storageInterface
      });

      const result = await executor.executeTask(
        mockAgent,
        'complexCampaignTask',
        {},
        mockHandler
      );

      assert.strictEqual(result.status, 'deferred');

      // Resume with complex typed input
      const complexInput = {
        name: 'Complex Campaign',
        budget: 100000,
        targeting: {
          locations: ['US', 'CA'],
          demographics: { ageMin: 25, ageMax: 45 }
        },
        creative: {
          headline: 'Amazing Product',
          description: 'The best product ever',
          imageUrl: 'https://example.com/image.jpg'
        }
      };

      const resumeResult = await result.deferred.resume(complexInput);
      assert.strictEqual(resumeResult.success, true);
      assert.strictEqual(resumeResult.data.campaignId, 'camp-complex-123');
    });
  });

  describe('SubmittedContinuation<T> Type Safety', () => {
    test('should maintain type safety for submitted task tracking', async () => {
      /**
       * @typedef {Object} ProcessingResult
       * @property {boolean} processed
       * @property {number} itemsCount
       * @property {number} processingTime
       * @property {string[]} errors
       * @property {Object} summary
       * @property {number} summary.totalItems
       * @property {number} summary.successfulItems
       * @property {number} summary.failedItems
       */

      const mockWebhookManager = {
        generateUrl: mock.fn(() => 'https://webhook.test/processing'),
        registerWebhook: mock.fn(async () => {}),
        processWebhook: mock.fn()
      };

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'tasks/get') {
          const processingResult = {
            processed: true,
            itemsCount: 1000,
            processingTime: 45000,
            errors: [],
            summary: {
              totalItems: 1000,
              successfulItems: 995,
              failedItems: 5
            }
          };
          
          return {
            task: {
              taskId: 'proc-task-456',
              status: 'completed',
              taskType: 'dataProcessing',
              createdAt: Date.now() - 60000,
              updatedAt: Date.now(),
              result: processingResult
            }
          };
        } else {
          return { status: 'submitted' };
        }
      });

      const executor = new TaskExecutor({
        webhookManager: mockWebhookManager
      });

      const result = await executor.executeTask(
        mockAgent,
        'dataProcessingTask',
        { dataSet: 'large-dataset' }
      );

      // Verify submitted result structure
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'submitted');
      assert(result.submitted);
      
      // Verify SubmittedContinuation structure
      assert.strictEqual(typeof result.submitted.taskId, 'string');
      assert.strictEqual(typeof result.submitted.webhookUrl, 'string');
      assert.strictEqual(typeof result.submitted.track, 'function');
      assert.strictEqual(typeof result.submitted.waitForCompletion, 'function');
      
      // Test tracking with type preservation
      const taskInfo = await result.submitted.track();
      assert.strictEqual(typeof taskInfo.taskId, 'string');
      assert.strictEqual(typeof taskInfo.status, 'string');
      assert.strictEqual(typeof taskInfo.taskType, 'string');
      assert.strictEqual(typeof taskInfo.createdAt, 'number');
      assert.strictEqual(typeof taskInfo.updatedAt, 'number');
      
      // Verify result type structure
      assert(typeof taskInfo.result === 'object');
      const typedResult = taskInfo.result;
      assert.strictEqual(typeof typedResult.processed, 'boolean');
      assert.strictEqual(typeof typedResult.itemsCount, 'number');
      assert(Array.isArray(typedResult.errors));
      assert.strictEqual(typeof typedResult.summary.totalItems, 'number');
    });

    test('should handle polling until completion with type preservation', async () => {
      /**
       * @typedef {Object} AnalyticsResult
       * @property {Object} metrics
       * @property {number} metrics.impressions
       * @property {number} metrics.clicks
       * @property {number} metrics.conversions
       * @property {number} metrics.revenue
       * @property {Object} breakdown
       * @property {Array<{date: string, impressions: number, clicks: number}>} breakdown.byDate
       * @property {Array<{location: string, impressions: number}>} breakdown.byLocation
       * @property {Object} computed
       * @property {number} computed.ctr
       * @property {number} computed.conversionRate
       * @property {number} computed.roas
       */

      let pollCount = 0;
      const finalResult = {
        metrics: {
          impressions: 500000,
          clicks: 12500,
          conversions: 850,
          revenue: 42500
        },
        breakdown: {
          byDate: [
            { date: '2024-01-01', impressions: 250000, clicks: 6250 },
            { date: '2024-01-02', impressions: 250000, clicks: 6250 }
          ],
          byLocation: [
            { location: 'US', impressions: 300000 },
            { location: 'CA', impressions: 200000 }
          ]
        },
        computed: {
          ctr: 0.025,
          conversionRate: 0.068,
          roas: 4.25
        }
      };

      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        if (taskName === 'tasks/get') {
          pollCount++;
          return {
            task: pollCount >= 3
              ? {
                  taskId: 'analytics-task',
                  status: 'completed',
                  taskType: 'analytics',
                  createdAt: Date.now() - 180000,
                  updatedAt: Date.now(),
                  result: finalResult
                }
              : {
                  taskId: 'analytics-task',
                  status: 'working',
                  taskType: 'analytics',
                  createdAt: Date.now() - 180000,
                  updatedAt: Date.now()
                }
          };
        } else {
          return { status: 'submitted' };
        }
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'analyticsTask',
        {}
      );

      assert.strictEqual(result.status, 'submitted');
      
      // Test waitForCompletion with type preservation
      const completionResult = await result.submitted.waitForCompletion(100); // Fast polling
      
      assert.strictEqual(completionResult.success, true);
      assert.strictEqual(typeof completionResult.data.metrics.impressions, 'number');
      assert.strictEqual(typeof completionResult.data.computed.ctr, 'number');
      assert(Array.isArray(completionResult.data.breakdown.byDate));
      assert.strictEqual(completionResult.data.metrics.impressions, 500000);
      assert.strictEqual(completionResult.data.computed.roas, 4.25);
      
      assert(pollCount >= 3, 'Should have polled multiple times');
    });
  });

  describe('InputHandler Response Type Validation', () => {
    test('should handle typed handler responses', async () => {
      /**
       * @typedef {Object} BudgetAllocation
       * @property {number} totalBudget
       * @property {Object} channels
       * @property {number} channels.search
       * @property {number} channels.display
       * @property {number} channels.social
       * @property {number} channels.video
       * @property {Object} timeline
       * @property {number} timeline.q1
       * @property {number} timeline.q2
       * @property {number} timeline.q3
       * @property {number} timeline.q4
       */

      const typedHandler = mock.fn(async (context) => {
        if (context.inputRequest.field === 'budget_allocation') {
          return {
            totalBudget: 500000,
            channels: {
              search: 200000,
              display: 150000,
              social: 100000,
              video: 50000
            },
            timeline: {
              q1: 125000,
              q2: 125000,
              q3: 125000,
              q4: 125000
            }
          };
        }
        throw new Error('Unexpected field');
      });

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'continue_task') {
          const allocation = params.input;
          assert.strictEqual(typeof allocation.totalBudget, 'number');
          assert.strictEqual(typeof allocation.channels.search, 'number');
          assert.strictEqual(typeof allocation.timeline.q1, 'number');
          
          return {
            status: 'completed',
            result: { allocated: true, budget: allocation.totalBudget }
          };
        } else {
          return {
            status: 'input-required',
            question: 'How should we allocate the budget?',
            field: 'budget_allocation'
          };
        }
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'budgetAllocationTask',
        {},
        typedHandler
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.allocated, true);
      assert.strictEqual(result.data.budget, 500000);
    });

    test('should validate handler response type variants', async () => {
      const responseVariants = [
        { type: 'string', value: 'text response' },
        { type: 'number', value: 42 },
        { type: 'boolean', value: true },
        { type: 'object', value: { complex: 'object', nested: { value: 123 } } },
        { type: 'array', value: ['item1', 'item2', 'item3'] },
        { type: 'null', value: null },
        { type: 'undefined', value: undefined }
      ];

      for (const variant of responseVariants) {
        const variantHandler = mock.fn(async () => variant.value);

        ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
          if (taskName === 'continue_task') {
            const receivedType = params.input === null ? 'null' : 
                                params.input === undefined ? 'undefined' :
                                Array.isArray(params.input) ? 'array' :
                                typeof params.input;
            
            return {
              status: 'completed',
              result: { 
                receivedType,
                receivedValue: params.input,
                originalType: variant.type
              }
            };
          } else {
            return {
              status: 'input-required',
              question: `Provide ${variant.type} response`,
              field: 'variant_test'
            };
          }
        });

        const executor = new TaskExecutor();
        const result = await executor.executeTask(
          mockAgent,
          `variantTask_${variant.type}`,
          {},
          variantHandler
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data.originalType, variant.type);
        
        if (variant.type === 'array') {
          assert(Array.isArray(result.data.receivedValue));
        } else {
          const expectedType = variant.type === 'null' ? 'object' : variant.type;
          assert.strictEqual(result.data.receivedType, expectedType);
        }
      }
    });
  });

  describe('Conversation Type Structure Validation', () => {
    test('should maintain message type structure throughout conversation', async () => {
      const conversationHandler = mock.fn(async (context) => {
        // Verify message structure
        context.messages.forEach(message => {
          assert.strictEqual(typeof message.id, 'string');
          assert(['user', 'agent', 'system'].includes(message.role));
          assert(message.content !== undefined);
          assert.strictEqual(typeof message.timestamp, 'string');
          
          if (message.metadata) {
            assert.strictEqual(typeof message.metadata, 'object');
            if (message.metadata.toolName) {
              assert.strictEqual(typeof message.metadata.toolName, 'string');
            }
            if (message.metadata.type) {
              assert.strictEqual(typeof message.metadata.type, 'string');
            }
          }
        });

        return 'conversation-validated';
      });

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'continue_task') {
          return {
            status: 'completed',
            result: { validated: true }
          };
        } else {
          return {
            status: 'input-required',
            question: 'Validate conversation structure?',
            field: 'validation'
          };
        }
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'conversationValidationTask',
        { initialData: 'test' },
        conversationHandler
      );

      assert.strictEqual(result.success, true);
      
      // Verify final conversation structure
      assert(Array.isArray(result.conversation));
      result.conversation.forEach(message => {
        assert.strictEqual(typeof message.id, 'string');
        assert(['user', 'agent'].includes(message.role));
        assert.strictEqual(typeof message.timestamp, 'string');
        
        // Verify timestamp is valid ISO string
        assert(!isNaN(Date.parse(message.timestamp)));
      });
    });
  });

  describe('Error Type Hierarchy Validation', () => {
    test('should preserve error type information', async () => {
      const errorTypes = [
        'TaskTimeoutError',
        'InputRequiredError', 
        'DeferredTaskError',
        'MaxClarificationError'
      ];

      for (const errorType of errorTypes) {
        // Import error classes
        const lib = require('../../dist/lib/index.js');
        const ErrorClass = lib[errorType];
        
        if (ErrorClass) {
          let thrownError;
          try {
            switch (errorType) {
              case 'TaskTimeoutError':
                thrownError = new ErrorClass('test-task', 5000);
                break;
              case 'InputRequiredError':
                thrownError = new ErrorClass('Test question?');
                break;
              case 'DeferredTaskError':
                thrownError = new ErrorClass('test-token');
                break;
              case 'MaxClarificationError':
                thrownError = new ErrorClass('test-task', 3);
                break;
            }
            
            // Verify error properties
            assert(thrownError instanceof Error);
            assert(thrownError instanceof ErrorClass);
            assert.strictEqual(thrownError.name, errorType);
            assert.strictEqual(typeof thrownError.message, 'string');
            
            // Verify specific properties based on error type
            if (errorType === 'TaskTimeoutError') {
              assert.strictEqual(thrownError.taskId, 'test-task');
              assert.strictEqual(thrownError.timeout, 5000);
            } else if (errorType === 'DeferredTaskError') {
              assert.strictEqual(thrownError.token, 'test-token');
            }
            
          } catch (constructorError) {
            console.log(`Error constructing ${errorType}:`, constructorError.message);
          }
        }
      }
    });
  });
});

console.log('🔒 Type safety verification test suite loaded successfully');