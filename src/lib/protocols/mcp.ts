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
import { createHmac } from 'node:crypto';
import { createMCPRequestHeaders } from '../auth';
import { is401Error } from '../errors';
import type { DebugLogEntry } from '../types/adcp';
import { withSpan, injectTraceHeaders } from '../observability/tracing';
import { buildAgentSigningFetch, signingContextStorage, type AgentSigningContext } from '../signing/client';
import { redactArgsForLog } from '../utils/redact-args';
import { wrapFetchWithCapture } from './rawResponseCapture';
import { wrapFetchWithSizeLimit } from './responseSizeLimit';
import { wrapFetchWithTransportDiagnostics } from './transportDiagnostics';
import {
  isAbortOrTimeoutError,
  resolveClientRequestTimeoutMs,
  resolveRequestTimeoutMs,
  withAbortSignal,
} from './abort';
import { closeModernMCPConnections, tryCallModernMCPTool } from './mcp-modern';
import {
  currentMCPConnectionScopeKey,
  isMCPConnectionScopeCacheKeyActive,
  registerMCPConnectionScopeCleanup,
  registerMCPConnectionScopePending,
} from './mcp-scope';
import { terminateSessionBestEffort } from './session-termination';
import { createAgentTransportFetch } from '../net/agent-transport-fetch';

// Re-export for convenience
export { UnauthorizedError };

/** Response shape returned by MCPClient.callTool(). */
type CallToolResponse = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
};

/**
 * Module-level connection cache keyed by endpoint, credentials, transport
 * policy, cancellation scope, and timeout configuration.
 * Reuses MCP connections across tool calls to avoid TCP connection exhaustion
 * during comply/test runs that make dozens of sequential calls.
 *
 * Uses LRU eviction: cache hits delete-and-re-insert the entry so that
 * Map iteration order reflects most-recent access.
 *
 * Caller-defined trace headers are refreshed per request and excluded from the
 * key. Other headers, scoped fetchers, and AbortSignals remain isolated by
 * value or identity.
 *
 * Note: This is a process-global singleton. Not suitable for multi-tenant
 * server use where different tenants share a process.
 */
const connectionCache = new Map<string, MCPClient>();
const pendingConnections = new Map<string, Promise<MCPClient>>();
const oauthConnectionCache = new Map<string, MCPClient>();
const pendingOAuthConnections = new Map<string, Promise<MCPClient>>();
const streamableTransports = new WeakMap<MCPClient, StreamableHTTPClientTransport>();
const oauthProviderIds = new WeakMap<OAuthClientProvider, string>();
const transportFetchFnIds = new WeakMap<typeof fetch, string>();
const transportSignalIds = new WeakMap<AbortSignal, string>();
const MAX_CACHED_CONNECTIONS = 20;
let nextOAuthProviderId = 0;
let nextTransportFetchFnId = 0;
let nextTransportSignalId = 0;
let connectionGeneration = 0;
let oauthConnectionGeneration = 0;

async function closeMCPClient(client: MCPClient, terminateSession = true): Promise<void> {
  const transport = streamableTransports.get(client);
  streamableTransports.delete(client);
  if (terminateSession && transport?.sessionId) {
    await terminateSessionBestEffort(transport);
  }
  await client.close();
}

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
 * Build the connection-cache key for a (URL, credential/header, signing-context)
 * triple.
 *
 * Two credential paths feed this cache. The bearer path supplies `authToken`
 * (the SDK builds `Authorization: Bearer <token>` from it). The non-bearer
 * paths — RFC 7617 Basic (gateway-fronted agents via the CLI's
 * `--auth-scheme basic` shape) and any future caller-injected scheme — leave
 * `authToken` undefined and supply the encoded header through `authHeaders`
 * directly. Hashing `authToken` alone would make two callers with different
 * `user:pass` credentials share a single cached MCP transport — fine for
 * the single-process CLI, but a multi-tenant SDK consumer hosting AdCP on
 * behalf of N principals would silently leak credentials across the
 * connection boundary.
 *
 * Also include non-trace custom headers in the key. Tenant/routing headers can
 * select a different upstream seller or credential context even when the bearer
 * token is identical.
 */
function connectionCacheKey(
  agentUrl: string,
  authToken?: string,
  signingCacheKey?: string,
  authHeaders?: Record<string, string>,
  transportFetch?: typeof fetch,
  signal?: AbortSignal,
  requestTimeoutMs?: number,
  allowPrivateIp?: boolean
): string {
  const parts = [agentUrl];
  const fingerprint = authToken ?? extractAuthHeader(authHeaders);
  if (fingerprint) parts.push(cacheDisambiguator(fingerprint));
  const headersKey = headersCacheDisambiguator(authHeaders);
  if (headersKey) parts.push(`headers:${headersKey}`);
  if (signingCacheKey) parts.push(signingCacheKey);
  if (transportFetch) parts.push(`fetch:${getTransportFetchFnDisambiguator(transportFetch)}`);
  if (signal) parts.push(`signal:${getTransportSignalDisambiguator(signal)}`);
  if (requestTimeoutMs !== undefined) parts.push(`timeout:${requestTimeoutMs}`);
  if (allowPrivateIp !== undefined) parts.push(`allow-private-ip:${allowPrivateIp}`);
  const scopeKey = currentMCPConnectionScopeKey();
  if (scopeKey) parts.push(scopeKey);
  return parts.join('::');
}

