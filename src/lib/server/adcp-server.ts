/**
 * Opaque AdCP server handle.
 *
 * `createAdcpServer()` returns a value typed as `AdcpServer` rather than the
 * underlying `@modelcontextprotocol/sdk` `McpServer`. Two reasons:
 *
 *   1. **Dual-package hazard.** Re-exporting the SDK's `McpServer` type from
 *      our public API forces downstream consumers through a specific SDK
 *      resolution path (ESM or CJS). When a TypeScript ESM consumer
 *      imports `@adcp/sdk` (CJS) and separately imports the SDK (ESM),
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
 * surface intentionally doesn't expose `registerTool()` — keeping it off the
 * public API lets the framework own tool registration conventions
 * (idempotency, governance, validation, response shape).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolResponse } from './responses';
import { ADCP_VERSION } from '../version';

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
 * Auth principal visible to handlers and `resolveAccount`. Mirrors the
 * shape `serve()` produces from its `authenticate` hook, and what the
 * A2A adapter's `authenticate` callback should return.
 */
export interface AdcpAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

/**
 * Optional per-call overrides for `dispatchTestRequest()`. Lets tests
 * simulate transport-level state — most importantly the `authInfo` that
 * `serve()` populates from its `authenticate` hook — without spinning up
 * a real HTTP transport.
 */
export interface AdcpTestRequestExtras {
  authInfo?: AdcpAuthInfo;
}

/**
 * Arguments accepted by `AdcpServer.invoke()`. A transport adapter (MCP
 * `serve()`, `createA2AAdapter()`, etc.) authenticates the incoming
 * request, maps it to one of the registered AdCP tool names, then calls
 * this surface to run the framework pipeline (idempotency, account
 * resolution, validation, governance, response-union narrowing).
 */
export interface AdcpInvokeOptions {
  /** AdCP tool name (`get_products`, `create_media_buy`, ...). */
  toolName: string;
  /** Tool arguments as received from the transport, pre-schema-validation. */
  args: Record<string, unknown>;
  /**
   * Auth principal the transport produced from its `authenticate` hook.
   * Handlers and `resolveAccount` see it as `ctx.authInfo`. Transports
   * MUST verify the principal before calling `invoke()` — `invoke()`
   * does NOT re-check the token.
   */
  authInfo?: AdcpAuthInfo;
  /** Abort signal for cancellation; defaults to a fresh controller. */
  signal?: AbortSignal;
}

/**
 * Test-harness hooks attached to every `AdcpServer`. Namespaced under
 * `compliance` so production code paths don't accidentally reach for
 * them — `reset()` drops cached state and is intended for storyboard
 * runners that exercise many scenarios in one process.
 */
export interface AdcpServerComplianceApi {
  /**
   * Drop session state and the idempotency cache so subsequent
   * storyboards don't inherit plans, media buys, or cached replies from
   * earlier runs. Conformance storyboards share brand domains across
   * test kits — without this hook, a $10K governance plan seeded by
   * `media_buy_seller/governance_denied` would intercept a $50K buy in
   * `sales_guaranteed`.
   *
   * Refuses to run by default unless BOTH guardrails hold:
   *   - `NODE_ENV !== 'production'` (opt out with `allowProduction: true`)
   *   - The configured stores are the in-memory SDK defaults
   *     (`InMemoryStateStore` + memory idempotency backend). Opt out
   *     with `force: true` when you've wired a disposable test
   *     Postgres cluster and know the flush is safe.
   *
   * The two flags are independent on purpose: `force` lets you flush
   * a non-memory store you've verified is a test DB, WITHOUT also
   * opening the door to running against a production `NODE_ENV`.
   * Same the other way: `allowProduction` lets you run in a prod-
   * labeled CI environment against memory stores, without bypassing
   * the store-shape safety check.
   */
  reset(options?: { force?: boolean; allowProduction?: boolean }): Promise<void>;
}

/**
 * Phantom brand for {@link AdcpServer}. Makes the type nominal — a plain
 * object that has the same methods structurally cannot be assigned to
 * `AdcpServer` because it lacks this symbol-keyed property. Closes the
 * door on `(plainObject as AdcpServer).registerTool(...)` patterns that
 * tried to reach for an MCP-SDK method the framework intentionally
 * doesn't expose.
 *
 * The brand is `never`-typed and never set on the runtime object, so
 * `Object.getOwnPropertySymbols(server)` won't expose it — only the
 * wrapper produced by `createAdcpServer()` carries the type-level
 * signature, via the `as AdcpServerInternal` cast in `wrapMcpServer()`.
 *
 * Must be a real (non-`declare`) const so the d.ts emit retains it. An
 * `export declare const X: unique symbol` in a `.ts` source file does
 * not survive emit — the binding gets dropped from the published d.ts
 * while consumers (the public `AdcpServer` interface) keep referencing
 * it, which produces `TS2304: Cannot find name 'ADCP_SERVER_BRAND'` on
 * any adopter `tsc --noEmit` against `@adcp/sdk/server` (issue #1236).
 */
