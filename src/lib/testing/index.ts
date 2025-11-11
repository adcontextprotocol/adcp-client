// Test helpers for AdCP client library
// Provides pre-configured test agents for examples and quick testing

export {
  // Test agents (with auth)
  testAgent,
  testAgentA2A,
  testAgentClient,
  createTestAgent,
  TEST_AGENT_TOKEN,
  TEST_AGENT_MCP_CONFIG,
  TEST_AGENT_A2A_CONFIG,
  // Test agents (without auth - for demonstrating auth requirements)
  testAgentNoAuth,
  testAgentNoAuthA2A,
  TEST_AGENT_NO_AUTH_MCP_CONFIG,
  TEST_AGENT_NO_AUTH_A2A_CONFIG,
  // Creative agents (MCP only - A2A not yet supported)
  creativeAgent,
} from './test-helpers';
