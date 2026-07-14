/**
 * MCP 2026-07-28 client path.
 *
 * The v2 SDK removed the experimental 2025 Tasks interception API. During the
 * migration window we therefore negotiate with the v2 client first and use it
 * only when the peer selects the modern protocol era. Legacy peers fall back
 * to mcp-tasks.ts, which keeps the existing v1 Tasks behavior intact.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider as ModernOAuthClientProvider,
  type Tool,
} from '@modelcontextprotocol/client';
import { createHmac } from 'node:crypto';
import { createMCPAuthHeaders } from '../auth';
import { is401Error } from '../errors';
import { withSpan, injectTraceHeaders } from '../observability/tracing';
import { buildAgentSigningFetch, signingContextStorage, type AgentSigningContext } from '../signing/client';
import type { DebugLogEntry } from '../types/adcp';
import {
  isAbortOrTimeoutError,
  resolveClientRequestTimeoutMs,
  resolveRequestTimeoutMs,
  withAbortSignal,
} from './abort';
import { wrapFetchWithCapture } from './rawResponseCapture';
import { wrapFetchWithSizeLimit } from './responseSizeLimit';
import { wrapFetchWithTransportDiagnostics } from './transportDiagnostics';

type CallToolResponse = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
};

export type ModernMCPAttempt = { handled: false } | { handled: true; response: CallToolResponse };
export type ModernMCPListAttempt = { handled: false } | { handled: true; tools: Tool[] };

export interface ModernMCPConnectionOptions {
  signingContext?: AgentSigningContext;
  authProvider?: object;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  /** Use the v2 SDK's negotiated legacy client instead of handing off to v1. */
  handleLegacy?: boolean;
}

interface ModernConnectionOptions {
  agentUrl: string;
  authToken?: string;
  customHeaders?: Record<string, string>;
  debugLogs: DebugLogEntry[];
  signingContext?: AgentSigningContext;
  authProvider?: object;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  handleLegacy?: boolean;
}

const modernConnections = new Map<string, Client>();
const legacyConnectionExpiresAt = new Map<string, number>();
const pendingModernConnections = new Map<string, Promise<Client>>();
const knownLegacyConnections = new Map<string, number>();
const MAX_CACHED_CONNECTIONS = 20;
const LEGACY_CLASSIFICATION_TTL_MS = 5 * 60 * 1000;
const modernOAuthProviderIds = new WeakMap<object, string>();
let nextModernOAuthProviderId = 0;
let connectionGeneration = 0;

function cacheDisambiguator(value: string): string {
  return createHmac('sha256', '').update(value).digest('hex');
}

function buildAuthHeaders(
  authToken: string | undefined,
  customHeaders: Record<string, string> | undefined,
  authProvider?: object
): Record<string, string> {
  const filteredHeaders =
    authProvider || authToken
      ? Object.fromEntries(
          Object.entries(customHeaders ?? {}).filter(keyValue => {
            const key = keyValue[0].toLowerCase();
            return key !== 'authorization' && key !== 'x-adcp-auth';
          })
        )
      : customHeaders;
  return {
    ...filteredHeaders,
    ...(!authProvider && authToken ? createMCPAuthHeaders(authToken) : {}),
  };
}

function oauthProviderCacheKey(provider: object | undefined): string | undefined {
  if (!provider) return undefined;
  let key = modernOAuthProviderIds.get(provider);
  if (!key) {
    key = `oauth-provider:${++nextModernOAuthProviderId}`;
    modernOAuthProviderIds.set(provider, key);
  }
  return key;
}

function connectionCacheKey(
  agentUrl: string,
  headers: Record<string, string>,
  signingCacheKey?: string,
  authProvider?: object
): string {
  const normalizedHeaders = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const parts = [agentUrl, `headers:${cacheDisambiguator(JSON.stringify(normalizedHeaders))}`];
  if (signingCacheKey) parts.push(signingCacheKey);
  const providerKey = oauthProviderCacheKey(authProvider);
  if (providerKey) parts.push(providerKey);
  return parts.join('::');
}

