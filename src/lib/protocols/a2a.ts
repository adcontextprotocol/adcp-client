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
import { wrapFetchWithSizeLimit } from './responseSizeLimit';

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

/**
 * Fire-and-forget A2A tasks/cancel for an in-flight task (A2A 0.3.0 §7.4).
 *
 * Sends a raw JSON-RPC 2.0 POST directly to the agent endpoint. Uses the same
 * auth header shape as `callA2AToolImpl` (Bearer + x-adcp-auth) and applies
 * request signing when a signing context is active (required for `signed-requests`
 * sellers that verify signatures on mutating operations). Does NOT enter
 * `callContextStorage` — debug-log capture and 401-cache-eviction are
 * intentionally skipped for best-effort cancellation.
 *
 * **Auth-code OAuth gap:** `authToken` is resolved by `getAuthToken(agent)`,
 * which returns `undefined` for authorization-code-flow sellers (those tokens are
 * managed by the OAuth provider path in `ProtocolClient.callTool`, not accessible
 * here). Cancel calls to those sellers go out unauthenticated and will likely 401.
 * This is acceptable — the cancel is best-effort and the buyer is already
 * abandoning the task.
 *
 * The caller is responsible for swallowing errors: cancel failure
 * (TaskNotCancelable, network error, auth rejection) is non-fatal because
 * the buyer is already abandoning the task.
 *
 * @param agentUrl  The A2A agent endpoint URL (agent.agent_uri).
 * @param taskId    The server-assigned A2A Task.id to cancel.
 * @param authToken Bearer token for the seller, if available.
 */
export async function cancelA2ATask(agentUrl: string, taskId: string, authToken: string | undefined): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
    headers['x-adcp-auth'] = authToken;
  }
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    method: 'tasks/cancel',
    params: { id: taskId },
  });
  // Apply request signing when a signing context is active. Sellers claiming
  // `signed-requests` verify signatures on mutating operations including
  // tasks/cancel — without this, the cancel would be rejected with 401/403,
  // leaving the task orphaned even though the buyer dispatched a cancel.
  // Note: the `callA2ATool` → `signingContextStorage.run()` ALS context is
  // NOT active during `pollTaskCompletion` (different execution context), so
  // `getStore()` returns undefined here unless the caller explicitly wraps
  // `pollTaskCompletion` in `signingContextStorage.run()`. The signing branch
  // is a forward-compatibility hook; in practice Phase 1 cancel calls are
  // unsigned for signed-requests sellers and will 401 non-fatally.
  const signingContext = signingContextStorage.getStore();
  const fetchFn = signingContext
    ? buildAgentSigningFetch({
        upstream: (input, init) => fetch(input as any, init),
        signing: signingContext.signing,
        getCapability: signingContext.getCapability,
      })
    : fetch;
  await fetchFn(agentUrl as any, { method: 'POST', headers, body });
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

  // Innermost wrapper: enforce response body size cap from the active
  // `responseSizeLimitStorage` slot. Pass-through when no slot is set.
  const networkFetch = wrapFetchWithSizeLimit((input, init) => fetch(input as any, init));

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

    const response = await networkFetch(url as any, { ...options, headers });

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
 * Terminal A2A task states per A2A 0.3.0 §3.4. Only these can carry the
 * AdCP-mandated artifact + DataPart envelope (per transport-errors §A2A
 * Binding); intermediate states (`working`, `submitted`, `input-required`,
 * `auth-required`) carry no completion artifact.
 */
const TERMINAL_A2A_STATES = new Set(['completed', 'failed', 'rejected', 'canceled']);

/**
 * Detect whether a JSON-RPC response carries a spec-compliant terminal-state
 * Task with at least one artifact containing a structured DataPart payload.
 * Per AdCP transport-errors §A2A Binding, the artifact's DataPart is the
 * canonical envelope for both the success arm (`completed`) and the error
 * arms (`failed` / `rejected` / `canceled`). The criterion intentionally
 * matches the unwrapper's terminal-state extraction in
 * `unwrapA2AResponse` — keeping protocol layer and unwrapper in lockstep
 * across all terminal states, not just the error arms.
 *
 * Used to short-circuit the generic "A2A agent returned error" throw when
 * a non-conformant seller surfaces both a transport-level `result.error`
 * hint and the canonical artifact envelope side-by-side. The DataPart is
 * authoritative; the throw would otherwise swallow it.
 */
function hasTerminalTaskWithDataArtifact(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const result = (response as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return false;
  const r = result as { kind?: unknown; status?: unknown; artifacts?: unknown };
  if (r.kind !== 'task') return false;
  const status = r.status as { state?: unknown } | undefined;
  if (typeof status?.state !== 'string' || !TERMINAL_A2A_STATES.has(status.state)) return false;
  if (!Array.isArray(r.artifacts) || r.artifacts.length === 0) return false;
  for (const artifact of r.artifacts) {
    if (!artifact || typeof artifact !== 'object') continue;
    const parts = (artifact as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const p = part as { kind?: unknown; data?: unknown };
      if (p.kind === 'data' && p.data && typeof p.data === 'object') return true;
    }
  }
  return false;
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
      // adcp-client#1575: when the seller emits a spec-compliant terminal-state
      // Task carrying an `adcp_error` DataPart (per AdCP transport-errors §A2A
      // Binding), the structured artifact is canonical — even if the seller
      // also surfaced a transport-level error string. Pass the response
      // through so the upstream unwrapper extracts `adcp_error.code` instead
      // of throwing a generic message that loses the AdCP error envelope.
      if (!hasTerminalTaskWithDataArtifact(messageResponse)) {
        const errorObj = messageResponse.error || messageResponse.result?.error;
        const errorMessage = errorObj.message || JSON.stringify(errorObj);
        throw new Error(`A2A agent returned error: ${errorMessage}`);
      }
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
