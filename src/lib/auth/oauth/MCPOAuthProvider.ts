/**
 * MCP OAuth Provider
 *
 * Implements the MCP SDK's OAuthClientProvider interface
 * using AgentConfig for token storage.
 */

import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
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
import {
  DEFAULT_CLIENT_METADATA,
  toMCPTokens,
  fromMCPTokens,
  toMCPClientInfo,
  fromMCPClientInfo,
  OAuthError,
} from './types';
import { randomBytes } from 'crypto';
import { validateOAuthResourceUrl } from './resource-url';
import { assertOAuthCredentialIssuers, validatedOAuthIssuer } from './issuer';

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
 *   // A fresh interactive flow saves issuer-bound tokens here.
 * };
 *
 * const provider = new MCPOAuthProvider({
 *   allowInteractiveAuthorization: true,
 *   agent,
 *   flowHandler: new CLIFlowHandler(),
 *   clientMetadata: DEFAULT_CLIENT_METADATA,
 *   storage: myConfigStorage  // Optional: persists tokens
 * });
 *
 * const transport = new StreamableHTTPClientTransport(url, {
 *   authProvider: provider
 * });
 * ```
 */
export class MCPOAuthProvider implements OAuthClientProvider {
  private readonly allowInteractiveAuthorization: boolean;
  private savedDiscoveryState?: OAuthDiscoveryState;
  private agent: AgentConfig;
  private readonly storage?: OAuthConfigStorage;
  private readonly flowHandler: OAuthFlowHandler;
  private readonly _clientMetadata: OAuthClientMetadata;
  private readonly allowHttp: boolean;
  private readonly configuredResourceOverride?: string | null;

  constructor(config: OAuthProviderConfig) {
    this.allowInteractiveAuthorization = config.allowInteractiveAuthorization === true;
    this.agent = config.agent;
    this.storage = config.storage;
    this.flowHandler = config.flowHandler;
    this._clientMetadata = config.clientMetadata;
    this.allowHttp = config.allowHttp === true;
    this.configuredResourceOverride = config.resourceOverride;
  }

  /**
   * Create a provider for CLI usage
   */
  static forCLI(
    agent: AgentConfig,
    flowHandler: OAuthFlowHandler,
    storage?: OAuthConfigStorage,
    clientMetadataOverrides?: Partial<OAuthClientMetadata>,
    options?: { allowHttp?: boolean; resourceOverride?: string | null }
  ): MCPOAuthProvider {
    // Build complete client metadata with required fields
    const clientMetadata: OAuthClientMetadata = {
      ...DEFAULT_CLIENT_METADATA,
      redirect_uris: [flowHandler.getRedirectUrl().toString()],
      ...clientMetadataOverrides,
    };

    return new MCPOAuthProvider({
      allowInteractiveAuthorization: true,
      agent,
      flowHandler,
      storage,
      clientMetadata,
      allowHttp: options?.allowHttp,
      resourceOverride: options?.resourceOverride,
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
   * Validate the protected resource URL from server metadata (RFC 9728).
   *
   * Servers behind reverse proxies or DNS aliases may advertise a canonical
   * resource URL (RFC 8707) that differs from the URL the client connected to.
   * We allow cross-origin resource URLs because agent configs are pre-configured
   * by the user, not discovered from untrusted sources. The authorization server
   * remains the final gatekeeper for token audience validation.
   *
   * Non-HTTPS resource URLs are rejected by default. Construct the provider
   * with `allowHttp: true` to lift that restriction for local development —
   * mirrors the CLI's `--allow-http` flag.
   */
  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    const selectedResource =
      this.configuredResourceOverride === null
        ? resource
        : (this.configuredResourceOverride ?? this.agent.oauth_resource ?? resource);
    if (!selectedResource) {
      return undefined;
    }

    return validateOAuthResourceUrl(selectedResource, { allowHttp: this.allowHttp });
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
  async clientInformation(ctx?: { issuer: string }): Promise<OAuthClientInformation | undefined> {
    const issuer = this.checkIssuerContext(ctx);
    if (issuer && !this.agent.oauth_client && !this.allowInteractiveAuthorization) {
      throw this.ownerReauthorizationRequired();
    }
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
  async tokens(ctx?: { issuer: string }): Promise<OAuthTokens | undefined> {
    this.checkIssuerContext(ctx);
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
    this.agent.oauth_code_verifier = undefined;
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
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'discovery') {
      this.savedDiscoveryState = undefined;
      return;
    }
    if (!this.allowInteractiveAuthorization && (scope === 'all' || scope === 'client' || scope === 'tokens')) {
      throw this.ownerReauthorizationRequired();
    }
    await this.clearCredentials(scope);
  }

  private async clearCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    switch (scope) {
      case 'all':
        this.savedDiscoveryState = undefined;
        this.agent.oauth_tokens = undefined;
        this.agent.oauth_client = undefined;
        this.agent.oauth_code_verifier = undefined;
        break;
      case 'tokens':
        this.agent.oauth_tokens = undefined;
        break;
      case 'client':
        this.agent.oauth_client = undefined;
        break;
      case 'verifier':
        this.agent.oauth_code_verifier = undefined;
        break;
    }
    await this.persistAgent();
  }

  /** Public MCP lifecycle hook also protects legacy clients that supply no ctx. */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const issuer = validatedOAuthIssuer(state.authorizationServerUrl, state.authorizationServerMetadata?.issuer);
    assertOAuthCredentialIssuers(this.agent, issuer);
    if (!this.agent.oauth_client && !this.allowInteractiveAuthorization) throw this.ownerReauthorizationRequired();
    this.savedDiscoveryState = structuredClone(state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.savedDiscoveryState ? structuredClone(this.savedDiscoveryState) : undefined;
  }

  private checkIssuerContext(ctx?: { issuer: string }): string | undefined {
    const issuer = ctx?.issuer ?? this.savedDiscoveryState?.authorizationServerMetadata?.issuer;
    if (issuer !== undefined) assertOAuthCredentialIssuers(this.agent, issuer);
    return issuer;
  }

  private ownerReauthorizationRequired(): OAuthError {
    return new OAuthError(
      'OAuth owner reauthorization is required; this provider will not automatically clear credentials or register a new client. ' +
        'CLI: adcp <alias> --clear-oauth, then adcp --save-auth <alias> --oauth.',
      'owner_reauthorization_required',
      this.agent.id
    );
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
    await this.clearCredentials('all');
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
