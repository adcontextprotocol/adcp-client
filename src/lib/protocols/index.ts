// Unified Protocol Interface for AdCP
export { callMCPTool } from './mcp';
export { callA2ATool } from './a2a';

import { callMCPTool } from './mcp';
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
    debugLogs: any[] = []
  ): Promise<any> {
    validateAgentUrl(agent.agent_uri);
    
    const authToken = getAuthToken(agent);
    
    if (agent.protocol === 'mcp') {
      return callMCPTool(
        agent.agent_uri,
        toolName,
        args,
        authToken,
        debugLogs
      );
    } else if (agent.protocol === 'a2a') {
      return callA2ATool(
        agent.agent_uri,
        toolName,
        args, // This maps to 'parameters' in callA2ATool
        authToken,
        debugLogs
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