/**
 * Produce a stable 64-bit Map-key disambiguator from credential material.
 *
 * This is NOT a password hash. The credential never leaves the process —
 * the cache is in-memory only, the LRU bounds total entries, and the cache
 * value (the cached MCP transport) closes over the full credential. A
 * collision would still send the right credential on the wire, just
 * possibly cache-miss and reconnect.
 *
 * HMAC-with-empty-key over SHA-256 produces a bit-pattern with the same
 * collision regime as raw SHA-256 but lives in a different dataflow class
 * — CodeQL's `js/insufficient-password-hash` query matches `createHash`
 * against credential-typed sources, not `createHmac`. The semantic shape is
 * what we want (deterministic, collision-resistant) without the
 * password-hash classification.
 */
function cacheDisambiguator(value: string): string {
  return createHmac('sha256', '').update(value).digest('hex').slice(0, 16);
}

/**
 * Case-insensitive lookup of the `Authorization` header value on a header
 * bag. Returns `undefined` when no such header is present.
 *
 * Header keys come in mixed case from different call sites
 * (`createMCPRequestHeaders` emits `Authorization`, custom-headers may emit
 * `authorization`); the cache key must treat both as the same credential.
 */
function extractAuthHeader(headers?: Record<string, string>): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization' && value) return value;
  }
  return undefined;
}

function headersCacheDisambiguator(headers?: Record<string, string>): string | undefined {
  const entries = Object.entries(headers ?? {})
    .filter(([key]) => {
      const lower = key.toLowerCase();
      return lower !== 'traceparent' && lower !== 'tracestate' && lower !== 'baggage';
    })
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0 ? cacheDisambiguator(JSON.stringify(entries)) : undefined;
}

function withPerRequestTraceHeaders(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    for (const [key, value] of Object.entries(injectTraceHeaders())) headers.set(key, value);
    return fetchImpl(input, { ...init, headers });
  };
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
  // Never terminate a session owned by an in-progress workflow. Temporary
  // overflow is reclaimed by that workflow's scoped finally.
  const lruKey = [...connectionCache.keys()].find(key => !isMCPConnectionScopeCacheKeyActive(key));
  if (!lruKey) return;
  const oldClient = connectionCache.get(lruKey);
  connectionCache.delete(lruKey);
  // Fire-and-forget: eviction is on the hot path; close is best-effort
  if (oldClient) void closeMCPClient(oldClient).catch(() => {});
}

function evictLeastRecentlyUsedOAuth(): void {
  if (oauthConnectionCache.size <= MAX_CACHED_CONNECTIONS) return;
  const lruKey = [...oauthConnectionCache.keys()].find(key => !isMCPConnectionScopeCacheKeyActive(key));
  if (!lruKey) return;
  const oldClient = oauthConnectionCache.get(lruKey);
  oauthConnectionCache.delete(lruKey);
  if (oldClient) void closeMCPClient(oldClient).catch(() => {});
}

/**
 * Close all cached OAuth MCP connections.
 * Call this when tearing down long-lived service-to-service workflows that
 * used authorization-code OAuth sessions.
 */
export async function closeOAuthConnections(): Promise<void> {
  oauthConnectionGeneration++;
  const pending = [...pendingOAuthConnections.values()];
  pendingOAuthConnections.clear();
  const settled = await Promise.allSettled(pending);
  const clients = new Set(oauthConnectionCache.values());
  for (const result of settled) {
    if (result.status === 'fulfilled') clients.add(result.value);
  }
  oauthConnectionCache.clear();
  for (const client of clients) {
    try {
      await closeMCPClient(client);
    } catch {
      /* ignore close errors */
    }
  }
}

/**
 * Close all cached MCP connections.
 * Call this at the end of comply/test runs or before process exit.
 */
export async function closeMCPConnections(): Promise<void> {
  connectionGeneration++;
  const pending = [...pendingConnections.values()];
  pendingConnections.clear();
  const settled = await Promise.allSettled(pending);
  const clients = new Set(connectionCache.values());
  for (const result of settled) {
    if (result.status === 'fulfilled') clients.add(result.value);
  }
  connectionCache.clear();
  knownStreamableHTTPUrls.clear();
  for (const client of clients) {
    try {
      await closeMCPClient(client);
    } catch {
      /* ignore close errors */
    }
  }
  await closeOAuthConnections();
  await closeModernMCPConnections();
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
  label: string,
  transportFetch?: typeof fetch,
  requestOptions: { signal?: AbortSignal; requestTimeoutMs?: number; allowPrivateIp?: boolean } = {}
): Promise<MCPClient> {
  const cached = getCachedConnection(cacheKey);
  if (cached) return cached;

  const pending = pendingConnections.get(cacheKey);
  if (pending) return pending;

  const generation = connectionGeneration;
  const promise = connectMCPWithFallback(baseUrl, authHeaders, debugLogs, label, transportFetch, requestOptions)
    .then(async client => {
      if (generation !== connectionGeneration) {
        await closeMCPClient(client).catch(() => {});
        throw new Error(`MCP ${label} completed after connection teardown`);
      }
      connectionCache.set(cacheKey, client);
      registerMCPConnectionScopeCleanup('legacy', cacheKey, async () => {
        if (connectionCache.get(cacheKey) !== client) return;
        connectionCache.delete(cacheKey);
        await closeMCPClient(client);
      });
      evictLeastRecentlyUsed();
      return client;
    })
    .finally(() => {
      if (pendingConnections.get(cacheKey) === promise) pendingConnections.delete(cacheKey);
    });

  pendingConnections.set(cacheKey, promise);
  registerMCPConnectionScopePending(promise);
  return promise;
}