function isKnownLegacy(cacheKey: string): boolean {
  const classifiedAt = knownLegacyConnections.get(cacheKey);
  if (classifiedAt === undefined) return false;
  if (Date.now() - classifiedAt > LEGACY_CLASSIFICATION_TTL_MS) {
    knownLegacyConnections.delete(cacheKey);
    return false;
  }
  knownLegacyConnections.delete(cacheKey);
  knownLegacyConnections.set(cacheKey, classifiedAt);
  return true;
}

function markKnownLegacy(cacheKey: string): void {
  knownLegacyConnections.delete(cacheKey);
  knownLegacyConnections.set(cacheKey, Date.now());
  while (knownLegacyConnections.size > MAX_CACHED_CONNECTIONS) {
    const oldest = knownLegacyConnections.keys().next().value;
    if (!oldest) break;
    knownLegacyConnections.delete(oldest);
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

function withPerRequestTraceHeaders(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    for (const [key, value] of Object.entries(injectTraceHeaders())) headers.set(key, value);
    return fetchImpl(input, { ...init, headers });
  };
}

function getCachedConnection(cacheKey: string): Client | undefined {
  const client = modernConnections.get(cacheKey);
  if (client) {
    const legacyExpiry = legacyConnectionExpiresAt.get(cacheKey);
    if (legacyExpiry !== undefined && legacyExpiry <= Date.now()) {
      modernConnections.delete(cacheKey);
      legacyConnectionExpiresAt.delete(cacheKey);
      void client.close().catch(() => {});
      return undefined;
    }
    modernConnections.delete(cacheKey);
    modernConnections.set(cacheKey, client);
  }
  return client;
}

function evictLeastRecentlyUsed(): void {
  if (modernConnections.size <= MAX_CACHED_CONNECTIONS) return;
  const oldestKey = modernConnections.keys().next().value;
  if (!oldestKey) return;
  const client = modernConnections.get(oldestKey);
  modernConnections.delete(oldestKey);
  legacyConnectionExpiresAt.delete(oldestKey);
  void client?.close().catch(() => {});
}

async function createNegotiatedClient(
  options: ModernConnectionOptions,
  authHeaders: Record<string, string>
): Promise<Client> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const clientRequestTimeoutMs = resolveClientRequestTimeoutMs(options.requestTimeoutMs);
  const rawNetworkFetch: typeof fetch = (input, init) => fetch(input, init);
  const networkFetch: typeof fetch = (input, init) =>
    withAbortSignal<Response>([options.signal, init?.signal], requestTimeoutMs, signal =>
      rawNetworkFetch(input, { ...init, signal })
    );
  const diagnosticFetch = wrapFetchWithTransportDiagnostics(wrapFetchWithSizeLimit(networkFetch));
  const signedFetch: typeof fetch = options.signingContext
    ? (buildAgentSigningFetch({
        upstream: diagnosticFetch,
        signing: options.signingContext.signing,
        getCapability: options.signingContext.getCapability,
      }) as typeof fetch)
    : diagnosticFetch;
  const transport = new StreamableHTTPClientTransport(new URL(options.agentUrl), {
    requestInit: { headers: authHeaders, redirect: 'manual' },
    fetch: wrapFetchWithCapture(withPerRequestTraceHeaders(signedFetch)),
    ...(options.authProvider && {
      authProvider: options.authProvider as ModernOAuthClientProvider,
    }),
  });
  const client = new Client(
    { name: 'AdCP-Client', version: '1.0.0' },
    {
      versionNegotiation: {
        mode: 'auto',
        ...(clientRequestTimeoutMs !== undefined && { probe: { timeoutMs: clientRequestTimeoutMs } }),
      },
    }
  );

  try {
    await client.connect(transport, {
      ...(options.signal && { signal: options.signal }),
      ...(clientRequestTimeoutMs !== undefined && { timeout: clientRequestTimeoutMs }),
    });
    return client;
  } catch (error) {
    try {
      await client.close();
    } catch {
      /* ignore close errors */
    }
    throw error;
  }
}

