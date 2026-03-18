// Official A2A client implementation - NO FALLBACKS
const clientModule = require('@a2a-js/sdk/client');
const A2AClient = clientModule.A2AClient;

import type { PushNotificationConfig } from '../types/tools.generated';
import { AuthenticationRequiredError, is401Error } from '../errors';
import { discoverOAuthMetadata } from '../auth/oauth/discovery';
import { withSpan, injectTraceHeaders } from '../observability/tracing';

/**
 * Resolve agent card URL with fallback support
 *
 * Tries new standard path first (/.well-known/agent.json), falls back to legacy
 * path (/.well-known/agent-card.json) for backward compatibility.
 *
 * @param baseUrl Base URL or existing card URL to resolve
 * @returns Promise resolving to the resolved agent card URL
 */
async function resolveAgentCardUrl(baseUrl: string): Promise<string> {
  // Check if the URL already looks like a card URL (either new or legacy path)
  if (baseUrl.endsWith('/.well-known/agent.json') || baseUrl.endsWith('/.well-known/agent-card.json')) {
    // Already a card URL - use as-is
    return baseUrl;
  }

  // Try new standard path first (/.well-known/agent.json)
  try {
    const newUrl = new URL('/.well-known/agent.json', baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(newUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, */*',
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return newUrl.toString();
    }
  } catch (error) {
    // Fetch failed - try legacy path
  }

  // Fallback to legacy path (/.well-known/agent-card.json)
  try {
    const legacyUrl = new URL('/.well-known/agent-card.json', baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(legacyUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, */*',
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return legacyUrl.toString();
    }
  } catch (error) {
    // Both paths failed - fall back to legacy path as default
    // This ensures we have a URL even if the server is temporarily unavailable
  }

  // If both failed or server is down, fall back to legacy path as the default
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return base + '.well-known/agent-card.json';
}

if (!A2AClient) {
  throw new Error('A2A SDK client is required. Please install @a2a-js/sdk');
}

export async function callA2ATool(
  agentUrl: string,
  toolName: string,
  parameters: Record<string, any>,
  authToken?: string,
  debugLogs: any[] = [],
  pushNotificationConfig?: PushNotificationConfig,
  customHeaders?: Record<string, string>
): Promise<any> {
  return withSpan(
    'adcp.a2a.call_tool',
    {
      'adcp.tool': toolName,
      'http.url': agentUrl,
    },
    async () => {
      return callA2AToolImpl(
        agentUrl,
        toolName,
        parameters,
        authToken,
        debugLogs,
        pushNotificationConfig,
        customHeaders
      );
    }
  );
}

async function callA2AToolImpl(
  agentUrl: string,
  toolName: string,
  parameters: Record<string, any>,
  authToken?: string,
  debugLogs: any[] = [],
  pushNotificationConfig?: PushNotificationConfig,
  customHeaders?: Record<string, string>
): Promise<any> {
  // Track 401 errors for better error messaging
  let got401 = false;

  // Create authenticated fetch that wraps native fetch
  // This ensures ALL requests (including agent card fetching) include auth headers
  const fetchImpl = async (url: string | URL | Request, options?: RequestInit) => {
    // Build headers - always start with existing headers, then add auth if available
    const existingHeaders: Record<string, string> = {};
    if (options?.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((value, key) => {
          existingHeaders[key] = value;
        });
      } else if (Array.isArray(options.headers)) {
        for (const [key, value] of options.headers) {
          existingHeaders[key] = value;
        }
      } else {
        Object.assign(existingHeaders, options.headers);
      }
    }

    // Only inject trace context headers for actual tool requests, not discovery
    // The agent card endpoint is external/untrusted - don't leak trace IDs to it
    // Support both new (/.well-known/agent.json) and legacy (/.well-known/agent-card.json) paths
    const urlString = typeof url === 'string' ? url : url.toString();
    const isDiscoveryRequest =
      urlString.includes('/.well-known/agent-card.json') || urlString.includes('/.well-known/agent.json');
    const traceHeaders = isDiscoveryRequest ? {} : injectTraceHeaders();

    // Merge: existing < trace < custom < auth (auth always wins)
    const headers: Record<string, string> = {
      ...existingHeaders,
      ...traceHeaders,
      ...customHeaders,
      ...(authToken && {
        Authorization: `Bearer ${authToken}`,
        'x-adcp-auth': authToken,
      }),
    };

    debugLogs.push({
      type: 'info',
      message: `A2A: Fetch to ${typeof url === 'string' ? url : url.toString()}`,
      timestamp: new Date().toISOString(),
      hasAuth: !!authToken,
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => {
          const lower = k.toLowerCase();
          return lower === 'authorization' || lower === 'x-adcp-auth' ? [k, '***'] : [k, v];
        })
      ),
    });

    const response = await fetch(url, {
      ...options,
      headers,
    });

    // Track 401 errors
    if (response.status === 401) {
      got401 = true;
    }

    return response;
  };

  // Create A2A client using the recommended fromCardUrl method
  // Ensure the URL points to the agent card endpoint
  // Try new standard path first (/.well-known/agent.json), fall back to legacy (/.well-known/agent-card.json)
  const cardUrl = await resolveAgentCardUrl(agentUrl);

  debugLogs.push({
    type: 'info',
    message: `A2A: Creating client for ${cardUrl}`,
    timestamp: new Date().toISOString(),
  });

  try {
    const a2aClient = await A2AClient.fromCardUrl(cardUrl, {
      fetchImpl,
    });

    // Build request payload following A2A JSON-RPC spec
    // Per A2A SDK: pushNotificationConfig goes in params.configuration (camelCase)
    // Schema: https://adcontextprotocol.org/schemas/v1/core/push-notification-config.json
    const requestPayload: any = {
      message: {
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        role: 'user',
        kind: 'message', // Required by A2A spec
        parts: [
          {
            kind: 'data', // A2A spec uses "kind", not "type"
            data: {
              skill: toolName,
              parameters: parameters,
            },
          },
        ],
      },
    };

    // Add pushNotificationConfig in configuration object (A2A JSON-RPC spec)
    if (pushNotificationConfig) {
      requestPayload.configuration = {
        pushNotificationConfig: pushNotificationConfig,
      };
    }

    // Add debug log for A2A call
    const payloadSize = JSON.stringify(requestPayload).length;
    debugLogs.push({
      type: 'info',
      message: `A2A: Calling skill ${toolName} with parameters: ${JSON.stringify(
        parameters
      )}. Payload size: ${payloadSize} bytes`,
      timestamp: new Date().toISOString(),
      payloadSize,
      actualPayload: requestPayload,
    });

    // Send message using A2A protocol
    debugLogs.push({
      type: 'info',
      message: `A2A: Sending message via sendMessage()`,
      timestamp: new Date().toISOString(),
      skill: toolName,
    });

    const messageResponse = await a2aClient.sendMessage(requestPayload);

    // Add debug log for A2A response
    debugLogs.push({
      type: messageResponse?.error ? 'error' : 'success',
      message: `A2A: Response received (${messageResponse?.error ? 'error' : 'success'})`,
      timestamp: new Date().toISOString(),
      response: messageResponse,
      skill: toolName,
    });

    // Check for JSON-RPC error in response
    if (messageResponse?.error || messageResponse?.result?.error) {
      const errorObj = messageResponse.error || messageResponse.result?.error;
      const errorMessage = errorObj.message || JSON.stringify(errorObj);
      throw new Error(`A2A agent returned error: ${errorMessage}`);
    }

    return messageResponse;
  } catch (error: any) {
    // If we got a 401, throw AuthenticationRequiredError with OAuth metadata
    if (is401Error(error, got401)) {
      debugLogs.push({
        type: 'error',
        message: `A2A: Authentication required for ${agentUrl}`,
        timestamp: new Date().toISOString(),
      });

      const oauthMetadata = await discoverOAuthMetadata(agentUrl);
      throw new AuthenticationRequiredError(agentUrl, oauthMetadata || undefined);
    }

    // Re-throw other errors
    throw error;
  }
}
