/**
 * One-liner HTTP server for AdCP MCP agents.
 *
 * Wraps the StreamableHTTPServerTransport + http.createServer boilerplate
 * so agent builders can focus on business logic.
 *
 * @example
 * ```typescript
 * import { createTaskCapableServer, serve } from '@adcp/sdk';
 *
 * function createAgent({ taskStore }) {
 *   const server = createTaskCapableServer('My Agent', '1.0.0', { taskStore });
 *   server.registerTool('get_signals', { description: 'Discover audiences.', inputSchema: schema }, handler);
 *   return server;
 * }
 *
 * serve(createAgent); // listening on http://localhost:3001/mcp
 * ```
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { AuthPrincipal, Authenticator, ServeRequestContext } from './auth';
import {
  ADCP_SERVE_REQUEST_CONTEXT,
  AuthError,
  authenticatorNeedsRawBody,
  respondUnauthorized,
  signatureErrorCodeFromCause,
} from './auth';
import { ADCP_PRE_TRANSPORT, ADCP_INSTRUCTIONS_FN, type AdcpPreTransport } from './create-adcp-server';
import type { AdcpServer } from './adcp-server';

/**
 * Context passed to the agent factory on each request.
 *
 * Contains shared resources that must survive across stateless HTTP requests,
 * such as the task store for MCP Tasks protocol support.
 *
 * For multi-tenant / multi-host deployments, provide a custom `TaskStore` via
 * `ServeOptions` that enforces tenant/session scoping, and branch on
 * {@link host} inside your factory to return host-specific handlers.
 */
export interface ServeContext {
  /** Shared task store — use this when creating your McpServer so tasks persist across requests. */
  taskStore: TaskStore;
  /**
   * Canonical host the request arrived on, lowercased with port preserved
   * (e.g. `snap.example.com`, `localhost:3001`). Resolved from
   * `X-Forwarded-Host` when `ServeOptions.trustForwardedHost` is true,
   * otherwise from the `Host` header. Empty string when neither header
   * is present (unusual — HTTP/1.1 requires `Host`).
   *
   * Use this in the factory to branch on hostname when a single process
   * fronts multiple agents. The same string is passed to
   * `publicUrl` / `protectedResource` resolver functions.
   */
  host: string;
}

/**
 * Thrown from an agent factory (or a `publicUrl` / `protectedResource`
 * resolver) when the incoming request's host isn't configured. `serve()`
 * catches it and responds 404 with a generic body — the adapter routing
 * table never crosses the wire. Any other thrown error still surfaces
 * as 500 so unrelated bugs stay loud.
 */
export class UnknownHostError extends Error {
  constructor(message = 'Unknown host') {
    super(message);
    this.name = 'UnknownHostError';
  }
}

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) advertised at
 * `/.well-known/oauth-protected-resource<mountPath>`.
 *
 * The `resource` URL itself is taken from `ServeOptions.publicUrl` — set
 * that to the canonical MCP endpoint (e.g. `https://my-agent.example.com/mcp`)
 * so clients request tokens bound to the right RFC 8707 audience.
 */
export interface ProtectedResourceMetadata {
  /** URLs of authorization servers that issue tokens for this resource. */
  authorization_servers: string[];
  /** Scopes this resource accepts. Optional. */
  scopes_supported?: string[];
  /** Bearer token methods supported. Defaults to `['header']`. */
  bearer_methods_supported?: Array<'header' | 'body' | 'query'>;
  /** Human-readable resource docs URL. Optional. */
  resource_documentation?: string;
  /** Per-resource policy URL. Optional. */
  resource_policy_uri?: string;
  /** Per-resource ToS URL. Optional. */
  resource_tos_uri?: string;
}

