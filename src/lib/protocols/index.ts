// Unified Protocol Interface for AdCP
export { callMCPTool, callMCPToolWithOAuth, connectMCP, closeMCPConnections, UnauthorizedError } from './mcp';

import { closeMCPConnections } from './mcp';
import { closeA2AConnections } from './a2a';

/**
 * Close protocol connections for the given protocol.
 * MCP closes persistent HTTP transports; A2A clears the agent-card client cache.
 */
export async function closeConnections(protocol: 'mcp' | 'a2a' = 'mcp'): Promise<void> {
  if (protocol === 'mcp') {
    await closeMCPConnections();
  } else {
    closeA2AConnections();
  }
}
export type { MCPCallOptions, MCPConnectionResult } from './mcp';
export { callA2ATool } from './a2a';
export {
  callMCPToolWithTasks,
  getMCPTaskStatus,
  getMCPTaskResult,
  listMCPTasks,
  cancelMCPTask,
  mapMCPTaskStatus,
  serverSupportsTasks,
} from './mcp-tasks';

import { callMCPToolWithTasks } from './mcp-tasks';
import { callMCPToolWithOAuth } from './mcp';
import { callA2ATool } from './a2a';
import type { AgentConfig, DebugLogEntry } from '../types';
import type { PushNotificationConfig } from '../types/tools.generated';
import { getAuthToken } from '../auth';
import {
  createNonInteractiveOAuthProvider,
  discoverAuthorizationRequirements,
  NeedsAuthorizationError,
  getAgentStorage,
} from '../auth/oauth';
import { is401Error } from '../errors';
import { isLikelyPrivateUrl } from '../net';
import { validateAgentUrl } from '../validation';
import { withSpan } from '../observability/tracing';
import { ADCP_MAJOR_VERSION } from '../version';
import { buildAgentSigningContext, CAPABILITY_OP, ensureCapabilityLoaded } from '../signing/client';

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
    args: Record<string, unknown>,
    debugLogs: DebugLogEntry[] = [],
    webhookUrl?: string,
    webhookSecret?: string,
    webhookToken?: string,
    serverVersion?: 'v2' | 'v3'
  ): Promise<unknown> {
    return withSpan(
      `adcp.${agent.protocol}.call_tool`,
      {
        'adcp.agent_id': agent.id,
        'adcp.protocol': agent.protocol,
        'adcp.tool': toolName,
        'http.url': agent.agent_uri,
      },
      async () => {
        validateAgentUrl(agent.agent_uri);

        const authToken = getAuthToken(agent);

        // RFC 9421 signing context. Built once per call; the transport
        // attaches a fetch wrapper that reads the cached capability on every
        // outbound request. `get_adcp_capabilities` is exempt from signing
        // (it's the discovery call itself) and also triggers cache priming
        // for any other op on agents with `request_signing` configured.
        const signingContext = buildAgentSigningContext(agent);
        if (signingContext && toolName !== CAPABILITY_OP) {
          await ensureCapabilityLoaded(agent, signingContext, primeArgs =>
            ProtocolClient.callTool(
              agent,
              CAPABILITY_OP,
              primeArgs,
              debugLogs,
              undefined,
              undefined,
              undefined,
              serverVersion
            )
          );
        }

        // Declare AdCP major version on every request so sellers can validate compatibility.
        // Skip for v2 servers — they don't recognise the field and strict-schema agents reject it.
        const argsWithVersion = serverVersion === 'v2' ? args : { adcp_major_version: ADCP_MAJOR_VERSION, ...args };

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
          const argsWithWebhook = pushNotificationConfig
            ? { ...argsWithVersion, push_notification_config: pushNotificationConfig }
            : argsWithVersion;

          // If the agent config carries OAuth tokens, route through the OAuth
          // provider path so the MCP SDK can refresh on 401 instead of hard-failing.
          // This path does not cache connections (OAuth token-refresh can't share
          // a cached transport), so it's slower but correct for OAuth-gated agents.
          if (agent.oauth_tokens) {
            const storage = getAgentStorage(agent);
            const authProvider = createNonInteractiveOAuthProvider(agent, {
              agentHint: agent.id,
              storage,
            });
            try {
              return await callMCPToolWithOAuth({
                agentUrl: agent.agent_uri,
                toolName,
                args: argsWithWebhook,
                authProvider,
                debugLogs,
                customHeaders: agent.headers,
                signingContext,
              });
            } catch (err) {
              // Refresh failed or server rejected the refreshed token — walk the
              // discovery chain so the caller can distinguish "re-auth needed"
              // from other failure modes.
              await rethrowAsNeedsAuthorization(err, agent.agent_uri);
              throw err;
            }
          }

          // Use callMCPToolWithTasks which auto-detects server tasks capability
          // and falls back to standard callTool when tasks are not supported
          try {
            return await callMCPToolWithTasks(
              agent.agent_uri,
              toolName,
              argsWithWebhook,
              authToken,
              debugLogs,
              agent.headers,
              signingContext ? { signingContext } : undefined
            );
          } catch (err) {
            await rethrowAsNeedsAuthorization(err, agent.agent_uri);
            throw err;
          }
        } else if (agent.protocol === 'a2a') {
          // For A2A, pass pushNotificationConfig separately (not in skill parameters)
          return callA2ATool(
            agent.agent_uri,
            toolName,
            argsWithVersion,
            authToken,
            debugLogs,
            pushNotificationConfig,
            agent.headers,
            signingContext
          );
        } else {
          throw new Error(`Unsupported protocol: ${agent.protocol}`);
        }
      }
    );
  }
}

