// Advanced exports for library authors and specialized use cases
// Most developers should use ADCPMultiAgentClient from the main export

/**
 * Single-agent client with conversation management
 *
 * @remarks
 * For most use cases, prefer the main ADCPClient (which handles single or multi-agent).
 * This class is useful for:
 * - Building higher-level abstractions
 * - Integration with existing single-agent systems
 * - Advanced conversation management scenarios
 *
 * @example
 * ```typescript
 * import { SingleAgentClient } from '@adcp/client/advanced';
 *
 * const client = new SingleAgentClient({
 *   id: 'agent-1',
 *   agent_uri: 'https://agent.com',
 *   protocol: 'a2a'
 * });
 *
 * const result = await client.getProducts({ brief: '...' });
 * ```
 */
export { ADCPClient as SingleAgentClient, createADCPClient } from './core/ADCPClient';
export type { ADCPClientConfig } from './core/ADCPClient';

/**
 * Agent client with automatic context tracking
 *
 * @remarks
 * Wraps ADCPClient and automatically maintains conversation context across calls.
 * Useful for chat-like interactions where context should persist.
 *
 * @example
 * ```typescript
 * import { AgentClient } from '@adcp/client/advanced';
 *
 * const client = new AgentClient(agentConfig);
 *
 * // First call establishes context
 * await client.getProducts({ brief: '...' });
 *
 * // Subsequent calls reuse the same context
 * await client.createMediaBuy({ ... }); // Same conversation
 * ```
 */
export { AgentClient, type TaskResponseTypeMap, type AdcpTaskName } from './core/AgentClient';

/**
 * Protocol-level clients for direct protocol interaction
 *
 * @remarks
 * Low-level clients for MCP and A2A protocols. Used internally by ADCPClient.
 * Only export these if you need to build custom protocol handlers.
 */
export { ProtocolClient, callMCPTool, callA2ATool, createMCPClient, createA2AClient } from './protocols';
