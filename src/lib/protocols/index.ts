// Unified Protocol Interface for AdCP
export { callMCPTool } from './mcp';
export { callA2ATool } from './a2a';

import { callMCPTool } from './mcp';
import { callA2ATool } from './a2a';
import type { AgentConfig } from '../types';
import type { PushNotificationConfig } from '../types/tools.generated';
import { getAuthToken } from '../auth';
import { validateAgentUrl } from '../validation';

/**
 * Universal protocol client - automatically routes to the correct protocol implementation
 */
export class ProtocolClient {
  /**
   * Call a tool on an agent using the appropriate protocol
   *
   * @param agent - Agent configuration
   * @param toolName - Name of the tool/skill to call
   * @param args - Tool arguments (includes reporting_webhook if needed - NOT removed)
   * @param debugLogs - Debug log array
   * @param webhookUrl - Optional: URL for async task status notifications (push_notification_config)
   * @param webhookSecret - Optional: Secret for push_notification_config authentication
   * @param webhookToken - Optional: Token for push_notification_config validation
   *
   * IMPORTANT: webhookUrl/Secret/Token are for ASYNC TASK STATUS (push_notification_config).
   * For reporting webhooks (reporting_webhook), include them directly in args - they stay in skill parameters.
   */
  static async callTool(
    agent: AgentConfig,
    toolName: string,
    args: Record<string, any>,
    debugLogs: any[] = [],
    webhookUrl?: string,
    webhookSecret?: string,
    webhookToken?: string
  ): Promise<any> {
    validateAgentUrl(agent.agent_uri);

    const authToken = getAuthToken(agent);

    // Build push_notification_config for ASYNC TASK STATUS notifications
    // (NOT for reporting_webhook - that stays in args)
    // Schema: https://adcontextprotocol.org/schemas/v1/core/push-notification-config.json
    const pushNotificationConfig: PushNotificationConfig | undefined = webhookUrl
      ? {
          url: webhookUrl,
          ...(webhookToken && { token: webhookToken }),
          authentication: {
            schemes: ['HMAC-SHA256'],
            credentials: webhookSecret || 'placeholder_secret_min_32_characters_required',
          },
        }
      : undefined;

    if (agent.protocol === 'mcp') {
      // For MCP, include push_notification_config in tool arguments (MCP spec)
      const argsWithWebhook = pushNotificationConfig ? { ...args, push_notification_config: pushNotificationConfig } : args;
      return callMCPTool(agent.agent_uri, toolName, argsWithWebhook, authToken, debugLogs);
    } else if (agent.protocol === 'a2a') {
      // For A2A, pass pushNotificationConfig separately (not in skill parameters)
      return callA2ATool(
        agent.agent_uri,
        toolName,
        args, // This maps to 'parameters' in callA2ATool
        authToken,
        debugLogs,
        pushNotificationConfig
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
    callMCPTool(agentUrl, toolName, args, authToken, debugLogs),
});

export const createA2AClient = (agentUrl: string, authToken?: string) => ({
  callTool: (toolName: string, parameters: Record<string, any>, debugLogs?: any[]) =>
    callA2ATool(agentUrl, toolName, parameters, authToken, debugLogs),
});
