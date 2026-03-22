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

function connectionCacheKey(agentUrl: string, authToken?: string): string {
  if (!authToken) return agentUrl;
  const tokenHash = createHash('sha256').update(authToken).digest('hex').slice(0, 16);
  return `${agentUrl}::${tokenHash}`;
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
  const cacheKey = connectionCacheKey(agentUrl, authToken);
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
 */
export async function connectMCPWithFallback(
  url: URL,
  authHeaders: Record<string, string>,
  debugLogs: DebugLogEntry[] = [],
  label = 'connection'
): Promise<MCPClient> {
  return withSpan(
    'adcp.mcp.connect',
    {
      'http.url': url.toString(),
      'adcp.connection_label': label,
    },
    async () => {
      return connectMCPWithFallbackImpl(url, authHeaders, debugLogs, label);
    }
  );
}

async function connectMCPWithFallbackImpl(
  url: URL,
  authHeaders: Record<string, string>,
  debugLogs: DebugLogEntry[] = [],
  label = 'connection'
): Promise<MCPClient> {
  const transportOptions = { requestInit: { headers: authHeaders } };
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
    debugLogs.push({
      type: 'error',
      message: `MCP: StreamableHTTP failed for ${label}: ${errorMessage}`,
      timestamp: new Date().toISOString(),
      error,
    });

    // Stale session — retry StreamableHTTP with a fresh connection
    if (error instanceof StreamableHTTPError && error.code === 404) {
      debugLogs.push({
        type: 'info',
        message: `MCP: Session error detected, retrying StreamableHTTP for ${label}`,
        timestamp: new Date().toISOString(),
      });
      const client = new MCPClient({ name: 'AdCP-Client', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(url, transportOptions));
      debugLogs.push({
        type: 'success',
        message: `MCP: Connected via StreamableHTTP (retry) for ${label}`,
        timestamp: new Date().toISOString(),
      });
      return client;
    }

    // Auth failure — transport type won't change the outcome
    if (is401Error(error)) {
      throw error;
    }

    // Fall back to SSE
    debugLogs.push({
      type: 'info',
      message: `MCP: Falling back to SSE transport for ${label}`,
      timestamp: new Date().toISOString(),
    });
    const client = new MCPClient({ name: 'AdCP-Client', version: '1.0.0' });
    await client.connect(new SSEClientTransport(url, { requestInit: { headers: authHeaders } }));
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
  customHeaders?: Record<string, string>
): Promise<unknown> {
  return withSpan(
    'adcp.mcp.call_tool',
    {
      'adcp.tool': toolName,
      'http.url': agentUrl,
    },
    async () => {
      return callMCPToolImpl(agentUrl, toolName, args, authToken, debugLogs, customHeaders);
    }
  );
}

/**
 * Call an MCP tool and return the raw CallToolResult (with isError, content, structuredContent).
 * Unlike callMCPTool, this does NOT throw on isError responses — needed for error compliance testing.
 */
export async function callMCPToolRaw(
  agentUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  customHeaders?: Record<string, string>
): Promise<unknown> {
  return callMCPToolRawImpl(agentUrl, toolName, args, authToken, debugLogs, customHeaders);
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
    message: `MCP: Calling tool ${toolName} with args: ${JSON.stringify(args)}`,
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

  // If MCP returns an error response, throw an error with the extracted message
  if (response?.isError && response?.content && Array.isArray(response.content)) {
    const errorText = response.content
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text)
      .join('\n');

    throw new Error(errorText || `MCP tool '${toolName}' execution failed (no error details provided)`);
  }

  return response;
}

/**
 * Raw MCP tool call — returns the CallToolResult without throwing on isError.
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
}): Promise<MCPConnectionResult> {
  const { agentUrl, authToken, authProvider, debugLogs = [], customHeaders } = options;
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
 * @param options Call options
 * @returns Tool response
 * @throws UnauthorizedError if OAuth is required (with transport attached)
 */
export async function callMCPToolWithOAuth(options: MCPCallOptions): Promise<unknown> {
  const { agentUrl, toolName, args, authToken, authProvider, debugLogs = [], customHeaders } = options;

  // If no OAuth provider, use the legacy function
  if (!authProvider) {
    return callMCPTool(agentUrl, toolName, args, authToken, debugLogs, customHeaders);
  }

  let client: MCPClient | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  try {
    const result = await connectMCP({
      agentUrl,
      authProvider,
      debugLogs,
      customHeaders,
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

    if (response?.isError && response?.content && Array.isArray(response.content)) {
      const errorText = response.content
        .filter((item: { type: string; text?: string }) => item.type === 'text' && item.text)
        .map((item: { type: string; text?: string }) => item.text)
        .join('\n');
      throw new Error(errorText || `MCP tool '${toolName}' execution failed`);
    }

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
