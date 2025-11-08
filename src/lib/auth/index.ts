import type { AgentConfig } from '../types';

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
 * Get authentication token for an agent
 *
 * This function treats auth_token_env as a direct token value.
 * The CLI and application code are responsible for resolving environment variables
 * before passing values to AgentConfig.
 */
export function getAuthToken(agent: AgentConfig): string | undefined {
  if (!agent.requiresAuth || !agent.auth_token_env) {
    return undefined;
  }

  // Return the token directly - it should already be resolved by the caller
  return agent.auth_token_env;
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
 */
export function createMCPAuthHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
  };

  if (authToken) {
    headers['x-adcp-auth'] = authToken;
  }

  return headers;
}
