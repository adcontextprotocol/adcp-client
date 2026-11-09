/**
 * AdCP-layer validation for tools registered with a zod input schema.
 *
 * The MCP SDK parses `tools/call` arguments against a tool's registered
 * `inputSchema` before the handler runs, and answers a failure with a bare
 * `-32602` text result: no `structuredContent`, no `adcp_error`, and no echo
 * of the caller's `context` (adcp-client#3666). Framework tools avoid that by
 * registering a passthrough schema and validating inside the handler. These
 * helpers give zod-declared tools (`customTools`, `tasks_get`,
 * `comply_test_controller`) the same treatment:
 *
 * - {@link validateToolInputAtAdcpLayer} swaps the registered schema for a
 *   passthrough one, so MCP-level validation cannot reject first, and keeps
 *   `tools/list` advertising the declared schema.
 * - {@link parseDeclaredToolInput} runs the declared schema inside the
 *   handler and returns either the parsed value (coercion, defaults and
 *   transforms applied exactly as the SDK applied them) or an
 *   `INVALID_REQUEST` response that echoes `context`.
 *
 * @internal
 */

import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeObjectSchema, safeParseAsync, type AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { wrapSdkRequestHandler } from './adcp-server';
import { adcpError } from './errors';
import type { McpToolResponse } from './responses';
import { buildAdcpValidationErrorPayload } from '../validation/schema-errors';
import type { ValidationIssue } from '../validation/schema-validator';

/**
 * Registered MCP input schema for tools whose arguments the AdCP layer
 * validates. Accepts any object and keeps every key, so the handler sees the
 * caller's arguments unchanged.
 */
export const PASSTHROUGH_INPUT_SCHEMA = z.object({}).passthrough();

/** What a framework-built rejection on a declared-input tool is finished from. */
export interface DeclaredInputRejection {
  /** The caller's `context`, echoed verbatim. It never feeds a decision. */
  context: unknown;
  /**
   * Arguments the served release is read from: the parsed value once parsing
   * succeeded, the caller's arguments when parsing itself failed.
   */
  releaseArgs: unknown;
}

/**
 * Finishes a framework-built rejection the way the hosting server finishes its
 * own errors: the caller's `context`, envelope `status`, served `adcp_version`.
 */
export type DeclaredInputErrorFinalizer = (
  toolName: string,
  response: McpToolResponse,
  rejection: DeclaredInputRejection
) => McpToolResponse;

interface DeclaredInputState {
  schemas: Map<string, AnySchema>;
  discoveryInstalled: boolean;
  finalizeError?: DeclaredInputErrorFinalizer;
  exposeSchemaPath?: boolean;
}

const states = new WeakMap<McpServer, DeclaredInputState>();