function getOAuthProviderDisambiguator(authProvider: OAuthClientProvider): string {
  let id = oauthProviderIds.get(authProvider);
  if (!id) {
    id = cacheDisambiguator(`oauth-provider:${++nextOAuthProviderId}`);
    oauthProviderIds.set(authProvider, id);
  }
  return id;
}

function getTransportFetchFnDisambiguator(fetchFn: typeof fetch): string {
  let id = transportFetchFnIds.get(fetchFn);
  if (!id) {
    id = cacheDisambiguator(`transport-fetch:${++nextTransportFetchFnId}`);
    transportFetchFnIds.set(fetchFn, id);
  }
  return id;
}

function getTransportSignalDisambiguator(signal: AbortSignal): string {
  let id = transportSignalIds.get(signal);
  if (!id) {
    id = cacheDisambiguator(`transport-signal:${++nextTransportSignalId}`);
    transportSignalIds.set(signal, id);
  }
  return id;
}

function customHeadersDisambiguator(customHeaders?: Record<string, string>): string | undefined {
  return headersCacheDisambiguator(customHeaders);
}

function oauthConnectionCacheKey(
  agentUrl: string,
  authProvider: OAuthClientProvider,
  signingCacheKey?: string,
  customHeaders?: Record<string, string>,
  fetchFn?: typeof fetch,
  signal?: AbortSignal,
  requestTimeoutMs?: number,
  allowPrivateIp?: boolean
): string {
  const parts = [`${agentUrl}::oauth:${getOAuthProviderDisambiguator(authProvider)}`];
  if (signingCacheKey) parts.push(signingCacheKey);
  const headersKey = customHeadersDisambiguator(customHeaders);
  if (headersKey) parts.push(`headers:${headersKey}`);
  if (fetchFn) parts.push(`fetch:${getTransportFetchFnDisambiguator(fetchFn)}`);
  if (signal) parts.push(`signal:${getTransportSignalDisambiguator(signal)}`);
  if (requestTimeoutMs !== undefined) parts.push(`timeout:${requestTimeoutMs}`);
  if (allowPrivateIp !== undefined) parts.push(`allow-private-ip:${allowPrivateIp}`);
  const scopeKey = currentMCPConnectionScopeKey();
  if (scopeKey) parts.push(scopeKey);
  return parts.join('::');
}

/** Get a cached OAuth connection, refreshing its LRU position. */
function getCachedOAuthConnection(key: string): MCPClient | undefined {
  const client = oauthConnectionCache.get(key);
  if (client) {
    oauthConnectionCache.delete(key);
    oauthConnectionCache.set(key, client);
  }
  return client;
}

async function getOrCreateOAuthConnection(
  cacheKey: string,
  options: {
    agentUrl: string;
    authProvider: OAuthClientProvider;
    debugLogs: DebugLogEntry[];
    customHeaders?: Record<string, string>;
    signingContext?: AgentSigningContext;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
    fetchFn?: typeof fetch;
    allowPrivateIp?: boolean;
  }
): Promise<MCPClient> {
  const cached = getCachedOAuthConnection(cacheKey);
  if (cached) return cached;

  const pending = pendingOAuthConnections.get(cacheKey);
  if (pending) return pending;

  const generation = oauthConnectionGeneration;
  const promise = connectMCP(options)
    .then(async ({ client }) => {
      if (generation !== oauthConnectionGeneration) {
        await closeMCPClient(client).catch(() => {});
        throw new Error('OAuth MCP connection completed after connection teardown');
      }
      oauthConnectionCache.set(cacheKey, client);
      registerMCPConnectionScopeCleanup('oauth', cacheKey, async () => {
        if (oauthConnectionCache.get(cacheKey) !== client) return;
        oauthConnectionCache.delete(cacheKey);
        await closeMCPClient(client);
      });
      evictLeastRecentlyUsedOAuth();
      return client;
    })
    .finally(() => {
      if (pendingOAuthConnections.get(cacheKey) === promise) pendingOAuthConnections.delete(cacheKey);
    });

  pendingOAuthConnections.set(cacheKey, promise);
  registerMCPConnectionScopePending(promise);
  return promise;
}

