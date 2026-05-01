// Official MCP client implementation using HTTP streaming transport with SSE fallback
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { createHash } from 'node:crypto';
import { createMCPAuthHeaders } from '../auth';
import { is401Error } from '../errors';
import type { DebugLogEntry } from '../types/adcp';
import { withSpan, injectTraceHeaders } from '../observability/tracing';
import { buildAgentSigningFetch, signingContextStorage, type AgentSigningContext } from '../signing/client';
import { redactIdempotencyKeyInArgs } from '../utils/idempotency';
import { wrapFetchWithCapture } from './rawResponseCapture';
import { wrapFetchWithSizeLimit } from './responseSizeLimit';

// Re-export for convenience
export { UnauthorizedError };

/** Response shape returned by MCPClient.callTool(). */
type CallToolResponse = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
};

/**
 * Module-level connection cache keyed by agent URL + auth token hash.
 * Reuses MCP connections across tool calls to avoid TCP connection exhaustion
 * during comply/test runs that make dozens of sequential calls.
 *
 * Uses LRU eviction: cache hits delete-and-re-insert the entry so that
 * Map iteration order reflects most-recent access.
 *
 * The cache key includes only URL + auth token hash. Custom headers and trace
 * headers are set at connection-creation time and fixed for the connection's
 * lifetime — callers with different custom headers will share a connection
 * created with the first caller's headers.
 *
 * Note: This is a process-global singleton. Not suitable for multi-tenant
 * server use where different tenants share a process.
 */
const connectionCache = new Map<string, MCPClient>();
const pendingConnections = new Map<string, Promise<MCPClient>>();
const MAX_CACHED_CONNECTIONS = 20;

/**
 * Track URLs where StreamableHTTP has previously connected successfully.
 * When reconnecting to these URLs, skip SSE fallback — if StreamableHTTP
 * worked before, SSE won't help and will just produce 405 errors on
 * servers that only support POST-based StreamableHTTP.
 *
 * Capped at MAX_CACHED_CONNECTIONS to avoid unbounded growth. Oldest
 * entries are evicted first (Set iteration order = insertion order).
 */
const knownStreamableHTTPUrls = new Set<string>();

function trackStreamableHTTPUrl(url: string): void {
  // Refresh position if already known
  knownStreamableHTTPUrls.delete(url);
  knownStreamableHTTPUrls.add(url);
  // Evict oldest if over capacity
  while (knownStreamableHTTPUrls.size > MAX_CACHED_CONNECTIONS) {
    const oldest = knownStreamableHTTPUrls.values().next().value;
    if (oldest) knownStreamableHTTPUrls.delete(oldest);
  }
}

/**
 * Returns true for loopback and RFC-1918 private addresses where SSE fallback
 * is counterproductive: these agents are always StreamableHTTP-capable and will
 * return 405 on the SSE GET probe, masking the real StreamableHTTP failure.
 * Covers IPv4 loopback/private ranges, IPv6 loopback/link-local, IPv4-mapped
 * IPv6 (::ffff:x.y.z.w), and unspecified addresses (0.0.0.0 / ::).
 */
function isPrivateAddress(url: URL): boolean {
  // WHATWG URL strips brackets from IPv6 literals; hostname is already bare
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') return true;
  // Unwrap IPv4-mapped IPv6 (::ffff:x.y.z.w) so the IPv4-range checks below apply to both
  const bare = host.startsWith('::ffff:') ? host.slice(7) : host;
  // IPv4 loopback
  if (/^127\./.test(bare)) return true;
  // RFC-1918 private ranges
  if (/^10\./.test(bare)) return true;
  if (/^192\.168\./.test(bare)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(bare)) return true;
  // IPv6 link-local (not affected by ::ffff: stripping)
  if (/^fe80:/i.test(host)) return true;
  return false;
}

function connectionCacheKey(agentUrl: string, authToken?: string, signingCacheKey?: string): string {
  const base = authToken
    ? `${agentUrl}::${createHash('sha256').update(authToken).digest('hex').slice(0, 16)}`
    : agentUrl;
  return signingCacheKey ? `${base}::${signingCacheKey}` : base;
}

