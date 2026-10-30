import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sharedLegacyJsonSchemaValidator } from '../../protocols/mcp-schema-validator';
import { createAgentTransportFetch } from '../../net';
import { terminateSessionBestEffort } from '../../protocols/session-termination';
import { getSchemaValidatorByRef } from '../../validation/schema-loader';
import { SECRET_KEY_PATTERN } from '../../utils/redact-secrets';
import { globalAsyncLocalStorage } from '../../utils/global-async-local-storage';
import { ADCP_VERSION } from '../../version';
import { resolvePath } from './path';
import type { StoryboardValidation, ValidationResult, RunnerRequestRecord, RunnerResponseRecord } from './types';

// Keep live credentials available for the probe, then scrub the ENTIRE report,
// including schema diagnostics, context captures, and agent-controlled strings.
const credentials = globalAsyncLocalStorage<Set<string>>('property-list-reference-credentials');
const REPORT_SECRET_PATTERN = new RegExp(`${SECRET_KEY_PATTERN.source}|^auth[_-]token$`, 'i');

export function rememberPropertyListCredentials(data: unknown, paths: readonly string[] = []): void {
  const values = credentials.getStore();
  if (!values) return;
  const object = record(data);
  for (const path of ['auth_token', ...paths]) {
    const value = resolvePath(object, path);
    if (typeof value === 'string' && value.length > 0) values.add(value);
  }
}

export function redactPropertyListCredentials<T>(value: T): T {
  const secrets = [...(credentials.getStore() ?? [])].sort((a, b) => b.length - a.length);
  if (!secrets.length) return value;
  const spellings = [...new Set(secrets.flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]))].sort(
    (a, b) => b.length - a.length
  );
  const text = (s: string) => spellings.reduce((out, secret) => out.split(secret).join('[redacted]'), s);
  // These fields are authored runner metadata, never issuer-controlled strings.
  // An issuer choosing a token like "mcp" or a step ID must not rename checks,
  // transports, step IDs, or rollup keys in its own conformance report.
  const metadata = new Set([
    'check',
    'step_id',
    'phase_id',
    'storyboard_id',
    'task',
    'operation',
    'transport',
    'skip_reason',
    'reason',
    'requirement',
  ]);
  const walk = (entry: unknown, depth: number, raw = false, field = ''): unknown => {
    if (depth > 64) return '[redacted: depth limit]';
    if (typeof entry === 'string') return !raw && metadata.has(field) ? entry : text(entry);
    if (Array.isArray(entry)) return entry.map(item => walk(item, depth + 1, raw));
    if (entry && typeof entry === 'object') {
      const out = Object.fromEntries(
        Object.entries(entry).map(([key, item]) => {
          const rawChild =
            raw ||
            ['payload', 'body', 'context', 'headers', 'actual', 'expected', 'adcp_error'].includes(key) ||
            (key === 'response' &&
              ('step_id' in record(entry) || !('transport' in record(item) && 'payload' in record(item))));
          return [
            raw ? text(key) : key,
            raw && REPORT_SECRET_PATTERN.test(key) && (typeof item === 'string' || typeof item === 'number')
              ? '[redacted]'
              : walk(item, depth + 1, rawChild, key),
          ];
        })
      );
      // Context's private UUID alias cache is needed by step-by-step callers.
      for (const symbol of Object.getOwnPropertySymbols(entry))
        Object.defineProperty(out, symbol, Object.getOwnPropertyDescriptor(entry, symbol)!);
      return out;
    }
    return entry;
  };
  return walk(value, 0) as T;
}

