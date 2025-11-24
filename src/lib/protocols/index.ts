// Unified Protocol Interface for AdCP
export { callMCPTool, type ProtocolLoggingConfig as MCPLoggingConfig } from './mcp';
export { callA2ATool, type ProtocolLoggingConfig as A2ALoggingConfig } from './a2a';
export type { ProtocolLoggingConfig } from './mcp'; // Re-export for convenience

import { callMCPTool, type ProtocolLoggingConfig } from './mcp';
import { callA2ATool } from './a2a';
import type { AgentConfig } from '../types';
import { getAuthToken } from '../auth';
import { validateAgentUrl } from '../validation';

/**
 * Universal protocol client - automatically routes to the correct protocol implementation
 */
export class ProtocolClient {
  /**
   * Call a tool on an agent using the appropriate protocol
   */
  static async callTool(
    agent: AgentConfig,
    toolName: string,
    args: Record<string, any>,
    debugLogs: any[] = [],
    webhookUrl?: string,
    webhookSecret?: string,
    loggingConfig?: ProtocolLoggingConfig
  ): Promise<any> {
    validateAgentUrl(agent.agent_uri);

    const authToken = getAuthToken(agent);

    // Include push_notification_config in args if provided (AdCP spec)
    // Format: { url: string, authentication: { schemes: string[], credentials: string } }
    const argsWithWebhook = webhookUrl
      ? {
          ...args,
          push_notification_config: {
            url: webhookUrl,
            authentication: {
              schemes: ['HMAC-SHA256'],
              credentials: webhookSecret || 'placeholder_secret_min_32_characters_required'
            }
          }
        }
      : args;

    if (agent.protocol === 'mcp') {
      return callMCPTool(
        agent.agent_uri,
        toolName,
        argsWithWebhook,
        authToken,
        debugLogs,
        loggingConfig
      );
    } else if (agent.protocol === 'a2a') {
      return callA2ATool(
        agent.agent_uri,
        toolName,
        argsWithWebhook, // This maps to 'parameters' in callA2ATool
        authToken,
        debugLogs,
        loggingConfig
      );
    } else {
      throw new Error(`Unsupported protocol: ${agent.protocol}`);
    }
  }
}

/**
 * Simple factory functions for protocol-specific clients
 */
export const createMCPClient = (agentUrl: string, authToken?: string) => ({
  callTool: (toolName: string, args: Record<string, any>, debugLogs?: any[]) =>
    callMCPTool(agentUrl, toolName, args, authToken, debugLogs)
});

export const createA2AClient = (agentUrl: string, authToken?: string) => ({
  callTool: (toolName: string, parameters: Record<string, any>, debugLogs?: any[]) =>
    callA2ATool(agentUrl, toolName, parameters, authToken, debugLogs)
});