/** Get a cached connection, refreshing its LRU position. */
function getCachedConnection(key: string): MCPClient | undefined {
  const client = connectionCache.get(key);
  if (client) {
    // Delete and re-insert so this key moves to the end (most-recently-used)
    connectionCache.delete(key);
    connectionCache.set(key, client);
  }
  return client;
}

function evictLeastRecentlyUsed(): void {
  if (connectionCache.size <= MAX_CACHED_CONNECTIONS) return;
  // Map iteration order is insertion-order; first key = least-recently-used
  const lruKey = connectionCache.keys().next().value;
  if (!lruKey) return;
  const oldClient = connectionCache.get(lruKey);
  connectionCache.delete(lruKey);
  // Fire-and-forget: eviction is on the hot path; close is best-effort
  oldClient?.close().catch(() => {});
}

/**
 * Close all cached MCP connections.
 * Call this at the end of comply/test runs or before process exit.
 */
export async function closeMCPConnections(): Promise<void> {
  const entries = [...connectionCache.entries()];
  connectionCache.clear();
  knownStreamableHTTPUrls.clear();
  for (const [, client] of entries) {
    try {
      await client.close();
    } catch {
      /* ignore close errors */
    }
  }
}

/**
 * Get or create a cached connection for the given cache key.
 * Concurrent callers for the same key share a single in-flight connection
 * attempt via the pendingConnections map, preventing duplicate connections.
 */
async function getOrCreateConnection(
  cacheKey: string,
  baseUrl: URL,
  authHeaders: Record<string, string>,
  debugLogs: DebugLogEntry[],
  label: string
): Promise<MCPClient> {
  const cached = getCachedConnection(cacheKey);
  if (cached) return cached;

  const pending = pendingConnections.get(cacheKey);
  if (pending) return pending;

  const promise = connectMCPWithFallback(baseUrl, authHeaders, debugLogs, label)
    .then(client => {
      connectionCache.set(cacheKey, client);
      evictLeastRecentlyUsed();
      return client;
    })
    .finally(() => {
      pendingConnections.delete(cacheKey);
    });

  pendingConnections.set(cacheKey, promise);
  return promise;
}

/**
 * Get or create a cached MCP connection, then call `fn` with it.
 * On transport errors, evicts the stale connection and retries once.
 * Auth errors (401) evict and close the connection, then throw immediately.
 *
 * @internal Used by mcp-tasks.ts for protocol-level task operations.
 * Not part of the public API — do not import from outside the protocols directory.
 */
