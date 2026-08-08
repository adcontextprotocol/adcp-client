import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { getComplianceCacheDir } from './compliance';
import type {
  HttpProbeResult,
  StoryboardStep,
  TrustedMatchContextProviderEndpoint,
  TrustedMatchContextRouterRunnerOptions,
} from './types';

const DEFAULT_VECTOR_REF = 'test-vectors/trusted-match-context-merge/vectors.json';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ROUTER_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROVIDER_REQUEST_BYTES = 64 * 1024;

interface TrustedMatchContextVector {
  profile: string;
  registrations: Array<{ provider_id: string }>;
  provider_responses: Array<{
    registration_provider_id: string;
    response: Record<string, unknown>;
  }>;
  request?: Record<string, unknown>;
}

export interface TrustedMatchContextReplayResult {
  httpResult: HttpProbeResult;
  request: Record<string, unknown>;
  vectorSource?: string;
}

export async function replayTrustedMatchContextVector(
  step: StoryboardStep,
  options: TrustedMatchContextRouterRunnerOptions,
  params: {
    requestOverride?: Record<string, unknown>;
    adcpVersion?: string;
    signal?: AbortSignal;
  } = {}
): Promise<TrustedMatchContextReplayResult> {
  const vectorResult = loadVector(step.vector_ref, options.vectorsRoot, params.adcpVersion);
  const emptyRequest = params.requestOverride ?? step.sample_request ?? {};
  if ('error' in vectorResult) {
    return {
      request: emptyRequest,
      httpResult: failedProbe(options.router_url, vectorResult.error),
    };
  }

  const request = params.requestOverride ?? vectorResult.vector.request ?? step.sample_request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return {
      request: {},
      vectorSource: vectorResult.path,
      httpResult: failedProbe(
        options.router_url,
        '`replay_trusted_match_context_vector` requires vector.request or step.sample_request.'
      ),
    };
  }

  let fixtureServer: ProviderFixtureServer | undefined;
  let cleanupRegistration: void | (() => void | Promise<void>) = undefined;
  let result: TrustedMatchContextReplayResult;
  try {
    fixtureServer = await createProviderFixtureServer(vectorResult.vector, options.provider_server);
    cleanupRegistration = await options.registerProviders({
      profile: vectorResult.vector.profile,
      providers: fixtureServer.providers,
      request: structuredClone(request),
    });
    const httpResult = await postRouterContext(options, request, params.signal);
    result = { httpResult, request, vectorSource: vectorResult.path };
  } catch (error) {
    result = {
      request,
      vectorSource: vectorResult.path,
      httpResult: failedProbe(options.router_url, error instanceof Error ? error.message : String(error)),
    };
  } finally {
    const cleanupErrors: string[] = [];
    try {
      if (cleanupRegistration !== undefined) {
        if (typeof cleanupRegistration !== 'function') {
          throw new Error('registerProviders must return void or a cleanup function.');
        }
        await cleanupRegistration();
      }
    } catch (error) {
      cleanupErrors.push(`registration cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await fixtureServer?.close();
    } catch (error) {
      cleanupErrors.push(`provider fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cleanupErrors.length > 0) {
      const priorError = result!.httpResult.error;
      result!.httpResult.error = [...(priorError ? [priorError] : []), ...cleanupErrors].join('; ');
    }
  }
  return result!;
}

function loadVector(
  vectorRef: string | undefined,
  vectorsRoot: string | undefined,
  adcpVersion: string | undefined
): { vector: TrustedMatchContextVector; path: string } | { error: string } {
  const rawRef = (vectorRef ?? DEFAULT_VECTOR_REF).split('#', 1)[0]!;
  if (!rawRef || isAbsolute(rawRef) || rawRef.split(/[\\/]/).includes('..')) {
    return { error: `Invalid Trusted Match Context vector_ref: ${vectorRef ?? rawRef}` };
  }

  const withoutStatic = rawRef.replace(/^static\//, '').replace(/^compliance\/source\//, '');
  const candidates: string[] = [];
  if (vectorsRoot) {
    candidates.push(join(vectorsRoot, rawRef), join(vectorsRoot, withoutStatic), join(vectorsRoot, basename(rawRef)));
  }
  const complianceDir = getComplianceCacheDir({ ...(adcpVersion && { version: adcpVersion }) });
  candidates.push(
    join(complianceDir, withoutStatic),
    join(complianceDir, rawRef),
    join(process.cwd(), rawRef),
    join(process.cwd(), withoutStatic)
  );

  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as unknown;
      const validationError = validateVector(parsed);
      if (validationError) return { error: `${candidate}: ${validationError}` };
      return { vector: parsed as TrustedMatchContextVector, path: candidate };
    } catch (error) {
      return { error: `Failed to read Trusted Match Context vector ${candidate}: ${String(error)}` };
    }
  }
  return { error: `Trusted Match Context vector file not found for ${rawRef}` };
}

