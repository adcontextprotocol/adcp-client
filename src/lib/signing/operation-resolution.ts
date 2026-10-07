/**
 * Transport-neutral resolution of the AdCP operation a request carries, for
 * `request_signing.required_for` / `supported_for` / `warn_for` lookups
 * (adcp#7945, "Operation resolution over A2A").
 *
 * | Request                                                        | Resolved operation              |
 * |----------------------------------------------------------------|---------------------------------|
 * | MCP JSON-RPC `tools/call`                                      | `params.name`                   |
 * | A2A `SendMessage` / `SendStreamingMessage` / `message/send` / `message/stream` (and the HTTP+JSON `…/message:send` / `…/message:stream` paths) | the `skill` of the Message's sole DataPart |
 * | any other JSON-RPC method                                      | none (`undefined`)              |
 *
 * A request that does not resolve to exactly one operation yields
 * {@link UNRESOLVABLE_OPERATION}. Callers MUST treat that as a rejection
 * (`request_body_malformed`) and never as "an operation that is not in
 * `required_for`" — a parse ambiguity that fell through to "no operation"
 * would be a signature bypass.
 *
 * The parse is strict on purpose, and runs on unsigned bodies too: duplicate
 * object keys (compared after JSON string decoding), case variants of
 * recognized member names, JSON-RPC batches, FileParts, Parts with more than
 * one content member, and a `kind` that disagrees with the member present are
 * all unresolvable. Each is a place where two parsers could pick different
 * operations from the same bytes.
 */
import { parseStrictJson, StrictJsonError } from './agent-resolver/strict-json';

/**
 * Distinguished "this body does not resolve to exactly one operation" result.
 * A `Symbol.for` key so it survives duplicate copies of the SDK in one process.
 */
export const UNRESOLVABLE_OPERATION: unique symbol = Symbol.for('@adcp/client.signing.unresolvableOperation');

export type UnresolvableOperation = typeof UNRESOLVABLE_OPERATION;

/** What a `resolveOperation` callback may return. */
export type ResolvedOperation = string | undefined | UnresolvableOperation;

export function isUnresolvableOperation(value: unknown): value is UnresolvableOperation {
  return value === UNRESOLVABLE_OPERATION;
}

/** JSON-RPC methods that carry an A2A Message and therefore an invocation DataPart. */
export const A2A_MESSAGE_METHODS: ReadonlySet<string> = new Set([
  'SendMessage',
  'SendStreamingMessage',
  'message/send',
  'message/stream',
]);

export interface OperationResolutionInput {
  /** The exact request body bytes, decoded as UTF-8. */
  rawBody?: string | Buffer;
  /** HTTP method. When present and not `POST`, the request carries no operation. */
  method?: string;
  /** Request URL (path may be relative). Selects the A2A HTTP+JSON binding. */
  url?: string;
}

export type OperationResolution =
  | { kind: 'operation'; operation: string }
  | { kind: 'none' }
  | { kind: 'unresolvable'; reason: string };

const CONTENT_MEMBERS = ['text', 'data', 'raw', 'url', 'file'] as const;
const FILE_MEMBERS: ReadonlySet<string> = new Set(['raw', 'url', 'file']);
const HTTP_JSON_MESSAGE_PATH = /(?:^|\/)message:(?:send|stream)$/;

const ENVELOPE_MEMBERS = ['method', 'params'] as const;
const TOOLS_CALL_PARAMS_MEMBERS = ['name'] as const;
const CARRIER_MEMBERS = ['message'] as const;
const MESSAGE_MEMBERS = ['parts', 'taskId'] as const;
const PART_MEMBERS = [...CONTENT_MEMBERS, 'kind'] as const;
const DATA_MEMBERS = ['skill'] as const;

/**
 * Resolve the operation a request carries, with a diagnostic reason when it
 * cannot be resolved. Pure and synchronous; never throws.
 */
