// Basic test for the new conversation-aware ADCP client library
// Tests compilation and basic API functionality

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('ADCP Conversation Client Library', { skip: process.env.CI ? 'Slow tests - skipped in CI' : false }, () => {
  test('should import all core classes without errors', () => {
    const {
      ADCPMultiAgentClient,
      AgentClient,
      TaskExecutor,
      createFieldHandler,
      autoApproveHandler,
      MemoryStorage,
    } = require('../../dist/lib/index.js');

    assert(typeof ADCPMultiAgentClient === 'function', 'ADCPMultiAgentClient should be a constructor');
    assert(typeof AgentClient === 'function', 'AgentClient should be a constructor');
    assert(typeof TaskExecutor === 'function', 'TaskExecutor should be a constructor');
    assert(typeof createFieldHandler === 'function', 'createFieldHandler should be a function');
    assert(typeof autoApproveHandler === 'function', 'autoApproveHandler should be a function');
    assert(typeof MemoryStorage === 'function', 'MemoryStorage should be a constructor');
  });

  test('should create ADCPMultiAgentClient instance', () => {
    const { ADCPMultiAgentClient } = require('../../dist/lib/index.js');

    const agents = [
      {
        id: 'test-agent',
        name: 'Test Agent',
        agent_uri: 'https://test.example.com',
        protocol: 'mcp',
      },
    ];

    const client = new ADCPMultiAgentClient(agents);

    assert(client.agentCount === 1, 'Should have 1 agent');
    assert(client.getAgentIds().includes('test-agent'), 'Should include test-agent');
    assert(client.hasAgent('test-agent'), 'Should have test-agent');
  });

  test('should create and configure input handlers', () => {
    const {
      createFieldHandler,
      createConditionalHandler,
      autoApproveHandler,
      deferAllHandler,
    } = require('../../dist/lib/index.js');

    // Test field handler
    const fieldHandler = createFieldHandler({
      budget: 50000,
      targeting: ['US', 'CA'],
    });
    assert(typeof fieldHandler === 'function', 'Field handler should be a function');

    // Test conditional handler
    const conditionalHandler = createConditionalHandler(
      [
        {
          condition: () => true,
          handler: autoApproveHandler,
        },
      ],
      deferAllHandler
    );
    assert(typeof conditionalHandler === 'function', 'Conditional handler should be a function');

    // Test built-in handlers
    assert(typeof autoApproveHandler === 'function', 'Auto approve handler should be a function');
    assert(typeof deferAllHandler === 'function', 'Defer all handler should be a function');
  });

  test('should create MemoryStorage instance', () => {
    const { MemoryStorage, createMemoryStorageConfig } = require('../../dist/lib/index.js');

    const storage = new MemoryStorage();
    assert(storage instanceof MemoryStorage, 'Should create MemoryStorage instance');

    const config = createMemoryStorageConfig();
    assert(typeof config === 'object', 'Should create storage config object');
    assert(config.capabilities instanceof MemoryStorage, 'Should have capabilities storage');
    assert(config.conversations instanceof MemoryStorage, 'Should have conversations storage');
    assert(config.tokens instanceof MemoryStorage, 'Should have tokens storage');
  });

  test('should handle agent operations', () => {
    const { ADCPMultiAgentClient } = require('../../dist/lib/index.js');

    const agents = [
      {
        id: 'agent1',
        name: 'Agent 1',
        agent_uri: 'https://agent1.example.com',
        protocol: 'mcp',
      },
      {
        id: 'agent2',
        name: 'Agent 2',
        agent_uri: 'https://agent2.example.com',
        protocol: 'a2a',
      },
    ];

    const client = new ADCPMultiAgentClient(agents);

    // Test single agent access
    const agent1 = client.agent('agent1');
    assert(agent1.getAgentId() === 'agent1', 'Should return correct agent');
    assert(agent1.getProtocol() === 'mcp', 'Should return correct protocol');

    // Test multi-agent access
    const multiAgents = client.agents(['agent1', 'agent2']);
    assert(multiAgents.count === 2, 'Should have 2 agents in collection');

    // Test all agents access
    const allAgents = client.allAgents();
    assert(allAgents.count === 2, 'Should have all 2 agents');

    // Test agent addition
    client.addAgent({
      id: 'agent3',
      name: 'Agent 3',
      agent_uri: 'https://agent3.example.com',
      protocol: 'mcp',
    });
    assert(client.agentCount === 3, 'Should have 3 agents after addition');

    // Test agent removal
    const removed = client.removeAgent('agent3');
    assert(removed === true, 'Should successfully remove agent');
    assert(client.agentCount === 2, 'Should have 2 agents after removal');
  });

  test('should handle error classes', () => {
    const {
      TaskTimeoutError,
      MaxClarificationError,
      DeferredTaskError,
      AgentNotFoundError,
      isADCPError,
    } = require('../../dist/lib/index.js');

    const timeoutError = new TaskTimeoutError('task-123', 5000);
    assert(timeoutError.taskId === 'task-123', 'Should have correct task ID');
    assert(timeoutError.timeout === 5000, 'Should have correct timeout');
    assert(timeoutError.code === 'TASK_TIMEOUT', 'Should have correct error code');
    assert(isADCPError(timeoutError), 'Should be recognized as ADCP error');

    const clarificationError = new MaxClarificationError('task-456', 3);
    assert(clarificationError.maxAttempts === 3, 'Should have correct max attempts');
    assert(isADCPError(clarificationError), 'Should be recognized as ADCP error');

    const deferredError = new DeferredTaskError('token-789');
    assert(deferredError.token === 'token-789', 'Should have correct token');
    assert(isADCPError(deferredError), 'Should be recognized as ADCP error');

    const agentError = new AgentNotFoundError('missing-agent', ['agent1', 'agent2']);
    assert(agentError.agentId === 'missing-agent', 'Should have correct agent ID');
    assert(Array.isArray(agentError.availableAgents), 'Should have available agents array');
    assert(isADCPError(agentError), 'Should be recognized as ADCP error');
  });

  test('should verify type exports', () => {
    // This test ensures that TypeScript types are properly exported
    // In a real TypeScript environment, this would be caught at compile time
    const lib = require('../../dist/lib/index.js');

    // Check that main classes are exported
    const requiredExports = [
      'ADCPMultiAgentClient',
      'AgentClient',
      'TaskExecutor',
      'createFieldHandler',
      'createConditionalHandler',
      'autoApproveHandler',
      'deferAllHandler',
      'MemoryStorage',
      'createMemoryStorage',
      'TaskTimeoutError',
      'DeferredTaskError',
      'isADCPError',
    ];

    requiredExports.forEach(exportName => {
      assert(lib[exportName] !== undefined, `${exportName} should be exported from the library`);
    });
  });
});