export const ADCP_SERVER_BRAND: unique symbol = Symbol('ADCP_SERVER_BRAND');

/**
 * Opaque handle returned by `createAdcpServer()`.
 *
 * Pass to `serve()` to mount on an HTTP transport, or use
 * `dispatchTestRequest()` from a test harness to exercise handlers
 * in-process without opening a socket.
 */
export interface AdcpServer {
  /**
   * Phantom brand — type-level only, never present at runtime. See
   * {@link ADCP_SERVER_BRAND}. Tagged `never` so `(x as AdcpServer)`
   * casts from structurally-similar objects fail; a real `AdcpServer`
   * is only obtainable via `createAdcpServer()`.
   */
  readonly [ADCP_SERVER_BRAND]?: never;

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
   * Test-harness hooks — see {@link AdcpServerComplianceApi}. Not
   * intended for production call sites; production code paths should
   * use `close()` to release resources.
   */
  readonly compliance: AdcpServerComplianceApi;

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
   * **Never mount this behind an HTTP route.** `extras.authInfo` is
   * written directly onto the MCP handler's `extra` without any check
   * against `serve({ authenticate })` — exposing it externally lets a
   * caller impersonate any principal. This API is for in-process test
   * harnesses and storyboard runners only.
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
  dispatchTestRequest(request: AdcpTestToolsCallRequest, extras?: AdcpTestRequestExtras): Promise<CallToolResult>;
  dispatchTestRequest(request: AdcpTestRequest, extras?: AdcpTestRequestExtras): Promise<AdcpTestResponse>;

  /**
   * Production-safe tool invocation surface for transport adapters.
   *
   * Runs the full framework pipeline against a registered tool:
   * request schema validation → account resolution → idempotency →
   * handler dispatch → response narrowing → response validation.
   * Returns the same `McpToolResponse` envelope the MCP transport
   * observes — a transport adapter layers its own protocol framing on
   * top (JSON-RPC result for MCP, A2A `Task` artifact for A2A, etc.).
   *
   * **Auth is the caller's responsibility.** `invoke()` forwards the
   * provided `authInfo` verbatim to handlers and `resolveAccount`
   * without re-verifying. Mount it only behind a transport that has
   * already authenticated the principal (e.g. `serve({ authenticate })`
   * for MCP, `createA2AAdapter({ authenticate })` for A2A). Do not call
   * it directly from an HTTP handler — that path skips auth.
   *
   * For in-process tests that want to synthesize an `authInfo` without
   * running a transport, reach for {@link dispatchTestRequest} instead
   * — it takes the same principal shape but is explicitly marked
   * test-only in its docstring.
   *
   * Throws when `toolName` is not registered; schema errors round-trip
   * as structured `VALIDATION_ERROR` envelopes inside the return value.
   */
  invoke(options: AdcpInvokeOptions): Promise<McpToolResponse>;