export function resolveRequestOperationDetailed(input: OperationResolutionInput): OperationResolution {
  if (input.method !== undefined && input.method.toUpperCase() !== 'POST') return { kind: 'none' };

  const raw = typeof input.rawBody === 'string' ? input.rawBody : input.rawBody?.toString('utf8');
  if (raw === undefined || raw.trim() === '') return unresolvable('request body is empty');
  // `JSON.parse` rejects a BOM and the strict parser strips it; refuse the ambiguity.
  if (raw.charCodeAt(0) === 0xfeff) return unresolvable('body starts with a byte order mark');

  let body: unknown;
  try {
    body = parseStrictJson(raw);
  } catch (err) {
    return unresolvable(err instanceof StrictJsonError ? `body is not strict JSON (${err.code})` : 'body is not JSON');
  }
  if (!isPlainObject(body)) {
    return unresolvable(Array.isArray(body) ? 'JSON-RPC batches are not supported' : 'body is not a JSON object');
  }

  if (isHttpJsonMessagePath(input.url)) {
    // A2A HTTP+JSON binding: no JSON-RPC envelope, the body is the request.
    return resolveMessageCarrier(body);
  }

  if (hasCaseVariantMember(body, ENVELOPE_MEMBERS)) return unresolvable('case variant of an envelope member');
  const method = body.method;
  if (method === undefined && isJsonRpcResponse(body)) {
    // A client's reply to a server-initiated request (MCP sampling, elicitation)
    // is a POST with no `method`. It dispatches no operation.
    return { kind: 'none' };
  }
  if (typeof method !== 'string') return unresolvable('JSON-RPC request has no string method');

  if (method === 'tools/call') {
    const params = body.params;
    if (!isPlainObject(params)) return unresolvable('tools/call params is not an object');
    if (hasCaseVariantMember(params, TOOLS_CALL_PARAMS_MEMBERS)) return unresolvable('case variant of a params member');
    const name = params.name;
    if (typeof name !== 'string' || name.length === 0) return unresolvable('tools/call params.name is not a string');
    return { kind: 'operation', operation: name };
  }

  if (A2A_MESSAGE_METHODS.has(method)) {
    const params = body.params;
    if (!isPlainObject(params)) return unresolvable('message method params is not an object');
    return resolveMessageCarrier(params);
  }

  // `tasks/*`, `CancelTask`, `initialize`, notifications, … — no AdCP
  // operation. These match `protocol_methods_*` only.
  return { kind: 'none' };
}

/** {@link resolveRequestOperationDetailed} collapsed to the `resolveOperation` return shape. */
export function resolveRequestOperation(input: OperationResolutionInput): ResolvedOperation {
  const resolution = resolveRequestOperationDetailed(input);
  if (resolution.kind === 'operation') return resolution.operation;
  return resolution.kind === 'none' ? undefined : UNRESOLVABLE_OPERATION;
}

/** Diagnostic reason for an unresolvable body. Server-side logs only. */
export function describeUnresolvable(input: OperationResolutionInput): string | undefined {
  const resolution = resolveRequestOperationDetailed(input);
  return resolution.kind === 'unresolvable' ? resolution.reason : undefined;
}

function resolveMessageCarrier(container: Record<string, unknown>): OperationResolution {
  if (hasCaseVariantMember(container, CARRIER_MEMBERS)) return unresolvable('case variant of the message member');
  const message = container.message;
  if (!isPlainObject(message)) return unresolvable('request carries no message object');
  if (hasCaseVariantMember(message, MESSAGE_MEMBERS)) return unresolvable('case variant of a message member');
  const parts = message.parts;
  if (!Array.isArray(parts)) return unresolvable('message.parts is not an array');

  let invocation: Record<string, unknown> | undefined;
  for (const part of parts) {
    if (!isPlainObject(part)) return unresolvable('a Part is not an object');
    if (hasCaseVariantMember(part, PART_MEMBERS)) return unresolvable('case variant of a Part member');
    const present = CONTENT_MEMBERS.filter(member => Object.prototype.hasOwnProperty.call(part, member));
    if (present.length !== 1) return unresolvable('a Part must carry exactly one content member');
    const member = present[0]!;
    if (FILE_MEMBERS.has(member)) return unresolvable('FileParts are not allowed on an AdCP invocation');
    const kind = part.kind;
    if (kind !== undefined && kind !== member) return unresolvable('a Part kind disagrees with its content member');
    if (member === 'data') {
      if (invocation !== undefined) return unresolvable('message carries more than one DataPart');
      if (!isPlainObject(part.data)) return unresolvable('DataPart data is not an object');
      invocation = part.data;
    }
  }
  if (invocation === undefined) return unresolvable('message carries no DataPart');
  if (hasCaseVariantMember(invocation, DATA_MEMBERS)) return unresolvable('case variant of skill');
  const skill = invocation.skill;
  if (typeof skill !== 'string' || skill.length === 0) return unresolvable('DataPart skill is not a non-empty string');
  return { kind: 'operation', operation: skill };
}

/** A JSON-RPC response object: `result` or `error`, and nothing a dispatcher would read as a request. */
function isJsonRpcResponse(body: Record<string, unknown>): boolean {
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);
  return (has('result') || has('error')) && !has('params');
}

function unresolvable(reason: string): OperationResolution {
  return { kind: 'unresolvable', reason };
}

function isHttpJsonMessagePath(url: string | undefined): boolean {
  if (!url) return false;
  const queryStart = url.search(/[?#]/);
  return HTTP_JSON_MESSAGE_PATH.test(queryStart === -1 ? url : url.slice(0, queryStart));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when `obj` has a key equal to a recognized member name ignoring case, but not exactly. */
function hasCaseVariantMember(obj: Record<string, unknown>, recognized: readonly string[]): boolean {
  return Object.keys(obj).some(key => {
    const lowered = key.toLowerCase();
    return recognized.some(name => name.toLowerCase() === lowered && name !== key);
  });
}
