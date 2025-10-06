// Advanced mocking strategies for TaskExecutor
// Tests webhook scenarios, protocol integration, and timing patterns

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

/**
 * Mock Strategy Overview:
 * 1. Protocol-level mocking: Mock ProtocolClient.callTool responses
 * 2. Webhook simulation: Use EventEmitter to simulate webhook callbacks
 * 3. Timing control: Use controllable fake timers for polling tests
 * 4. Storage mocking: In-memory implementations for testing
 * 5. Network failure simulation: Controlled error injection
 */

describe('TaskExecutor Mocking Strategies', { skip: process.env.CI ? 'Slow tests - skipped in CI' : false }, () => {
  let TaskExecutor;
  let ProtocolClient;
  let originalCallTool;
  let mockAgent;
  let testEmitter;

  beforeEach(() => {
    // Fresh module imports
    delete require.cache[require.resolve('../../dist/lib/index.js')];
    const lib = require('../../dist/lib/index.js');
    TaskExecutor = lib.TaskExecutor;
    ProtocolClient = lib.ProtocolClient;
    
    originalCallTool = ProtocolClient.callTool;
    
    mockAgent = {
      id: 'mock-agent',
      name: 'Mock Agent',
      agent_uri: 'https://mock.test.com',
      protocol: 'mcp',
      requiresAuth: false
    };

    testEmitter = new EventEmitter();
  });

  afterEach(() => {
    if (originalCallTool) {
      ProtocolClient.callTool = originalCallTool;
    }
    testEmitter.removeAllListeners();
  });

  describe('Webhook Scenario Mocking', () => {
    test('should simulate webhook delivery with EventEmitter', async () => {
      const webhookData = { taskId: 'webhook-task-123', result: { processed: true } };
      let webhookReceived = false;
      
      // Mock webhook manager that uses EventEmitter
      const mockWebhookManager = {
        generateUrl: mock.fn((taskId) => `https://webhook.test/${taskId}`),
        registerWebhook: mock.fn(async (agent, taskId, webhookUrl) => {
          // Simulate webhook delivery after a delay
          setTimeout(() => {
            testEmitter.emit('webhook', taskId, webhookData);
          }, 100);
        }),
        processWebhook: mock.fn(async (token, body) => {
          webhookReceived = true;
          return body;
        })
      };

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'tasks/get') {
          // First poll - still working, then completed
          return {
            task: webhookReceived 
              ? { status: 'completed', result: webhookData.result }
              : { status: 'working' }
          };
        } else {
          return { status: 'submitted' }; // Initial submission
        }
      });

      const executor = new TaskExecutor({
        webhookManager: mockWebhookManager
      });

      const result = await executor.executeTask(
        mockAgent,
        'webhookTask',
        { data: 'test' }
      );

      assert.strictEqual(result.status, 'submitted');
      assert(result.submitted);
      
      // Listen for webhook
      testEmitter.once('webhook', (taskId, data) => {
        assert.strictEqual(taskId, 'webhook-task-123');
        assert.deepStrictEqual(data.result, { processed: true });
      });

      // Trigger the simulated webhook
      await new Promise(resolve => setTimeout(resolve, 150));
      
      assert.strictEqual(mockWebhookManager.generateUrl.mock.callCount(), 1);
      assert.strictEqual(mockWebhookManager.registerWebhook.mock.callCount(), 1);
    });

    test('should handle webhook timeout scenarios', async () => {
      const mockWebhookManager = {
        generateUrl: mock.fn(() => 'https://webhook.test/timeout'),
        registerWebhook: mock.fn(async () => {
          // Simulate no webhook delivery (timeout scenario)
        }),
        processWebhook: mock.fn()
      };

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'tasks/get') {
          // Always return working status (webhook never comes)
          return { task: { status: 'working' } };
        } else {
          return { status: 'submitted' };
        }
      });

      const executor = new TaskExecutor({
        webhookManager: mockWebhookManager
      });

      const result = await executor.executeTask(
        mockAgent,
        'timeoutWebhookTask',
        {}
      );

      assert.strictEqual(result.status, 'submitted');
      
      // Simulate polling with timeout
      const startTime = Date.now();
      try {
        await result.submitted.waitForCompletion(50); // 50ms poll interval
      } catch (error) {
        // Should eventually timeout or continue polling indefinitely
        // In real implementation, you'd have a max poll duration
      }
    });

    test('should mock webhook failure scenarios', async () => {
      const mockWebhookManager = {
        generateUrl: mock.fn(() => 'https://webhook.test/fail'),
        registerWebhook: mock.fn(async () => {
          throw new Error('Webhook registration failed');
        }),
        processWebhook: mock.fn()
      };

      ProtocolClient.callTool = mock.fn(async () => ({ status: 'submitted' }));

      const executor = new TaskExecutor({
        webhookManager: mockWebhookManager
      });

      // Should handle webhook registration failure gracefully
      await assert.rejects(
        executor.executeTask(mockAgent, 'failWebhookTask', {}),
        (error) => {
          assert(error.message.includes('Webhook registration failed'));
          return true;
        }
      );
    });
  });

  describe('Protocol Client Mocking Patterns', () => {
    test('should mock MCP-specific responses', async () => {
      const mcpAgent = { ...mockAgent, protocol: 'mcp' };
      
      // Mock MCP-style response structure
      ProtocolClient.callTool = mock.fn(async (agent, toolName, args) => {
        assert.strictEqual(agent.protocol, 'mcp');
        return {
          status: 'completed',
          result: {
            tool: toolName,
            arguments: args,
            protocol: 'mcp'
          }
        };
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mcpAgent,
        'mcpTool',
        { param1: 'value1' }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.protocol, 'mcp');
      assert.strictEqual(result.data.tool, 'mcpTool');
    });

    test('should mock A2A-specific responses', async () => {
      const a2aAgent = { ...mockAgent, protocol: 'a2a' };
      
      // Mock A2A-style response structure
      ProtocolClient.callTool = mock.fn(async (agent, toolName, parameters) => {
        assert.strictEqual(agent.protocol, 'a2a');
        return {
          status: 'completed',
          data: {
            action: toolName,
            parameters: parameters,
            protocol: 'a2a'
          }
        };
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        a2aAgent,
        'a2aTool',
        { param1: 'value1' }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.protocol, 'a2a');
      assert.strictEqual(result.data.action, 'a2aTool');
    });

    test('should handle authentication token scenarios', async () => {
      const authAgent = {
        ...mockAgent,
        requiresAuth: true,
        auth_token_env: 'TEST_AUTH_TOKEN'
      };

      // Mock authenticated call with token validation
      ProtocolClient.callTool = mock.fn(async (agent, toolName, args, debugLogs) => {
        // Verify authentication was handled
        assert.strictEqual(agent.requiresAuth, true);
        return {
          status: 'completed',
          result: { authenticated: true }
        };
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        authAgent,
        'authTool',
        {}
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.authenticated, true);
    });
  });

  describe('Storage Mocking Strategies', () => {
    test('should use in-memory storage for deferred tasks', async () => {
      const mockStorage = new Map();
      const storageInterface = {
        set: mock.fn(async (key, value) => mockStorage.set(key, value)),
        get: mock.fn(async (key) => mockStorage.get(key)),
        delete: mock.fn(async (key) => mockStorage.delete(key)),
        clear: mock.fn(async () => mockStorage.clear()),
        size: mock.fn(() => mockStorage.size)
      };

      const mockHandler = mock.fn(async () => ({ defer: true, token: 'TEST_STORAGE_TOKEN_PLACEHOLDER' }));

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'continue_task') {
          return { status: 'completed', result: { resumed: true } };
        } else {
          return {
            status: 'input-required',
            question: 'Test storage?',
            contextId: 'ctx-storage'
          };
        }
      });

      const executor = new TaskExecutor({
        deferredStorage: storageInterface
      });

      const result = await executor.executeTask(
        mockAgent,
        'storageTask',
        { testData: 'storage-test' },
        mockHandler
      );

      assert.strictEqual(result.status, 'deferred');
      assert.strictEqual(storageInterface.set.mock.callCount(), 1);
      
      // Verify stored data structure
      const [token, storedState] = storageInterface.set.mock.calls[0].arguments;
      assert.strictEqual(token, 'storage-test-token');
      assert.strictEqual(storedState.taskName, 'storageTask');
      assert.deepStrictEqual(storedState.params, { testData: 'storage-test' });
      assert.strictEqual(storedState.agent.id, 'mock-agent');

      // Test resumption
      const resumeResult = await result.deferred.resume('resumed-value');
      assert.strictEqual(resumeResult.success, true);
      assert.strictEqual(resumeResult.data.resumed, true);
    });

    test('should handle storage failures gracefully', async () => {
      const failingStorage = {
        set: mock.fn(async () => { throw new Error('Storage unavailable'); }),
        get: mock.fn(async () => { throw new Error('Storage unavailable'); }),
        delete: mock.fn(async () => { throw new Error('Storage unavailable'); })
      };

      const mockHandler = mock.fn(async () => ({ defer: true, token: 'fail-token' }));

      ProtocolClient.callTool = mock.fn(async () => ({
        status: 'input-required',
        question: 'Test failing storage?'
      }));

      const executor = new TaskExecutor({
        deferredStorage: failingStorage
      });

      // Storage failure should be handled gracefully
      await assert.rejects(
        executor.executeTask(
          mockAgent,
          'failingStorageTask',
          {},
          mockHandler
        ),
        (error) => {
          assert(error.message.includes('Storage unavailable'));
          return true;
        }
      );
    });
  });

  describe('Timing and Polling Mocking', () => {
    test('should control polling intervals with mock timing', async () => {
      let pollCount = 0;
      const pollStates = ['working', 'working', 'completed'];

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'tasks/get') {
          const state = pollStates[Math.min(pollCount++, pollStates.length - 1)];
          return {
            task: state === 'completed' 
              ? { status: 'completed', result: { polls: pollCount } }
              : { status: 'working' }
          };
        } else {
          return { status: 'working' }; // Initial working state
        }
      });

      const executor = new TaskExecutor({
        workingTimeout: 10000 // Long timeout to allow polling
      });

      const startTime = Date.now();
      const result = await executor.executeTask(
        mockAgent,
        'pollingTask',
        {}
      );

      const elapsed = Date.now() - startTime;
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.polls, 3);
      assert(pollCount >= 3, 'Should have polled at least 3 times');
      
      // Should complete reasonably quickly (polling every 2s by default)
      // but allow some margin for test execution
      assert(elapsed >= 4000, 'Should take at least 4 seconds for 2 polls');
      assert(elapsed < 8000, 'Should not take more than 8 seconds');
    });

    test('should handle rapid polling scenarios', async () => {
      let quickPollCount = 0;
      
      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        if (taskName === 'tasks/get') {
          quickPollCount++;
          return {
            task: quickPollCount >= 5 
              ? { status: 'completed', result: { rapidPolls: quickPollCount } }
              : { status: 'working' }
          };
        } else {
          return { status: 'working' };
        }
      });

      const executor = new TaskExecutor({
        workingTimeout: 2000 // Short timeout
      });

      const result = await executor.executeTask(
        mockAgent,
        'rapidPollingTask',
        {}
      );

      assert.strictEqual(result.success, true);
      assert(quickPollCount >= 5);
    });
  });

  describe('Network Failure Simulation', () => {
    test('should handle intermittent network failures', async () => {
      let callCount = 0;
      const failurePattern = [false, true, false, false]; // fail on second call

      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        callCount++;
        if (failurePattern[callCount - 1]) {
          throw new Error('Network timeout');
        }
        
        if (taskName === 'tasks/get') {
          return { task: { status: 'completed', result: { recovered: true } } };
        } else {
          return { status: 'working' };
        }
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'networkFailureTask',
        {}
      );

      // Should eventually succeed despite network failure
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.recovered, true);
    });

    test('should handle persistent network failures', async () => {
      ProtocolClient.callTool = mock.fn(async () => {
        throw new Error('Connection refused');
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'persistentFailureTask',
        {}
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'Connection refused');
      assert.strictEqual(result.metadata.status, 'failed');
    });

    test('should handle protocol-specific errors', async () => {
      ProtocolClient.callTool = mock.fn(async (agent) => {
        if (agent.protocol === 'mcp') {
          throw new Error('MCP server not responding');
        } else {
          throw new Error('A2A authentication failed');
        }
      });

      const mcpExecutor = new TaskExecutor();
      const mcpResult = await mcpExecutor.executeTask(
        { ...mockAgent, protocol: 'mcp' },
        'mcpFailTask',
        {}
      );

      assert.strictEqual(mcpResult.error, 'MCP server not responding');

      const a2aExecutor = new TaskExecutor();
      const a2aResult = await a2aExecutor.executeTask(
        { ...mockAgent, protocol: 'a2a' },
        'a2aFailTask',
        {}
      );

      assert.strictEqual(a2aResult.error, 'A2A authentication failed');
    });
  });

  describe('Complex Scenario Mocking', () => {
    test('should handle multi-step workflow with various states', async () => {
      const workflowSteps = [
        { status: 'working' },
        { status: 'input-required', question: 'Confirm action?', field: 'confirm' },
        { status: 'working' },
        { status: 'completed', result: { workflow: 'completed', steps: 4 } }
      ];
      
      let stepIndex = 0;
      const mockHandler = mock.fn(async (context) => {
        if (context.inputRequest.field === 'confirm') {
          return 'YES';
        }
        return 'default';
      });

      ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
        if (taskName === 'tasks/get') {
          // Move to next step in workflow
          const step = workflowSteps[Math.min(stepIndex++, workflowSteps.length - 1)];
          return { task: step };
        } else if (taskName === 'continue_task') {
          // Handler provided input, continue to next step
          return workflowSteps[2]; // Skip to working state
        } else {
          // Initial call
          return workflowSteps[0];
        }
      });

      const executor = new TaskExecutor();
      const result = await executor.executeTask(
        mockAgent,
        'workflowTask',
        {},
        mockHandler
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.workflow, 'completed');
      assert.strictEqual(result.data.steps, 4);
      assert.strictEqual(mockHandler.mock.callCount(), 1);
    });

    test('should simulate real-world task progression timing', async () => {
      const realWorldSteps = [
        { status: 'working', message: 'Initializing...' },
        { status: 'working', message: 'Processing data...' },
        { status: 'working', message: 'Generating results...' },
        { status: 'completed', result: { processed: 1000, generated: 50 } }
      ];

      let stepIndex = 0;
      const stepDurations = [500, 1000, 800, 0]; // Milliseconds for each step

      ProtocolClient.callTool = mock.fn(async (agent, taskName) => {
        if (taskName === 'tasks/get') {
          // Simulate realistic timing
          const currentStep = Math.min(stepIndex, realWorldSteps.length - 1);
          const step = realWorldSteps[currentStep];
          
          if (stepIndex < realWorldSteps.length - 1) {
            setTimeout(() => stepIndex++, stepDurations[stepIndex]);
          }
          
          return { task: step };
        } else {
          return realWorldSteps[0]; // Initial working state
        }
      });

      const executor = new TaskExecutor({
        workingTimeout: 5000 // 5 second timeout
      });

      const startTime = Date.now();
      const result = await executor.executeTask(
        mockAgent,
        'realWorldTask',
        {}
      );
      const elapsed = Date.now() - startTime;

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.processed, 1000);
      assert.strictEqual(result.data.generated, 50);
      
      // Should take approximately the sum of step durations
      const expectedDuration = stepDurations.reduce((a, b) => a + b, 0);
      assert(elapsed >= expectedDuration * 0.8, 'Should take at least 80% of expected duration');
      assert(elapsed <= expectedDuration * 2, 'Should not take more than 2x expected duration');
    });
  });
});

console.log('🎭 TaskExecutor mocking strategy test suite loaded successfully');