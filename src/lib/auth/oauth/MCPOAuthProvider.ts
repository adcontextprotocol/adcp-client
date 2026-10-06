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
  assertOAuthCredentialIssuer,
  assertOAuthServerIssuer,
  OAuthError,
} from './types';
import { randomBytes } from 'crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { validateOAuthResourceUrl } from './resource-url';

// Peer dependency overrides must not silently restore the vulnerable OAuth flow.
let legacyOAuthSdkChecked = false;
export function assertLegacyOAuthSdk(): void {
  if (legacyOAuthSdkChecked) return;
  try {
    const clientPath = createRequire(resolve(__dirname, 'MCPOAuthProvider.js')).resolve(
      '@modelcontextprotocol/sdk/client/index.js'
    );
    const { version } = JSON.parse(readFileSync(resolve(dirname(clientPath), '../../../package.json'), 'utf8'));
    const match = typeof version === 'string' && /^1\.(\d+)\.\d+$/.exec(version);
    if (!match || Number(match[1]) < 31) {
      throw new OAuthError(
        'Legacy MCP OAuth requires @modelcontextprotocol/sdk >=1.31.0 within major 1. Upgrade the installed peer dependency.',
        'mcp_oauth_sdk_upgrade_required'
      );
    }
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError(
      'Cannot verify a patched legacy MCP SDK. Install @modelcontextprotocol/sdk ^1.31.0 and keep it external when bundling.',
      'mcp_oauth_sdk_upgrade_required'
    );
  }
  legacyOAuthSdkChecked = true;
}

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
 *   // A fresh interactive flow saves issuer-bound credentials afterward.
 * };
 *
 * const flowHandler = new CLIFlowHandler();
 * const provider = new MCPOAuthProvider({
 *   agent,
 *   flowHandler,
 *   clientMetadata: { ...DEFAULT_CLIENT_METADATA, redirect_uris: [flowHandler.getRedirectUrl().toString()] },
 *   allowInteractiveAuthorization: true,
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
  private readonly allowHttp: boolean;
  private readonly configuredResourceOverride?: string | null;
  private readonly allowInteractiveAuthorization: boolean;
  private pendingDiscoveryState?: OAuthDiscoveryState;

  constructor(config: OAuthProviderConfig) {
    this.agent = config.agent;
    this.storage = config.storage;
    this.flowHandler = config.flowHandler;
    this._clientMetadata = config.clientMetadata;
    this.allowHttp = config.allowHttp === true;
    this.configuredResourceOverride = config.resourceOverride;
    this.allowInteractiveAuthorization = config.allowInteractiveAuthorization === true;
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
      agent,
      flowHandler,
      storage,
      clientMetadata,
      allowHttp: options?.allowHttp,
      resourceOverride: options?.resourceOverride,
      allowInteractiveAuthorization: true,
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
      if (this.agent.oauth_client.client_secret) assertLegacyOAuthSdk();
      assertOAuthCredentialIssuer(this.agent.oauth_client, undefined, !!this.agent.oauth_client.client_secret);
      return toMCPClientInfo(this.agent.oauth_client);
    }
    return undefined;
  }

  /**
   * Save client information after dynamic registration
   */
  async saveClientInformation(clientInfo: OAuthClientInformationFull): Promise<void> {
    this.agent.oauth_client = fromMCPClientInfo(clientInfo);
    await this.persistCredentials();
  }

  /**
   * Load existing tokens from agent config
   */
  async tokens(ctx?: { issuer: string }): Promise<OAuthTokens | undefined> {
    this.checkIssuerContext(ctx);
    if (this.agent.oauth_tokens) {
      if (this.agent.oauth_tokens.refresh_token) assertLegacyOAuthSdk();
      assertOAuthCredentialIssuer(this.agent.oauth_tokens, undefined, !!this.agent.oauth_tokens.refresh_token);
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
    if (this.allowInteractiveAuthorization) {
      this.agent.oauth_code_verifier = undefined;
      this.agent.oauth_discovery_state = undefined;
    }
    this.pendingDiscoveryState = undefined;
    await this.persistCredentials();
  }

  /**
   * Redirect user to authorization URL
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.allowInteractiveAuthorization) throw this.ownerReauthorizationRequired('interactive_required');
    try {
      await this.flowHandler.redirectToAuthorization(authorizationUrl);
    } catch (error) {
      await this.invalidateCredentials('verifier');
      throw error;
    }
  }

  /** Persist the authorization-server identity across the callback leg. */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.validateDiscoveryState(state);
    if (!this.agent.oauth_client && !this.allowInteractiveAuthorization) throw this.ownerReauthorizationRequired();
    this.pendingDiscoveryState = structuredClone(state);
    // Interactive PKCE callbacks must survive provider/process reconstruction.
    // Background refresh must not save metadata-only mutations before a grant
    // refusal; token persistence remains its existing durable boundary.
    if (this.allowInteractiveAuthorization) {
      this.agent.oauth_discovery_state = structuredClone(state);
      await this.persistAgent();
    }
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    // A scheduled provider must never consume another owner's pending browser
    // PKCE state. Its validated refresh discovery remains private to this run.
    if (!this.allowInteractiveAuthorization) return undefined;
    if (!this.agent.oauth_code_verifier) return undefined;
    const state = this.pendingDiscoveryState ?? this.agent.oauth_discovery_state;
    if (!state) return undefined;
    // State persisted by older supported legacy clients was not necessarily
    // metadata-validated. Never return that state as trusted callback discovery.
    this.validateDiscoveryState(state);
    this.pendingDiscoveryState = structuredClone(state);
    return structuredClone(state);
  }

  private validateDiscoveryState(state: OAuthDiscoveryState): void {
    assertOAuthServerIssuer(state.authorizationServerMetadata, String(state.authorizationServerUrl));
    this.checkIssuerContext({ issuer: String(state.authorizationServerUrl) });
  }

  private checkIssuerContext(ctx?: { issuer: string }): string | undefined {
    // Legacy helpers supply no ctx on later credential reads; retain the
    // validated per-instance AS binding through those reads too.
    const issuer = ctx?.issuer ?? this.pendingDiscoveryState?.authorizationServerUrl;
    if (issuer !== undefined) {
      if (this.agent.oauth_tokens) {
        assertOAuthCredentialIssuer(this.agent.oauth_tokens, issuer, !!this.agent.oauth_tokens.refresh_token);
      }
      if (this.agent.oauth_client) {
        assertOAuthCredentialIssuer(this.agent.oauth_client, issuer, !!this.agent.oauth_client.client_secret);
      }
    }
    return issuer;
  }

  private ownerReauthorizationRequired(
    code: 'owner_reauthorization_required' | 'interactive_required' = 'owner_reauthorization_required'
  ): OAuthError {
    return new OAuthError(
      'OAuth owner reauthorization is required; this provider will not automatically clear credentials or register a new client. ' +
        'CLI: adcp <alias> --clear-oauth, then adcp <alias> --oauth.',
      code,
      this.agent.id
    );
  }

  /**
   * Save PKCE code verifier
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!this.allowInteractiveAuthorization) throw this.ownerReauthorizationRequired();
    this.agent.oauth_code_verifier = codeVerifier;
    await this.persistAgent();
  }

  /**
   * Load PKCE code verifier
   * The MCP SDK calls saveCodeVerifier() before authorization and
   * retrieves it here during token exchange.
   */
  async codeVerifier(): Promise<string> {
    if (!this.allowInteractiveAuthorization) throw this.ownerReauthorizationRequired();
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
  async invalidateCredentials(
    scope: Parameters<NonNullable<OAuthClientProvider['invalidateCredentials']>>[0]
  ): Promise<void> {
    if (!this.allowInteractiveAuthorization && (scope === 'discovery' || scope === 'verifier')) {
      this.pendingDiscoveryState = undefined;
      return;
    }
    if (!this.allowInteractiveAuthorization && (scope === 'all' || scope === 'client' || scope === 'tokens')) {
      throw this.ownerReauthorizationRequired();
    }
    await this.clearCredentials(scope);
  }

  private async clearCredentials(
    scope: Parameters<NonNullable<OAuthClientProvider['invalidateCredentials']>>[0]
  ): Promise<void> {
    switch (scope) {
      case 'all':
        this.pendingDiscoveryState = undefined;
        this.agent.oauth_discovery_state = undefined;
        this.agent.oauth_tokens = undefined;
        this.agent.oauth_client = undefined;
        this.agent.oauth_code_verifier = undefined;
        break;
      case 'tokens':
        this.agent.oauth_tokens = undefined;
        break;
      case 'client':
        this.pendingDiscoveryState = undefined;
        this.agent.oauth_discovery_state = undefined;
        this.agent.oauth_client = undefined;
        break;
      case 'discovery':
        this.pendingDiscoveryState = undefined;
        this.agent.oauth_discovery_state = undefined;
        break;
      case 'verifier':
        this.pendingDiscoveryState = undefined;
        this.agent.oauth_discovery_state = undefined;
        this.agent.oauth_code_verifier = undefined;
        break;
    }
    await this.persistAgent();
  }

  // ========================================
  // Additional methods
  // ========================================

  /**
   * Persist a credential update without modifying independent browser state.
   */
  private async persistCredentials(): Promise<void> {
    // Both token refresh and the official public-client issuer back-stamp can
    // save a stale snapshot. Omit browser fields from background saves so
    // storage preserves its current pending state instead of stale clears.
    let savedAgent = this.agent;
    if (!this.allowInteractiveAuthorization) {
      savedAgent = { ...this.agent };
      delete savedAgent.oauth_code_verifier;
      delete savedAgent.oauth_discovery_state;
    }
    await this.persistAgent(savedAgent);
  }

  private async persistAgent(agent: AgentConfig = this.agent): Promise<void> {
    if (this.storage) {
      await this.storage.saveAgent(agent);
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