  /**
   * Returns the AdCP protocol version this server is configured to speak.
   *
   * Defaults to {@link ADCP_VERSION} (the GA version the SDK ships against)
   * unless overridden via `createAdcpServer({ adcpVersion })`. This is the
   * protocol version, **not** the publisher's app version (`config.version`).
   *
   * Plumbing surface — Stage 2 of the multi-version refactor exposes the
   * configured value but does not yet vary validator/schema selection by
   * version. Wire-shape adapters key off this getter in subsequent stages.
   */
  getAdcpVersion(): string;
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

/**
 * Symbol-keyed accessor for the state store backing an `AdcpServer`.
 * Test harnesses and helpers like
 * `@adcp/sdk/compliance-fixtures`'s `seedComplianceFixtures` need
 * to reach the store without widening the public `AdcpServer`
 * interface (handlers already get `ctx.store`; production code paths
 * don't need a second accessor).
 *
 * @internal
 */
export const ADCP_STATE_STORE: unique symbol = Symbol.for('@adcp/client.stateStore');

/**
 * Symbol-keyed accessor for the capabilities object `createAdcpServer`
 * assembles and the auto-wired `get_adcp_capabilities` handler reads from.
 * Mutating this object mutates what subsequent capability-discovery calls
 * return — `registerTestController` uses this to add a
 * `compliance_testing` capability block after registration so the server
 * advertises its controller scenarios even though `registerTestController`
 * runs after `createAdcpServer`.
 *
 * @internal
 */
export const ADCP_CAPABILITIES: unique symbol = Symbol.for('@adcp/client.capabilities');

/**
 * Marker set on `AdcpServer` instances built from a function-form
 * `platform.instructions`. `serve()` reads this to throw early when
 * `reuseAgent: true` is combined with function instructions.
 *
 * @internal
 */
export const FUNCTION_INSTRUCTIONS: unique symbol = Symbol.for('@adcp/client.functionInstructions');

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
 * Write `_instructions` on the low-level SDK server that backs `mcpServer`.
 * Used by the function-form instructions hook to inject the resolved string
 * into the `initialize` response at session time.
 *
 * @internal
 */
export function setSdkServerInstructions(mcpServer: McpServer, value: string | undefined): void {
  const priv = mcpServer as unknown as McpServerPrivates;
  if (priv.server) {
    priv.server._instructions = value;
  }
}

/** @internal */
type McpRequestHandler = (request: { method: string; params?: unknown }, extra: unknown) => unknown | Promise<unknown>;

/**
 * Wrap the `initialize` request handler on `mcpServer` with `wrapper`.
 * The wrapper receives the original handler so it can call-through after
 * any pre-processing.
 *
 * @internal
 */

export function wrapInitializeHandler(
  mcpServer: McpServer,
  wrapper: (
    origHandler: McpRequestHandler,
    req: { method: string; params?: unknown },
    extra: unknown
  ) => unknown | Promise<unknown>
): void {
  const priv = mcpServer as unknown as McpServerPrivates;
  const handlers = priv.server?._requestHandlers;
  if (!handlers) return;
  const orig = handlers.get('initialize');
  if (!orig) return;
  handlers.set('initialize', (req, extra) => wrapper(orig, req, extra));
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
    _instructions?: string;
  };
}

function getRegisteredTool(server: McpServer, name: string): RegisteredTool | undefined {
  return (server as unknown as McpServerPrivates)._registeredTools?.[name];
}

/**
 * Enumerate the tool names registered on the underlying SDK server.
 * Used by transport adapters that need to derive discovery metadata
 * (agent cards, capability listings) from the registered surface
 * without reaching into private SDK fields at every call site.
 *
 * @internal
 */
export function listRegisteredToolNames(server: McpServer): string[] {
  const registered = (server as unknown as McpServerPrivates)._registeredTools ?? {};
  return Object.keys(registered);
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
export function wrapMcpServer(
  inner: McpServer | AdcpServerInternal,
  compliance?: AdcpServerComplianceApi,
  adcpVersion: string = ADCP_VERSION
): AdcpServerInternal {
  if (isAdcpServer(inner)) return inner;
  const mcp = inner as McpServer;
  const resolvedCompliance: AdcpServerComplianceApi = compliance ?? {
    async reset() {
      throw new Error(
        'AdcpServer.compliance.reset: no-op handle returned by `wrapMcpServer` without a compliance implementation. ' +
          'Use `createAdcpServer()` to get a server whose `compliance.reset()` flushes the state and idempotency stores.'
      );
    },
  };
  const dispatch = async (request: AdcpTestRequest, extras?: AdcpTestRequestExtras): Promise<AdcpTestResponse> => {
    const extra: { signal: AbortSignal; authInfo?: AdcpTestRequestExtras['authInfo'] } = {
      signal: new AbortController().signal,
    };
    if (extras?.authInfo) extra.authInfo = extras.authInfo;

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
  const invoke = async (options: AdcpInvokeOptions): Promise<McpToolResponse> => {
    const tool = getRegisteredTool(mcp, options.toolName);
    if (!tool) {
      throw new Error(`AdcpServer.invoke: tool "${options.toolName}" is not registered`);
    }
    const extra: { signal: AbortSignal; authInfo?: AdcpAuthInfo } = {
      signal: options.signal ?? new AbortController().signal,
    };
    if (options.authInfo) extra.authInfo = options.authInfo;
    return (await tool.handler(options.args, extra)) as McpToolResponse;
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
    compliance: resolvedCompliance,
    // Satisfies both overloads (typed tools/call + generic fallback) — the
    // runtime dispatcher is a single function that narrows by method.
    dispatchTestRequest: dispatch as AdcpServerInternal['dispatchTestRequest'],
    invoke,
    getAdcpVersion: () => adcpVersion,
  };
  return wrapper;
}