export async function withCachedConnection<T>(
  agentUrl: string,
  authToken: string | undefined,
  authHeaders: Record<string, string>,
  debugLogs: DebugLogEntry[],
  label: string,
  fn: (client: MCPClient) => Promise<T>
): Promise<T> {
  const signingContext = signingContextStorage.getStore();
  const cacheKey = connectionCacheKey(agentUrl, authToken, signingContext?.cacheKey);
  const baseUrl = new URL(agentUrl);

  const mcpClient = await getOrCreateConnection(cacheKey, baseUrl, authHeaders, debugLogs, label);

  try {
    return await fn(mcpClient);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    debugLogs.push({
      type: 'error',
      message: `MCP: ${label} call failed: ${errorMessage}`,
      timestamp: new Date().toISOString(),
      error,
    });

    // Auth errors won't be fixed by reconnecting — fail fast
    if (is401Error(error)) {
      connectionCache.delete(cacheKey);
      try {
        await mcpClient.close();
      } catch {
        /* ignore */
      }
      debugLogs.push({
        type: 'warning',
        message: `MCP: Authentication issue detected for ${label} - headers may not be reaching server`,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    // Evict stale connection and retry once with a fresh connection
    connectionCache.delete(cacheKey);
    try {
      await mcpClient.close();
    } catch {
      /* ignore */
    }

    const retryClient = await getOrCreateConnection(cacheKey, baseUrl, authHeaders, debugLogs, `${label} (retry)`);

    try {
      return await fn(retryClient);
    } catch (retryError) {
      // Attach original error for diagnostics
      if (retryError instanceof Error && error instanceof Error) {
        retryError.cause = error;
      }
      throw retryError;
    }
  }
}

/**
 * Options for MCP tool calls with OAuth support
 */
export interface MCPCallOptions {
  /** Agent URL */
  agentUrl: string;
  /** Tool name to call */
  toolName: string;
  /** Tool arguments */
  args: Record<string, unknown>;
  /** Static auth token (legacy) */
  authToken?: string;
  /** OAuth provider for dynamic auth */
  authProvider?: OAuthClientProvider;
  /** Debug logs array */
  debugLogs?: DebugLogEntry[];
  /** Additional headers to send with every request (auth headers take precedence) */
  customHeaders?: Record<string, string>;
  /** RFC 9421 signing context — when set, the transport signs outbound ops per seller capability. */
  signingContext?: AgentSigningContext;
}

/**
 * Result of an MCP connection attempt
 */
export interface MCPConnectionResult {
  client: MCPClient;
  transport: StreamableHTTPClientTransport;
}

/**
 * Connect an MCPClient to the given URL with automatic transport fallback.
 *
 * Strategy:
 *  1. Try StreamableHTTPClientTransport.
 *  2. If a 404 StreamableHTTPError is returned (stale session), retry once with a
 *     fresh StreamableHTTP connection — the server supports the protocol, the
 *     session just expired.
 *  3. If a 401 is returned, throw immediately — auth failure is transport-agnostic.
 *  4. For any other error, fall back to SSEClientTransport with the same headers.
 *
 * The returned client is connected and ready for use. Callers are responsible for
 * calling client.close() when done.
 *
 * Auth: pass either `authHeaders` (static token) or `options.authProvider` (OAuth).
 * The provider is forwarded to both StreamableHTTP and SSE transports so OAuth
 * works through the SSE fallback as well.
 */
export async function connectMCPWithFallback(
  url: URL,
  authHeaders: Record<string, string>,
  debugLogs: DebugLogEntry[] = [],
  label = 'connection',
  options: { authProvider?: OAuthClientProvider } = {}
): Promise<MCPClient> {
  return withSpan(
    'adcp.mcp.connect',
    {
      'http.url': url.toString(),
      'adcp.connection_label': label,
    },
    async () => {
      return connectMCPWithFallbackImpl(url, authHeaders, debugLogs, label, options);
    }
  );
}

async function connectMCPWithFallbackImpl(
  url: URL,
  authHeaders: Record<string, string>,
  debugLogs: DebugLogEntry[] = [],
  label = 'connection',
  options: { authProvider?: OAuthClientProvider } = {}
): Promise<MCPClient> {
  const signingContext = signingContextStorage.getStore();
  // Wrap order (innermost → outermost): network → size-limit → signing → capture.
  // Size-limit applies to the raw network response so signing/capture see a
  // bounded body (capture clones via `response.clone()`, which would otherwise
  // buffer a hostile reply in memory).
  const sizeLimited = wrapFetchWithSizeLimit((input, init) => fetch(input as any, init));
  const baseFetch: typeof fetch = signingContext
    ? (buildAgentSigningFetch({
        upstream: sizeLimited,
        signing: signingContext.signing,
        getCapability: signingContext.getCapability,
      }) as typeof fetch)
    : sizeLimited;
  const transportOptions: StreamableHTTPClientTransportOptions = {
    requestInit: { headers: authHeaders },
    fetch: wrapFetchWithCapture(baseFetch),
  };
  if (options.authProvider) {
    transportOptions.authProvider = options.authProvider;
  }
  let failedClient: MCPClient | undefined;

  try {
    const client = new MCPClient({ name: 'AdCP-Client', version: '1.0.0' });
    failedClient = client;
    debugLogs.push({
      type: 'info',
      message: `MCP: Attempting StreamableHTTP ${label} to ${url}`,
      timestamp: new Date().toISOString(),
    });
    await client.connect(new StreamableHTTPClientTransport(url, transportOptions));
    failedClient = undefined;
    trackStreamableHTTPUrl(url.toString());
    debugLogs.push({
      type: 'success',
      message: `MCP: Connected via StreamableHTTP for ${label}`,
      timestamp: new Date().toISOString(),
    });
    return client;
  } catch (error: unknown) {
    // Close the failed client to avoid resource leaks
    if (failedClient) {
      try {
        await failedClient.close();
      } catch {
        /* ignore */
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorClass = error instanceof Error ? error.constructor.name : typeof error;
    const httpStatus = error instanceof StreamableHTTPError ? ` [HTTP ${error.code}]` : '';
    debugLogs.push({
      type: 'error',
      message: `MCP: StreamableHTTP failed for ${label}${httpStatus} (${errorClass}): ${errorMessage}`,
      timestamp: new Date().toISOString(),
      error,
    });

    // Stale/expired session — retry StreamableHTTP with a fresh connection.
    // 404 = session not found (per MCP spec), 400 = "Session not found" (SDK #1852),
    // other StreamableHTTPError codes may also indicate session issues.
    // Always retry StreamableHTTP before falling back to SSE.
    if (error instanceof StreamableHTTPError) {
      debugLogs.push({
        type: 'info',
        message: `MCP: Session error (${error.code}) detected, retrying StreamableHTTP for ${label}`,
        timestamp: new Date().toISOString(),
      });
      try {
        const client = new MCPClient({ name: 'AdCP-Client', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(url, transportOptions));
        trackStreamableHTTPUrl(url.toString());
        debugLogs.push({
          type: 'success',
          message: `MCP: Connected via StreamableHTTP (retry) for ${label}`,
          timestamp: new Date().toISOString(),
        });
        return client;
      } catch (retryError) {
        debugLogs.push({
          type: 'error',
          message: `MCP: StreamableHTTP retry also failed for ${label}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          timestamp: new Date().toISOString(),
        });
        // Fall through to SSE fallback below
      }
    }

    // Auth failure — transport type won't change the outcome
    if (is401Error(error)) {
      throw error;
    }

    // If StreamableHTTP previously worked for this URL, don't fall back to SSE.
    // Transient failures (connection reuse, concurrency limits) should be retried
    // with StreamableHTTP, not SSE — SSE sends GET requests that return 405 on
    // servers that only support POST-based StreamableHTTP.
    if (knownStreamableHTTPUrls.has(url.toString())) {
      debugLogs.push({
        type: 'info',
        message: `MCP: StreamableHTTP previously succeeded for ${url} — skipping SSE fallback for ${label}`,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    // Private/loopback addresses always support StreamableHTTP — SSE would return
    // 405 on GET /mcp, masking the actual failure and producing a misleading error.
    // Surface the StreamableHTTP failure directly so operators can diagnose it.
    if (isPrivateAddress(url)) {
      debugLogs.push({
        type: 'warning',
        message: `MCP: SSE fallback skipped for private/loopback address ${url} — StreamableHTTP failure is the root cause for ${label}`,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    // Fall back to SSE (public addresses only)
    debugLogs.push({
      type: 'warning',
      message: `MCP: Falling back to SSE transport for ${label}`,
      timestamp: new Date().toISOString(),
    });
    const client = new MCPClient({ name: 'AdCP-Client', version: '1.0.0' });
    await client.connect(
      new SSEClientTransport(url, {
        requestInit: { headers: authHeaders },
        fetch: wrapFetchWithCapture(baseFetch),
        ...(options.authProvider ? { authProvider: options.authProvider } : {}),
      })
    );
    debugLogs.push({
      type: 'success',
      message: `MCP: Connected via SSE transport for ${label}`,
      timestamp: new Date().toISOString(),
    });
    return client;
  }
}

export async function callMCPTool(
  agentUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  customHeaders?: Record<string, string>,
  signingContext?: AgentSigningContext
): Promise<unknown> {
  return withSpan(
    'adcp.mcp.call_tool',
    {
      'adcp.tool': toolName,
      'http.url': agentUrl,
    },
    async () => {
      return signingContextStorage.run(signingContext, () =>
        callMCPToolImpl(agentUrl, toolName, args, authToken, debugLogs, customHeaders)
      );
    }
  );
}

/**
 * Call an MCP tool and return the raw CallToolResult (with isError, content, structuredContent).
 * Raw MCP tool call — returns the CallToolResult directly, including isError responses.
 */
export async function callMCPToolRaw(
  agentUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  customHeaders?: Record<string, string>,
  signingContext?: AgentSigningContext
): Promise<unknown> {
  return signingContextStorage.run(signingContext, () =>
    callMCPToolRawImpl(agentUrl, toolName, args, authToken, debugLogs, customHeaders)
  );
}

async function callMCPToolImpl(
  agentUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  customHeaders?: Record<string, string>
): Promise<unknown> {
  // Inject trace context headers for distributed tracing
  const traceHeaders = injectTraceHeaders();

  // Merge: custom < trace < auth (auth always wins)
  const authHeaders = {
    ...customHeaders,
    ...traceHeaders,
    ...(authToken ? createMCPAuthHeaders(authToken) : {}),
  };

  // Log auth configuration (token values redacted)
  debugLogs.push({
    type: 'info',
    message: `MCP: Auth configuration`,
    timestamp: new Date().toISOString(),
    hasAuth: !!authToken,
    headers: authToken ? { 'x-adcp-auth': '***' } : {},
    customHeaderKeys: customHeaders ? Object.keys(customHeaders) : [],
  });

  debugLogs.push({
    type: 'info',
    message: `MCP: Calling tool ${toolName} with args: ${JSON.stringify(redactIdempotencyKeyInArgs(args))}`,
    timestamp: new Date().toISOString(),
  });

  if (authToken) {
    debugLogs.push({
      type: 'info',
      message: `MCP: Transport configured with x-adcp-auth header for ${toolName}`,
      timestamp: new Date().toISOString(),
    });
  }

  const response = await withCachedConnection(
    agentUrl,
    authToken,
    authHeaders,
    debugLogs,
    toolName,
    client => client.callTool({ name: toolName, arguments: args }) as Promise<CallToolResponse>
  );

  debugLogs.push({
    type: response?.isError ? 'error' : 'success',
    message: `MCP: Tool ${toolName} response received (${response?.isError ? 'error' : 'success'})`,
    timestamp: new Date().toISOString(),
    response: response,
  });

  return response;
}

/**
 * Raw MCP tool call — returns the CallToolResult directly.
 */
async function callMCPToolRawImpl(
  agentUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  customHeaders?: Record<string, string>
): Promise<unknown> {
  const traceHeaders = injectTraceHeaders();
  const authHeaders = {
    ...customHeaders,
    ...traceHeaders,
    ...(authToken ? createMCPAuthHeaders(authToken) : {}),
  };

  return withCachedConnection(agentUrl, authToken, authHeaders, debugLogs, toolName, client =>
    client.callTool({ name: toolName, arguments: args })
  );
}

/**
 * Connect to an MCP server with OAuth support
 *
 * This function handles both static token auth and OAuth flows.
 * When using OAuth, if the server requires authorization:
 * 1. UnauthorizedError is thrown
 * 2. The OAuth provider's redirectToAuthorization is called
 * 3. Caller should wait for callback and call finishAuth on transport
 *
 * @param options Connection options
 * @returns MCP client and transport (for finishing OAuth if needed)
 * @throws UnauthorizedError if OAuth is required
 *
 * @example
 * ```typescript
 * // With OAuth provider
 * const provider = createCLIOAuthProvider(serverUrl);
 *
 * try {
 *   const { client, transport } = await connectMCP({
 *     agentUrl: serverUrl,
 *     authProvider: provider
 *   });
 *   // Connected! Use client...
 * } catch (error) {
 *   if (error instanceof UnauthorizedError) {
 *     // OAuth flow started, wait for callback
 *     const code = await provider.waitForCallback();
 *     await transport.finishAuth(code);
 *     // Retry connection...
 *   }
 * }
 * ```
 */
export async function connectMCP(options: {
  agentUrl: string;
  authToken?: string;
  authProvider?: OAuthClientProvider;
  debugLogs?: DebugLogEntry[];
  customHeaders?: Record<string, string>;
  signingContext?: AgentSigningContext;
}): Promise<MCPConnectionResult> {
  const { agentUrl, authToken, authProvider, debugLogs = [], customHeaders, signingContext } = options;
  const baseUrl = new URL(agentUrl);

  debugLogs.push({
    type: 'info',
    message: `MCP: Connecting to ${baseUrl}`,
    timestamp: new Date().toISOString(),
    authMethod: authProvider ? 'oauth' : authToken ? 'token' : 'none',
  });

  const mcpClient = new MCPClient({
    name: 'AdCP-Client',
    version: '1.0.0',
  });

  // Build transport options
  const transportOptions: StreamableHTTPClientTransportOptions = {};

  if (authProvider) {
    // Use OAuth provider
    transportOptions.authProvider = authProvider;
    debugLogs.push({
      type: 'info',
      message: 'MCP: Using OAuth provider for authentication',
      timestamp: new Date().toISOString(),
    });
  } else if (authToken) {
    // Use static token, merged with any custom headers (auth takes precedence)
    const authHeaders = { ...customHeaders, ...createMCPAuthHeaders(authToken) };
    transportOptions.requestInit = { headers: authHeaders };
    debugLogs.push({
      type: 'info',
      message: 'MCP: Using static token for authentication',
      timestamp: new Date().toISOString(),
    });
  }

  // RFC 9421 signing — wrap the transport's fetch so the signer sees the final
  // headers the SDK assembled (including any OAuth-issued Authorization) and
  // decides per outbound request whether to sign. Size-limit sits innermost so
  // the response body is bounded before signing/capture observe it.
  const sizeLimited = wrapFetchWithSizeLimit((input, init) => fetch(input as string | URL, init));
  const signedFetch: typeof fetch = signingContext
    ? (buildAgentSigningFetch({
        upstream: sizeLimited,
        signing: signingContext.signing,
        getCapability: signingContext.getCapability,
      }) as typeof fetch)
    : sizeLimited;
  transportOptions.fetch = wrapFetchWithCapture(signedFetch);

  const transport = new StreamableHTTPClientTransport(baseUrl, transportOptions);

  try {
    await mcpClient.connect(transport);
    debugLogs.push({
      type: 'success',
      message: 'MCP: Connected successfully',
      timestamp: new Date().toISOString(),
    });
    return { client: mcpClient, transport };
  } catch (error) {
    // If it's an UnauthorizedError, the OAuth flow has started
    // Rethrow so the caller can handle the callback
    if (error instanceof UnauthorizedError) {
      debugLogs.push({
        type: 'info',
        message: 'MCP: OAuth authorization required, flow initiated',
        timestamp: new Date().toISOString(),
      });
      // Return transport so caller can call finishAuth
      throw Object.assign(error, { transport, client: mcpClient });
    }
    throw error;
  }
}

/**
 * Call an MCP tool with OAuth support.
 *
 * Note: OAuth connections are NOT cached (each call creates a fresh connection)
 * because OAuth token refresh requires transport-level coordination that is
 * incompatible with connection pooling. This is acceptable because OAuth flows
 * are interactive and infrequent.
 *
 * Signing: this path consumes `options.signingContext` via the transport —
 * `connectMCP` attaches a signing-fetch wrapper at transport-creation time —
 * rather than via `signingContextStorage`. Because each OAuth call creates a
 * fresh transport that isn't shared across calls, there's no cache-key
 * disambiguation concern and no need to seed ALS. The non-OAuth fallback
 * (`callMCPTool`) does enter ALS.
 *
 * @param options Call options
 * @returns Tool response
 * @throws UnauthorizedError if OAuth is required (with transport attached)
 */
export async function callMCPToolWithOAuth(options: MCPCallOptions): Promise<unknown> {
  const { agentUrl, toolName, args, authToken, authProvider, debugLogs = [], customHeaders, signingContext } = options;

  // If no OAuth provider, use the legacy function
  if (!authProvider) {
    return callMCPTool(agentUrl, toolName, args, authToken, debugLogs, customHeaders, signingContext);
  }

  let client: MCPClient | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  try {
    const result = await connectMCP({
      agentUrl,
      authProvider,
      debugLogs,
      customHeaders,
      signingContext,
    });
    client = result.client;
    transport = result.transport;

    debugLogs.push({
      type: 'info',
      message: `MCP: Calling tool ${toolName}`,
      timestamp: new Date().toISOString(),
    });

    const response = await client.callTool({
      name: toolName,
      arguments: args,
    });

    debugLogs.push({
      type: response?.isError ? 'error' : 'success',
      message: `MCP: Tool ${toolName} response received`,
      timestamp: new Date().toISOString(),
    });

    return response;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}
