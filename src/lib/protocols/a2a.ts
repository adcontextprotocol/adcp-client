// Official A2A client implementation - NO FALLBACKS
const clientModule = require('@a2a-js/sdk/client');
const A2AClient = clientModule.A2AClient;

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { PushNotificationConfig } from '../types/tools.generated';
import type { DebugLogEntry } from '../types/adcp';
import { AuthenticationRequiredError, is401Error } from '../errors';
import { discoverOAuthMetadata } from '../auth/oauth/discovery';
import { withSpan, injectTraceHeaders } from '../observability/tracing';
import { isAgentCardPath, buildCardUrls } from '../utils/a2a-discovery';
import { buildAgentSigningFetch, type AgentSigningContext } from '../signing/client';
import { redactIdempotencyKeyInArgs } from '../utils/idempotency';

if (!A2AClient) {
  throw new Error('A2A SDK client is required. Please install @a2a-js/sdk');
}

/**
 * Per-call state flowed through AsyncLocalStorage so concurrent callers
 * that share a cached A2AClient don't clobber each other's debugLogs,
 * customHeaders, or 401 flag.
 */
interface A2ACallContext {
  customHeaders?: Record<string, string>;
  debugLogs: DebugLogEntry[];
  got401Ref: { value: boolean };
}

const callContextStorage = new AsyncLocalStorage<A2ACallContext>();

/**
 * Cached A2AClient keyed by (agentUrl, authToken hash). Avoids re-fetching
 * /.well-known/agent.json on every tool call. The cached client's fetchImpl
 * reads per-call state from callContextStorage, so concurrent calls to the
 * same cache entry are safe.
 *
 * Process-global singleton — not suitable for multi-tenant servers that
 * want per-tenant isolation (use separate processes or explicit cache keys).
 */
const a2aClientCache = new Map<string, InstanceType<typeof A2AClient>>();
const pendingA2AClients = new Map<string, Promise<InstanceType<typeof A2AClient>>>();

function a2aCacheKey(agentUrl: string, authToken?: string, signingCacheKey?: string): string {
  // 64-bit hash prefix — cache key disambiguator, not a security boundary.
  // The cached client closes over the full authToken; a hypothetical hash
  // collision still sends the original token, not the colliding one.
  const tokenSuffix = authToken ? `::${createHash('sha256').update(authToken).digest('hex').slice(0, 16)}` : '';
  const signingSuffix = signingCacheKey ? `::${signingCacheKey}` : '';
  return `${agentUrl}${tokenSuffix}${signingSuffix}`;
}

/**
 * Clear all cached A2A clients. Called by closeConnections('a2a').
 * A2A clients hold no persistent network resources (unlike MCP), so this
 * is just cache eviction.
 */
export function closeA2AConnections(): void {
  a2aClientCache.clear();
  pendingA2AClients.clear();
}

async function getOrCreateA2AClient(
  agentUrl: string,
  authToken: string | undefined,
  signingContext: AgentSigningContext | undefined
): Promise<InstanceType<typeof A2AClient>> {
  const cacheKey = a2aCacheKey(agentUrl, authToken, signingContext?.cacheKey);
  const cached = a2aClientCache.get(cacheKey);
  if (cached) return cached;

  const pending = pendingA2AClients.get(cacheKey);
  if (pending) return pending;

  const promise = createA2AClient(agentUrl, authToken, signingContext)
    .then(client => {
      a2aClientCache.set(cacheKey, client);
      return client;
    })
    .finally(() => {
      pendingA2AClients.delete(cacheKey);
    });

  pendingA2AClients.set(cacheKey, promise);
  return promise;
}

async function createA2AClient(
  agentUrl: string,
  authToken: string | undefined,
  signingContext: AgentSigningContext | undefined
): Promise<InstanceType<typeof A2AClient>> {
  const fetchImpl = buildFetchImpl(authToken, signingContext);
  const cardUrls = buildCardUrls(agentUrl);

  const context = callContextStorage.getStore();
  context?.debugLogs.push({
    type: 'info',
    message: `A2A: Discovering agent card at ${cardUrls.join(', ')}`,
    timestamp: new Date().toISOString(),
  });

  let client: InstanceType<typeof A2AClient> | undefined;
  let lastError: Error = new Error(`A2A agent card not found at ${cardUrls.join(', ')}`);
  for (const cardUrl of cardUrls) {
    try {
      client = await A2AClient.fromCardUrl(cardUrl, { fetchImpl });
      break;
    } catch (err: unknown) {
      lastError = err as Error;
      if (context?.got401Ref.value) break;
    }
  }
  if (!client) throw lastError;

  return client;
}

