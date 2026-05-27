import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface MockScenarioControllerOptions {
  specialism: string;
  controlToken?: string;
  snapshot?: () => unknown;
  reset?: () => void | Promise<void>;
}

export interface MockScenarioScriptInput {
  match?: {
    method?: string;
    path?: string;
    path_regex?: string;
  };
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
  delay_ms?: number;
  times?: number;
}

export interface MockScenarioWebhookAttempt {
  webhook_id: string;
  url: string;
  payload: unknown;
  headers: Record<string, string>;
  status?: number;
  error?: string;
  emitted_at: string;
}

export interface MockScenarioHandle {
  controlToken: string;
  reset: () => Promise<void>;
  state: () => MockScenarioState;
  addScript: (script: MockScenarioScriptInput) => string;
  clearScripts: () => void;
}

export interface MockScenarioState {
  specialism: string;
  snapshot: unknown;
  scripts: Array<{
    script_id: string;
    match: Required<Pick<MockScenarioScript, 'method'>> & Pick<MockScenarioScript, 'path' | 'path_regex'>;
    remaining: number | null;
    created_at: string;
  }>;
  webhooks: MockScenarioWebhookAttempt[];
  idempotency: {
    entries: number;
  };
}

interface MockScenarioScript {
  script_id: string;
  method: string;
  path?: string;
  path_regex?: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  delay_ms: number;
  remaining: number | null;
  created_at: string;
}

export interface CachedIdempotentResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class MockIdempotencyReplayStore {
  private readonly entries = new Map<
    string,
    {
      fingerprint: string;
      response: CachedIdempotentResponse;
    }
  >();