/**
 * If `err` looks like a 401 from the MCP transport, probe the agent for a
 * Bearer challenge and throw a {@link NeedsAuthorizationError} carrying
 * walked discovery metadata. If the error isn't a 401 or we can't build a
 * requirements record, return silently so the caller re-throws the original.
 *
 * Keeping this off the hot path: we only probe on error, and the probe is
 * a single unauthenticated `tools/list` POST — no retries, no DNS rebind.
 */
async function rethrowAsNeedsAuthorization(err: unknown, agentUrl: string): Promise<void> {
  if (err instanceof NeedsAuthorizationError) throw err;
  if (!is401Error(err)) return;

  // If the caller has already connected to the agent URL, they've implicitly
  // trusted it — inherit that trust for the discovery probe so loopback /
  // private-IP development agents work the same way as public ones.
  const allowPrivateIp = isLikelyPrivateUrl(agentUrl);

  // discoverAuthorizationRequirements internally catches network failures and
  // returns null rather than throwing — anything that escapes is a genuine
  // bug we want to surface rather than mask the 401 with.
  const requirements = await discoverAuthorizationRequirements(agentUrl, { allowPrivateIp });
  if (requirements) {
    throw new NeedsAuthorizationError(requirements);
  }
  // No requirements walked; let the caller re-throw the original error.
}

/**
 * Simple factory functions for protocol-specific clients
 */
export const createMCPClient = (
  agentUrl: string,
  authToken?: string,
  headers?: Record<string, string>,
  serverVersion?: 'v2' | 'v3'
) => ({
  callTool: (toolName: string, args: Record<string, unknown>, debugLogs?: DebugLogEntry[]) =>
    callMCPToolWithTasks(
      agentUrl,
      toolName,
      serverVersion === 'v2' ? args : { adcp_major_version: ADCP_MAJOR_VERSION, ...args },
      authToken,
      debugLogs,
      headers
    ),
});

export const createA2AClient = (
  agentUrl: string,
  authToken?: string,
  headers?: Record<string, string>,
  serverVersion?: 'v2' | 'v3'
) => ({
  callTool: (toolName: string, parameters: Record<string, unknown>, debugLogs?: DebugLogEntry[]) =>
    callA2ATool(
      agentUrl,
      toolName,
      serverVersion === 'v2' ? parameters : { adcp_major_version: ADCP_MAJOR_VERSION, ...parameters },
      authToken,
      debugLogs,
      undefined,
      headers
    ),
});
