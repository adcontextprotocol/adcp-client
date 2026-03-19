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
import { createMCPAuthHeaders } from '../auth';
import { is401Error } from '../errors';
import { withSpan, injectTraceHeaders } from '../observability/tracing';

// Re-export for convenience
export { UnauthorizedError };

// Connection cache: reuse MCP connections across tool calls to the same agent
const connectionCache = new Map<string, MCPClient>();

// Endpoint cache: remember which URLs have been successfully connected to,
// so discovery across multiple SingleAgentClient instances doesn't re-probe
const endpointCache = new Set<string>();

/**
 * Check if a URL has previously connected successfully.
 */
export function isEndpointKnown(url: string): boolean {
  return endpointCache.has(url);
}

/**
 * Close all cached MCP connections and clear endpoint cache.
 * Call this when done with a batch of operations (e.g., after comply finishes)
 * or before process exit.
 */
export async function closeMCPConnections(): Promise<void> {
  for (const [, client] of connectionCache) {
    try {
      await client.close();
    } catch {
      // ignore close errors during cleanup
    }
  }
  connectionCache.clear();
  endpointCache.clear();
}

/**
 * Get or create a cached MCP connection for the given URL.
 * Callers must NOT close the returned client — it's shared.
 * If the cached connection is stale, evicts and reconnects.
 */
export async function getOrCreateMCPClient(
  url: string,
  authHeaders: Record<string, string>
): Promise<MCPClient> {
  const cached = connectionCache.get(url);
  if (cached) return cached;

  const client = await connectMCPWithFallback(new URL(url), authHeaders);
  connectionCache.set(url, client);
  return client;
}

/**
 * Evict a cached connection (e.g., after a stale connection error).
 */
