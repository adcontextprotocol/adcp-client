/**
 * Opaque AdCP server handle.
 *
 * `createAdcpServer()` returns a value typed as `AdcpServer` rather than the
 * underlying `@modelcontextprotocol/sdk` `McpServer`. Two reasons:
 *
 *   1. **Dual-package hazard.** Re-exporting the SDK's `McpServer` type from
 *      our public API forces downstream consumers through a specific SDK
 *      resolution path (ESM or CJS). When a TypeScript ESM consumer
 *      imports `@adcp/client` (CJS) and separately imports the SDK (ESM),
 *      the two `McpServer` types are structurally identical but distinct
 *      — the SDK's private `_serverInfo` field breaks assignment
 *      compatibility between them. Owning the type on our side
 *      eliminates the hazard: `AdcpServer` resolves the same way for
 *      every consumer because it comes from a single package.
 *
 *   2. **Test ergonomics.** Downstream test harnesses have been reaching
 *      into `(server as any)._requestHandlers` and
 *      `server.server._requestHandlers` to dispatch tool calls in-process.
 *      `dispatchTestRequest()` moves that private-field access into a
 *      single encapsulated helper so consumers don't have to repeat it.
 *
 * To register additional tools or resources, configure them through
 * `createAdcpServer()`'s domain-grouped handler config. The opaque
 * surface intentionally doesn't expose `.tool()` — keeping it off the
 * public API lets the framework own tool registration conventions
 * (idempotency, governance, validation, response shape).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Structural shape of an MCP transport the server can connect to.
 *
 * Matches `@modelcontextprotocol/sdk/shared/transport.js` Transport without
 * importing it — keeping the SDK type off our public API surface.
 * `StreamableHTTPServerTransport`, `StdioServerTransport`, and
 * `InMemoryTransport` from the SDK all satisfy this shape.
 *
 * `message` / callback parameters are typed with `any` (not `unknown`) so
 * SDK-specific transports with narrower message types (JSONRPCMessage) are
 * assignable bi-directionally without forcing downstream consumers to
 * widen their own transport types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AdcpServerTransport {
  start(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(message: any, options?: any): Promise<void>;
  close(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage?: (message: any, extra?: any) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}

/**
 * Request envelope accepted by `AdcpServer.dispatchTestRequest()`.
 *
 * Mirrors the JSON-RPC method/params shape so tests can target the same
 * methods the transport would — `tools/call`, `tools/list`, etc.
 */
export interface AdcpTestRequest {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Typed variant of {@link AdcpTestRequest} for `tools/call`. Used by the
 * `dispatchTestRequest` overload that returns a typed `CallToolResult`.
 */
export interface AdcpTestToolsCallRequest {
  method: 'tools/call';
  params: { name: string; arguments?: Record<string, unknown> };
}

/**
 * Response returned by `AdcpServer.dispatchTestRequest()`.
 *
 * The shape depends on the `method` — for `tools/call` this is the
 * `CallToolResult` (content + structuredContent + optional isError);
 * for other methods it's the method-specific result. Left as `unknown`
 * so callers narrow with type guards or schema validation relevant to
 * the specific method they're dispatching.
 */
export type AdcpTestResponse = unknown;

/**
 * Opaque handle returned by `createAdcpServer()`.
 *
 * Pass to `serve()` to mount on an HTTP transport, or use
 * `dispatchTestRequest()` from a test harness to exercise handlers
 * in-process without opening a socket.
 */
export interface AdcpServer {
  /**
   * Connect the server to an MCP transport.
   *
   * Takes ownership of the transport — any callbacks previously
   * registered on it are replaced. Matches the semantics of the SDK's
   * `McpServer.connect()`.
   */
  connect(transport: AdcpServerTransport): Promise<void>;

  /** Close the server and release resources. */
  close(): Promise<void>;

