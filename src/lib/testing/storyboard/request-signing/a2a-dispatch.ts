/**
 * Capture requests emitted by the official A2A 1.x client for RFC 9421
 * signing. The SDK owns endpoint selection, method names, version headers,
 * and proto-JSON encoding; this module only intercepts its fetch seam.
 */
import { createAgentTransportFetch } from '../../../net/agent-transport-fetch';
import { MAX_TIMER_DELAY_MS, withAbortSignal } from '../../../protocols/abort';
import { buildCardUrls } from '../../../utils/a2a-discovery';
import {
  toA2ATaskPushNotificationConfig,
  type A2APushNotificationConfig,
} from '../../../protocols/a2a-push-notification';
import type { SendMessageRequest } from '@a2a-js/sdk-v1';
import type { Client } from '@a2a-js/sdk-v1/client';

const DEFAULT_CARD_FETCH_TIMEOUT_MS = 10_000;
const MAX_CACHED_AGENT_CARD_BYTES = 1_048_576;
const ADCP_A2A_EXTENSION = 'https://adcontextprotocol.org/extensions/adcp/v3';
const CARD_DRIVEN_LEGACY_COMPAT = Object.freeze({ enabled: true });

export interface CapturedA2aRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type A2aCall =
  | { kind: 'sendMessage'; operation: string; args: Record<string, unknown> }
  | { kind: 'cancelTask'; taskId: string };

export interface A2aDispatchOptions {
  timeoutMs?: number;
  allowPrivateIp?: boolean;
  /** Trusted fetch used only for agent-card discovery. */
  cardFetch?: typeof fetch;
}

class RequestCaptured extends Error {
  constructor(readonly captured: CapturedA2aRequest) {
    super('a2a request captured');
  }
}

export async function captureA2aRequest(
  agentUrl: string,
  call: A2aCall,
  options: A2aDispatchOptions = {}
): Promise<CapturedA2aRequest> {
  const { ClientFactory, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions } =
    await import('@a2a-js/sdk-v1/client');
  const { Role } = await import('@a2a-js/sdk-v1');

  const capturingFetch: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    throw new RequestCaptured({
      url: request.url,
      method: request.method,
      headers,
      body: await request.text(),
    });
  };

  const cardFetch = buildGuardedCardFetch(agentUrl, options);
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: capturingFetch, legacyCompat: CARD_DRIVEN_LEGACY_COMPAT })],
    cardResolver: new (await import('@a2a-js/sdk-v1/client')).DefaultAgentCardResolver({
      fetchImpl: cardFetch,
      legacyCompat: CARD_DRIVEN_LEGACY_COMPAT,
    }),
  });
  const client = await createCardDrivenClient(agentUrl, factory);
  const legacyWire = client.protocolVersion?.startsWith('0.') ?? false;

  try {
    if (call.kind === 'cancelTask') {
      await client.cancelTask({ tenant: '', id: call.taskId, metadata: undefined });
    } else {
      const { push_notification_config: pushNotificationConfig, ...skillArgs } = call.args;
      const invocation = legacyWire
        ? { skill: call.operation, parameters: skillArgs }
        : {
            skill: call.operation,
            // Native A2A transport registration cannot represent AdCP-only
            // fields such as operation_id. Keep the complete application
            // registration in skill input, matching the runtime path.
            input: call.args,
          };
      const request: SendMessageRequest = {
        tenant: '',
        message: {
          messageId: globalThis.crypto.randomUUID(),
          contextId: '',
          taskId: '',
          role: Role.ROLE_USER,
          parts: [
            {
              content: { $case: 'data', value: invocation },
              metadata: undefined,
              filename: '',
              mediaType: 'application/json',
            },
          ],
          metadata: undefined,
          extensions: legacyWire ? [] : [ADCP_A2A_EXTENSION],
          referenceTaskIds: [],
        },
        configuration:
          pushNotificationConfig != null &&
          typeof pushNotificationConfig === 'object' &&
          !Array.isArray(pushNotificationConfig)
            ? {
                acceptedOutputModes: ['application/json'],
                taskPushNotificationConfig: toA2ATaskPushNotificationConfig(
                  pushNotificationConfig as A2APushNotificationConfig
                ),
                returnImmediately: false,
              }
            : undefined,
        metadata: undefined,
      };
      await client.sendMessage(request, {
        ...(legacyWire ? {} : { serviceParameters: ServiceParameters.create(withA2AExtensions(ADCP_A2A_EXTENSION)) }),
      });
    }
  } catch (error) {
    if (error instanceof RequestCaptured) {
      assertSameOriginEndpoint(agentUrl, error.captured.url);
      return error.captured;
    }
    throw error;
  }
  throw new Error(`the A2A client returned without issuing a request for ${call.kind}`);
}