async function getOrCreateModernConnection(
  cacheKey: string,
  options: ModernConnectionOptions,
  authHeaders: Record<string, string>
): Promise<Client> {
  const cached = getCachedConnection(cacheKey);
  if (cached) return cached;

  const pending = pendingModernConnections.get(cacheKey);
  if (pending) return pending;

  const generation = connectionGeneration;
  const promise = createNegotiatedClient(options, authHeaders)
    .then(client => {
      if (
        (client.getProtocolEra() === 'modern' || options.handleLegacy === true) &&
        generation === connectionGeneration
      ) {
        modernConnections.set(cacheKey, client);
        if (client.getProtocolEra() === 'legacy') {
          legacyConnectionExpiresAt.set(cacheKey, Date.now() + LEGACY_CLASSIFICATION_TTL_MS);
        } else {
          legacyConnectionExpiresAt.delete(cacheKey);
        }
        evictLeastRecentlyUsed();
      } else if (generation !== connectionGeneration) {
        void client.close().catch(() => {});
      }
      return client;
    })
    .finally(() => {
      if (pendingModernConnections.get(cacheKey) === promise) pendingModernConnections.delete(cacheKey);
    });
  pendingModernConnections.set(cacheKey, promise);
  return promise;
}

async function callOnModernClient(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  requestTimeoutMs?: number
): Promise<CallToolResponse> {
  const resolvedRequestTimeoutMs = resolveClientRequestTimeoutMs(requestTimeoutMs);
  return (await client.callTool(
    { name: toolName, arguments: args },
    {
      ...(signal && { signal }),
      ...(resolvedRequestTimeoutMs !== undefined && { timeout: resolvedRequestTimeoutMs }),
    }
  )) as CallToolResponse;
}