  check(
    scope: string,
    idempotencyKey: string | undefined,
    fingerprint: string
  ):
    | { kind: 'disabled' }
    | { kind: 'fresh'; record: (response: CachedIdempotentResponse) => void }
    | { kind: 'replay'; response: CachedIdempotentResponse }
    | { kind: 'conflict'; response: CachedIdempotentResponse } {
    if (!idempotencyKey) return { kind: 'disabled' };
    const key = `${scope}::${idempotencyKey}`;
    const existing = this.entries.get(key);
    if (!existing) {
      return {
        kind: 'fresh',
        record: response => {
          this.entries.set(key, { fingerprint, response });
        },
      };
    }
    if (existing.fingerprint !== fingerprint) {
      return {
        kind: 'conflict',
        response: {
          status: 409,
          body: {
            code: 'idempotency_conflict',
            message: `idempotency_key ${idempotencyKey} was previously used with a different body. Use a fresh key for distinct requests.`,
            field: 'idempotency_key',
          },
        },
      };
    }
    return { kind: 'replay', response: existing.response };
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

export function createMockScenarioController(options: MockScenarioControllerOptions): {
  handle: MockScenarioHandle;
  idempotency: MockIdempotencyReplayStore;
  handleControlRequest: (req: IncomingMessage, res: ServerResponse, method: string, path: string) => Promise<boolean>;
  handleScriptedResponse: (
    res: ServerResponse,
    method: string,
    path: string,
    onMatch?: (method: string, path: string) => void
  ) => Promise<boolean>;
} {
  const scripts: MockScenarioScript[] = [];
  const webhooks: MockScenarioWebhookAttempt[] = [];
  const idempotency = new MockIdempotencyReplayStore();
  const controlToken = options.controlToken ?? `ctrl_${randomUUID().replace(/-/g, '')}`;

  const handle: MockScenarioHandle = {
    controlToken,
    reset,
    state,
    addScript,
    clearScripts: () => {
      scripts.length = 0;
    },
  };

  async function reset(): Promise<void> {
    scripts.length = 0;
    webhooks.length = 0;
    idempotency.clear();
    await options.reset?.();
  }

  function state(): MockScenarioState {
    return {
      specialism: options.specialism,
      snapshot: options.snapshot?.() ?? {},
      scripts: scripts.map(script => ({
        script_id: script.script_id,
        match: {
          method: script.method,
          ...(script.path !== undefined && { path: script.path }),
          ...(script.path_regex !== undefined && { path_regex: script.path_regex }),
        },
        remaining: script.remaining,
        created_at: script.created_at,
      })),
      webhooks: webhooks.slice(),
      idempotency: {
        entries: idempotency.size(),
      },
    };
  }

  function addScript(input: MockScenarioScriptInput): string {
    const method = input.match?.method?.toUpperCase() ?? '*';
    const path = input.match?.path;
    const pathRegex = input.match?.path_regex;
    if (path && pathRegex) {
      throw new Error('scenario script match must use either path or path_regex, not both.');
    }
    if (!path && !pathRegex) {
      throw new Error('scenario script match requires path or path_regex.');
    }
    if (pathRegex !== undefined) {
      try {
        new RegExp(pathRegex);
      } catch {
        throw new Error('scenario script match.path_regex must be a valid regular expression.');
      }
    }
    const times = input.times === undefined ? 1 : input.times;
    if (!Number.isInteger(times) || times < 1) {
      throw new Error('scenario script times must be a positive integer.');
    }
    const status = input.response?.status ?? 500;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error('scenario script response.status must be an HTTP status code.');
    }
    const delayMs = input.delay_ms ?? 0;
    if (!Number.isInteger(delayMs) || delayMs < 0) {
      throw new Error('scenario script delay_ms must be a non-negative integer.');
    }
    const id = `script_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    scripts.push({
      script_id: id,
      method,
      ...(path !== undefined && { path }),
      ...(pathRegex !== undefined && { path_regex: pathRegex }),
      status,
      headers: input.response?.headers ?? {},
      body: input.response?.body ?? {
        code: 'scripted_response',
        message: `Scripted response from ${options.specialism} mock scenario controller.`,
      },
      delay_ms: delayMs,
      remaining: times,
      created_at: new Date().toISOString(),
    });
    return id;
  }

  async function emitWebhook(
    url: string,
    payload: unknown,
    headers: Record<string, string> = {}
  ): Promise<MockScenarioWebhookAttempt> {
    const target = validateWebhookTarget(url);
    const attempt: MockScenarioWebhookAttempt = {
      webhook_id: `wh_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      url: target.toString(),
      payload,
      headers: filterWebhookHeaders(headers),
      emitted_at: new Date().toISOString(),
    };
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...attempt.headers,
        },
        body: JSON.stringify(payload),
      });
      attempt.status = response.status;
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : String(err);
    }
    webhooks.push(attempt);
    return attempt;
  }

  async function handleControlRequest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string
  ): Promise<boolean> {
    if (!path.startsWith('/_scenario')) return false;
    if (!authorizeScenario(req, controlToken)) {
      writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
      return true;
    }

    if (method === 'GET' && path === '/_scenario/state') {
      writeJson(res, 200, state());
      return true;
    }

    if (method === 'POST' && path === '/_scenario/reset') {
      await reset();
      writeJson(res, 200, { reset: true, state: state() });
      return true;
    }

    if (method === 'GET' && path === '/_scenario/scripts') {
      writeJson(res, 200, { scripts: state().scripts });
      return true;
    }

    if (method === 'DELETE' && path === '/_scenario/scripts') {
      scripts.length = 0;
      writeJson(res, 200, { cleared: true });
      return true;
    }

    if (method === 'POST' && path === '/_scenario/script') {
      const body = await readJsonObject(req, res);
      if (!body) return true;
      try {
        const script_id = addScript(body as MockScenarioScriptInput);
        writeJson(res, 201, { script_id });
      } catch (err) {
        writeJson(res, 400, {
          code: 'invalid_scenario_script',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    if (method === 'GET' && path === '/_scenario/webhooks') {
      writeJson(res, 200, { webhooks: webhooks.slice() });
      return true;
    }

    if (method === 'POST' && path === '/_scenario/webhooks/emit') {
      const body = await readJsonObject(req, res);
      if (!body) return true;
      const url = body.url;
      if (typeof url !== 'string' || url.length === 0) {
        writeJson(res, 400, { code: 'invalid_request', message: 'url is required.' });
        return true;
      }
      const headers = isRecord(body.headers) ? stringRecord(body.headers) : {};
      try {
        const attempt = await emitWebhook(url, body.payload ?? {}, headers);
        writeJson(res, 200, attempt);
      } catch (err) {
        writeJson(res, 400, {
          code: 'invalid_webhook_target',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    writeJson(res, 404, { code: 'not_found', message: `No scenario route for ${method} ${path}` });
    return true;
  }

  async function handleScriptedResponse(
    res: ServerResponse,
    method: string,
    path: string,
    onMatch?: (method: string, path: string) => void
  ): Promise<boolean> {
    const script = scripts.find(candidate => scriptMatches(candidate, method, path));
    if (!script) return false;
    onMatch?.(method.toUpperCase(), path);
    if (script.remaining !== null) {
      script.remaining -= 1;
      if (script.remaining <= 0) {
        const idx = scripts.indexOf(script);
        if (idx >= 0) scripts.splice(idx, 1);
      }
    }
    if (script.delay_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, script.delay_ms));
    }
    writeScriptedResponse(res, script);
    return true;
  }

  return { handle, idempotency, handleControlRequest, handleScriptedResponse };
}

export function idempotencyKeyFromBody(body: Record<string, unknown>): string | undefined {
  if (typeof body.idempotency_key === 'string' && body.idempotency_key.length > 0) return body.idempotency_key;
  return undefined;
}

export function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function writeCachedResponse(res: ServerResponse, cached: CachedIdempotentResponse): void {
  writeJson(res, cached.status, cached.body, cached.headers);
}

function scriptMatches(script: MockScenarioScript, method: string, path: string): boolean {
  if (script.method !== '*' && script.method !== method.toUpperCase()) return false;
  if (script.path !== undefined) return script.path === path;
  if (script.path_regex !== undefined) return new RegExp(script.path_regex).test(path);
  return false;
}

function writeScriptedResponse(res: ServerResponse, script: MockScenarioScript): void {
  writeJson(res, script.status, script.body, script.headers);
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  if (status === 204 || body === undefined) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.setHeader('content-type', headers['content-type'] ?? 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(payload));
  res.end(payload);
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      writeJson(res, 400, { code: 'invalid_request', message: 'request body must be a JSON object.' });
      return null;
    }
    return parsed;
  } catch {
    writeJson(res, 400, { code: 'invalid_json', message: 'Request body must be valid JSON.' });
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

function authorizeScenario(req: IncomingMessage, controlToken: string): boolean {
  const raw = req.headers['x-mock-control-token'];
  const got = Array.isArray(raw) ? raw[0] : raw;
  if (typeof got !== 'string') return false;
  const gotBuffer = Buffer.from(got);
  const expectedBuffer = Buffer.from(controlToken);
  return gotBuffer.length === expectedBuffer.length && timingSafeEqual(gotBuffer, expectedBuffer);
}

function validateWebhookTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('webhook target must be a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('webhook target must use http or https.');
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== '::1' && url.hostname !== 'localhost') {
    throw new Error('webhook target must be loopback.');
  }
  return url;
}

function filterWebhookHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower === 'host') continue;
    if (lower === 'content-type' || lower.startsWith('x-')) out[name] = value;
  }
  return out;
}
