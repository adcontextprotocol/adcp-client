/**
 * OAuth module for MCP authentication
 *
 * OAuth tokens are stored directly in AgentConfig, same as static auth tokens.
 *
 * @example
 * ```typescript
 * import { MCPOAuthProvider, CLIFlowHandler } from '@adcp/client';
 *
 * // Agent config - tokens will be stored here
 * const agent: AgentConfig = {
 *   id: 'my-agent',
 *   name: 'My Agent',
 *   agent_uri: 'https://agent.example.com/mcp',
 *   protocol: 'mcp',
 *   // After OAuth flow completes:
 *   // oauth_tokens: { access_token: '...', refresh_token: '...' }
 * };
 *
 * // Create provider with CLI flow handler
 * const provider = new MCPOAuthProvider({
 *   agent,
 *   flowHandler: new CLIFlowHandler(),
 *   storage: myConfigStorage  // Optional: persists tokens to file/db
 * });
 *
 * // Use with MCP transport
 * const transport = new StreamableHTTPClientTransport(url, {
 *   authProvider: provider
 * });
 * ```
 */

// Types
export type {
  OAuthFlowHandler,
  OAuthProviderConfig,
  OAuthConfigStorage,
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
  AgentConfig,
  AgentOAuthTokens,
  AgentOAuthClient,
} from './types';

export {
  DEFAULT_CLIENT_METADATA,
  OAuthError,
  OAuthCancelledError,
  OAuthTimeoutError,
  toMCPTokens,
  fromMCPTokens,
  toMCPClientInfo,
  fromMCPClientInfo,
} from './types';

// Flow handlers
export { CLIFlowHandler, type CLIFlowHandlerConfig } from './CLIFlowHandler';

// Main provider
export { MCPOAuthProvider } from './MCPOAuthProvider';

// ========================================
// Convenience factory functions
// ========================================

import { MCPOAuthProvider } from './MCPOAuthProvider';
import { CLIFlowHandler, type CLIFlowHandlerConfig } from './CLIFlowHandler';
import type { OAuthClientMetadata, OAuthConfigStorage, AgentConfig } from './types';
import { DEFAULT_CLIENT_METADATA } from './types';

/**
 * Create an OAuth provider for CLI usage
 *
 * @param agent Agent configuration (tokens stored here)
 * @param options Optional configuration
 * @returns Configured OAuth provider
 *
 * @example
 * ```typescript
 * const agent: AgentConfig = {
 *   id: 'my-agent',
 *   name: 'My Agent',
 *   agent_uri: 'https://agent.example.com/mcp',
 *   protocol: 'mcp'
 * };
 *
 * const provider = createCLIOAuthProvider(agent);
 *
 * const transport = new StreamableHTTPClientTransport(url, {
 *   authProvider: provider
 * });
 *
 * try {
 *   await client.connect(transport);
 * } catch (error) {
 *   if (error instanceof UnauthorizedError) {
 *     const code = await provider.waitForCallback();
 *     await transport.finishAuth(code);
 *     await client.connect(transport);
 *   }
 * }
 *
 * // After successful auth, agent.oauth_tokens is populated
 * console.log(agent.oauth_tokens);
 * ```
 */
export function createCLIOAuthProvider(
  agent: AgentConfig,
  options?: {
    /** Callback port (default: 8766) */
    callbackPort?: number;
    /** Auth timeout in ms (default: 300000 = 5 min) */
    timeout?: number;
    /** Custom client metadata overrides */
    clientMetadata?: Partial<OAuthClientMetadata>;
    /** Suppress console output */
    quiet?: boolean;
    /** Storage for persisting agent config */
    storage?: OAuthConfigStorage;
  }
): MCPOAuthProvider {
  const flowConfig: CLIFlowHandlerConfig = {
    callbackPort: options?.callbackPort,
    timeout: options?.timeout,
    quiet: options?.quiet,
  };
  const flowHandler = new CLIFlowHandler(flowConfig);

  // Build complete client metadata
  const clientMetadata: OAuthClientMetadata = {
    ...DEFAULT_CLIENT_METADATA,
    redirect_uris: [flowHandler.getRedirectUrl().toString()],
    ...options?.clientMetadata,
  };

  return new MCPOAuthProvider({
    agent,
    flowHandler,
    storage: options?.storage,
    clientMetadata,
  });
}

/**
 * Check if an error indicates OAuth is required
 */
export function isOAuthRequired(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'UnauthorizedError') return true;
    const msg = error.message.toLowerCase();
    if (msg.includes('unauthorized') || msg.includes('authentication required') || msg.includes('oauth')) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an agent has valid OAuth tokens
 */
export function hasValidOAuthTokens(agent: AgentConfig): boolean {
  const tokens = agent.oauth_tokens;
  if (!tokens?.access_token) return false;

  if (tokens.expires_at) {
    const expiresAt = new Date(tokens.expires_at);
    // Expired if within 5 minutes of expiration
    if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
      return false;
    }
  }

  return true;
}

/**
 * Clear OAuth tokens from an agent config
 */
export function clearOAuthTokens(agent: AgentConfig): void {
  delete agent.oauth_tokens;
  delete agent.oauth_client;
  delete agent.oauth_code_verifier;
}

/**
 * Get the effective auth token for an agent
 * Returns OAuth access_token if available, otherwise static auth_token
 */
export function getEffectiveAuthToken(agent: AgentConfig): string | undefined {
  // Prefer OAuth if available and valid
  if (hasValidOAuthTokens(agent)) {
    return agent.oauth_tokens!.access_token;
  }
  // Fall back to static token
  return agent.auth_token;
}

// OAuth discovery
export {
  discoverOAuthMetadata,
  supportsOAuth,
  supportsDynamicRegistration,
  type OAuthMetadata,
  type DiscoveryOptions,
} from './discovery';