async function attemptModernCall(
  options: ModernConnectionOptions,
  toolName: string,
  args: Record<string, unknown>
): Promise<ModernMCPAttempt> {
  const authHeaders = buildAuthHeaders(options.authToken, options.customHeaders, options.authProvider);
  const cacheKey = connectionCacheKey(
    options.agentUrl,
    authHeaders,
    options.signingContext?.cacheKey,
    options.authProvider
  );
  if (isKnownLegacy(cacheKey)) return { handled: false };

  const guardedConnection = options.signal !== undefined || options.requestTimeoutMs !== undefined;
  let client: Client;
  try {
    client = guardedConnection
      ? await createNegotiatedClient(options, authHeaders)
      : await getOrCreateModernConnection(cacheKey, options, authHeaders);
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 404 || status === 405) {
      markKnownLegacy(cacheKey);
      options.debugLogs.push({
        type: 'info',
        message: `MCP: Modern Streamable HTTP is unavailable (HTTP ${status}); preserving the v1 transport path`,
        timestamp: new Date().toISOString(),
      });
      return { handled: false };
    }
    throw error;
  }

  if (client.getProtocolEra() !== 'modern') {
    if (options.handleLegacy === true) {
      options.debugLogs.push({
        type: 'info',
        message: `MCP: v2 client selected the legacy protocol era for ${toolName}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      markKnownLegacy(cacheKey);
      try {
        await client.close();
      } catch {
        /* ignore close errors */
      }
      options.debugLogs.push({
        type: 'info',
        message: `MCP: Server selected the legacy protocol era for ${toolName}; preserving the v1 Tasks path`,
        timestamp: new Date().toISOString(),
      });
      return { handled: false };
    }
  }

  options.debugLogs.push({
    type: 'success',
    message: `MCP: Negotiated protocol ${client.getNegotiatedProtocolVersion()} for ${toolName}`,
    timestamp: new Date().toISOString(),
  });

  try {
    const response = await callOnModernClient(client, toolName, args, options.signal, options.requestTimeoutMs);
    return { handled: true, response };
  } catch (error) {
    // A tool request may have reached the server even when its response was
    // lost. Never replay automatically: mutating AdCP tools depend on the
    // caller's explicit idempotency policy, not transport guesswork.
    modernConnections.delete(cacheKey);
    legacyConnectionExpiresAt.delete(cacheKey);
    try {
      await client.close();
    } catch {
      /* ignore close errors */
    }
    throw error;
  } finally {
    if (guardedConnection) {
      try {
        await client.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

/**
 * Try a tool call using the MCP 2026-07-28 protocol era.
 *
 * `handled: false` means the caller must use the existing v1 client. This is
 * deliberately a result rather than an exception because legacy negotiation
 * is normal during the transition window.
 */
export async function tryCallModernMCPTool(
  agentUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  customHeaders?: Record<string, string>,
  options: ModernMCPConnectionOptions = {}
): Promise<ModernMCPAttempt> {
  return withSpan('adcp.mcp.negotiate', { 'adcp.tool': toolName, 'http.url': agentUrl }, () =>
    signingContextStorage.run(options.signingContext, () =>
      attemptModernCall(
        {
          agentUrl,
          authToken,
          customHeaders,
          debugLogs,
          signingContext: options.signingContext,
          authProvider: options.authProvider,
          signal: options.signal,
          requestTimeoutMs: options.requestTimeoutMs,
          handleLegacy: options.handleLegacy,
        },
        toolName,
        args
      )
    )
  );
}

/**
 * Probe an endpoint with the official v2 client's auto negotiation.
 * `connected: false` lets endpoint discovery retain its v1 SSE fallback.
 */
export async function probeModernMCPConnection(
  agentUrl: string,
  authToken?: string,
  customHeaders?: Record<string, string>,
  options: ModernMCPConnectionOptions = {}
): Promise<{ connected: boolean; era?: 'legacy' | 'modern' }> {
  const connectionOptions: ModernConnectionOptions = {
    agentUrl,
    authToken,
    customHeaders,
    debugLogs: [],
    signingContext: options.signingContext,
    authProvider: options.authProvider,
    signal: options.signal,
    requestTimeoutMs: options.requestTimeoutMs,
    handleLegacy: options.handleLegacy,
  };
  const authHeaders = buildAuthHeaders(authToken, customHeaders, options.authProvider);
  let client: Client | undefined;
  try {
    client = await createNegotiatedClient(connectionOptions, authHeaders);
    return { connected: true, era: client.getProtocolEra() };
  } catch (error) {
    if (is401Error(error) || isAbortOrTimeoutError(error)) throw error;
    const status = httpStatusOf(error);
    if (status === 404 || status === 405) return { connected: false };
    throw error;
  } finally {
    await client?.close().catch(() => {});
  }
}

/** List tools when the endpoint selected the modern era; otherwise let the v1 caller continue. */
export async function tryListModernMCPTools(
  agentUrl: string,
  authToken?: string,
  customHeaders?: Record<string, string>,
  options: ModernMCPConnectionOptions = {}
): Promise<ModernMCPListAttempt> {
  const connectionOptions: ModernConnectionOptions = {
    agentUrl,
    authToken,
    customHeaders,
    debugLogs: [],
    signingContext: options.signingContext,
    authProvider: options.authProvider,
    signal: options.signal,
    requestTimeoutMs: options.requestTimeoutMs,
  };
  const authHeaders = buildAuthHeaders(authToken, customHeaders, options.authProvider);
  let client: Client | undefined;
  try {
    client = await createNegotiatedClient(connectionOptions, authHeaders);
    if (client.getProtocolEra() !== 'modern') return { handled: false };
    const resolvedRequestTimeoutMs = resolveClientRequestTimeoutMs(options.requestTimeoutMs);
    const result = await client.listTools(undefined, {
      ...(options.signal && { signal: options.signal }),
      ...(resolvedRequestTimeoutMs !== undefined && { timeout: resolvedRequestTimeoutMs }),
    });
    return { handled: true, tools: result.tools };
  } catch (error) {
    if (is401Error(error) || isAbortOrTimeoutError(error)) throw error;
    const status = httpStatusOf(error);
    if (status === 404 || status === 405) return { handled: false };
    throw error;
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function closeModernMCPConnections(): Promise<void> {
  connectionGeneration++;
  const pending = [...pendingModernConnections.values()];
  pendingModernConnections.clear();
  const settled = await Promise.allSettled(pending);
  const clients = new Set(modernConnections.values());
  for (const result of settled) {
    if (result.status === 'fulfilled') clients.add(result.value);
  }
  modernConnections.clear();
  legacyConnectionExpiresAt.clear();
  knownLegacyConnections.clear();
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      /* ignore close errors */
    }
  }
}