export interface ServeOptions {
  /** Port to listen on. Defaults to PORT env var or 3001. */
  port?: number;
  /** HTTP path to mount the MCP endpoint on. Defaults to '/mcp'. */
  path?: string;
  /** Called when the server starts listening. */
  onListening?: (url: string) => void;
  /**
   * Async check called before the server begins accepting connections.
   * Throw to abort boot — `serve()` logs the error and calls `process.exit(1)`,
   * so the server never enters listen mode and no traffic arrives during the
   * check. Use to validate external dependencies (database pools, credential
   * fetches) so a misconfigured deployment fails loudly at startup rather than
   * silently on the first live request.
   *
   * @example
   * ```ts
   * serve(createAgent, {
   *   readinessCheck: () => store.probe(),
   * });
   * ```
   */
  readinessCheck?: () => Promise<void>;
  /**
   * Custom task store. Defaults to a shared InMemoryTaskStore.
   *
   * The default InMemoryTaskStore only evicts tasks that have a TTL set.
   * For long-running servers, always set `ttl` when creating tasks, or
   * provide a store with automatic eviction to prevent unbounded memory growth.
   */
  taskStore?: TaskStore;

  /**
   * Canonical public URL of this MCP endpoint (e.g. `https://my-agent.example.com/mcp`).
   * Required when `protectedResource` is configured — the RFC 9728 `resource`
   * field, the RFC 6750 `resource_metadata` URL on 401 challenges, and the
   * JWT audience your tokens must carry are all derived from it. Setting this
   * defends against attacker-controlled `Host` header phishing: without it,
   * the server would advertise whatever host a caller happened to send.
   *
   * Must be an absolute https:// URL whose path matches the mount path.
   *
   * **Multi-host.** Pass a function `(host) => string` when one process
   * fronts multiple hostnames (white-label publishers, multi-brand
   * adapters). The resolver runs per unique host — the returned URL is
   * cached and used as the RFC 9728 `resource`, the 401-challenge
   * `resource_metadata`, and the JWT audience for that host. Each
   * resolved URL's path must match the mount path, same as the static
   * form. Setting {@link trustForwardedHost} is recommended when
   * behind a proxy.
   */
  publicUrl?: string | ((host: string) => string);

  /**
   * Authentication middleware applied to every request. When configured,
   * missing or invalid credentials produce a 401 with a compliant
   * `WWW-Authenticate` header — no request reaches the MCP transport
   * without passing. Use helpers from `./auth`: `verifyApiKey`,
   * `verifyBearer`, or `anyOf(verifyApiKey(...), verifyBearer(...))`.
   */
  authenticate?: Authenticator;

  /**
   * Advertise OAuth 2.0 protected-resource metadata at
   * `/.well-known/oauth-protected-resource<mountPath>`. Requires {@link publicUrl}.
   *
   * Pass a function `(host) => ProtectedResourceMetadata` for multi-host
   * deployments whose authorization servers or supported scopes vary per
   * hostname (e.g., each white-label seller has its own AS). The resolver
   * runs once per unique host and the result is cached. The static form
   * still works when every host uses the same PRM body.
   */
  protectedResource?: ProtectedResourceMetadata | ((host: string) => ProtectedResourceMetadata);

  /**
   * Reuse the agent returned by the factory across requests instead of
   * closing it after each. Default `false` (one fresh server per
   * request — the pre-existing behavior).
   *
   * When `true`, `serve()` DOES NOT call `agentServer.close()` between
   * requests. The factory is still called on every request; it's the
   * caller's responsibility to cache `AdcpServer` instances (typically
   * keyed on `ctx.host`) and return the cached instance when possible.
   * Concurrent requests to the same cached server are serialized per
   * instance — `McpServer.connect()` rejects when a transport is
   * already attached, so the framework wraps the
   * connect→handleRequest→release cycle in a per-instance async
   * mutex. Requests for DIFFERENT cached servers still run in parallel.
   *
   * Use when `createAdcpServer(...)` setup cost (tool registration,
   * handler wiring) is a measurable portion of request latency — common
   * in multi-host deployments with many tools per host. Trade-off:
   * throughput per unique host drops to 1 in flight at a time. For
   * higher concurrency per host, cache a small pool of servers in the
   * factory and round-robin.
   *
   * Cleanup is the caller's responsibility: listen for the process
   * shutdown signal and call `close()` on every cached server to
   * release MCP Tasks timers, HTTP keepalives, etc.
   *
   * **Incompatible with long-lived server→client streams.** MCP's
   * `Protocol._onclose` aborts in-flight handlers and clears progress
   * tokens when the transport closes. In stateless HTTP mode (the
   * default this helper uses) each request is already single-response,
   * so this is a no-op concern. Don't enable `reuseAgent` if you
   * eventually wire a transport that keeps an SSE channel open across
   * multiple logical requests.
   */
  reuseAgent?: boolean;