export function evictMCPClient(url: string): void {
  const client = connectionCache.get(url);
  if (client) {
    connectionCache.delete(url);
    client.close().catch(() => {});
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
  args: any;
  /** Static auth token (legacy) */
  authToken?: string;
  /** OAuth provider for dynamic auth */
  authProvider?: OAuthClientProvider;
  /** Debug logs array */
  debugLogs?: any[];
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
  debugLogs: any[] = [],
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
  debugLogs: any[] = [],
  label = 'connection'
): Promise<MCPClient> {
  // Wrap connection attempt with rate limit retry
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await connectMCPOnce(url, authHeaders, debugLogs, label);
    } catch (error: any) {
      if (isRateLimitThrown(error) && attempt < RATE_LIMIT_MAX_RETRIES) {
        const retryAfter = getRetryAfterFromError(error);
        const delayMs = calcRateLimitDelay(attempt, retryAfter);
        debugLogs.push({
          type: 'info',
          message: `MCP: Rate limited during ${label} connect, retrying in ${delayMs}ms${retryAfter ? ` (server: ${retryAfter}s)` : ''} (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`,
          timestamp: new Date().toISOString(),
        });
        await rateLimitDelay(attempt, retryAfter);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`MCP connection for ${label} failed after ${RATE_LIMIT_MAX_RETRIES} rate limit retries`);
}

async function connectMCPOnce(
  url: URL,
  authHeaders: Record<string, string>,
  debugLogs: any[] = [],
  label = 'connection'
): Promise<MCPClient> {
  const transportOptions = { requestInit: { headers: authHeaders } };

  try {
    const client = new MCPClient({ name: 'AdCP-Client', version: '1.0.0' });
    debugLogs.push({
      type: 'info',
      message: `MCP: Attempting StreamableHTTP ${label} to ${url}`,
      timestamp: new Date().toISOString(),
    });
    await client.connect(new StreamableHTTPClientTransport(url, transportOptions));
    debugLogs.push({
      type: 'success',
      message: `MCP: Connected via StreamableHTTP for ${label}`,
      timestamp: new Date().toISOString(),
    });
    endpointCache.add(url.toString());
    return client;
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    debugLogs.push({
      type: 'error',
      message: `MCP: StreamableHTTP failed for ${label}: ${errorMessage}`,
      timestamp: new Date().toISOString(),
      error,
    });

    // Rate limit — let the outer retry loop handle it
    if (isRateLimitThrown(error)) {
      throw error;
    }

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
      endpointCache.add(url.toString());
      return client;
    }

    // Auth failure — transport type won't change the outcome
    if (is401Error(error)) {
      throw error;
    }

    // If we've previously connected to this endpoint via StreamableHTTP,
    // don't fall back to SSE — it's a transient error, not a transport mismatch
    if (endpointCache.has(url.toString())) {
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
  args: any,
  authToken?: string,
  debugLogs: any[] = [],
  customHeaders?: Record<string, string>
): Promise<any> {
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
 * Call an MCP tool and return the raw response without throwing on isError.
 * Used by error compliance scenarios that need to inspect the error response structure.
 */
export async function callMCPToolRaw(
  agentUrl: string,
  toolName: string,
  args: any,
  authToken?: string,
  debugLogs: any[] = [],
  customHeaders?: Record<string, string>
): Promise<any> {
  return callMCPToolRawImpl(agentUrl, toolName, args, authToken, debugLogs, customHeaders);
}

async function callMCPToolImpl(
  agentUrl: string,
  toolName: string,
  args: any,
  authToken?: string,
  debugLogs: any[] = [],
  customHeaders?: Record<string, string>
): Promise<any> {
  const baseUrl = new URL(agentUrl);
  const cacheKey = agentUrl;

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

  // Reuse cached connection or create a new one
  let mcpClient = connectionCache.get(cacheKey);
  if (!mcpClient) {
    mcpClient = await connectMCPWithFallback(baseUrl, authHeaders, debugLogs, toolName);
    connectionCache.set(cacheKey, mcpClient);
  }

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

  try {
    return await callToolOnClient(mcpClient, toolName, args, debugLogs);
  } catch (error) {
    // Connection may be stale — evict, reconnect, and retry once
    connectionCache.delete(cacheKey);
    try { await mcpClient.close(); } catch { /* ignore */ }

    const errorMessage = error instanceof Error ? error.message : String(error);
    debugLogs.push({
      type: 'info',
      message: `MCP: Retrying ${toolName} with fresh connection after error: ${errorMessage}`,
      timestamp: new Date().toISOString(),
    });

    // Auth errors won't be fixed by reconnecting
    if (errorMessage.toLowerCase().includes('auth') || errorMessage.toLowerCase().includes('unauthorized')) {
      debugLogs.push({
        type: 'warning',
        message: `MCP: Authentication issue detected for ${toolName} - headers may not be reaching server`,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    mcpClient = await connectMCPWithFallback(baseUrl, authHeaders, debugLogs, toolName);
    connectionCache.set(cacheKey, mcpClient);
    return await callToolOnClient(mcpClient, toolName, args, debugLogs);
  }
}

/**
 * Raw variant of callMCPToolImpl — returns the MCP response as-is,
 * including isError responses, without throwing or retrying rate limits.
 */
async function callMCPToolRawImpl(
  agentUrl: string,
  toolName: string,
  args: any,
  authToken?: string,
  debugLogs: any[] = [],
  customHeaders?: Record<string, string>
): Promise<any> {
  const baseUrl = new URL(agentUrl);
  const cacheKey = agentUrl;
  const traceHeaders = injectTraceHeaders();
  const authHeaders = {
    ...customHeaders,
    ...traceHeaders,
    ...(authToken ? createMCPAuthHeaders(authToken) : {}),
  };

  let mcpClient = connectionCache.get(cacheKey);
  if (!mcpClient) {
    mcpClient = await connectMCPWithFallback(baseUrl, authHeaders, debugLogs, toolName);
    connectionCache.set(cacheKey, mcpClient);
  }

  try {
    return await mcpClient.callTool({ name: toolName, arguments: args });
  } catch (error) {
    // Connection may be stale — evict, reconnect, retry once
    connectionCache.delete(cacheKey);
    try { await mcpClient.close(); } catch { /* ignore */ }

    mcpClient = await connectMCPWithFallback(baseUrl, authHeaders, debugLogs, toolName);
    connectionCache.set(cacheKey, mcpClient);
    return await mcpClient.callTool({ name: toolName, arguments: args });
  }
}

/** Maximum number of retries for rate-limited requests */
const RATE_LIMIT_MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff (doubles each retry: 2s, 4s, 8s) */
const RATE_LIMIT_BASE_DELAY_MS = 2000;

import {
  extractAdcpErrorFromMcp,
  extractAdcpErrorFromTransport,
} from '../utils/error-extraction';

/** Check if an MCP tool response is a rate limit error */
function isRateLimitResponse(response: any): boolean {
  const error = extractAdcpErrorFromMcp(response);
  return error?.code === 'RATE_LIMITED';
}

/** Get retry_after from a rate-limited response (seconds), or null if not specified */
function getRetryAfter(response: any): number | null {
  const error = extractAdcpErrorFromMcp(response);
  if (error?.code === 'RATE_LIMITED' && typeof error.retry_after === 'number') {
    return error.retry_after;
  }
  return null;
}

/** Check if a thrown error is a rate limit error (transport-level) */
function isRateLimitThrown(error: any): boolean {
  const extracted = extractAdcpErrorFromTransport(error);
  return extracted?.code === 'RATE_LIMITED';
}

/** Get retry_after from a transport-level rate limit error (seconds) */
function getRetryAfterFromError(error: any): number | null {
  const extracted = extractAdcpErrorFromTransport(error);
  if (extracted?.code === 'RATE_LIMITED' && typeof extracted.retry_after === 'number') {
    return extracted.retry_after;
  }
  return null;
}

/** Calculate delay for a rate limit retry: use retry_after if available, else exponential backoff */
function calcRateLimitDelay(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds != null && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  return RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
}

/** Sleep for the calculated rate limit delay */
function rateLimitDelay(attempt: number, retryAfterSeconds: number | null = null): Promise<void> {
  const delayMs = calcRateLimitDelay(attempt, retryAfterSeconds);
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/** Execute a tool call on an MCP client, retrying with backoff on rate limits. */
async function callToolOnClient(
  mcpClient: MCPClient,
  toolName: string,
  args: any,
  debugLogs: any[]
): Promise<any> {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    const response = await mcpClient.callTool({
      name: toolName,
      arguments: args,
    });

    debugLogs.push({
      type: response?.isError ? 'error' : 'success',
      message: `MCP: Tool ${toolName} response received (${response?.isError ? 'error' : 'success'})`,
      timestamp: new Date().toISOString(),
      response: response,
    });

    // Rate limit: respect retry_after if provided, else exponential backoff
    if (isRateLimitResponse(response) && attempt < RATE_LIMIT_MAX_RETRIES) {
      const retryAfter = getRetryAfter(response);
      const delayMs = calcRateLimitDelay(attempt, retryAfter);
      debugLogs.push({
        type: 'info',
        message: `MCP: Rate limited on ${toolName}, retrying in ${delayMs}ms${retryAfter ? ` (server: ${retryAfter}s)` : ''} (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`,
        timestamp: new Date().toISOString(),
      });
      await rateLimitDelay(attempt, retryAfter);
      continue;
    }

    if (response?.isError && response?.content && Array.isArray(response.content)) {
      const errorText = response.content
        .filter((item: any) => item.type === 'text' && item.text)
        .map((item: any) => item.text)
        .join('\n');

      throw new Error(errorText || `MCP tool '${toolName}' execution failed (no error details provided)`);
    }

    return response;
  }

  // Shouldn't reach here, but just in case
  throw new Error(`MCP tool '${toolName}' failed after ${RATE_LIMIT_MAX_RETRIES} rate limit retries`);
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
  debugLogs?: any[];
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
 * Call an MCP tool with OAuth support
 *
 * This is an enhanced version of callMCPTool that supports OAuth.
 * For simple cases with static tokens, use the original callMCPTool.
 *
 * @param options Call options
 * @returns Tool response
 * @throws UnauthorizedError if OAuth is required (with transport attached)
 */
export async function callMCPToolWithOAuth(options: MCPCallOptions): Promise<any> {
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
        .filter((item: any) => item.type === 'text' && item.text)
        .map((item: any) => item.text)
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
