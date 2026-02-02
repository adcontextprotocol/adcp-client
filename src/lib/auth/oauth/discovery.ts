/**
 * OAuth Discovery utilities
 *
 * Functions to discover OAuth capabilities of MCP servers.
 * MCP servers expose OAuth metadata at /.well-known/oauth-authorization-server
 */

/**
 * OAuth Authorization Server Metadata
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */
export interface OAuthMetadata {
  /** URL of the authorization endpoint */
  authorization_endpoint: string;
  /** URL of the token endpoint */
  token_endpoint: string;
  /** URL of the dynamic client registration endpoint (optional) */
  registration_endpoint?: string;
  /** Issuer identifier */
  issuer?: string;
  /** PKCE code challenge methods supported */
  code_challenge_methods_supported?: string[];
  /** Response types supported */
  response_types_supported?: string[];
  /** Grant types supported */
  grant_types_supported?: string[];
  /** Token endpoint auth methods supported */
  token_endpoint_auth_methods_supported?: string[];
  /** Scopes supported */
  scopes_supported?: string[];
}

/**
 * Options for OAuth discovery
 */
export interface DiscoveryOptions {
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Custom fetch function (for testing or custom HTTP handling) */
  fetch?: typeof fetch;
}

/**
 * Discover OAuth metadata from an MCP server
 *
 * Fetches the OAuth Authorization Server Metadata from the well-known endpoint.
 * Returns null if the server doesn't support OAuth or the metadata isn't available.
 *
 * @param agentUrl - The MCP server URL
 * @param options - Discovery options
 * @returns OAuth metadata or null if not available
 *
 * @example
 * ```typescript
 * const metadata = await discoverOAuthMetadata('https://agent.example.com/mcp');
 * if (metadata) {
 *   console.log('Authorization URL:', metadata.authorization_endpoint);
 *   console.log('Supports dynamic registration:', !!metadata.registration_endpoint);
 * }
 * ```
 */
export async function discoverOAuthMetadata(
  agentUrl: string,
  options: DiscoveryOptions = {}
): Promise<OAuthMetadata | null> {
  const { timeout = 5000, fetch: customFetch = fetch } = options;

  try {
    const baseUrl = new URL(agentUrl);
    const metadataUrl = new URL('/.well-known/oauth-authorization-server', baseUrl.origin);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await customFetch(metadataUrl.toString(), {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const metadata = (await response.json()) as OAuthMetadata;

      // Validate required fields
      if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
        return null;
      }

      return metadata;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    // Network error, timeout, or invalid URL - agent doesn't support OAuth
    return null;
  }
}

/**
 * Check if an MCP server supports OAuth authentication
 *
 * This is a simple boolean check - use discoverOAuthMetadata() if you need
 * the actual endpoints.
 *
 * @param agentUrl - The MCP server URL
 * @param options - Discovery options
 * @returns true if the server supports OAuth
 *
 * @example
 * ```typescript
 * if (await supportsOAuth('https://agent.example.com/mcp')) {
 *   console.log('Agent requires OAuth authentication');
 * }
 * ```
 */
export async function supportsOAuth(agentUrl: string, options: DiscoveryOptions = {}): Promise<boolean> {
  const metadata = await discoverOAuthMetadata(agentUrl, options);
  return metadata !== null;
}

/**
 * Check if an MCP server supports dynamic client registration
 *
 * Servers that support dynamic registration allow clients to register
 * automatically without pre-configured credentials.
 *
 * @param agentUrl - The MCP server URL
 * @param options - Discovery options
 * @returns true if the server supports dynamic client registration
 *
 * @example
 * ```typescript
 * if (await supportsDynamicRegistration('https://agent.example.com/mcp')) {
 *   console.log('Agent supports automatic client registration');
 * }
 * ```
 */
export async function supportsDynamicRegistration(agentUrl: string, options: DiscoveryOptions = {}): Promise<boolean> {
  const metadata = await discoverOAuthMetadata(agentUrl, options);
  return metadata?.registration_endpoint !== undefined;
}