  /**
   * Trust `X-Forwarded-Host` and RFC 7239 `Forwarded: host=...` for
   * host resolution and for reconstructing the public URL on 401
   * challenges. Default `false` — an attacker-controlled header can't
   * flip the advertised OAuth `resource` URL unless you opt in.
   *
   * **Your proxy must OVERWRITE the forwarded headers on ingress, not
   * append.** The framework trusts the first (left-most) entry in a
   * chain. With an overwriting proxy that's the sanitized value; with
   * an appending proxy it's whatever the client sent — an attacker
   * picks it. Common behavior:
   *
   * - Overwrite (safe to trust): Fly.io, Cloud Run, GCP HTTPS LB.
   * - Append (NOT safe without extra config): AWS ALB default, nginx
   *   default. These need `proxy_set_header X-Forwarded-Host $host;`
   *   or equivalent before enabling this flag.
   *
   * Verify your proxy's behavior against a request that already has
   * `X-Forwarded-Host: attacker.example` in it before turning this on.
   */
  trustForwardedHost?: boolean;

  /**
   * Pre-MCP middleware — runs after authentication but before MCP transport
   * is connected. Intended for transport-layer concerns like RFC 9421
   * request-signature verification: the agent's body is already buffered
   * into `(req as any).rawBody` before the middleware fires so signature
   * verifiers can hash it without racing the transport's own body read.
   *
   * Return `true` to signal the middleware handled the response (e.g. a
   * 401 with `WWW-Authenticate`); the transport is skipped. Return `false`
   * to continue into MCP dispatch.
   *
   * Throwing from the middleware produces a 500 with a generic body.
   */
  preTransport?: (
    req: import('http').IncomingMessage & { rawBody?: string },
    res: import('http').ServerResponse
  ) => Promise<boolean>;
}

/**
 * Start an HTTP server that serves an AdCP MCP agent.
 *
 * Creates a new MCP server instance per request (stateless), wires up the
 * StreamableHTTPServerTransport, and returns the underlying http.Server
 * for lifecycle control.
 *
 * A shared task store is created once and passed to the factory on every
 * request via `ServeContext`. This ensures MCP Tasks (create → poll → result)
 * work correctly across stateless HTTP requests.
 *
 * **Multi-host.** Pass functions for `publicUrl` and `protectedResource` and
 * branch on `ctx.host` in the factory to front multiple hostnames from one
 * process. The framework resolves host from `X-Forwarded-Host` (when
 * `trustForwardedHost: true`) or `Host`, threads it through `ServeContext`,
 * and caches per-host `publicUrl`/PRM so each hostname advertises its own
 * audience-bound `resource`.
 *
 * @param createAgent - Factory function that returns a configured server —
 *   either an `AdcpServer` from `createAdcpServer()` or a raw SDK `McpServer`
 *   from `createTaskCapableServer()`. Called once per request so each gets a
 *   fresh instance (a server can only be connected once). Receives a
 *   `ServeContext` with a shared `taskStore` and the resolved `host` —
 *   branch on `host` to return host-specific handlers in multi-host mode.
 * @param options - Port, path, and callback configuration.
 * @returns The http.Server instance. Use the `onListening` callback or
 *   listen for the 'listening' event to know when it's ready.
 */
