/**
 * OAuth Discovery utilities
 *
 * Functions to discover OAuth capabilities of MCP servers.
 * MCP servers expose OAuth metadata at /.well-known/oauth-authorization-server
 */

import { throwIfAborted } from '../../protocols/abort';
import { wrapFetchWithSizeLimit } from '../../protocols/responseSizeLimit';
import { ssrfSafeFetch, SsrfRefusedError, SSRF_TRANSIENT_CODES } from '../../net/ssrf-fetch';

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
  /**
   * Caller-owned fetch that provides connect-time DNS pinning itself.
   * Use only for a controlled test transport or a hardened egress proxy.
   */
  trustedFetchFn?: typeof fetch;
  /** @deprecated Rename to `trustedFetchFn`; the custom transport must pin DNS. */
  fetch?: typeof fetch;
  /** Permit HTTP and private DNS answers for local/private development agents. */
  allowPrivateIp?: boolean;
  /** Caller cancellation, including the absolute task deadline. */
  signal?: AbortSignal;
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
  const { timeout = 5000 } = options;
  if (options.fetch && options.trustedFetchFn && options.fetch !== options.trustedFetchFn) {
    throw new TypeError('DiscoveryOptions cannot set different fetch and trustedFetchFn implementations');
  }
  if (options.fetch) {
    console.warn(
      '[adcp] DiscoveryOptions.fetch is deprecated; rename it to trustedFetchFn. ' +
        'Custom fetch implementations must provide connect-time DNS pinning.'
    );
  }
  const selectedFetch = options.trustedFetchFn ?? options.fetch;
  const trustedFetchFn = selectedFetch ? wrapFetchWithSizeLimit(selectedFetch) : undefined;
  throwIfAborted(options.signal);

  try {
    const baseUrl = new URL(agentUrl);

    // RFC 8414 path-aware discovery: try path-suffixed URL first, then fall back to root.
    // For https://example.com/mcp, try:
    //   1. https://example.com/.well-known/oauth-authorization-server/mcp
    //   2. https://example.com/.well-known/oauth-authorization-server (fallback)
    const pathname = baseUrl.pathname.endsWith('/') ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname;
    const hasPath = pathname !== '' && pathname !== '/';

    const pathAwareUrl = hasPath ? new URL(`/.well-known/oauth-authorization-server${pathname}`, baseUrl.origin) : null;
    const rootUrl = new URL('/.well-known/oauth-authorization-server', baseUrl.origin);

    const urlsToTry = pathAwareUrl ? [pathAwareUrl, rootUrl] : [rootUrl];

    for (const metadataUrl of urlsToTry) {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

      try {
        const response = await ssrfSafeFetch(metadataUrl.toString(), {
          headers: { accept: 'application/json' },
          signal,
          timeoutMs: timeout,
          maxBodyBytes: 64 * 1024,
          allowPrivateIp: options.allowPrivateIp,
          ...(trustedFetchFn ? { trustedFetchFn } : {}),
        });

        if (response.status < 200 || response.status >= 300) {
          continue;
        }

        const metadata = JSON.parse(new TextDecoder().decode(response.body)) as OAuthMetadata;

        // Validate required fields
        if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
          continue;
        }

        return metadata;
      } catch (error) {
        throwIfAborted(options.signal);
        if (error instanceof SsrfRefusedError && !SSRF_TRANSIENT_CODES.has(error.code)) throw error;
        // Parse error, timeout, or network error on this URL -- try next
        continue;
      }
    }

    return null;
  } catch (error) {
    throwIfAborted(options.signal);
    if (error instanceof SsrfRefusedError && !SSRF_TRANSIENT_CODES.has(error.code)) throw error;
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
