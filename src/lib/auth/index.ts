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
 * Supports two explicit authentication methods:
 * 1. auth_token: Direct token value, used as-is
 * 2. auth_token_env: Environment variable name, looked up in process.env
 *
 * Priority: auth_token takes precedence if both are provided
 *
 * The `requiresAuth` flag controls enforcement, not usage:
 * - If auth credentials are provided, they're always used (regardless of requiresAuth)
 * - If requiresAuth is true but no credentials are provided, an error is thrown in production
 *
 * @param agent - Agent configuration
 * @returns Authentication token string or undefined if not configured
 */
export function getAuthToken(agent: AgentConfig): string | undefined {
  // Explicit auth_token takes precedence - always use it if provided
  if (agent.auth_token) {
    return agent.auth_token;
  }

  // Look up auth_token_env in environment
  if (agent.auth_token_env) {
    const envValue = process.env[agent.auth_token_env];
    if (!envValue) {
      const message = `Environment variable "${agent.auth_token_env}" not found for agent ${agent.id}`;
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`[AUTH] ${message} - Agent cannot authenticate`);
      } else {
        console.warn(`⚠️  ${message}`);
      }
    }
    return envValue;
  }

  // No auth credentials provided - check if they're required
  if (agent.requiresAuth && process.env.NODE_ENV === 'production') {
    throw new Error(`[AUTH] Agent ${agent.id} requires authentication but no auth_token or auth_token_env configured`);
  }

  return undefined;
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