export function serve(createAgent: (ctx: ServeContext) => AdcpServer | McpServer, options?: ServeOptions): HttpServer {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  if (envPort !== undefined && (Number.isNaN(envPort) || envPort < 0 || envPort > 65535)) {
    throw new Error(`Invalid PORT environment variable: "${process.env.PORT}"`);
  }
  const port = options?.port ?? envPort ?? 3001;
  const mountPath = options?.path ?? '/mcp';
  const taskStore = options?.taskStore ?? new InMemoryTaskStore();
  const trustForwardedHost = options?.trustForwardedHost === true;
  const reuseAgent = options?.reuseAgent === true;

  // Per-instance mutex chain for `reuseAgent: true`. The MCP SDK's
  // `Protocol.connect()` hard-throws when a transport is already
  // attached (node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:215),
  // so concurrent requests that land on the same cached server would
  // race without this. WeakMap so agents GC normally when the caller
  // drops references. Only used when `reuseAgent` is true — the
  // default path still creates a fresh server per request and doesn't
  // share any state across calls.
  const reuseMutexes = new WeakMap<AdcpServer | McpServer, Promise<unknown>>();

  if (options?.protectedResource && !options.publicUrl) {
    throw new Error(
      'serve(): `protectedResource` requires `publicUrl` (the canonical https:// URL clients use for this MCP endpoint). ' +
        'Without it, the server would advertise an attacker-controlled Host header as the OAuth resource URL.'
    );
  }

  const publicUrlOption = options?.publicUrl;
  const protectedResourceOption = options?.protectedResource;
  const publicUrlIsFn = typeof publicUrlOption === 'function';
  const prmIsFn = typeof protectedResourceOption === 'function';

  // Static publicUrl — validate once at construction. Function form validates
  // lazily per host so a stale factory for one host can't prevent boot.
  let staticPublicOrigin: string | undefined;
  if (typeof publicUrlOption === 'string') {
    staticPublicOrigin = validatePublicUrl(publicUrlOption, mountPath);
  }

  // Per-host caches. Function-form options are pure host → value lookups,
  // so memoization is safe and avoids the per-request allocation of
  // `new URL(...)` plus the caller's own host → config table work.
  const publicUrlCache = new Map<string, string>();
  const publicOriginCache = new Map<string, string>();
  const prmCache = new Map<string, ProtectedResourceMetadata>();

  const resolvePublicUrl = (host: string): string | undefined => {
    if (typeof publicUrlOption === 'string') return publicUrlOption;
    if (!publicUrlIsFn) return undefined;
    let cached = publicUrlCache.get(host);
    if (cached !== undefined) return cached;
    cached = (publicUrlOption as (h: string) => string)(host);
    const origin = validatePublicUrl(cached, mountPath);
    publicUrlCache.set(host, cached);
    publicOriginCache.set(host, origin);
    return cached;
  };

  const resolvePublicOrigin = (host: string): string | undefined => {
    if (typeof publicUrlOption === 'string') return staticPublicOrigin;
    // Populate via resolvePublicUrl so both caches share a single validation pass.
    if (resolvePublicUrl(host) == null) return undefined;
    return publicOriginCache.get(host);
  };

  const resolveProtectedResource = (host: string): ProtectedResourceMetadata | undefined => {
    if (!protectedResourceOption) return undefined;
    if (!prmIsFn) return protectedResourceOption as ProtectedResourceMetadata;
    let cached = prmCache.get(host);
    if (cached !== undefined) return cached;
    cached = (protectedResourceOption as (h: string) => ProtectedResourceMetadata)(host);
    prmCache.set(host, cached);
    return cached;
  };

  if (options?.authenticate == null && process.env.NODE_ENV === 'production') {
    console.warn(
      '[adcp/serve] No `authenticate` configured — this agent will accept unauthenticated requests. ' +
        'AdCP security_baseline requires authentication in production.'
    );
  }

  const explicitPreTransport = options?.preTransport as AdcpPreTransport | undefined;

  const protectedResourcePath = `/.well-known/oauth-protected-resource${mountPath}`;

  const httpServer = createServer(async (req, res) => {
    const { pathname } = new URL(req.url || '', 'http://localhost');
    const host = resolveHost(req, { trustForwardedHost });

    // RFC 9728 protected-resource metadata — intentionally auth-free so
    // clients can discover the authorization server before they have a token.
    if (protectedResourceOption && pathname === protectedResourcePath) {
      let resource: string | undefined;
      let prm: ProtectedResourceMetadata | undefined;
      try {
        resource = resolvePublicUrl(host);
        prm = resolveProtectedResource(host);
      } catch (err) {
        if (err instanceof UnknownHostError) {
          // Operator signalled "this host isn't in my routing table." 404
          // lets the OAuth grader probe fall through cleanly and doesn't
          // leak the configured host set across the wire.
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        console.error('[adcp/serve] publicUrl/protectedResource resolver failed:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Protected-resource metadata unavailable for this host.' }));
        return;
      }
      if (!resource || !prm) {
        // Fail closed: advertising a garbage resource URL would mint
        // audience-mismatched tokens across the fleet. 404 signals "this
        // host doesn't publish PRM" — the operator sees it and either
        // wires the host up or takes it out of DNS.
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const body = {
        resource,
        ...prm,
        bearer_methods_supported: prm.bearer_methods_supported ?? ['header'],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    if (pathname === mountPath || pathname === `${mountPath}/`) {
      // Resolve per-request `resource_metadata` URL for 401 challenges and
      // the per-host `publicUrl` authenticators read via
      // {@link getServeRequestContext}. Resolving both up front means
      // the audience callback in `verifyBearer` can never diverge from
      // what the framework advertises in `/.well-known/...`. For static
      // PRM this is the same string every request (pre-multi-host
      // behavior); for function-form PRM/URL it follows the host.
      let resourceMetadataUrl: string | undefined;
      let resolvedPublicUrl: string | undefined;
      try {
        resolvedPublicUrl = resolvePublicUrl(host);
      } catch (err) {
        if (err instanceof UnknownHostError) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        console.error('[adcp/serve] publicUrl resolver failed:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Protected-resource metadata unavailable for this host.' }));
        return;
      }
      if (protectedResourceOption) {
        const hostOrigin = resolvePublicOrigin(host);
        if (hostOrigin) resourceMetadataUrl = `${hostOrigin}${protectedResourcePath}`;
      }

      // Stamp the serve-resolved context on the request so authenticator
      // callbacks (e.g. `verifyBearer`'s audience resolver) inherit the
      // framework's host resolution — they MUST NOT re-derive host from
      // raw headers, since that would diverge from what PRM advertises
      // and let a spoofed `X-Forwarded-Host` flip the JWT audience check
      // when `trustForwardedHost` is false.
      const serveRequestContext: ServeRequestContext = resolvedPublicUrl
        ? { host, publicUrl: resolvedPublicUrl }
        : { host };
      (req as IncomingMessage & { [ADCP_SERVE_REQUEST_CONTEXT]?: ServeRequestContext })[ADCP_SERVE_REQUEST_CONTEXT] =
        serveRequestContext;

      // Body buffering happens at most once per request. An idempotent helper
      // lets the auth path (for signature authenticators) and the preTransport
      // path share the buffer without re-reading a drained stream.
      let rawBody: string | undefined;
      let parsedBody: unknown;
      const ensureRawBody = async (): Promise<void> => {
        if (rawBody !== undefined) return;
        rawBody = await bufferBody(req);
        (req as { rawBody?: string }).rawBody = rawBody;
        if (rawBody.length > 0) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            // Non-JSON body — let transport reject as malformed JSON-RPC.
          }
        }
      };

      // RFC 9421 signature authenticators need `req.rawBody` for Content-Digest
      // recompute, so buffer before authentication runs when the authenticator
      // (or any branch of an anyOf composition) carries the needs-raw-body tag.
      if (authenticatorNeedsRawBody(options?.authenticate)) {
        try {
          await ensureRawBody();
        } catch (err) {
          // `bufferBody` has already called `req.destroy()` on the
          // oversize path; additional teardown here would race the
          // response write. Write the status and return.
          const errName = (err as Error).name || 'Error';
          console.error(`[adcp/serve] request body read failed before auth: ${errName}`);
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body read failed.' }));
          }
          return;
        }
      }

      // Enforce authentication before transport work.
      if (options?.authenticate) {
        let principal: AuthPrincipal | null;
        try {
          principal = await options.authenticate(req);
        } catch (err) {
          // Surface only sanitized messages to the client; log internal cause server-side.
          const publicMessage = err instanceof AuthError ? err.publicMessage : 'Credentials rejected.';
          console.error('[adcp/auth] rejected:', err);
          // Switch challenge scheme to `Signature` when the rejection
          // originates in the RFC 9421 verifier — the signed_requests
          // negative-vector grader reads the error code from the
          // `WWW-Authenticate` header, so collapsing it into the generic
          // `Bearer error="invalid_token"` challenge would surface the
          // wrong code and fail every negative vector.
          const signatureCode = signatureErrorCodeFromCause(err);
          if (signatureCode) {
            respondUnauthorized(req, res, {
              signatureError: signatureCode,
              errorDescription: publicMessage,
              resourceMetadata: resourceMetadataUrl,
            });
            return;
          }
          respondUnauthorized(req, res, {
            error: 'invalid_token',
            errorDescription: publicMessage,
            resourceMetadata: resourceMetadataUrl,
          });
          return;
        }
        if (!principal) {
          respondUnauthorized(req, res, {
            error: 'invalid_token',
            errorDescription: 'Missing or unrecognized credentials.',
            resourceMetadata: resourceMetadataUrl,
          });
          return;
        }
        // Propagate to MCP transport so tool handlers see `extra.authInfo`.
        attachAuthInfo(req, principal);
      }

      // Create the agent first so we can inspect it for an auto-wired
      // preTransport attached by `createAdcpServer({ signedRequests })`. An
      // explicit `options.preTransport` wins — it lets callers override the
      // default wiring (e.g., to add request logging or swap verifier
      // implementations).
      let agentServer: AdcpServer | McpServer;
      try {
        agentServer = createAgent({ taskStore, host });
      } catch (err) {
        if (err instanceof UnknownHostError) {
          // Factory signalled "this host isn't routable." 404 keeps the
          // adapter table off the wire while giving ops a clean failure
          // mode instead of the generic-500 confusion.
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        // Unexpected factory failure — surface as 500 to the client and
        // log server-side. Rethrowing would bubble to the createServer
        // handler as an unhandled rejection (async callback), which
        // could crash a node process with `--unhandled-rejections=strict`.
        console.error('[adcp/serve] factory threw:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
      }
      // Refuse `reuseAgent: true` + function-form `instructions`. The function
      // is captured at server construction and would not re-evaluate per
      // session under server reuse — silently degrading to "instructions are
      // a constant after all" is worse than failing loud at the first request.
      // Adopters fix this by removing `reuseAgent: true` (default factory
      // creates a fresh agent per request, which is what the function needs)
      // OR by passing a static string for `instructions`.
      //
      // The check fires when `reuseAgent: true` was declared, regardless of
      // whether the adopter's factory actually caches. The flag is the
      // adopter's stated intent to reuse; we can't introspect cache behavior.
      if (reuseAgent && (agentServer as unknown as Record<symbol, unknown>)[ADCP_INSTRUCTIONS_FN] === true) {
        const hint =
          'Drop `reuseAgent: true` (a fresh agent per request fires the function each session) OR pass a static string for `instructions`.';
        console.error(
          '[adcp/serve] refusing reuseAgent: true with function-form instructions. ' +
            'The function is captured once at construction and would not re-evaluate per session under server reuse. ' +
            hint
        );
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'serve(): reuseAgent is incompatible with function-form instructions',
              hint,
            })
          );
        }
        return;
      }
      const attached = (agentServer as unknown as Record<symbol, unknown>)[ADCP_PRE_TRANSPORT];
      const autoWiredPreTransport = typeof attached === 'function' ? (attached as AdcpPreTransport) : undefined;
      const activePreTransport = explicitPreTransport ?? autoWiredPreTransport;

      if (activePreTransport) {
        try {
          await ensureRawBody();
          const handled = await activePreTransport(req as import('http').IncomingMessage & { rawBody?: string }, res);
          if (handled) {
            // PreTransport already responded (401, etc.). Close the agent
            // before returning so the McpServer doesn't leak.
            await agentServer.close();
            return;
          }
        } catch (err) {
          // Narrow to name+code — transport errors can embed remote URLs.
          const errName = (err as Error).name || 'Error';
          const errCode = (err as { code?: string }).code ?? 'unknown';
          console.error(`preTransport middleware error: ${errName} (${errCode})`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
          await agentServer.close();
          return;
        }
      }

      // In reuseAgent mode, serialize connect→handle→close per server
      // instance. `McpServer.connect()` rejects when a transport is
      // already attached (protocol.js:215), so concurrent requests on a
      // cached server would race without this chain. Requests on
      // DIFFERENT servers (different WeakMap keys) proceed in parallel.
      // Outside reuseAgent mode the factory returns a fresh server per
      // request — no shared instance, no lock needed.
      const runTransportCycle = async (): Promise<void> => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        try {
          await agentServer.connect(transport);
          // When preTransport already consumed the request stream, pass the
          // parsed body through so the transport doesn't re-read (stream is
          // drained). MCP SDK's `handleRequest(req, res, parsedBody)` accepts
          // this shape.
          if (parsedBody !== undefined) {
            await transport.handleRequest(req, res, parsedBody);
          } else {
            await transport.handleRequest(req, res);
          }
        } catch (err) {
          console.error('Server error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        } finally {
          // close() here releases the transport AND (in reuseAgent mode)
          // resets `_transport = undefined` on the cached server so the
          // next queued request can connect. The server's tools,
          // handlers, and idempotency wiring survive — close() clears
          // the transport, not the registration.
          await agentServer.close();
        }
      };

      if (reuseAgent) {
        const prev = reuseMutexes.get(agentServer) ?? Promise.resolve();
        // `.then(runTransportCycle, runTransportCycle)` runs the cycle on
        // EITHER prior outcome — we only care about sequencing, not the
        // prior request's result. A plain `.then(runTransportCycle)`
        // would skip this request when the prior rejected, leaving it
        // stuck behind a poison-pill promise forever.
        const current = prev.then(runTransportCycle, runTransportCycle);
        // Swallow errors on the copy stored for sequencing so one
        // rejection doesn't poison every subsequent request for this
        // server instance. `current` itself is still awaited below and
        // surfaces errors to THIS request.
        reuseMutexes.set(
          agentServer,
          current.catch(() => {})
        );
        await current;
      } else {
        await runTransportCycle();
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  const doListen = () => {
    httpServer.listen(port, () => {
      const actualPort = (httpServer.address() as { port: number }).port;
      const url = `http://localhost:${actualPort}${mountPath}`;
      if (options?.onListening) {
        options.onListening(url);
      } else {
        console.log(`AdCP agent running at ${url}`);
        console.log(`\nTest with:\n  npx @adcp/sdk@latest ${url}`);
      }
    });
  };

  if (options?.readinessCheck) {
    options
      .readinessCheck()
      .then(doListen)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[adcp/serve] readinessCheck failed — aborting boot:', message);
        process.exit(1);
      });
  } else {
    doListen();
  }

  return httpServer;
}

