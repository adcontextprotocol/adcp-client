// Test agent helpers for easy examples and quick testing
// These provide pre-configured access to AdCP's public test agent

import { ADCPMultiAgentClient } from '../core/ADCPMultiAgentClient';
import { CreativeAgentClient, STANDARD_CREATIVE_AGENTS } from '../core/CreativeAgentClient';
import type { AgentClient } from '../core/AgentClient';
import type { AgentConfig } from '../types';

/**
 * Public test agent auth token
 * This token is public and rate-limited, for testing/examples only.
 */
export const TEST_AGENT_TOKEN = '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ';

/**
 * Public test agent configuration - MCP protocol
 * This is the raw configuration object if you need to customize it
 */
export const TEST_AGENT_MCP_CONFIG: AgentConfig = {
  id: 'test-agent-mcp',
  name: 'AdCP Public Test Agent (MCP)',
  agent_uri: 'https://test-agent.adcontextprotocol.org/mcp/',
  protocol: 'mcp',
  auth_token_env: TEST_AGENT_TOKEN,
  requiresAuth: true,
};

/**
 * Public test agent configuration - A2A protocol
 * This is the raw configuration object if you need to customize it
 */
export const TEST_AGENT_A2A_CONFIG: AgentConfig = {
  id: 'test-agent-a2a',
  name: 'AdCP Public Test Agent (A2A)',
  agent_uri: 'https://test-agent.adcontextprotocol.org',
  protocol: 'a2a',
  auth_token_env: TEST_AGENT_TOKEN,
  requiresAuth: true,
};

/**
 * Pre-configured test agent client using MCP protocol.
 * Ready to use for examples, documentation, and quick testing.
 *
 * @example
 * ```typescript
 * import { testAgent } from '@adcp/client/testing';
 *
 * // Simple getProducts call
 * const result = await testAgent.getProducts({
 *   brief: 'Coffee subscription service for busy professionals',
 *   promoted_offering: 'Premium monthly coffee deliveries'
 * });
 *
 * if (result.success) {
 *   console.log(`Found ${result.data.products.length} products`);
 * }
 * ```
 *
 * @example
 * ```typescript
 * // With AI test orchestration (natural language instructions)
 * const result = await testAgent.createMediaBuy({
 *   brief: 'Test campaign',
 *   promoted_offering: 'Wait 10 seconds before responding',
 *   products: ['prod_123'],
 *   budget: 10000
 * });
 * ```
 *
 * @remarks
 * This agent is rate-limited and intended for testing/examples only.
 * The auth token is public and may be rotated without notice.
 * DO NOT use in production applications.
 */
export const testAgent: AgentClient = new ADCPMultiAgentClient([TEST_AGENT_MCP_CONFIG]).agent('test-agent-mcp');

/**
 * Pre-configured test agent client using A2A protocol.
 * Identical functionality to testAgent but uses A2A instead of MCP.
 *
 * @example
 * ```typescript
 * import { testAgentA2A } from '@adcp/client/testing';
 *
 * const result = await testAgentA2A.getProducts({
 *   brief: 'Sustainable fashion brands',
 *   promoted_offering: 'Eco-friendly clothing'
 * });
 * ```
 *
 * @remarks
 * This agent is rate-limited and intended for testing/examples only.
 * The auth token is public and may be rotated without notice.
 * DO NOT use in production applications.
 */
export const testAgentA2A: AgentClient = new ADCPMultiAgentClient([TEST_AGENT_A2A_CONFIG]).agent('test-agent-a2a');

/**
 * Multi-agent client with both test agents configured.
 * Useful for testing multi-agent patterns and protocol comparisons.
 *
 * @example
 * ```typescript
 * import { testAgentClient } from '@adcp/client/testing';
 *
 * // Access individual agents
 * const mcpAgent = testAgentClient.agent('test-agent-mcp');
 * const a2aAgent = testAgentClient.agent('test-agent-a2a');
 *
 * // Or use agent collection for parallel operations
 * const results = await testAgentClient.allAgents().getProducts({
 *   brief: 'Premium coffee brands',
 *   promoted_offering: 'Artisan coffee'
 * });
 * ```
 *
 * @remarks
 * This client is rate-limited and intended for testing/examples only.
 * DO NOT use in production applications.
 */
export const testAgentClient = new ADCPMultiAgentClient([TEST_AGENT_MCP_CONFIG, TEST_AGENT_A2A_CONFIG]);

/**
 * Create a custom test agent configuration.
 * Useful when you need to modify the default test agent setup.
 *
 * @param overrides - Partial agent config to override defaults
 * @returns Complete agent configuration
 *
 * @example
 * ```typescript
 * import { createTestAgent, ADCPMultiAgentClient } from '@adcp/client/testing';
 *
 * // Use default test agent with custom ID
 * const config = createTestAgent({ id: 'my-test-agent' });
 * const client = new ADCPMultiAgentClient([config]);
 * ```
 *
 * @example
 * ```typescript
 * // Use A2A protocol instead of MCP
 * const config = createTestAgent({
 *   protocol: 'a2a',
 *   agent_uri: 'https://test-agent.adcontextprotocol.org'
 * });
 * ```
 */
export function createTestAgent(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    ...TEST_AGENT_MCP_CONFIG,
    ...overrides,
  };
}

// ====== CREATIVE AGENT HELPERS ======

/**
 * Pre-configured creative agent client using MCP protocol.
 * Ready to use for creative generation and format listing.
 *
 * @example
 * ```typescript
 * import { creativeAgent } from '@adcp/client/testing';
 *
 * // List available creative formats
 * const formats = await creativeAgent.listFormats();
 * console.log(`Found ${formats.length} creative formats`);
 *
 * // Filter to specific format types
 * const videoFormats = formats.filter(f => f.type === 'video');
 * const displayFormats = formats.filter(f => f.type === 'display');
 * ```
 *
 * @example
 * ```typescript
 * // Find formats by dimensions
 * const formats = await creativeAgent.listFormats();
 * const banner = formats.find(f =>
 *   f.renders?.[0]?.dimensions?.width === 300 &&
 *   f.renders?.[0]?.dimensions?.height === 250
 * );
 * ```
 *
 * @remarks
 * This is the official AdCP reference creative agent.
 * No authentication required for public endpoints.
 */
export const creativeAgent: CreativeAgentClient = new CreativeAgentClient({
  agentUrl: STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE,
  protocol: 'mcp',
});

/**
 * Pre-configured creative agent client using A2A protocol.
 * Identical functionality to creativeAgent but uses A2A instead of MCP.
 *
 * @example
 * ```typescript
 * import { creativeAgentA2A } from '@adcp/client/testing';
 *
 * const formats = await creativeAgentA2A.listFormats({ type: 'video' });
 * console.log(`Found ${formats.length} video formats`);
 * ```
 *
 * @remarks
 * This is the official AdCP reference creative agent.
 * No authentication required for public endpoints.
 */
export const creativeAgentA2A: CreativeAgentClient = new CreativeAgentClient({
  agentUrl: STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE_A2A,
  protocol: 'a2a',
});
