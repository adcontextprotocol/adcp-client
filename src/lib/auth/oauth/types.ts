/**
 * OAuth types for MCP authentication
 *
 * These types support the pluggable OAuth architecture:
 * - OAuthConfigStorage: Interface for reading/writing agent config with OAuth data
 * - OAuthFlowHandler: Abstract interface for authorization flow (CLI vs web)
 */

import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AgentConfig, AgentOAuthTokens, AgentOAuthClient } from '../../types/adcp';

// Re-export MCP SDK types for convenience
export type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
};

// Re-export agent types
export type { AgentConfig, AgentOAuthTokens, AgentOAuthClient };

/**
 * Agent config storage interface
 *
 * Implement this to persist OAuth tokens back to agent configuration.
 * This allows different storage backends (file, database, memory)
 * while keeping tokens in the agent config structure.
 */
export interface OAuthConfigStorage {
  /**
   * Load agent configuration
   * @param agentId The agent ID
   * @returns Agent config or undefined if not found
   */
  loadAgent(agentId: string): Promise<AgentConfig | undefined>;

  /**
   * Save agent configuration (with updated OAuth data)
   * @param agent The agent config to save
   */
  saveAgent(agent: AgentConfig): Promise<void>;
}

/**
 * Authorization flow handler - implement this for different environments
 *
 * Examples:
 * - CLIFlowHandler: Opens browser, starts callback server
 * - WebFlowHandler: HTTP redirects
 * - HeadlessFlowHandler: Device code flow (future)
 */
export interface OAuthFlowHandler {
  /**
   * Get the callback URL for OAuth redirects
   */
  getRedirectUrl(): string | URL;

  /**
   * Redirect the user to the authorization URL
   * For CLI: Opens browser
   * For web: HTTP redirect or return URL for client-side redirect
   *
   * @param authorizationUrl The OAuth authorization URL
   * @returns Promise that resolves when user is redirected
   */
  redirectToAuthorization(authorizationUrl: URL): Promise<void>;

  /**
   * Wait for the authorization callback and extract the auth code
   * For CLI: Starts a local HTTP server and waits
   * For web: Called by the callback route handler
   *
   * @returns Promise resolving to the authorization code
   */
  waitForCallback(): Promise<string>;

  /**
   * Clean up any resources (e.g., callback server)
   */
  cleanup(): Promise<void>;
}

/**
 * Configuration for creating an OAuth provider
 */
export interface OAuthProviderConfig {
  /** Agent configuration (tokens will be stored here) */
  agent: AgentConfig;

  /** Storage for persisting agent config changes */
  storage?: OAuthConfigStorage;

  /** Authorization flow handler */
  flowHandler: OAuthFlowHandler;

  /** OAuth client metadata (required - use DEFAULT_CLIENT_METADATA as base) */
  clientMetadata: OAuthClientMetadata;
}

/**
 * Default OAuth client metadata for ADCP clients
 */
export const DEFAULT_CLIENT_METADATA: OAuthClientMetadata = {
  client_name: 'ADCP Client',
  redirect_uris: ['http://localhost:8766/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none', // Public client (no client_secret)
};

/**
 * OAuth error types
 */
export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly agentId?: string
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export class OAuthCancelledError extends OAuthError {
  constructor(agentId?: string) {
    super('OAuth flow was cancelled by user', 'cancelled', agentId);
    this.name = 'OAuthCancelledError';
  }
}

export class OAuthTimeoutError extends OAuthError {
  constructor(agentId?: string, timeoutMs?: number) {
    super(
      `OAuth flow timed out${timeoutMs ? ` after ${timeoutMs}ms` : ''}`,
      'timeout',
      agentId
    );
    this.name = 'OAuthTimeoutError';
  }
}

/**
 * Convert AgentOAuthTokens to MCP SDK OAuthTokens format
 */
export function toMCPTokens(tokens: AgentOAuthTokens): OAuthTokens {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type || 'Bearer',
    expires_in: tokens.expires_in,
    scope: tokens.scope,
  };
}

/**
 * Convert MCP SDK OAuthTokens to AgentOAuthTokens format
 */
export function fromMCPTokens(tokens: OAuthTokens): AgentOAuthTokens {
  const result: AgentOAuthTokens = {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    scope: tokens.scope,
  };

  if (tokens.refresh_token) {
    result.refresh_token = tokens.refresh_token;
  }

  if (tokens.expires_in) {
    result.expires_in = tokens.expires_in;
    // Calculate expiration timestamp
    result.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  }

  return result;
}

/**
 * Convert AgentOAuthClient to MCP SDK OAuthClientInformation format
 */
export function toMCPClientInfo(client: AgentOAuthClient): OAuthClientInformation {
  return {
    client_id: client.client_id,
    client_secret: client.client_secret,
    client_secret_expires_at: client.client_secret_expires_at,
  };
}

/**
 * Convert MCP SDK OAuthClientInformationFull to AgentOAuthClient format
 */
export function fromMCPClientInfo(info: OAuthClientInformationFull): AgentOAuthClient {
  return {
    client_id: info.client_id,
    client_secret: info.client_secret,
    client_secret_expires_at: info.client_secret_expires_at,
  };
}
