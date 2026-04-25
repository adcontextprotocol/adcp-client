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
import { buildAgentSigningFetch, signingContextStorage, type AgentSigningContext } from '../signing/client';
import { redactIdempotencyKeyInArgs } from '../utils/idempotency';
import { wrapFetchWithCapture } from './rawResponseCapture';
import type { TaskInfo } from '../core/ConversationTypes';

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
  authToken: string | undefined
): Promise<InstanceType<typeof A2AClient>> {
  const signingContext = signingContextStorage.getStore();
  const cacheKey = a2aCacheKey(agentUrl, authToken, signingContext?.cacheKey);
  const cached = a2aClientCache.get(cacheKey);
  if (cached) return cached;

  const pending = pendingA2AClients.get(cacheKey);
  if (pending) return pending;

  const promise = createA2AClient(agentUrl, authToken)
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
  authToken: string | undefined
): Promise<InstanceType<typeof A2AClient>> {
  const fetchImpl = buildFetchImpl(authToken);
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

function buildFetchImpl(authToken: string | undefined) {
  // The A2A client is cached per (url, authToken, signingCacheKey). We capture
  // the signing context at client-creation time so all subsequent calls that
  // share this cached client use the same signing identity — changing identity
  // requires a different cache entry, built on a separate call that enters ALS
  // with a different context.
  const signingContext = signingContextStorage.getStore();

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

  if (!signingContext) return wrapFetchWithCapture(baseFetch);

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
  return wrapFetchWithCapture(signingFetch as typeof fetch);
}

/**
 * Protocol-level session identifiers that ride on the A2A Message envelope
 * (not in the skill parameters). `contextId` binds sends to a server-side
 * conversation; `taskId` resumes an existing non-terminal task.
 *
 * Callers (buyers) typically retain these across calls on a per-conversation
 * AgentClient; see AgentClient.getContextId() / getPendingTaskId().
 */
export interface A2ASessionIds {
  contextId?: string;
  taskId?: string;
}

export async function callA2ATool(
  agentUrl: string,
  toolName: string,
  parameters: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  pushNotificationConfig?: PushNotificationConfig,
  customHeaders?: Record<string, string>,
  signingContext?: AgentSigningContext,
  session?: A2ASessionIds
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
      return signingContextStorage.run(signingContext, () =>
        callContextStorage.run(context, () =>
          callA2AToolImpl(
            agentUrl,
            toolName,
            parameters,
            authToken,
            debugLogs,
            pushNotificationConfig,
            context,
            session
          )
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
  session: A2ASessionIds | undefined
): Promise<unknown> {
  try {
    const client = await getOrCreateA2AClient(agentUrl, authToken);

    const requestPayload: {
      message: {
        messageId: string;
        role: string;
        kind: string;
        parts: Array<{ kind: string; data: { skill: string; parameters: Record<string, unknown> } }>;
        contextId?: string;
        taskId?: string;
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
        ...(session?.contextId && { contextId: session.contextId }),
        ...(session?.taskId && { taskId: session.taskId }),
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
      const signingContext = signingContextStorage.getStore();
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

/**
 * Poll an A2A task's current state via the native `tasks/get` JSON-RPC method.
 * Parallel to `getMCPTaskStatus`. Intentionally not signed — `tasks/get` is a
 * read-only lifecycle method, matching the convention in `getMCPTaskStatus`.
 *
 * The `a2aTaskId` must be the server-assigned A2A `Task.id` from the initial
 * `message/send` response — NOT the client-minted correlation UUID.
 */
export async function getA2ATaskStatus(
  agentUrl: string,
  a2aTaskId: string,
  authToken: string | undefined
): Promise<TaskInfo> {
  if (!a2aTaskId || typeof a2aTaskId !== 'string' || a2aTaskId.length > 256) {
    throw new Error(`Invalid a2aTaskId: expected non-empty string (max 256 chars)`);
  }
  const client = await getOrCreateA2AClient(agentUrl, authToken);
  try {
    const task = await client.getTask({ id: a2aTaskId });
    return mapA2ATaskToTaskInfo(task);
  } catch (error: unknown) {
    if (is401Error(error)) {
      // Evict both the unsigned entry (used by this call) and any signed entry
      // that may exist from a prior callA2ATool call for the same agent.
      a2aClientCache.delete(a2aCacheKey(agentUrl, authToken));
      a2aClientCache.delete(a2aCacheKey(agentUrl, authToken, signingContextStorage.getStore()?.cacheKey));
      const oauthMetadata = await discoverOAuthMetadata(agentUrl);
      throw new AuthenticationRequiredError(agentUrl, oauthMetadata || undefined);
    }
    throw error;
  }
}

/**
 * Map an A2A `Task` returned by `tasks/get` to the AdCP `TaskInfo` shape.
 *
 * Key invariant: A2A `Task.status.state` is always `'completed'` for submitted
 * AdCP arms because the adapter marks the transport call as done while the AdCP
 * work is queued (see a2a-adapter.ts commentary). The real AdCP lifecycle status
 * lives in `artifact.parts[last-data-part].data.status`; `Task.state` is only
 * reliable for distinguishing terminal transport failures (`'failed'`/`'canceled'`).
 */
function mapA2ATaskToTaskInfo(task: {
  id: string;
  status: { state: string; timestamp?: string };
  artifacts?: Array<{
    parts: Array<{ kind: string; data?: Record<string, unknown> }>;
    metadata?: Record<string, unknown>;
  }>;
}): TaskInfo {
  const lastArtifact = task.artifacts?.[task.artifacts.length - 1];
  const lastDataPart = lastArtifact?.parts.filter(p => p.kind === 'data').slice(-1)[0] as
    | { kind: 'data'; data: Record<string, unknown> }
    | undefined;

  const rawStatus = lastDataPart?.data?.status;
  const adcpStatus = typeof rawStatus === 'string' ? rawStatus : undefined;
  const a2aState = task.status.state;

  // Prefer the AdCP-level status embedded in the artifact payload; fall back to
  // the A2A transport state (working, submitted, failed, canceled, etc.) when
  // no artifact payload is present yet.
  const status = adcpStatus ?? a2aState;

  const timestampMs = task.status.timestamp ? new Date(task.status.timestamp).getTime() : Date.now();

  return {
    taskId: task.id,
    status,
    // A2A tasks/get does not carry the originating AdCP tool name.
    taskType: 'unknown',
    createdAt: timestampMs,
    updatedAt: Date.now(),
    result: lastDataPart?.data,
    // 'canceled' is omitted: it's a deliberate stop, not an unexpected failure, so
    // TaskResult callers can surface it via status without treating it as an error.
    error: a2aState === 'failed' || a2aState === 'rejected' ? `A2A task ${task.id} ${a2aState}` : undefined,
  };
}