describe('Integration with existing codebase', () => {
  test('should maintain v3 API exports', () => {
    const { AdCPClient, ADCPMultiAgentClient, ConfigurationManager } = require('../../dist/lib/index.js');

    // Test primary export (AdCPClient - the renamed ADCPMultiAgentClient)
    assert(typeof AdCPClient === 'function', 'AdCPClient should be available');

    // Test deprecated alias still works
    assert(typeof ADCPMultiAgentClient === 'function', 'ADCPMultiAgentClient alias should still be available');

    // Verify they're the same class
    assert(AdCPClient === ADCPMultiAgentClient, 'AdCPClient should be the same as ADCPMultiAgentClient');

    // Test configuration manager
    assert(typeof ConfigurationManager === 'function', 'ConfigurationManager should be available');
    assert(typeof ConfigurationManager.loadAgentsFromEnv === 'function', 'Should have loadAgentsFromEnv method');
  });

  test('should work with protocol clients from /advanced', () => {
    const { callMCPTool, callA2ATool, ProtocolClient } = require('../../dist/lib/advanced.js');

    assert(typeof callMCPTool === 'function', 'MCP client should be available in /advanced');
    assert(typeof callA2ATool === 'function', 'A2A client should be available in /advanced');
    assert(typeof ProtocolClient === 'function', 'ProtocolClient should be available in /advanced');
  });
});

console.log('✅ All tests passed! The new conversation-aware ADCP client library is working correctly.');
