/**
 * Advanced exports for library authors building custom protocol implementations
 *
 * @remarks
 * **Most developers should use AdCPClient from the main export**, which provides:
 * - Single-agent access via `client.agent(id)` with conversation context
 * - Multi-agent parallel operations via `client.agents([ids])`
 * - All AdCP tools with full type safety
 *
 * These low-level protocol clients are only needed if you're:
 * - Building custom protocol handlers
 * - Integrating AdCP with other frameworks
 * - Implementing custom agent orchestration
 *
 * @example
 * ```typescript
 * // ❌ Don't do this - use main AdCPClient instead:
 * import { callA2ATool } from '@adcp/client/advanced';
 *
 * // ✅ Do this - use the main client:
 * import { AdCPClient } from '@adcp/client';
 * const client = new AdCPClient([agentConfig]);
 * const agent = client.agent('agent-id');
 * await agent.getProducts({ brief: '...' });
 * ```
 */

/**
 * Protocol-level clients for direct protocol interaction
 *
 * @remarks
 * Low-level clients for MCP and A2A protocols. Used internally by AdCPClient.
 * Only use these if you need to build custom protocol handlers or integrations.
 *
 * For normal usage, prefer AdCPClient which wraps these and provides:
 * - Automatic agent configuration
 * - Conversation context management
 * - Type-safe tool methods
 * - Error handling and validation
 */
export { ProtocolClient, callMCPTool, callA2ATool, createMCPClient, createA2AClient } from './protocols';