async function createCardDrivenClient(
  agentUrl: string,
  factory: { createFromUrl(baseUrl: string, path?: string): Promise<Client> }
): Promise<Client> {
  let lastError: unknown;
  for (const cardUrl of buildCardUrls(agentUrl)) {
    try {
      return await factory.createFromUrl(cardUrl, '');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('A2A agent card discovery failed', { cause: lastError });
}

function buildGuardedCardFetch(agentUrl: string, options: A2aDispatchOptions): typeof fetch {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CARD_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`A2A card timeoutMs must be a finite positive number <= ${MAX_TIMER_DELAY_MS}`);
  }
  const transportFetch = createAgentTransportFetch(agentUrl, {
    ...(options.cardFetch ? { trustedFetchFn: options.cardFetch } : {}),
    allowPrivateIp: options.allowPrivateIp === true,
  });
  return ((input: RequestInfo | URL, init: RequestInit = {}) =>
    withAbortSignal([init.signal], timeoutMs, async signal => {
      const response = await transportFetch(input, { ...init, ...(signal ? { signal } : {}) });
      // Keep the same discovery deadline active through body consumption. A
      // peer can otherwise return headers plus one byte and stall grading
      // forever while the official resolver waits for JSON completion.
      const body = await readCardBodyBounded(response, MAX_CACHED_AGENT_CARD_BYTES, signal);
      return new Response(body.byteLength > 0 ? Uint8Array.from(body).buffer : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    })) as typeof fetch;
}

/**
 * Cache discovery within one grading run without turning the platform fetch
 * into a trusted fetch override. The guarded transport performs DNS/private
 * address enforcement before this wrapper sees a response.
 */
export function createCachedA2aCardFetch(agentUrl: string, options: A2aDispatchOptions = {}): typeof fetch {
  const upstream = buildGuardedCardFetch(agentUrl, options);
  const responses = new Map<
    string,
    Promise<{ status: number; statusText: string; headers: [string, string][]; body: Uint8Array }>
  >();
  return async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    if (request.method !== 'GET') return upstream(input, init);
    let pending = responses.get(request.url);
    if (!pending) {
      pending = upstream(input, init).then(async response => ({
        status: response.status,
        statusText: response.statusText,
        headers: (() => {
          const entries: [string, string][] = [];
          response.headers.forEach((value, name) => entries.push([name, value]));
          return entries;
        })(),
        body: await readCardBodyBounded(response, MAX_CACHED_AGENT_CARD_BYTES),
      }));
      responses.set(request.url, pending);
      pending.catch(() => responses.delete(request.url));
    }
    const cached = await pending;
    return new Response(cached.body.slice(), {
      status: cached.status,
      statusText: cached.statusText,
      headers: cached.headers,
    });
  };
}

async function readCardBodyBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`A2A agent card exceeds the ${maxBytes}-byte discovery limit`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error(`A2A agent card exceeds the ${maxBytes}-byte discovery limit`);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export function operationFromVectorUrl(vectorUrl: string): string {
  const last = new URL(vectorUrl).pathname.split('/').filter(Boolean).at(-1);
  if (!last || !/^[a-z][a-z0-9_]*$/.test(last)) {
    throw new Error(`Cannot extract an AdCP operation name from vector URL: ${vectorUrl}`);
  }
  return last;
}

export async function resolveA2aDispatchTarget(
  agentUrl: string,
  options: A2aDispatchOptions = {}
): Promise<{ endpoint: string }> {
  const { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } = await import('@a2a-js/sdk-v1/client');
  let endpoint = '';
  const noteEndpoint: typeof fetch = async (input, init) => {
    endpoint = new Request(input as RequestInfo, init).url;
    throw new RequestCaptured({ url: endpoint, method: 'POST', headers: {}, body: '' });
  };
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: noteEndpoint, legacyCompat: CARD_DRIVEN_LEGACY_COMPAT })],
    cardResolver: new DefaultAgentCardResolver({
      fetchImpl: buildGuardedCardFetch(agentUrl, options),
      legacyCompat: CARD_DRIVEN_LEGACY_COMPAT,
    }),
  });
  const client = await createCardDrivenClient(agentUrl, factory);
  try {
    await client.cancelTask({ tenant: '', id: 'a2a-dispatch-probe', metadata: undefined });
  } catch (error) {
    if (error instanceof RequestCaptured) {
      assertSameOriginEndpoint(agentUrl, endpoint);
      return { endpoint };
    }
    throw error;
  }
  throw new Error('the A2A client returned without issuing a dispatch probe');
}

function assertSameOriginEndpoint(agentUrl: string, endpoint: string): void {
  const agentOrigin = new URL(agentUrl).origin;
  const endpointOrigin = new URL(endpoint).origin;
  if (endpointOrigin === agentOrigin) return;
  throw new Error(
    `A2A request-signing probes refuse a cross-origin card endpoint (${endpointOrigin}); expected ${agentOrigin}`
  );
}