function stateFor(server: McpServer): DeclaredInputState {
  let state = states.get(server);
  if (state === undefined) {
    state = { schemas: new Map(), discoveryInstalled: false };
    states.set(server, state);
  }
  return state;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Configure how declared-input errors on `server` are finished. Called by
 * `createAdcpServer` so tools registered after it returns (the
 * `comply_test_controller` helpers) stamp the same envelope fields as
 * framework errors. Without it, errors still carry `adcp_error` and `context`.
 */
export function configureDeclaredInputErrors(
  server: McpServer,
  options: { finalize: DeclaredInputErrorFinalizer; exposeSchemaPath: boolean }
): void {
  const state = stateFor(server);
  state.finalizeError = options.finalize;
  state.exposeSchemaPath = options.exposeSchemaPath;
}

/**
 * Move a freshly registered tool's argument validation from the MCP SDK to
 * the AdCP layer. The schema the SDK normalized at registration becomes the
 * declared schema: {@link parseDeclaredToolInput} validates against it and
 * `tools/list` keeps advertising it. The SDK itself validates against
 * {@link PASSTHROUGH_INPUT_SCHEMA} from now on.
 *
 * The handler must call {@link parseDeclaredToolInput} before using its
 * arguments. A tool registered without an input schema is left unchanged, and
 * so is a tool on a server that is not an SDK `McpServer` (a test double or
 * proxy that returns no registration record or has no `tools/list` handler to
 * wrap): its SDK keeps validating, and {@link parseDeclaredToolInput} passes
 * the arguments through.
 */
export function validateToolInputAtAdcpLayer(
  server: McpServer,
  name: string,
  // The MCP Apps helper types its result with the v2 SDK's RegisteredTool,
  // but on a v1 server it is the v1 record.
  registered: Pick<RegisteredTool, 'inputSchema'> | { inputSchema?: unknown } | undefined
): void {
  const declared = registered?.inputSchema as AnySchema | undefined;
  if (registered === undefined || declared === undefined) return;
  const state = stateFor(server);
  // Advertising comes first: swapping the schema without it would degrade
  // `tools/list` to the passthrough schema.
  state.discoveryInstalled ||= wrapSdkRequestHandler(server, 'tools/list', async (original, request, extra) =>
    advertiseDeclaredInputSchemas(await original(request, extra), state.schemas)
  );
  if (!state.discoveryInstalled) return;
  state.schemas.set(name, declared);
  registered.inputSchema = PASSTHROUGH_INPUT_SCHEMA;
}

/** The declared input schema of `name` on `server`, when the AdCP layer validates it. */
export function getDeclaredInputSchema(server: McpServer, name: string): AnySchema | undefined {
  return states.get(server)?.schemas.get(name);
}

/** The JSON Schema the MCP SDK's own `tools/list` emits for an input schema. */
export function declaredInputJsonSchema(schema: AnySchema): Record<string, unknown> {
  const objectSchema = normalizeObjectSchema(schema);
  return objectSchema
    ? (toJsonSchemaCompat(objectSchema, { strictUnions: true, pipeStrategy: 'input' }) as Record<string, unknown>)
    : { type: 'object', properties: {} };
}

function advertiseDeclaredInputSchemas(response: unknown, schemas: ReadonlyMap<string, AnySchema>): unknown {
  if (!isPlainObject(response) || !Array.isArray(response.tools)) return response;
  return {
    ...response,
    tools: response.tools.map(tool => {
      const name = isPlainObject(tool) ? tool.name : undefined;
      const declared = typeof name === 'string' ? schemas.get(name) : undefined;
      return declared === undefined ? tool : { ...tool, inputSchema: declaredInputJsonSchema(declared) };
    }),
  };
}

export type DeclaredInputParseResult = { success: true; data: unknown } | { success: false; response: McpToolResponse };

/**
 * Validate `args` against the schema `name` declared at registration.
 *
 * Success carries the parsed value — the same value the MCP SDK used to hand
 * the handler, with zod coercion, defaults and transforms applied. Every
 * decision the caller makes afterwards (authorization, release selection,
 * gating) must read this value and hand the handler this same value; reading
 * the raw arguments again would let a default or coercion change what was
 * authorized. Failure carries an `INVALID_REQUEST` response with `field`
 * naming the first failing path, the field-level `issues`, and the caller's
 * `context` echoed. A tool without a declared schema passes `args` through.
 */
export async function parseDeclaredToolInput(
  server: McpServer,
  name: string,
  args: unknown
): Promise<DeclaredInputParseResult> {
  const state = states.get(server);
  const declared = state?.schemas.get(name);
  if (state === undefined || declared === undefined) return { success: true, data: args };
  const input = args ?? {};
  // Mirrors the SDK's own `validateToolInput`, so a valid call parses to the
  // same value it did when the SDK validated it.
  const result = await safeParseAsync(normalizeObjectSchema(declared) ?? declared, input);
  if (result.success) return { success: true, data: result.data };

  const payload = buildAdcpValidationErrorPayload(name, 'request', zodIssuesToValidationIssues(result.error, input), {
    exposeSchemaPath: state.exposeSchemaPath === true,
  });
  // No parsed value exists, so the release that labels this error is read
  // from the caller's arguments. Nothing runs on it.
  const context = isPlainObject(input) ? input.context : undefined;
  return {
    success: false,
    response: finishDeclaredInputRejection(server, name, adcpError('INVALID_REQUEST', payload), {
      context,
      releaseArgs: input,
    }),
  };
}

/**
 * Finish a framework-built rejection of `name` the way its `INVALID_REQUEST`
 * is finished: with the hosting server's finalizer, or on a server without
 * one, by echoing the caller's `context`.
 */
export function finishDeclaredInputRejection(
  server: McpServer,
  name: string,
  response: McpToolResponse,
  rejection: DeclaredInputRejection
): McpToolResponse {
  const finalize = states.get(server)?.finalizeError;
  if (finalize !== undefined) return finalize(name, response, rejection);
  const structured = response.structuredContent;
  if (!isPlainObject(rejection.context) || !isPlainObject(structured) || 'context' in structured) return response;
  const text = response.content?.[0];
  const mirrors = text?.type === 'text' && text.text === JSON.stringify(structured);
  structured.context = rejection.context;
  if (mirrors) text.text = JSON.stringify(structured);
  return response;
}

type PathSegment = string | number;

function escapePointerSegment(segment: PathSegment): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function isMissingAt(value: unknown, path: readonly PathSegment[]): boolean {
  let parent = value;
  for (const segment of path.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object') return false;
    parent = (parent as Record<PathSegment, unknown>)[segment];
  }
  if (parent === null || typeof parent !== 'object') return false;
  return (parent as Record<PathSegment, unknown>)[path[path.length - 1]!] === undefined;
}

function toValidationIssue(path: readonly PathSegment[], keyword: string, message: string): ValidationIssue {
  return {
    pointer: path.map(segment => `/${escapePointerSegment(segment)}`).join(''),
    message,
    keyword,
    schemaPath: `#${path.map(segment => (typeof segment === 'number' ? '/items' : `/properties/${escapePointerSegment(segment)}`)).join('')}/${keyword}`,
  };
}

/**
 * Project zod (v3 or v4) issues onto the AJV-shaped issues framework
 * validation reports. A missing property becomes a `required` issue at the
 * property's own pointer, and each unknown key of a strict object gets its
 * own `additionalProperties` issue, so `field` names the exact offending path.
 */
function zodIssuesToValidationIssues(error: unknown, input: unknown): ValidationIssue[] {
  const zodIssues = isPlainObject(error) ? error.issues : undefined;
  if (!Array.isArray(zodIssues) || zodIssues.length === 0) {
    return [toValidationIssue([], 'type', 'Invalid arguments')];
  }
  return zodIssues.flatMap((raw): ValidationIssue[] => {
    const issue = isPlainObject(raw) ? raw : {};
    const path = (Array.isArray(issue.path) ? issue.path : []).filter(
      (segment): segment is PathSegment => typeof segment === 'string' || typeof segment === 'number'
    );
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      return issue.keys.map(key =>
        toValidationIssue([...path, String(key)], 'additionalProperties', `must NOT have additional property '${key}'`)
      );
    }
    if (path.length > 0 && isMissingAt(input, path)) {
      return [toValidationIssue(path, 'required', `must have required property '${path[path.length - 1]}'`)];
    }
    const message = typeof issue.message === 'string' ? issue.message : 'Invalid value';
    return [toValidationIssue(path, typeof issue.code === 'string' ? issue.code : 'type', message)];
  });
}
