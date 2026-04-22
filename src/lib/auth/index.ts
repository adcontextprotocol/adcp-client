import type { AgentConfig } from '../types';

// ====== OAuth Support ======
export * from './oauth';

/**
 * Generate UUID for request tracking
 */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get authentication token for an agent.
 *
 * Returns, in order:
 * 1. The cached client-credentials access token (when the agent declares
 *    `oauth_client_credentials`). These tokens are refreshed via secret
 *    re-exchange, not the MCP SDK's `refresh_token` grant, so the bearer
 *    path is the correct transport — there is no "refresh on 401" hook
 *    the SDK can use, and the call path pre-refreshes them anyway.
 * 2. The static `auth_token`.
 *
 * Tokens from the authorization-code flow (`oauth_tokens` without
 * `oauth_client_credentials`) are handled separately by the OAuth provider
 * path in `ProtocolClient.callTool` and intentionally do NOT surface here.
 */
export function getAuthToken(agent: AgentConfig): string | undefined {
  if (agent.oauth_client_credentials && agent.oauth_tokens?.access_token) {
    return agent.oauth_tokens.access_token;
  }
  return agent.auth_token;
}

/**
 * Create AdCP-compliant headers
 */
export function createAdCPHeaders(authToken?: string, isMCP: boolean = false): Record<string, string> {
  return {
    'Content-Type': isMCP ? 'application/json' : 'application/vnd.adcp+json',
    'AdCP-Version': '1.0',
    'AdCP-Request-ID': generateUUID(),
    'User-Agent': 'AdCP-Testing-Framework/1.0.0',
    Accept: isMCP ? 'application/json, text/event-stream' : 'application/vnd.adcp+json, application/json',
    ...(authToken && { Authorization: `Bearer ${authToken}` }),
  };
}

/**
 * Create an authenticated fetch function for A2A client
 */
export function createAuthenticatedFetch(authToken: string) {
  return async (url: string | URL | Request, options?: RequestInit) => {
    const headers = createAdCPHeaders(authToken);

    return fetch(url, {
      ...options,
      headers: {
        ...headers,
        ...(options?.headers || {}),
      },
    });
  };
}

/**
 * Create MCP authentication headers
 *
 * Sends both:
 * - Authorization: Bearer (standard OAuth, required by OAuth-protected MCP servers)
 * - x-adcp-auth (AdCP-specific header for backwards compatibility)
 */
export function createMCPAuthHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
    headers['x-adcp-auth'] = authToken;
  }

  return headers;
}