  /**
   * Invoke a registered handler in-process and return its response.
   *
   * Bypasses the transport layer — no sockets, no JSON-RPC framing.
   * Intended for test harnesses only; production callers should go
   * through a transport so protocol invariants (request ID linking,
   * task progress, notifications) are enforced.
   *
   * Throws when no handler is registered for the requested method,
   * or when a `tools/call` request targets an unknown tool. Arguments
   * default to `{}` when `params.arguments` is omitted — a validation
   * error from the tool's input schema (not from dispatch) is the
   * expected failure mode for a missing required field.
   *
   * @example
   * ```typescript
   * const result = await server.dispatchTestRequest({
   *   method: 'tools/call',
   *   params: {
   *     name: 'get_products',
   *     arguments: { brief: 'premium sports inventory' },
   *   },
   * });
   * ```
   */
  dispatchTestRequest(request: AdcpTestToolsCallRequest): Promise<CallToolResult>;
  dispatchTestRequest(request: AdcpTestRequest): Promise<AdcpTestResponse>;
}

/**
 * Symbol-keyed accessor for the underlying SDK `McpServer`. Used by
 * `serve()` to reach through the opaque wrapper when SDK-specific
 * operations are needed. Not part of the public API — typed on a
 * separate internal interface so downstream consumers can't discover
 * it through the `AdcpServer` type.
 *
 * @internal
 */
export const ADCP_SDK_SERVER: unique symbol = Symbol.for('@adcp/client.sdkServer');

/** @internal */
export interface AdcpServerInternal extends AdcpServer {
  readonly [ADCP_SDK_SERVER]: McpServer;
}

/**
 * Return the underlying `McpServer` for a wrapped `AdcpServer`, or
 * `undefined` if the value is not an `AdcpServer` produced by
 * `createAdcpServer()`.
 *
 * @internal
 */
export function getSdkServer(server: AdcpServer | McpServer): McpServer | undefined {
  const candidate = (server as unknown as Partial<AdcpServerInternal>)[ADCP_SDK_SERVER];
  return candidate;
}

/**
 * True when `value` is an `AdcpServer` produced by `createAdcpServer()`.
 *
 * @internal
 */
export function isAdcpServer(value: unknown): value is AdcpServerInternal {
  return (
    value != null &&
    typeof value === 'object' &&
    ADCP_SDK_SERVER in (value as Record<PropertyKey, unknown>) &&
    typeof (value as AdcpServer).dispatchTestRequest === 'function'
  );
}

// ---------------------------------------------------------------------------
// Private-field access — centralized
// ---------------------------------------------------------------------------
//
// The MCP SDK marks `_requestHandlers` and `_registeredTools` as private.
// Dispatching a request in-process from a test needs them. Doing it once
// here means downstream harnesses don't each repeat the (server as any)
// dance, which is the whole point of exposing `dispatchTestRequest()`.
//
// If/when the SDK ships a public in-process dispatch API, swap these two
// helpers for that API. The AdcpServer surface stays the same.

interface RegisteredTool {
  handler: (args: unknown, extra: unknown) => unknown | Promise<unknown>;
}

interface McpServerPrivates {
  _registeredTools?: Record<string, RegisteredTool | undefined>;
  server?: {
    _requestHandlers?: Map<
      string,
      (request: { method: string; params?: unknown }, extra: unknown) => unknown | Promise<unknown>
    >;
  };
}

function getRegisteredTool(server: McpServer, name: string): RegisteredTool | undefined {
  return (server as unknown as McpServerPrivates)._registeredTools?.[name];
}

function getRequestHandler(
  server: McpServer,
  method: string
): ((request: { method: string; params?: unknown }, extra: unknown) => unknown | Promise<unknown>) | undefined {
  return (server as unknown as McpServerPrivates).server?._requestHandlers?.get(method);
}

/**
 * Wrap an SDK `McpServer` into the opaque `AdcpServer` handle returned by
 * `createAdcpServer()`. Consumers should prefer `createAdcpServer()` and
 * treat this as an internal utility; it's exported for framework code
 * that needs to produce an `AdcpServer` around a hand-built server.
 *
 * Idempotent — passing an already-wrapped `AdcpServer` returns it
 * unchanged rather than nesting wrappers (which would leave
 * `ADCP_SDK_SERVER` pointing at the outer wrapper instead of the SDK
 * handle and break `getSdkServer()` round-trips).
 *
 * @internal
 */
export function wrapMcpServer(inner: McpServer | AdcpServerInternal): AdcpServerInternal {
  if (isAdcpServer(inner)) return inner;
  const mcp = inner as McpServer;
  const dispatch = async (request: AdcpTestRequest): Promise<AdcpTestResponse> => {
    const extra = { signal: new AbortController().signal };

    if (request.method === 'tools/call') {
      const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (typeof params.name !== 'string') {
        throw new Error("dispatchTestRequest: 'tools/call' requires params.name (string)");
      }
      const tool = getRegisteredTool(mcp, params.name);
      if (!tool) {
        throw new Error(`dispatchTestRequest: tool "${params.name}" is not registered`);
      }
      return tool.handler(params.arguments ?? {}, extra);
    }

    const handler = getRequestHandler(mcp, request.method);
    if (!handler) {
      throw new Error(`dispatchTestRequest: no handler registered for method "${request.method}"`);
    }
    return handler({ method: request.method, params: request.params ?? {} }, extra);
  };
  const wrapper: AdcpServerInternal = {
    [ADCP_SDK_SERVER]: mcp,
    connect(transport) {
      // The SDK's Transport interface is structurally compatible with
      // AdcpServerTransport — the cast is boundary-crossing, not lossy.
      return mcp.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
    },
    close() {
      return mcp.close();
    },
    // Satisfies both overloads (typed tools/call + generic fallback) — the
    // runtime dispatcher is a single function that narrows by method.
    dispatchTestRequest: dispatch as AdcpServerInternal['dispatchTestRequest'],
  };
  return wrapper;
}