export async function withPropertyListCredentialRedaction<T>(run: () => Promise<T>): Promise<T> {
  return credentials.run(new Set(), async () => {
    try {
      return redactPropertyListCredentials(await run());
    } catch (error) {
      if (!credentials.getStore()!.size) throw error;
      if (!(error instanceof Error)) throw redactPropertyListCredentials(error);
      const details = redactPropertyListCredentials({
        ...error,
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      });
      const clean = new Error(details.message, { cause: details.cause });
      Object.assign(clean, details);
      clean.name = redactPropertyListCredentials(error.name);
      throw clean;
    }
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toolPayload(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (result.structuredContent !== undefined) return record(result.structuredContent);
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.filter(item => record(item).type === 'text');
  if (texts.length !== 1 || typeof record(texts[0]).text !== 'string') return {};
  try {
    return record(JSON.parse(record(texts[0]).text as string));
  } catch {
    return {};
  }
}

const AUTH_DENIALS = new Set([
  'AUTH_REQUIRED',
  'AUTH_MISSING',
  'AUTH_INVALID',
  'PERMISSION_DENIED',
  'SCOPE_INSUFFICIENT',
  'READ_ONLY_SCOPE',
]);

function containsListPayload(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some(item => containsListPayload(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  const object = record(value);
  if ('list' in object || 'identifiers' in object || object.status === 'completed' || object.success === true)
    return true;
  return Object.values(object).some(item => containsListPayload(item, depth + 1));
}

interface WireResponseEvidence {
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  /** SSE is parsed by the official client; its logical result is recorded instead. */
  body?: string;
}

/** A successful payload or an unrelated error can never prove credential scoping. */
function isScopeDenial(raw: unknown, crossList: boolean, version: string): boolean {
  const payloads: Record<string, unknown>[] = [];
  if (record(raw).structuredContent !== undefined) payloads.push(record(record(raw).structuredContent));
  const content = Array.isArray(record(raw).content) ? (record(raw).content as unknown[]) : [];
  for (const block of content) {
    if (record(block).type !== 'text' || typeof record(block).text !== 'string') return false;
    try {
      payloads.push(record(JSON.parse(record(block).text as string)));
    } catch {
      if (record(raw).structuredContent === undefined) return false;
    }
  }
  return payloads.length > 0 && payloads.every(payload => isDenialPayload(payload, crossList, version));
}

function isDenialPayload(payload: Record<string, unknown>, crossList: boolean, version: string): boolean {
  if (containsListPayload(payload) || 'result' in payload || 'payload' in payload) return false;
  if (payload.status !== undefined && payload.status !== 'failed' && payload.status !== 'rejected') return false;
  const envelope = getSchemaValidatorByRef('core/protocol-envelope.json', version);
  if (!envelope || !envelope(payload)) return false;
  if (payload.errors !== undefined && !Array.isArray(payload.errors)) return false;
  const errors = [
    ...(Array.isArray(payload.errors) ? payload.errors : []),
    ...(payload.adcp_error ? [payload.adcp_error] : []),
  ];
  const validate = getSchemaValidatorByRef('core/error.json', version);
  return (
    errors.length > 0 &&
    !!validate &&
    errors.every(error => {
      const code = record(error).code;
      return (
        validate(error) &&
        record(error).severity !== 'warning' &&
        typeof code === 'string' &&
        (AUTH_DENIALS.has(code) || (crossList && code === 'REFERENCE_NOT_FOUND'))
      );
    })
  );
}

function isHttpScopeDenial(capture: WireResponseEvidence, crossList: boolean, version: string): boolean {
  if (capture.status !== 401 && capture.status !== 403) return false;
  if (capture.headers['content-type']?.includes('text/event-stream')) return false;
  if (!capture.body?.trim()) return true;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(capture.body);
    if (Array.isArray(parsed) || containsListPayload(parsed)) return false;
    body = record(parsed);
  } catch {
    return true;
  }
  if (containsListPayload(body) || 'result' in body || 'payload' in body) return false;
  if ('errors' in body || 'adcp_error' in body || 'status' in body)
    return isScopeDenial({ isError: true, structuredContent: body }, crossList, version);
  if ('error' in body) return ['invalid_token', 'insufficient_scope', 'invalid_client'].includes(String(body.error));
  if ('code' in body)
    return isScopeDenial(
      { isError: true, structuredContent: { status: 'failed', adcp_error: body } },
      crossList,
      version
    );
  return true;
}

interface ProbeOptions {
  agentUrl: string;
  version?: string;
  signal?: AbortSignal;
  allowHttp?: boolean;
  /** Scrub suite credentials if an issuer reflects them; never forward them. */
  redactValues?: readonly string[];
}

/** Implements adcp#8289's property_list_reference_check using the official MCP client. */
export async function verifyPropertyListReference(
  validation: StoryboardValidation,
  creation: unknown,
  options: ProbeOptions
): Promise<ValidationResult> {
  if (!credentials.getStore())
    return withPropertyListCredentialRedaction(() => verifyPropertyListReference(validation, creation, options));
  const observations: unknown[] = [];
  let pointer: string | null = null;
  let schemaRef: string | undefined;
  let expectedResult: unknown = 'complete token-only resolution and two authorization denials';
  let actualResult: unknown = null;
  const version = options.version ?? ADCP_VERSION;
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const requireSchema = (ref: string, value: unknown): void => {
    schemaRef = ref;
    const validate = getSchemaValidatorByRef(ref, version);
    if (!validate) fail(`Required probe schema is unavailable: ${ref}`);
    if (!validate!(value)) {
      expectedResult = { schema_ref: ref };
      actualResult = { issues: validate!.errors };
      pointer = validate!.errors?.[0]?.instancePath ?? null;
      fail(`Probe payload fails ${ref}: ${validate!.errors?.[0]?.message ?? 'schema violation'}`);
    }
    schemaRef = undefined;
    pointer = null;
  };
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  let terminate: (() => Promise<void>) | undefined;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  try {
    for (const secret of options.redactValues ?? []) if (secret) credentials.getStore()!.add(secret);
    rememberPropertyListCredentials(creation, validation.auth_token_path ? [validation.auth_token_path] : []);
    const listId = resolvePath(creation, validation.list_id_path ?? 'list.list_id');
    const token = resolvePath(creation, validation.auth_token_path ?? 'auth_token');
    if (typeof listId !== 'string' || !listId.trim())
      fail(`Issued list ID is missing at ${validation.list_id_path ?? 'list.list_id'}.`);
    if (typeof token !== 'string' || !token.trim())
      fail(`Issued reference credential is missing at ${validation.auth_token_path ?? 'auth_token'}.`);
    const deniedId = validation.denied_list_id;
    if (
      typeof deniedId !== 'string' ||
      !deniedId.trim() ||
      deniedId === listId ||
      deniedId.includes('$context.') ||
      deniedId.includes('{{')
    )
      fail('An existing, distinct control list ID is required.');
    const pageSize = validation.page_size;
    const maxPages = validation.max_pages;
    if (!Number.isInteger(pageSize) || pageSize! < 1 || pageSize! > 10_000)
      fail('page_size must be an integer in [1, 10000].');
    if (!Number.isInteger(maxPages) || maxPages! < 1 || maxPages! > 100)
      fail('max_pages must be an integer in [1, 100].');
    if (!Array.isArray(validation.expected_identifiers)) fail('expected_identifiers is required.');
    const expected = validation.expected_identifiers!;
    for (const identifier of expected) requireSchema('core/identifier.json', identifier);
    const key = (identifier: unknown) => JSON.stringify([record(identifier).type, record(identifier).value]);
    const expectedSet = new Set(expected.map(key));
    if (expectedSet.size !== expected.length) fail('expected_identifiers contains duplicates.');

    const endpoint = new URL(
      validation.agent_url === '$agent_url' || !validation.agent_url ? options.agentUrl : validation.agent_url
    );
    if (endpoint.href !== new URL(options.agentUrl).href)
      fail('The probe endpoint must match the agent that issued the reference.');
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      fail('The isolated endpoint must not contain URL credentials, query parameters, or a fragment.');
    if (endpoint.protocol !== 'https:' && !(options.allowHttp && endpoint.protocol === 'http:'))
      fail('The isolated endpoint requires HTTPS (or allow_http for local tests).');
    const network = createAgentTransportFetch(endpoint.href, {
      allowPrivateIp: options.allowHttp === true,
      allowPrivateInitialOrigin: false,
    });
    let bytes = 0;
    let exchanges = 0;
    let issuedSessionId: string | undefined;
    const wireCaptures: WireResponseEvidence[] = [];
    // The SDK owns protocol parsing. This boundary only enforces isolation,
    // redirect refusal, cancellation, and a bounded response stream.
    const isolatedFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body === 'string') {
        const outgoing = record(JSON.parse(init.body));
        if (outgoing.method === 'initialize') Object.assign(request, record(outgoing.params));
      }
      if (++exchanges > maxPages! + 16) fail('Probe exceeded its transport request budget.');
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.href !== endpoint.href) fail('MCP attempted to leave the managing endpoint.');
      const response = await network(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        redirect: 'error',
        credentials: 'omit',
      });
      issuedSessionId = response.headers.get('mcp-session-id') ?? issuedSessionId;
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const capture: WireResponseEvidence = {
        url: url.href,
        method: init?.method ?? 'GET',
        status: response.status,
        headers: responseHeaders,
      };
      wireCaptures.push(capture);
      if (!response.body) return response;
      let responseBytes = 0;
      const bounded = new Response(
        response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              responseBytes += chunk.byteLength;
              if (bytes > 4 * 1024 * 1024 || responseBytes > 1024 * 1024)
                throw new Error('Probe response byte budget exceeded.');
              controller.enqueue(chunk);
            },
          })
        ),
        { status: response.status, statusText: response.statusText, headers: response.headers }
      );
      // Never eagerly consume SSE: a valid result can arrive while its POST
      // stream stays open. The official client parses it without waiting for EOF.
      if (!response.headers.get('content-type')?.includes('text/event-stream'))
        capture.body = await bounded.clone().text();
      return bounded;
    };
    // Deliberately construct from scratch. No owner client, account, headers,
    // cookies, OAuth provider, signing key, or client certificate is inherited.
    client = new Client(
      { name: 'adcp-property-list-reference-probe', version: '1.0.0' },
      { capabilities: {}, jsonSchemaValidator: sharedLegacyJsonSchemaValidator }
    );
    transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', redirect: 'error', signal },
      fetch: isolatedFetch,
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    terminate = async () => {
      if (!issuedSessionId) return;
      const terminator = new StreamableHTTPClientTransport(endpoint, {
        sessionId: issuedSessionId,
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(1000),
        },
        fetch: (input, init) =>
          network(input, { ...init, signal: AbortSignal.timeout(1000), redirect: 'error', credentials: 'omit' }),
      });
      try {
        await terminateSessionBestEffort(terminator);
      } finally {
        await terminator.close().catch(() => {});
      }
    };
    const rpcOptions = { signal, timeout: 30_000 };
    let operation = 'initialize';
    let request: Record<string, unknown> = {};
    const observe = async <T>(invoke: () => Promise<T>): Promise<T> => {
      const requestRecord = {
        transport: 'mcp',
        operation,
        url: endpoint.href,
        headers: { authorization: '[redacted]' },
        payload: request,
      };
      const started = Date.now();
      const captureStart = wireCaptures.length;
      try {
        const result = await invoke();
        observations.push({
          request: requestRecord,
          response: { transport: 'mcp', payload: result, duration_ms: Date.now() - started },
          wire_responses: wireCaptures.slice(captureStart),
        });
        return result;
      } catch (error) {
        observations.push({
          request: requestRecord,
          response: {
            transport: 'mcp',
            payload: null,
            ...(error instanceof StreamableHTTPError && { status: error.code }),
            duration_ms: Date.now() - started,
          },
          wire_responses: wireCaptures.slice(captureStart),
          error: error instanceof Error ? error.message : 'Transport failure',
        });
        throw error;
      }
    };
    await observe(async () => {
      await client!.connect(transport!, rpcOptions);
      return { serverInfo: client!.getServerVersion(), capabilities: client!.getServerCapabilities() };
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      operation = name;
      request = args;
      requireSchema(`property/${name.replaceAll('_', '-')}-request.json`, args);
      return observe(() => client!.callTool({ name, arguments: args }, undefined, rpcOptions));
    };
    const identifiers = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      if (++pages > maxPages!) fail('Pagination exceeded max_pages.');
      const raw = await call('get_property_list', {
        list_id: listId,
        resolve: true,
        pagination: { max_results: pageSize, ...(cursor && { cursor }) },
      });
      if (record(raw).isError === true) {
        actualResult = toolPayload(raw);
        fail(`Page ${pages}: get_property_list was rejected; the issued Bearer must work without an account argument.`);
      }
      const payload = toolPayload(raw);
      requireSchema('property/get-property-list-response.json', payload);
      if ((payload.status !== undefined && payload.status !== 'completed') || payload.adcp_error)
        fail(`Page ${pages}: list resolution did not complete successfully.`);
      pointer = '/list/list_id';
      if (record(payload.list).list_id !== listId) fail(`Page ${pages}: returned another list.`);
      pointer = '/identifiers';
      if (!Array.isArray(payload.identifiers) || payload.identifiers.length > pageSize!)
        fail(`Page ${pages}: missing identifiers or page exceeds page_size.`);
      for (const identifier of payload.identifiers as unknown[]) {
        const id = key(identifier);
        if (identifiers.has(id)) fail(`Page ${pages}: duplicate identifier.`);
        identifiers.add(id);
      }
      pointer = '/pagination';
      const pagination = record(payload.pagination);
      if (payload.pagination === undefined && pages === 1 && expected.length <= pageSize!) break;
      if (typeof pagination.has_more !== 'boolean') fail(`Page ${pages}: pagination.has_more is required.`);
      if (pagination.has_more === false) {
        if (pagination.cursor !== undefined) fail(`Page ${pages}: terminal page carries a continuation cursor.`);
        break;
      }
      if (typeof pagination.cursor !== 'string' || !pagination.cursor || cursors.has(pagination.cursor))
        fail(`Page ${pages}: missing or repeated continuation cursor.`);
      cursors.add(pagination.cursor as string);
      cursor = pagination.cursor as string;
    }
    pointer = '/identifiers';
    expectedResult = expected;
    actualResult = {
      missing: expected.filter(identifier => !identifiers.has(key(identifier))),
      unexpected: [...identifiers].filter(id => !expectedSet.has(id)).map(id => JSON.parse(id)),
    };
    if (expected.length > pageSize! && pages < 2) fail('The fixture requires multiple pages.');
    if (identifiers.size !== expectedSet.size || [...expectedSet].some(id => !identifiers.has(id)))
      fail('The complete snapshot does not equal expected_identifiers.');
    const denial = async (name: string, args: Record<string, unknown>, crossList: boolean): Promise<void> => {
      pointer = null;
      expectedResult = { authorization: 'denied', operation: name };
      let denied = false;
      const denialStart = wireCaptures.length;
      try {
        const raw = await call(name, args);
        actualResult = toolPayload(raw);
        const serialized = JSON.stringify(raw);
        denied =
          !expected.some(identifier => serialized.includes(identifier.value)) && isScopeDenial(raw, crossList, version);
      } catch (error) {
        actualResult = {
          error: error instanceof Error ? error.message : 'Transport failure',
          ...(error instanceof StreamableHTTPError && { status: error.code }),
        };
        denied = error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403);
        const captures = wireCaptures.slice(denialStart).filter(capture => capture.method.toUpperCase() === 'POST');
        // Only actual HTTP authentication denials or canonical tool errors
        // qualify. JSON-RPC method/params/internal errors never establish scope.
        denied =
          denied &&
          captures.length > 0 &&
          captures.every(
            capture =>
              isHttpScopeDenial(capture, crossList, version) &&
              !expected.some(identifier => capture.body?.includes(identifier.value))
          );
      }
      if (!denied)
        fail(
          `${crossList ? 'Cross-list read' : 'Mutation'}: authorization denial was not established (${JSON.stringify(actualResult).slice(0, 512)}).`
        );
      observations.push({ probe: crossList ? 'cross_list' : 'mutation', authorization: 'denied' });
    };
    await denial(
      'get_property_list',
      { list_id: deniedId, resolve: true, pagination: { max_results: pageSize } },
      true
    );
    await denial(
      'update_property_list',
      { list_id: listId, name: `Credential isolation probe ${randomUUID()}`, idempotency_key: randomUUID() },
      false
    );
    observations.push({
      agent_url: endpoint.href,
      list_id: listId,
      page_count: pages,
      identifier_count: identifiers.size,
    });
    return redactPropertyListCredentials({
      check: validation.check,
      passed: true,
      description: validation.description,
      observations,
    });
  } catch (error) {
    const last = observations
      .slice()
      .reverse()
      .find(observation => record(observation).request) as
      | { request: RunnerRequestRecord; response: RunnerResponseRecord }
      | undefined;
    return redactPropertyListCredentials({
      check: validation.check,
      passed: false,
      description: validation.description,
      error: error instanceof Error ? error.message : 'Reference probe failed.',
      json_pointer: pointer,
      schema_id: null,
      schema_url: null,
      expected: schemaRef ? { schema_ref: schemaRef } : expectedResult,
      actual: actualResult ?? last?.response.payload ?? null,
      ...(last && { request: last.request, response: last.response }),
      observations,
    });
  } finally {
    if (client) await client.close().catch(() => {});
    if (terminate) await terminate();
  }
}