function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return s.slice(0, end);
}

/**
 * Parse and validate a `publicUrl`, returning its origin. Shared by the
 * static-string path (validated once at `serve()` construction) and the
 * function path (validated lazily per unique host). A bad value from the
 * function form throws on the first request for that host, after PRM
 * resolution has already decided to fetch; the error is caught at the
 * call site and surfaced as a 500 so the operator sees the misconfigured
 * host instead of a silent audience-mismatch on minted tokens.
 */
function validatePublicUrl(publicUrl: string, mountPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error(`serve(): \`publicUrl\` is not a valid URL: ${publicUrl}`);
  }
  if (trimTrailingSlashes(parsed.pathname) !== trimTrailingSlashes(mountPath)) {
    throw new Error(
      `serve(): \`publicUrl\` path (${parsed.pathname}) must match mount path (${mountPath}). ` +
        'The public URL is the full MCP endpoint URL, including the path.'
    );
  }
  return parsed.origin;
}

/**
 * Strip the port from a `host` string (`"snap.example.com:3001"` →
 * `"snap.example.com"`). Use inside `publicUrl` / `protectedResource`
 * resolvers to build scheme://host URLs without carrying the test-time
 * port into production URLs. IPv6 brackets preserved.
 */
export function hostname(host: string): string {
  if (host.startsWith('[')) {
    // IPv6 — preserve brackets, drop port after the closing bracket.
    const end = host.indexOf(']');
    if (end === -1) return host;
    return host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Resolve the canonical host the request arrived on for multi-host
 * routing and per-host PRM / audience advertisement. Same logic
 * `serve()` uses internally — exported so callers writing their own
 * host-dispatch middleware (e.g., behind `createExpressAdapter`) can
 * match `serve()`'s semantics exactly instead of re-implementing them.
 *
 * When `options.trustForwardedHost: true`, consults in order:
 *   1. `X-Forwarded-Host` (most common — Fly, Cloud Run, most ALBs).
 *   2. RFC 7239 `Forwarded: host=...` (spec-standard, less common).
 *   3. `Host`.
 *
 * When `trustForwardedHost: false` (default), only `Host` is read — an
 * attacker-controlled forwarded header can't flip the advertised OAuth
 * `resource` URL.
 *
 * **Proxy behavior matters when you opt in.** The helper trusts the
 * FIRST entry in a forwarded chain. That's safe when your proxy
 * OVERWRITES the header on ingress (rewriting the original value from
 * the client). It's UNSAFE when your proxy APPENDS — the attacker gets
 * to pick the first entry. Fly, Cloud Run, and GCP HTTPS LBs overwrite;
 * AWS ALB and nginx (by default) append. Verify your proxy's behavior
 * before enabling `trustForwardedHost`.
 *
 * Normalizes to lowercase and preserves port. Returns empty string when
 * no usable header is present (HTTP/1.1 requires `Host`, so this is
 * unusual — callers can branch on it to fail closed).
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { resolveHost } from '@adcp/sdk/server';
 *
 * const routersByHost = new Map<string, express.Router>();
 *
 * function hostDispatch(req, res, next) {
 *   const host = resolveHost(req, { trustForwardedHost: true });
 *   const router = routersByHost.get(host);
 *   if (!router) return res.status(404).end();
 *   return router(req, res, next);
 * }
 * ```
 */
export function resolveHost(req: IncomingMessage, options?: { trustForwardedHost?: boolean }): string {
  const trustForwardedHost = options?.trustForwardedHost === true;
  if (trustForwardedHost) {
    const xfh = firstHeaderValue(req.headers['x-forwarded-host']);
    if (xfh) {
      const first = xfh.split(',')[0]?.trim();
      if (first) return first.toLowerCase();
    }
    const forwarded = firstHeaderValue(req.headers['forwarded']);
    if (forwarded) {
      const host = parseForwardedHost(forwarded);
      if (host) return host.toLowerCase();
    }
  }
  const host = firstHeaderValue(req.headers['host']);
  return host ? host.toLowerCase() : '';
}

/**
 * Extract the `host=` parameter from an RFC 7239 `Forwarded:` header.
 * Takes the first (left-most) hop — same policy as the `X-Forwarded-Host`
 * chain rule above, and subject to the same "your proxy must overwrite,
 * not append" guarantee.
 *
 * Handles quoted-string values per RFC 7239 §4 (IPv6 literals and hosts
 * with ports must be quoted). Returns undefined when the header has no
 * `host` parameter, a malformed value, or a blank host.
 */
function parseForwardedHost(header: string): string | undefined {
  // Multi-hop: `Forwarded: for=1;host=a.example, for=2;host=b.example` —
  // first hop is the client-facing proxy's view. Commas INSIDE quoted
  // strings aren't separators, so a naive split would mis-parse IPv6.
  // Scan manually, respecting quotes.
  const firstHop = extractFirstForwardedHop(header);
  if (!firstHop) return undefined;
  for (const pair of firstHop.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    if (key !== 'host') continue;
    let value = pair.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    return value || undefined;
  }
  return undefined;
}

function extractFirstForwardedHop(header: string): string | undefined {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === '"') {
      // Skip the quoted run, respecting backslash escapes.
      i++;
      while (i < header.length && header[i] !== '"') {
        if (header[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === ',' && depth === 0) {
      return header.slice(start, i);
    }
  }
  return header.slice(start).trim() || undefined;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function attachAuthInfo(req: IncomingMessage, principal: AuthPrincipal): void {
  // Propagate the kind-discriminated `credential` (Stage 3 of #1269) into
  // `info.extra.credential` so the dispatcher can hoist it to top-level
  // `ctx.authInfo.credential` and pass it to `BuyerAgentRegistry.resolve`.
  // MCP's `extra` is `Record<string, unknown>`, so this round-trips
  // without a wire-shape change. Adopters with custom authenticators that
  // don't stamp `credential` see the registry resolve to `null` (no
  // credential = no known agent), preserving Stage 2's strict opt-in.
  const baseExtra = principal.claims !== undefined ? { ...principal.claims } : undefined;
  const extra =
    principal.credential !== undefined ? { ...(baseExtra ?? {}), credential: principal.credential } : baseExtra;
  const info: AuthInfo = {
    token: principal.token ?? '',
    clientId: principal.principal,
    scopes: principal.scopes ?? [],
    ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
  (req as IncomingMessage & { auth?: AuthInfo }).auth = info;
}

function bufferBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 2 * 1024 * 1024; // 2 MiB — generous for MCP JSON-RPC payloads
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error(`Request body exceeded ${MAX} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
