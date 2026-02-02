/**
 * MCP OAuth Provider
 *
 * Implements the MCP SDK's OAuthClientProvider interface
 * using AgentConfig for token storage.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthFlowHandler,
  OAuthProviderConfig,
  OAuthConfigStorage,
  AgentConfig,
} from './types';
import { DEFAULT_CLIENT_METADATA, toMCPTokens, fromMCPTokens, toMCPClientInfo, fromMCPClientInfo } from './types';
import { randomBytes } from 'crypto';

/**
 * MCP OAuth Client Provider
 *
 * This provider stores OAuth tokens directly in the AgentConfig,
 * using the same structure as static auth tokens.
 *
 * @example
 * ```typescript
 * const agent: AgentConfig = {
 *   id: 'my-agent',
 *   name: 'My Agent',
 *   agent_uri: 'https://agent.example.com/mcp',
 *   protocol: 'mcp',
 *   // OAuth tokens stored here after auth flow
 *   oauth_tokens: { access_token: '...', refresh_token: '...' }
 * };
 *
 * const provider = new MCPOAuthProvider({
 *   agent,
 *   flowHandler: new CLIFlowHandler(),
 *   storage: myConfigStorage  // Optional: persists tokens
 * });
 *
 * const transport = new StreamableHTTPClientTransport(url, {
 *   authProvider: provider
 * });
 * ```
 */
export class MCPOAuthProvider implements OAuthClientProvider {
  private agent: AgentConfig;
  private readonly storage?: OAuthConfigStorage;
  private readonly flowHandler: OAuthFlowHandler;
  private readonly _clientMetadata: OAuthClientMetadata;

  constructor(config: OAuthProviderConfig) {
    this.agent = config.agent;
    this.storage = config.storage;
    this.flowHandler = config.flowHandler;
    this._clientMetadata = config.clientMetadata;
  }

  /**
   * Create a provider for CLI usage
   */
  static forCLI(
    agent: AgentConfig,
    flowHandler: OAuthFlowHandler,
    storage?: OAuthConfigStorage,
    clientMetadataOverrides?: Partial<OAuthClientMetadata>
  ): MCPOAuthProvider {
    // Build complete client metadata with required fields
    const clientMetadata: OAuthClientMetadata = {
      ...DEFAULT_CLIENT_METADATA,
      redirect_uris: [flowHandler.getRedirectUrl().toString()],
      ...clientMetadataOverrides,
    };

    return new MCPOAuthProvider({
      agent,
      flowHandler,
      storage,
      clientMetadata,
    });
  }

  // ========================================
  // OAuthClientProvider interface
  // ========================================

  get redirectUrl(): string | URL {
    return this.flowHandler.getRedirectUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata;
  }

  /**
   * Generate OAuth state parameter
   */
  async state(): Promise<string> {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Load client information from agent config
   */
  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.agent.oauth_client) {
      return toMCPClientInfo(this.agent.oauth_client);
    }
    return undefined;
  }

  /**
   * Save client information after dynamic registration
   */
  async saveClientInformation(clientInfo: OAuthClientInformationFull): Promise<void> {
    this.agent.oauth_client = fromMCPClientInfo(clientInfo);
    await this.persistAgent();
  }

  /**
   * Load existing tokens from agent config
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.agent.oauth_tokens) {
      return toMCPTokens(this.agent.oauth_tokens);
    }
    return undefined;
  }

  /**
   * Save tokens after authorization
   * Also cleans up the temporary code verifier
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.agent.oauth_tokens = fromMCPTokens(tokens);
    // Clean up temporary code verifier after successful token exchange
    delete this.agent.oauth_code_verifier;
    await this.persistAgent();
  }

  /**
   * Redirect user to authorization URL
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.flowHandler.redirectToAuthorization(authorizationUrl);
  }

  /**
   * Save PKCE code verifier
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.agent.oauth_code_verifier = codeVerifier;
    await this.persistAgent();
  }

  /**
   * Load PKCE code verifier
   * The MCP SDK calls saveCodeVerifier() before authorization and
   * retrieves it here during token exchange.
   */
  async codeVerifier(): Promise<string> {
    if (!this.agent.oauth_code_verifier) {
      throw new Error(
        'No PKCE code verifier found. The OAuth flow may have been interrupted or ' +
          'the agent config was modified. Please try authenticating again.'
      );
    }
    return this.agent.oauth_code_verifier;
  }

  /**
   * Invalidate credentials when server indicates they're invalid
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    switch (scope) {
      case 'all':
        delete this.agent.oauth_tokens;
        delete this.agent.oauth_client;
        delete this.agent.oauth_code_verifier;
        break;
      case 'tokens':
        delete this.agent.oauth_tokens;
        break;
      case 'client':
        delete this.agent.oauth_client;
        break;
      case 'verifier':
        delete this.agent.oauth_code_verifier;
        break;
    }
    await this.persistAgent();
  }

  // ========================================
  // Additional methods
  // ========================================

  /**
   * Persist agent config to storage if configured
   */
  private async persistAgent(): Promise<void> {
    if (this.storage) {
      await this.storage.saveAgent(this.agent);
    }
  }

  /**
   * Wait for the OAuth callback
   * Call this after UnauthorizedError is thrown
   */
  async waitForCallback(): Promise<string> {
    return this.flowHandler.waitForCallback();
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    await this.flowHandler.cleanup();
  }

  /**
   * Check if we have valid, non-expired OAuth tokens
   * @returns true if access_token exists and hasn't expired (with 5 minute buffer)
   */
  hasValidTokens(): boolean {
    const tokens = this.agent.oauth_tokens;
    if (!tokens?.access_token) return false;

    // Check expiration if available
    if (tokens.expires_at) {
      const expiresAt = new Date(tokens.expires_at);
      // Consider expired if within 5 minutes of expiration
      if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if we have a refresh token available for token refresh
   * @returns true if refresh_token is present
   */
  hasRefreshToken(): boolean {
    return !!this.agent.oauth_tokens?.refresh_token;
  }

  /**
   * Clear all OAuth data for this agent
   */
  async clearAuth(): Promise<void> {
    await this.invalidateCredentials('all');
  }

  /**
   * Get the agent config this provider manages
   * @returns The AgentConfig with OAuth tokens populated after successful auth
   */
  getAgent(): AgentConfig {
    return this.agent;
  }

  /**
   * Get the agent identifier
   * @returns The agent's unique ID
   */
  getAgentId(): string {
    return this.agent.id;
  }
}