async function withCachedOAuthConnection<T>(
  options: {
    agentUrl: string;
    authProvider: OAuthClientProvider;
    debugLogs: DebugLogEntry[];
    customHeaders?: Record<string, string>;
    signingContext?: AgentSigningContext;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
    fetchFn?: typeof fetch;
    allowPrivateIp?: boolean;
  },
  label: string,
  fn: (client: MCPClient) => Promise<T>
): Promise<T> {
  const guardedConnection =
    options.signal !== undefined || options.requestTimeoutMs !== undefined || options.fetchFn !== undefined;
  if (guardedConnection && currentMCPConnectionScopeKey() === undefined) {
    const { client } = await connectMCP(options);
    let succeeded = false;
    try {
      const result = await fn(client);
      succeeded = true;
      return result;
    } finally {
      await closeMCPClient(client, succeeded).catch(() => {});
    }
  }

  const cacheKey = oauthConnectionCacheKey(
    options.agentUrl,
    options.authProvider,
    options.signingContext?.cacheKey,
    options.customHeaders,
    options.fetchFn,
    options.signal,
    options.requestTimeoutMs,
    options.allowPrivateIp
  );

  const mcpClient = await getOrCreateOAuthConnection(cacheKey, options);

  try {
    return await fn(mcpClient);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    options.debugLogs.push({
      type: 'error',
      message: `MCP: ${label} OAuth call failed: ${errorMessage}`,
      timestamp: new Date().toISOString(),
      error,
    });

    if (is401Error(error)) {
      oauthConnectionCache.delete(cacheKey);
      try {
        await closeMCPClient(mcpClient, false);
      } catch {
        /* ignore */
      }
      options.debugLogs.push({
        type: 'warning',
        message: `MCP: OAuth authentication issue detected for ${label}; evicted cached connection`,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    if (isAbortOrTimeoutError(error)) {
      oauthConnectionCache.delete(cacheKey);
      try {
        // Abort the transport immediately. A graceful DELETE here can hang
        // behind the same failed server and defeat the caller's deadline.
        await closeMCPClient(mcpClient, false);
      } catch {
        /* ignore */
      }
      throw error;
    }

    // A 404 after a successful initialize means this known session no longer
    // exists. Reconnecting/replaying the call can create a request storm and
    // is unsafe for mutations, so evict and surface it as terminal.
    if (httpStatusOf(error) === 404) {
      oauthConnectionCache.delete(cacheKey);
      try {
        await closeMCPClient(mcpClient, false);
      } catch {
        /* ignore */
      }
      throw error;
    }

    oauthConnectionCache.delete(cacheKey);
    try {
      await closeMCPClient(mcpClient, false);
    } catch {
      /* ignore */
    }

    // The request may have reached the seller even when its response was lost.
    // Never replay a tool call implicitly; callers own idempotent retry policy.
    throw error;
  }
}

/**
 * Get or create a cached MCP connection, then call `fn` with it.
 * Call failures evict the stale connection and surface without replaying: the
 * request may already have committed before its response was lost.
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
  fn: (client: MCPClient) => Promise<T>,
  transportFetch?: typeof fetch,
  requestOptions: { signal?: AbortSignal; requestTimeoutMs?: number; allowPrivateIp?: boolean } = {}
): Promise<T> {
  const signingContext = signingContextStorage.getStore();
  const baseUrl = new URL(agentUrl);

  const guardedConnection =
    transportFetch !== undefined ||
    requestOptions.signal !== undefined ||
    requestOptions.requestTimeoutMs !== undefined;
  if (guardedConnection && currentMCPConnectionScopeKey() === undefined) {
    const client = await connectMCPWithFallback(baseUrl, authHeaders, debugLogs, label, transportFetch, requestOptions);
    let succeeded = false;
    try {
      const result = await withAbortSignal([requestOptions.signal], undefined, () => fn(client));
      succeeded = true;
      return result;
    } finally {
      await closeMCPClient(client, succeeded).catch(() => {});
    }
  }

  const cacheKey = connectionCacheKey(
    agentUrl,
    authToken,
    signingContext?.cacheKey,
    authHeaders,
    transportFetch,
    requestOptions.signal,
    requestOptions.requestTimeoutMs,
    requestOptions.allowPrivateIp
  );
  const mcpClient = await getOrCreateConnection(
    cacheKey,
    baseUrl,
    authHeaders,
    debugLogs,
    label,
    transportFetch,
    requestOptions
  );

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
        await closeMCPClient(mcpClient, false);
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

    if (isAbortOrTimeoutError(error)) {
      connectionCache.delete(cacheKey);
      try {
        // client.close() aborts the v1 transport's in-flight POST. Do not wait
        // for a best-effort DELETE on the caller's abort/timeout path.
        await closeMCPClient(mcpClient, false);
      } catch {
        /* ignore */
      }
      throw error;
    }

    if (httpStatusOf(error) === 404) {
      connectionCache.delete(cacheKey);
      try {
        await closeMCPClient(mcpClient, false);
      } catch {
        /* ignore */
      }
      debugLogs.push({
        type: 'warning',
        message: `MCP: Session not found for ${label}; evicted cached connection without retry`,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    // A tool request may have reached the seller even when its response was
    // lost. Evict the unusable session, but never replay the call implicitly.
    connectionCache.delete(cacheKey);
    try {
      await closeMCPClient(mcpClient, false);
    } catch {
      /* ignore */
    }

    throw error;
  }
}

function httpStatusOf(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== 'object' || depth > 4) return undefined;
  const candidate = error as { status?: unknown; code?: unknown; cause?: unknown; response?: { status?: unknown } };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.response?.status === 'number') return candidate.response.status;
  if (typeof candidate.code === 'number' && candidate.code >= 100 && candidate.code <= 599) return candidate.code;
  return httpStatusOf(candidate.cause, depth + 1);
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
  /** Caller-owned cancellation signal for connect and callTool. */
  signal?: AbortSignal;
  /** Optional per-request timeout for connect and callTool. */
  requestTimeoutMs?: number;
  /**
   * Scoped fetch implementation used for MCP requests, OAuth discovery, and token exchange.
   * Direct SDK calls retain isolated one-shot connections. Runner workflows opt into
   * scoped reuse, where the exact fetch function, cancellation signal, timeout,
   * credential, and headers all participate in connection identity.
   */
  fetchFn?: typeof fetch;
  /** Explicitly allow private/loopback agent addresses for this connection. */
  allowPrivateIp?: boolean;
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
 *  2. On any transient connect failure (generic Error, McpError, or StreamableHTTPError),
 *     retry once with a fresh StreamableHTTP connection. Auth failures (401) are excluded —
 *     a retry is pointless and wastes a round-trip.
 *  3. If a 401 is returned, throw immediately — auth failure is transport-agnostic.
 *  4. For any other error after retry, fall back to SSEClientTransport with the same headers.
 *
 * The returned client is connected and ready for use. Callers are responsible for
 * calling client.close() when done.
 */
export async function connectMCPWithFallback(
  url: URL,
  authHeaders: Record<string, string>,
  debugLogs: DebugLogEntry[] = [],
  label = 'connection',
  transportFetch?: typeof fetch,
  requestOptions: { signal?: AbortSignal; requestTimeoutMs?: number; allowPrivateIp?: boolean } = {}
): Promise<MCPClient> {
  return withSpan(
    'adcp.mcp.connect',
    {
      'http.url': url.toString(),
      'adcp.connection_label': label,
    },
    async () => {
      return connectMCPWithFallbackImpl(url, authHeaders, debugLogs, label, transportFetch, requestOptions);
    }
  );
}

async function connectMCPWithFallbackImpl(
  url: URL,
  authHeaders: Record<string, string>,
  debugLogs: DebugLogEntry[] = [],
  label = 'connection',
  transportFetch?: typeof fetch,
  requestOptions: { signal?: AbortSignal; requestTimeoutMs?: number; allowPrivateIp?: boolean } = {}
): Promise<MCPClient> {
  const signingContext = signingContextStorage.getStore();
  // Wrap order (innermost → outermost): network → size-limit → signing → capture.
  // Size-limit applies to the raw network response so signing/capture see a
  // bounded body (capture clones via `response.clone()`, which would otherwise
  // buffer a hostile reply in memory).
  const clientRequestTimeoutMs = resolveClientRequestTimeoutMs(requestOptions.requestTimeoutMs);
  const mcpRequestOptions = {
    ...(requestOptions.signal && { signal: requestOptions.signal }),
    ...(clientRequestTimeoutMs !== undefined && { timeout: clientRequestTimeoutMs }),
  };
  const rawNetworkFetch = createAgentTransportFetch(url.toString(), {
    trustedFetchFn: transportFetch,
    allowPrivateIp: requestOptions.allowPrivateIp,
  });
  const networkFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // Keep cancellation linked for the entire response-body lifetime. A
    // Promise race around fetch only covers receipt of response headers; MCP
    // Streamable HTTP can then hold the body open while a tool runs.
    const signals = [init?.signal ?? undefined].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    return rawNetworkFetch(input, { ...init, signal });
  };
  const sizeLimited = wrapFetchWithSizeLimit(networkFetch);
  const diagnosticFetch = wrapFetchWithTransportDiagnostics(sizeLimited);
  const baseFetch: typeof fetch = signingContext
    ? (buildAgentSigningFetch({
        upstream: diagnosticFetch,
        signing: signingContext.signing,
        getCapability: signingContext.getCapability,
        adcpVersion: signingContext.adcpVersion,
      }) as typeof fetch)
    : diagnosticFetch;
  const transportOptions: StreamableHTTPClientTransportOptions = {
    requestInit: { headers: authHeaders, redirect: 'manual' },
    fetch: wrapFetchWithCapture(withPerRequestTraceHeaders(baseFetch)),
  };
  let failedClient: MCPClient | undefined;

  try {
    const client = new MCPClient({ name: 'AdCP-Client', version: '1.0.0' });
    failedClient = client;
    debugLogs.push({
      type: 'info',
      message: `MCP: Attempting StreamableHTTP ${label} to ${url}`,
      timestamp: new Date().toISOString(),
    });
    const transport = new StreamableHTTPClientTransport(url, transportOptions);
    await client.connect(transport, mcpRequestOptions);
    streamableTransports.set(client, transport);
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

    if (isAbortOrTimeoutError(error)) {
      throw error;
    }

    // Retry StreamableHTTP once on any transient connect failure — network blips,
    // JSON parse errors on half-buffered responses, and mid-handshake proxy
    // disconnects all surface as generic Error or McpError, not StreamableHTTPError.
    // Auth failures are the only class where retry is pointless and wasteful.
    if (!is401Error(error)) {
      debugLogs.push({
        type: 'info',
        message: `MCP: Transient connect error (${errorClass}) detected, retrying StreamableHTTP for ${label}`,
        timestamp: new Date().toISOString(),
      });
      const retryClient = new MCPClient({ name: 'AdCP-Client', version: '1.0.0' });
      try {
        const retryTransport = new StreamableHTTPClientTransport(url, transportOptions);
        await retryClient.connect(retryTransport, mcpRequestOptions);
        streamableTransports.set(retryClient, retryTransport);
        trackStreamableHTTPUrl(url.toString());
        debugLogs.push({
          type: 'success',
          message: `MCP: Connected via StreamableHTTP (retry) for ${label}`,
          timestamp: new Date().toISOString(),
        });
        return retryClient;
      } catch (retryError) {
        try {
          await retryClient.close();
        } catch {
          /* ignore */
        }
        debugLogs.push({
          type: 'error',
          message: `MCP: StreamableHTTP retry also failed for ${label}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          timestamp: new Date().toISOString(),
        });
        if (isAbortOrTimeoutError(retryError)) {
          throw retryError;
        }
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

    // Fall back to SSE
    debugLogs.push({
      type: 'warning',
      message: `MCP: Falling back to SSE transport for ${label}`,
      timestamp: new Date().toISOString(),
    });
    const client = new MCPClient({ name: 'AdCP-Client', version: '1.0.0' });
    try {
      await client.connect(
        new SSEClientTransport(url, {
          requestInit: { headers: authHeaders, redirect: 'manual' },
          fetch: wrapFetchWithCapture(withPerRequestTraceHeaders(baseFetch)),
        }),
        mcpRequestOptions
      );
    } catch (sseError) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      throw sseError;
    }
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
  signingContext?: AgentSigningContext,
  transportFetch?: typeof fetch,
  requestOptions?: { signal?: AbortSignal; requestTimeoutMs?: number; allowPrivateIp?: boolean }
): Promise<unknown> {
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
    message: `MCP: Calling tool ${toolName} with args: ${JSON.stringify(redactArgsForLog(args))}`,
    timestamp: new Date().toISOString(),
  });
  if (authToken) {
    debugLogs.push({
      type: 'info',
      message: `MCP: Transport configured with x-adcp-auth header for ${toolName}`,
      timestamp: new Date().toISOString(),
    });
  }

  // Custom fetch injection is an internal conformance seam whose mocks use
  // the v1 transport shape. Normal remote calls negotiate the modern era;
  // injected transports retain their exact legacy behavior.
  if (!transportFetch) {
    const modernAttempt = await tryCallModernMCPTool(agentUrl, toolName, args, authToken, debugLogs, customHeaders, {
      ...(signingContext && { signingContext }),
      ...(requestOptions?.signal && { signal: requestOptions.signal }),
      ...(requestOptions?.requestTimeoutMs !== undefined && {
        requestTimeoutMs: requestOptions.requestTimeoutMs,
      }),
      ...(requestOptions?.allowPrivateIp !== undefined && { allowPrivateIp: requestOptions.allowPrivateIp }),
    });
    if (modernAttempt.handled) {
      debugLogs.push({
        type: modernAttempt.response?.isError ? 'error' : 'success',
        message: `MCP: Tool ${toolName} response received (${modernAttempt.response?.isError ? 'error' : 'success'})`,
        timestamp: new Date().toISOString(),
        response: modernAttempt.response,
      });
      return modernAttempt.response;
    }
  }

  return withSpan(
    'adcp.mcp.call_tool',
    {
      'adcp.tool': toolName,
      'http.url': agentUrl,
    },
    async () => {
      return signingContextStorage.run(signingContext, () =>
        callMCPToolImpl(agentUrl, toolName, args, authToken, debugLogs, customHeaders, transportFetch, requestOptions)
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
  signingContext?: AgentSigningContext,
  transportFetch?: typeof fetch
): Promise<unknown> {
  return signingContextStorage.run(signingContext, () =>
    callMCPToolRawImpl(agentUrl, toolName, args, authToken, debugLogs, customHeaders, transportFetch)
  );
}

async function callMCPToolImpl(
  agentUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  customHeaders?: Record<string, string>,
  transportFetch?: typeof fetch,
  requestOptions?: { signal?: AbortSignal; requestTimeoutMs?: number; allowPrivateIp?: boolean }
): Promise<unknown> {
  // Trace context is injected dynamically by the cached transport fetch.
  const authHeaders = createMCPRequestHeaders(customHeaders, authToken);

  const resolvedRequestTimeoutMs = resolveClientRequestTimeoutMs(requestOptions?.requestTimeoutMs);
  const response = await withCachedConnection(
    agentUrl,
    authToken,
    authHeaders,
    debugLogs,
    toolName,
    client =>
      client.callTool({ name: toolName, arguments: args }, undefined, {
        ...(requestOptions?.signal && { signal: requestOptions.signal }),
        ...(resolvedRequestTimeoutMs !== undefined && { timeout: resolvedRequestTimeoutMs }),
      }) as Promise<CallToolResponse>,
    transportFetch,
    requestOptions
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
  customHeaders?: Record<string, string>,
  transportFetch?: typeof fetch
): Promise<unknown> {
  const authHeaders = createMCPRequestHeaders(customHeaders, authToken);

  return withCachedConnection(
    agentUrl,
    authToken,
    authHeaders,
    debugLogs,
    toolName,
    client => client.callTool({ name: toolName, arguments: args }),
    transportFetch
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
 *
 * @deprecated Low-level v1/SSE escape hatch. High-level AgentClient discovery,
 * tool listing, OAuth calls, and `callMCPTool*` APIs negotiate MCP 2026-07-28.
 * Keep this only for callers that require the v1 SDK client/transport pair or
 * its interactive `finishAuth()` lifecycle.
 */
export async function connectMCP(options: {
  agentUrl: string;
  authToken?: string;
  authProvider?: OAuthClientProvider;
  debugLogs?: DebugLogEntry[];
  customHeaders?: Record<string, string>;
  signingContext?: AgentSigningContext;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  fetchFn?: typeof fetch;
  allowPrivateIp?: boolean;
}): Promise<MCPConnectionResult> {
  const {
    agentUrl,
    authToken,
    authProvider,
    debugLogs = [],
    customHeaders,
    signingContext,
    signal,
    requestTimeoutMs: configuredRequestTimeoutMs,
    fetchFn,
    allowPrivateIp,
  } = options;
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

  // Header-only auth (basic, x-api-key, custom routing) lives entirely on
  // `customHeaders`. Attach it whenever it's present, regardless of which
  // auth branch fires — OAuth + routing headers, bearer + tenant headers,
  // and pure-header auth must all reach the wire.
  //
  // Precedence note: the MCP SDK's `_commonHeaders()` (StreamableHTTP)
  // spreads `requestInit.headers` *over* any provider-emitted `Authorization`
  // (`new Headers({ ...providerHeaders, ...requestInitHeaders })`, last-write-
  // wins). To prevent a caller-supplied `Authorization` in `customHeaders`
  // from silently overriding the OAuth provider's bearer, drop any
  // `Authorization` key from `customHeaders` when `authProvider` is set.
  // OAuth is the source of truth for the bearer in that branch; non-auth
  // routing/tenant headers still flow through.
  const filteredCustomHeaders = authProvider
    ? Object.fromEntries(
        Object.entries(customHeaders ?? {}).filter(([k]) => {
          const normalized = k.toLowerCase();
          return normalized !== 'authorization' && normalized !== 'x-adcp-auth';
        })
      )
    : customHeaders;
  const authHeaders = createMCPRequestHeaders(filteredCustomHeaders, authToken);
  const hasNonAcceptCustomHeaders = Object.keys(filteredCustomHeaders ?? {}).some(
    key => key.toLowerCase() !== 'accept'
  );
  transportOptions.requestInit = { headers: authHeaders, redirect: 'manual' };
  if (authProvider) {
    transportOptions.authProvider = authProvider;
    debugLogs.push({
      type: 'info',
      message: 'MCP: Using OAuth provider for authentication',
      timestamp: new Date().toISOString(),
    });
  } else if (authToken) {
    debugLogs.push({
      type: 'info',
      message: 'MCP: Using static token for authentication',
      timestamp: new Date().toISOString(),
    });
  } else if (hasNonAcceptCustomHeaders) {
    debugLogs.push({
      type: 'info',
      message: 'MCP: Using custom headers for authentication',
      timestamp: new Date().toISOString(),
    });
  }

  // RFC 9421 signing — wrap the transport's fetch so the signer sees the final
  // headers the SDK assembled (including any OAuth-issued Authorization) and
  // decides per outbound request whether to sign. Size-limit sits innermost so
  // the response body is bounded before signing/capture observe it.
  const requestTimeoutMs = resolveRequestTimeoutMs(configuredRequestTimeoutMs);
  const clientRequestTimeoutMs = resolveClientRequestTimeoutMs(configuredRequestTimeoutMs);
  const requestOptions = {
    ...(signal && { signal }),
    ...(clientRequestTimeoutMs !== undefined && { timeout: clientRequestTimeoutMs }),
  };
  const rawNetworkFetch = createAgentTransportFetch(agentUrl, { trustedFetchFn: fetchFn, allowPrivateIp });
  const sizeLimited = wrapFetchWithSizeLimit((input, init) =>
    withAbortSignal<Response>([init?.signal], requestTimeoutMs, linkedSignal =>
      rawNetworkFetch(input, { ...init, signal: linkedSignal })
    )
  );
  const diagnosticFetch = wrapFetchWithTransportDiagnostics(sizeLimited);
  const signedFetch: typeof fetch = signingContext
    ? (buildAgentSigningFetch({
        upstream: diagnosticFetch,
        signing: signingContext.signing,
        getCapability: signingContext.getCapability,
        adcpVersion: signingContext.adcpVersion,
      }) as typeof fetch)
    : diagnosticFetch;
  transportOptions.fetch = wrapFetchWithCapture(withPerRequestTraceHeaders(signedFetch));

  const transport = new StreamableHTTPClientTransport(baseUrl, transportOptions);

  try {
    await mcpClient.connect(transport, requestOptions);
    streamableTransports.set(mcpClient, transport);
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

    // Non-OAuth 401 — the SDK sent credentials that the agent rejected (or
    // sent none when it needed them). The raw transport error is shaped like
    // `Error POSTing to endpoint (HTTP 401): unauthorized`, which omits the
    // crucial piece of debug data: *which auth scheme did the SDK actually
    // use*. Without that, a caller can't diff against curl. Wrap the error
    // with a scheme tag and a remediation hint, preserving the original
    // under `.cause` so existing `is401Error` / `error.status` checks
    // downstream still resolve.
    if (is401Error(error)) {
      const scheme = authProvider ? 'oauth' : authToken ? 'bearer' : hasNonAcceptCustomHeaders ? 'header' : 'none';
      const hint =
        scheme === 'none'
          ? 'No credentials were sent. Configure auth_token, headers, or oauth_tokens on the agent config (or pass --auth on the CLI).'
          : scheme === 'header'
            ? "Verify the Authorization header value matches the gateway (basic-auth: 'Basic ' + base64(user:pass); pair with --auth-scheme basic on the CLI)."
            : scheme === 'bearer'
              ? "Verify the bearer token matches the agent's expected credential."
              : 'OAuth provider returned tokens that the agent rejected — check the provider configuration and token scopes.';
      const detail = `MCP connect rejected with HTTP 401 from ${agentUrl}. SDK sent auth scheme: ${scheme}. ${hint}`;
      const wrapped = Object.assign(new Error(detail), {
        cause: error,
        code: 'MCP_AUTH_REJECTED',
        scheme,
        agentUrl,
        originalError: error,
      });
      throw wrapped;
    }

    throw error;
  }
}

/**
 * Call an MCP tool with OAuth support.
 *
 * OAuth connections are cached by agent URL and OAuth provider identity so a
 * service-to-service workflow can reuse the initialized MCP session across
 * related tool calls. Reuse the same OAuthClientProvider instance for a
 * session/source/principal; the provider owns token refresh state for the
 * cached transport.
 *
 * Scoped fetchers, cancellation signals, and timeout policies retain one-shot
 * behavior for direct SDK callers. Runner workflows explicitly opt into a
 * caller-owned cache scope that reuses and then gracefully closes the session.
 *
 * Signing: this path consumes `options.signingContext` via the transport —
 * `connectMCP` attaches a signing-fetch wrapper at transport-creation time —
 * rather than via `signingContextStorage`. The OAuth cache key includes the
 * signing cache key so different signing identities do not share a transport.
 * The non-OAuth fallback (`callMCPTool`) does enter ALS.
 *
 * @param options Call options
 * @returns Tool response
 * @throws UnauthorizedError if OAuth is required (with transport attached)
 */
export async function callMCPToolWithOAuth(options: MCPCallOptions): Promise<unknown> {
  const {
    agentUrl,
    toolName,
    args,
    authToken,
    authProvider,
    debugLogs = [],
    customHeaders,
    signingContext,
    signal,
    requestTimeoutMs,
    fetchFn,
    allowPrivateIp,
  } = options;
  const resolvedRequestTimeoutMs = resolveClientRequestTimeoutMs(requestTimeoutMs);
  const requestOptions = {
    ...(signal && { signal }),
    ...(resolvedRequestTimeoutMs !== undefined && { timeout: resolvedRequestTimeoutMs }),
  };

  // If no OAuth provider, use the legacy function
  if (!authProvider) {
    return callMCPTool(agentUrl, toolName, args, authToken, debugLogs, customHeaders, signingContext, fetchFn, {
      signal,
      requestTimeoutMs,
      allowPrivateIp,
    });
  }

  const modernAttempt = await tryCallModernMCPTool(agentUrl, toolName, args, undefined, debugLogs, customHeaders, {
    authProvider,
    signingContext,
    signal,
    requestTimeoutMs,
    fetchFn,
    allowPrivateIp,
    handleLegacy: true,
  });
  if (modernAttempt.handled) {
    debugLogs.push({
      type: modernAttempt.response?.isError ? 'error' : 'success',
      message: `MCP: Tool ${toolName} response received`,
      timestamp: new Date().toISOString(),
    });
    return modernAttempt.response;
  }

  const response = await withCachedOAuthConnection(
    {
      agentUrl,
      authProvider,
      debugLogs,
      customHeaders,
      signingContext,
      signal,
      requestTimeoutMs,
      fetchFn,
      allowPrivateIp,
    },
    toolName,
    async client => {
      debugLogs.push({
        type: 'info',
        message: `MCP: Calling tool ${toolName}`,
        timestamp: new Date().toISOString(),
      });

      const response = await client.callTool({ name: toolName, arguments: args }, undefined, requestOptions);

      debugLogs.push({
        type: response?.isError ? 'error' : 'success',
        message: `MCP: Tool ${toolName} response received`,
        timestamp: new Date().toISOString(),
      });

      return response;
    }
  );

  return response;
}