function buildFetchImpl(authToken: string | undefined, signingContext: AgentSigningContext | undefined) {
  // Inner fetch handles auth/header injection and 401 detection. If the
  // agent has request-signing configured, we wrap it with the AdCP signing
  // fetch so the signature covers the exact bytes we're about to send (auth
  // headers included, since the signer re-reads the final header record).
  const baseFetch = async (url: string | URL | Request, options?: RequestInit) => {
    const context = callContextStorage.getStore();

    const existingHeaders: Record<string, string> = {};
    if (options?.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((value, key) => {
          existingHeaders[key] = value;
        });
      } else if (Array.isArray(options.headers)) {
        for (const [key, value] of options.headers) {
          existingHeaders[key] = value;
        }
      } else {
        Object.assign(existingHeaders, options.headers);
      }
    }

    // Only inject trace context headers for actual tool requests, not discovery.
    // The agent card endpoint is external/untrusted — don't leak trace IDs to it.
    const urlString = typeof url === 'string' ? url : url.toString();
    const isDiscoveryRequest = isAgentCardPath(urlString);
    const traceHeaders = isDiscoveryRequest ? {} : injectTraceHeaders();

    // Merge: existing < trace < custom < auth (auth always wins)
    const headers: Record<string, string> = {
      ...existingHeaders,
      ...traceHeaders,
      ...context?.customHeaders,
      ...(authToken && {
        Authorization: `Bearer ${authToken}`,
        'x-adcp-auth': authToken,
      }),
    };

    context?.debugLogs.push({
      type: 'info',
      message: `A2A: Fetch to ${urlString}`,
      timestamp: new Date().toISOString(),
      hasAuth: !!authToken,
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => {
          const lower = k.toLowerCase();
          return lower === 'authorization' || lower === 'x-adcp-auth' ? [k, '***'] : [k, v];
        })
      ),
    });

    const response = await fetch(url, { ...options, headers });

    if (response.status === 401 && context) {
      context.got401Ref.value = true;
    }

    return response;
  };

  if (!signingContext) return baseFetch;

  // The signing wrapper assembles headers into the signature base. We invoke
  // it first so the signer sees the caller-supplied headers; baseFetch then
  // overlays auth/trace headers afterwards — A2A's auth scheme (bearer) is
  // not among the MANDATORY_COMPONENTS and is injected by the counterparty's
  // transport layer, not signed.
  const signingFetch = buildAgentSigningFetch({
    upstream: (input, init) => baseFetch(input as any, init),
    signing: signingContext.signing,
    getCapability: signingContext.getCapability,
  });
  return signingFetch;
}

export async function callA2ATool(
  agentUrl: string,
  toolName: string,
  parameters: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  pushNotificationConfig?: PushNotificationConfig,
  customHeaders?: Record<string, string>,
  signingContext?: AgentSigningContext
): Promise<unknown> {
  return withSpan(
    'adcp.a2a.call_tool',
    {
      'adcp.tool': toolName,
      'http.url': agentUrl,
    },
    async () => {
      const context: A2ACallContext = {
        customHeaders,
        debugLogs,
        got401Ref: { value: false },
      };
      return callContextStorage.run(context, () =>
        callA2AToolImpl(
          agentUrl,
          toolName,
          parameters,
          authToken,
          debugLogs,
          pushNotificationConfig,
          context,
          signingContext
        )
      );
    }
  );
}

async function callA2AToolImpl(
  agentUrl: string,
  toolName: string,
  parameters: Record<string, unknown>,
  authToken: string | undefined,
  debugLogs: DebugLogEntry[],
  pushNotificationConfig: PushNotificationConfig | undefined,
  context: A2ACallContext,
  signingContext: AgentSigningContext | undefined
): Promise<unknown> {
  try {
    const client = await getOrCreateA2AClient(agentUrl, authToken, signingContext);

    const requestPayload: {
      message: {
        messageId: string;
        role: string;
        kind: string;
        parts: Array<{ kind: string; data: { skill: string; parameters: Record<string, unknown> } }>;
      };
      configuration?: { pushNotificationConfig: PushNotificationConfig };
    } = {
      message: {
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        role: 'user',
        kind: 'message',
        parts: [
          {
            kind: 'data',
            data: {
              skill: toolName,
              parameters: parameters,
            },
          },
        ],
      },
    };

    if (pushNotificationConfig) {
      requestPayload.configuration = {
        pushNotificationConfig: pushNotificationConfig,
      };
    }

    const payloadSize = JSON.stringify(requestPayload).length;
    const redactedParameters = redactIdempotencyKeyInArgs(parameters);
    const redactedPayload =
      redactedParameters === parameters
        ? requestPayload
        : {
            ...requestPayload,
            message: {
              ...requestPayload.message,
              parts: [
                {
                  kind: 'data',
                  data: { skill: toolName, parameters: redactedParameters },
                },
              ],
            },
          };
    debugLogs.push({
      type: 'info',
      message: `A2A: Calling skill ${toolName} with parameters: ${JSON.stringify(
        redactedParameters
      )}. Payload size: ${payloadSize} bytes`,
      timestamp: new Date().toISOString(),
      payloadSize,
      actualPayload: redactedPayload,
    });

    debugLogs.push({
      type: 'info',
      message: `A2A: Sending message via sendMessage()`,
      timestamp: new Date().toISOString(),
      skill: toolName,
    });

    const messageResponse = await client.sendMessage(requestPayload);

    debugLogs.push({
      type: messageResponse?.error ? 'error' : 'success',
      message: `A2A: Response received (${messageResponse?.error ? 'error' : 'success'})`,
      timestamp: new Date().toISOString(),
      response: messageResponse,
      skill: toolName,
    });

    if (messageResponse?.error || messageResponse?.result?.error) {
      const errorObj = messageResponse.error || messageResponse.result?.error;
      const errorMessage = errorObj.message || JSON.stringify(errorObj);
      throw new Error(`A2A agent returned error: ${errorMessage}`);
    }

    return messageResponse;
  } catch (error: unknown) {
    if (is401Error(error, context.got401Ref.value)) {
      // Evict this cache entry — token may have expired or been revoked.
      a2aClientCache.delete(a2aCacheKey(agentUrl, authToken, signingContext?.cacheKey));

      debugLogs.push({
        type: 'error',
        message: `A2A: Authentication required for ${agentUrl}`,
        timestamp: new Date().toISOString(),
      });

      const oauthMetadata = await discoverOAuthMetadata(agentUrl);
      throw new AuthenticationRequiredError(agentUrl, oauthMetadata || undefined);
    }

    throw error;
  }
}