function validateVector(value: unknown): string | undefined {
  if (!isRecord(value)) return 'vector must be an object';
  if (typeof value.profile !== 'string' || value.profile.length === 0) return 'profile must be a non-empty string';
  if (!Array.isArray(value.registrations) || value.registrations.length === 0) {
    return 'registrations must be a non-empty array';
  }
  if (!Array.isArray(value.provider_responses) || value.provider_responses.length === 0) {
    return 'provider_responses must be a non-empty array';
  }

  const ids = new Set<string>();
  for (const registration of value.registrations) {
    if (!isRecord(registration) || typeof registration.provider_id !== 'string' || !registration.provider_id) {
      return 'every registration requires a non-empty provider_id';
    }
    if (ids.has(registration.provider_id)) return `duplicate provider_id: ${registration.provider_id}`;
    ids.add(registration.provider_id);
  }
  const responseIds = new Set<string>();
  for (const entry of value.provider_responses) {
    if (!isRecord(entry) || typeof entry.registration_provider_id !== 'string' || !isRecord(entry.response)) {
      return 'every provider response requires registration_provider_id and an object response';
    }
    if (!ids.has(entry.registration_provider_id)) {
      return `provider response has no matching registration: ${entry.registration_provider_id}`;
    }
    if (responseIds.has(entry.registration_provider_id)) {
      return `duplicate provider response: ${entry.registration_provider_id}`;
    }
    responseIds.add(entry.registration_provider_id);
  }
  for (const providerId of ids) {
    if (!responseIds.has(providerId)) return `registration has no provider response: ${providerId}`;
  }
  if ('request' in value && !isRecord(value.request)) return 'request must be an object when present';
  return undefined;
}

interface ProviderFixtureServer {
  providers: TrustedMatchContextProviderEndpoint[];
  close(): Promise<void>;
}

async function createProviderFixtureServer(
  vector: TrustedMatchContextVector,
  config: TrustedMatchContextRouterRunnerOptions['provider_server']
): Promise<ProviderFixtureServer> {
  const host = config?.host ?? '127.0.0.1';
  const port = config?.port ?? 0;
  const mode = config?.mode ?? 'loopback_mock';
  if (mode === 'proxy_url' && !config?.public_url) {
    throw new Error('trusted_match_context_router_runner.provider_server.public_url is required in proxy_url mode.');
  }
  if (config?.public_url) assertHttpUrl(config.public_url, 'provider_server.public_url');

  const responses = new Map(
    vector.provider_responses.map(entry => [entry.registration_provider_id, entry.response] as const)
  );
  const server = createServer((req, res) => {
    void serveProviderFixture(req, res, responses).catch(error => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      } else {
        respondJson(res, 500, { error: 'fixture_server_error' });
      }
    });
  });
  await listen(server, host, port);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Provider fixture server did not expose a TCP address.');
  }
  const localBase = `http://${formatHost(host)}:${address.port}`;
  const advertisedBase = (mode === 'proxy_url' ? config!.public_url! : localBase).replace(/\/$/, '');
  const providers = vector.registrations.map(({ provider_id }) => ({
    provider_id,
    context_url: `${advertisedBase}/providers/${encodeURIComponent(provider_id)}/context`,
  }));
  return { providers, close: () => closeServer(server) };
}

async function serveProviderFixture(
  req: IncomingMessage,
  res: ServerResponse,
  responses: Map<string, Record<string, unknown>>
): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
  const match = pathname.match(/^\/providers\/([^/]+)\/context$/);
  if (req.method !== 'POST' || !match) {
    respondJson(res, req.method === 'POST' ? 404 : 405, { error: 'not_found' });
    return;
  }
  try {
    await consumeBody(req, MAX_PROVIDER_REQUEST_BYTES);
  } catch {
    respondJson(res, 413, { error: 'request_too_large' });
    return;
  }
  const providerId = decodeURIComponent(match[1]!);
  const response = responses.get(providerId);
  if (!response) {
    respondJson(res, 404, { error: 'provider_not_found' });
    return;
  }
  respondJson(res, 200, response);
}

async function postRouterContext(
  options: TrustedMatchContextRouterRunnerOptions,
  request: Record<string, unknown>,
  parentSignal?: AbortSignal
): Promise<HttpProbeResult> {
  const routerUrl = `${options.router_url.replace(/\/$/, '')}/context`;
  const parsed = new URL(routerUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('trusted_match_context_router_runner.router_url must use http or https.');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  parentSignal?.addEventListener('abort', abort, { once: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('trusted_match_context_router_runner.timeoutMs must be a positive finite number.');
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`Context router replay timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    const response = await (options.fetchImpl ?? fetch)(routerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body = await readResponseBody(response, MAX_ROUTER_RESPONSE_BYTES);
    return {
      url: routerUrl,
      status: response.status,
      headers: responseHeaders(response.headers),
      body,
      ...(!response.ok && { error: `Context router returned HTTP ${response.status}.` }),
    };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

function assertHttpUrl(value: string, field: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`trusted_match_context_router_runner.${field} must use http or https.`);
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`Context router response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

function consumeBody(req: IncomingMessage, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let size = 0;
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) reject(new Error('request too large'));
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) });
  res.end(encoded);
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function failedProbe(url: string, error: string): HttpProbeResult {
  return { url, status: 0, headers: {}, body: null, error };
}

function responseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
