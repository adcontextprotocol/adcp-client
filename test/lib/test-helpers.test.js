// Test for the test helpers module
const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('Test Helpers', () => {
  test('should export all test helpers from main module', () => {
    const {
      testAgent,
      testAgentA2A,
      testAgentClient,
      createTestAgent,
      TEST_AGENT_TOKEN,
      TEST_AGENT_MCP_CONFIG,
      TEST_AGENT_A2A_CONFIG,
      creativeAgent,
    } = require('../../dist/lib/index.js');

    assert.ok(testAgent, 'testAgent should be exported');
    assert.ok(testAgentA2A, 'testAgentA2A should be exported');
    assert.ok(testAgentClient, 'testAgentClient should be exported');
    assert.strictEqual(typeof createTestAgent, 'function', 'createTestAgent should be a function');
    assert.strictEqual(typeof TEST_AGENT_TOKEN, 'string', 'TEST_AGENT_TOKEN should be a string');
    assert.ok(TEST_AGENT_MCP_CONFIG, 'TEST_AGENT_MCP_CONFIG should be exported');
    assert.ok(TEST_AGENT_A2A_CONFIG, 'TEST_AGENT_A2A_CONFIG should be exported');
    assert.ok(creativeAgent, 'creativeAgent should be exported');
  });

  test('should export from /testing subpath', () => {
    const {
      testAgent,
      testAgentA2A,
      testAgentClient,
      createTestAgent,
      TEST_AGENT_TOKEN,
      TEST_AGENT_MCP_CONFIG,
      TEST_AGENT_A2A_CONFIG,
      creativeAgent,
    } = require('../../dist/lib/testing/index.js');

    assert.ok(testAgent, 'testAgent should be exported from /testing');
    assert.ok(testAgentA2A, 'testAgentA2A should be exported from /testing');
    assert.ok(testAgentClient, 'testAgentClient should be exported from /testing');
    assert.strictEqual(typeof createTestAgent, 'function', 'createTestAgent should be a function');
    assert.strictEqual(typeof TEST_AGENT_TOKEN, 'string', 'TEST_AGENT_TOKEN should be a string');
    assert.ok(TEST_AGENT_MCP_CONFIG, 'TEST_AGENT_MCP_CONFIG should be exported from /testing');
    assert.ok(TEST_AGENT_A2A_CONFIG, 'TEST_AGENT_A2A_CONFIG should be exported from /testing');
    assert.ok(creativeAgent, 'creativeAgent should be exported from /testing');
  });

  test('TEST_AGENT_MCP_CONFIG should have correct structure', () => {
    const { TEST_AGENT_MCP_CONFIG } = require('../../dist/lib/testing/index.js');

    assert.strictEqual(TEST_AGENT_MCP_CONFIG.id, 'test-agent-mcp');
    assert.strictEqual(TEST_AGENT_MCP_CONFIG.protocol, 'mcp');
    assert.strictEqual(TEST_AGENT_MCP_CONFIG.agent_uri, 'https://test-agent.adcontextprotocol.org/mcp/');
    assert.strictEqual(TEST_AGENT_MCP_CONFIG.requiresAuth, true);
    assert.ok(TEST_AGENT_MCP_CONFIG.auth_token_env, 'should have auth_token_env');
  });

  test('TEST_AGENT_A2A_CONFIG should have correct structure', () => {
    const { TEST_AGENT_A2A_CONFIG } = require('../../dist/lib/testing/index.js');

    assert.strictEqual(TEST_AGENT_A2A_CONFIG.id, 'test-agent-a2a');
    assert.strictEqual(TEST_AGENT_A2A_CONFIG.protocol, 'a2a');
    assert.strictEqual(TEST_AGENT_A2A_CONFIG.agent_uri, 'https://test-agent.adcontextprotocol.org');
    assert.strictEqual(TEST_AGENT_A2A_CONFIG.requiresAuth, true);
    assert.ok(TEST_AGENT_A2A_CONFIG.auth_token_env, 'should have auth_token_env');
  });

  test('testAgent should be an AgentClient instance', () => {
    const { testAgent } = require('../../dist/lib/testing/index.js');

    // Check that it has the expected AgentClient methods
    assert.strictEqual(typeof testAgent.getProducts, 'function', 'should have getProducts method');
    assert.strictEqual(typeof testAgent.listCreativeFormats, 'function', 'should have listCreativeFormats method');
    assert.strictEqual(typeof testAgent.createMediaBuy, 'function', 'should have createMediaBuy method');
  });

  test('testAgentA2A should be an AgentClient instance', () => {
    const { testAgentA2A } = require('../../dist/lib/testing/index.js');

    // Check that it has the expected AgentClient methods
    assert.strictEqual(typeof testAgentA2A.getProducts, 'function', 'should have getProducts method');
    assert.strictEqual(typeof testAgentA2A.listCreativeFormats, 'function', 'should have listCreativeFormats method');
    assert.strictEqual(typeof testAgentA2A.createMediaBuy, 'function', 'should have createMediaBuy method');
  });

  test('testAgentClient should be an ADCPMultiAgentClient instance', () => {
    const { testAgentClient } = require('../../dist/lib/testing/index.js');

    // Check that it has the expected MultiAgent methods
    assert.strictEqual(typeof testAgentClient.agent, 'function', 'should have agent method');
    assert.strictEqual(typeof testAgentClient.agents, 'function', 'should have agents method');
    assert.strictEqual(typeof testAgentClient.allAgents, 'function', 'should have allAgents method');
    assert.strictEqual(testAgentClient.agentCount, 2, 'should have 2 agents configured');
  });

  test('testAgentClient should provide access to both agents', () => {
    const { testAgentClient } = require('../../dist/lib/testing/index.js');

    const mcpAgent = testAgentClient.agent('test-agent-mcp');
    const a2aAgent = testAgentClient.agent('test-agent-a2a');

    assert.ok(mcpAgent, 'should be able to access MCP agent');
    assert.ok(a2aAgent, 'should be able to access A2A agent');
    assert.strictEqual(typeof mcpAgent.getProducts, 'function', 'MCP agent should have getProducts');
    assert.strictEqual(typeof a2aAgent.getProducts, 'function', 'A2A agent should have getProducts');
  });

  test('createTestAgent should create valid config', () => {
    const { createTestAgent } = require('../../dist/lib/testing/index.js');

    const config = createTestAgent();

    assert.strictEqual(config.id, 'test-agent-mcp');
    assert.strictEqual(config.protocol, 'mcp');
    assert.ok(config.auth_token_env, 'should have auth_token_env');
  });

  test('createTestAgent should allow overrides', () => {
    const { createTestAgent } = require('../../dist/lib/testing/index.js');

    const config = createTestAgent({
      id: 'custom-test-agent',
      name: 'Custom Test Agent',
    });

    assert.strictEqual(config.id, 'custom-test-agent');
    assert.strictEqual(config.name, 'Custom Test Agent');
    assert.strictEqual(config.protocol, 'mcp'); // unchanged
    assert.ok(config.auth_token_env, 'should retain auth_token_env');
  });

  test('createTestAgent should allow protocol override', () => {
    const { createTestAgent } = require('../../dist/lib/testing/index.js');

    const config = createTestAgent({
      protocol: 'a2a',
      agent_uri: 'https://test-agent.adcontextprotocol.org',
    });

    assert.strictEqual(config.protocol, 'a2a');
    assert.strictEqual(config.agent_uri, 'https://test-agent.adcontextprotocol.org');
  });

  test('TEST_AGENT_TOKEN should be a valid string', () => {
    const { TEST_AGENT_TOKEN } = require('../../dist/lib/testing/index.js');

    assert.strictEqual(typeof TEST_AGENT_TOKEN, 'string');
    assert.ok(TEST_AGENT_TOKEN.length > 0, 'token should not be empty');
    assert.strictEqual(TEST_AGENT_TOKEN, '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ');
  });

  test('creativeAgent should be a CreativeAgentClient instance', () => {
    const { creativeAgent } = require('../../dist/lib/testing/index.js');

    // Check that it has the expected CreativeAgentClient methods
    assert.strictEqual(typeof creativeAgent.listFormats, 'function', 'should have listFormats method');
    assert.strictEqual(typeof creativeAgent.findByType, 'function', 'should have findByType method');
    assert.strictEqual(typeof creativeAgent.findByDimensions, 'function', 'should have findByDimensions method');
    assert.strictEqual(typeof creativeAgent.findById, 'function', 'should have findById method');
  });
});
