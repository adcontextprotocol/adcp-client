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
 */
export function getAuthToken(agent: AgentConfig): string | undefined {
  if (!agent.requiresAuth || !agent.auth_token_env) {
    return undefined;
  }

  // If auth_token_env looks like a direct token (not an env var name), use it directly
  // Base64-like tokens are typically 40+ chars and contain mixed case/symbols
  if (agent.auth_token_env.length > 20 && !agent.auth_token_env.match(/^[A-Z_][A-Z0-9_]*$/)) {
    return agent.auth_token_env;
  }

  // Otherwise, look up the environment variable
  return process.env[agent.auth_token_env];
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
    ...(authToken && { Authorization: `Bearer ${authToken}` })
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
        ...(options?.headers || {})
      }
    });
  };
}

/**
 * Create MCP authentication headers
 */
export function createMCPAuthHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream'
  };

  if (authToken) {
    headers['x-adcp-auth'] = authToken;
  }

  return headers;
}
