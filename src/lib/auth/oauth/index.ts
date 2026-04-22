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
export { NonInteractiveFlowHandler, type NonInteractiveFlowHandlerConfig } from './NonInteractiveFlowHandler';

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
 * Create an OAuth provider that uses and auto-refreshes saved tokens but
 * refuses to start a new interactive browser flow. Use this for storyboard
 * runs, scheduled jobs, and other non-interactive contexts where you've
 * already saved tokens via `createCLIOAuthProvider`.
 *
 * If refresh fails (e.g., the refresh_token is revoked or expired), the
 * MCP SDK will throw `UnauthorizedError` at call time — the caller should
 * treat that as a signal to run `adcp --save-auth <alias> --oauth` and retry.
 */
export function createNonInteractiveOAuthProvider(
  agent: AgentConfig,
  options?: {
    /** Hint shown in error messages if an interactive flow is attempted. */
    agentHint?: string;
    /** Custom client metadata overrides (inherited from saved registration in practice). */
    clientMetadata?: Partial<OAuthClientMetadata>;
    /** Storage for persisting refreshed tokens back to disk. */
    storage?: OAuthConfigStorage;
  }
): MCPOAuthProvider {
  const { NonInteractiveFlowHandler } = require('./NonInteractiveFlowHandler');
  const flowHandler = new NonInteractiveFlowHandler({ agentHint: options?.agentHint });

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

// Diagnostics utilities — for `adcp diagnose-auth` and consumer introspection
export {
  parseWWWAuthenticate,
  decodeAccessTokenClaims,
  validateTokenAudience,
  type WWWAuthenticateChallenge,
  type DecodedJWTHeader,
  type DecodedJWTClaims,
  type DecodedAccessToken,
  type TokenAudienceResult,
} from './diagnostics';

// End-to-end OAuth handshake diagnosis (powers `adcp diagnose-auth`)
export {
  runAuthDiagnosis,
  AUTH_DIAGNOSIS_SCHEMA_VERSION,
  type DiagnoseOptions,
  type HttpCapture,
  type DiagnosisStep,
  type Hypothesis,
  type HypothesisVerdict,
  type AuthDiagnosisReport,
} from './diagnose';

// Zero-config authorization discovery + actionable error type.
// Raised automatically by `ProtocolClient.callTool` when an MCP agent returns
// a 401 Bearer challenge and the caller has no saved tokens.
export {
  NeedsAuthorizationError,
  discoverAuthorizationRequirements,
  type AuthorizationRequirements,
  type DiscoverAuthorizationOptions,
} from './authorization-required';

// File-backed `OAuthConfigStorage` implementation (agents.json format).
export { createFileOAuthStorage, type FileOAuthStorageOptions } from './file-storage';

// OAuth 2.0 client credentials grant (RFC 6749 §4.4) for machine-to-machine
// token exchange. Used by the CLI for automated compliance runs where there
// is no user to walk through an authorization-code flow.
export {
  exchangeClientCredentials,
  ensureClientCredentialsTokens,
  ClientCredentialsExchangeError,
  type ExchangeClientCredentialsOptions,
  type EnsureClientCredentialsOptions,
} from './ClientCredentialsFlow';

// `$ENV:VAR` indirection for client credentials so secrets can live in env
// vars (CI) rather than on disk in the agent config.
export {
  resolveSecret,
  isEnvSecretReference,
  toEnvSecretReference,
  extractEnvSecretName,
  MissingEnvSecretError,
} from './secret-resolver';

// Type re-export — the credentials struct itself lives in the ADCP core types
// module alongside `AgentOAuthTokens` / `AgentOAuthClient`.
export type { AgentOAuthClientCredentials } from '../../types/adcp';

// Per-agent storage binding — the bridge that lets `callTool` pick up the
// caller's chosen `OAuthConfigStorage` without a signature change.
export { bindAgentStorage, getAgentStorage, unbindAgentStorage } from './storage-registry';

// Re-exported MCP SDK OAuth error types so consumers can discriminate 401 causes
// without string-matching on error messages. These originate from the MCP server
// auth module but are the canonical OAuth error classes for client-side handling too.
export { InvalidTokenError, InsufficientScopeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
