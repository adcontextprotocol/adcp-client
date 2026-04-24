/**
 * One-liner HTTP server for AdCP MCP agents.
 *
 * Wraps the StreamableHTTPServerTransport + http.createServer boilerplate
 * so agent builders can focus on business logic.
 *
 * @example
 * ```typescript
 * import { createTaskCapableServer, serve } from '@adcp/client';
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
import type { AuthPrincipal, Authenticator } from './auth';
import { AuthError, authenticatorNeedsRawBody, respondUnauthorized, signatureErrorCodeFromCause } from './auth';
import { ADCP_PRE_TRANSPORT, type AdcpPreTransport } from './create-adcp-server';
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
   * Trust `X-Forwarded-Host` / `X-Forwarded-Proto` for host resolution
   * and for reconstructing the public URL on 401 challenges. Default
   * `false`. Enable when `serve()` sits behind a proxy that sanitizes
   * these headers (Fly.io, Cloud Run, an internal ALB that overwrites
   * them). Leaving this off on the open internet lets an attacker pick
   * the advertised OAuth `resource` URL by spoofing the header — so the
   * framework ignores the forwarded value unless you opt in.
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
    const host = resolveHost(req, trustForwardedHost);

    // RFC 9728 protected-resource metadata — intentionally auth-free so
    // clients can discover the authorization server before they have a token.
    if (protectedResourceOption && pathname === protectedResourcePath) {
      let resource: string | undefined;
      let prm: ProtectedResourceMetadata | undefined;
      try {
        resource = resolvePublicUrl(host);
        prm = resolveProtectedResource(host);
      } catch (err) {
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
      // Resolve per-request `resource_metadata` URL for 401 challenges. For
      // static PRM this is the same string every request (same as before the
      // multi-host refactor); for function-form PRM it follows the host the
      // request arrived on so the challenge points at the right discovery
      // document.
      let resourceMetadataUrl: string | undefined;
      if (protectedResourceOption) {
        try {
          const hostOrigin = resolvePublicOrigin(host);
          if (hostOrigin) resourceMetadataUrl = `${hostOrigin}${protectedResourcePath}`;
        } catch (err) {
          console.error('[adcp/serve] publicUrl resolver failed:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Protected-resource metadata unavailable for this host.' }));
          return;
        }
      }

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
      const agentServer = createAgent({ taskStore, host });
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
        await agentServer.close();
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  httpServer.listen(port, () => {
    const actualPort = (httpServer.address() as { port: number }).port;
    const url = `http://localhost:${actualPort}${mountPath}`;
    if (options?.onListening) {
      options.onListening(url);
    } else {
      console.log(`AdCP agent running at ${url}`);
      console.log(`\nTest with:\n  npx @adcp/client@latest ${url}`);
    }
  });

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
 * Resolve the canonical host the request arrived on for multi-host
 * routing and per-host PRM / audience advertisement.
 *
 * `X-Forwarded-Host` is trusted only when `trustForwardedHost: true` —
 * otherwise an attacker could flip the advertised OAuth `resource` URL
 * by spoofing one header. When a comma-separated forwarded chain is
 * present the first (left-most) entry is the client-reported origin —
 * use it and let the operator's upstream sanitize what it forwards.
 *
 * Normalizes to lowercase and preserves port. Returns empty string when
 * neither header is present (HTTP/1.1 requires `Host`, so this is
 * unusual — factories can branch on it to fail closed).
 */
function resolveHost(req: IncomingMessage, trustForwardedHost: boolean): string {
  if (trustForwardedHost) {
    const forwarded = firstHeaderValue(req.headers['x-forwarded-host']);
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first.toLowerCase();
    }
  }
  const host = firstHeaderValue(req.headers['host']);
  return host ? host.toLowerCase() : '';
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function attachAuthInfo(req: IncomingMessage, principal: AuthPrincipal): void {
  const info: AuthInfo = {
    token: principal.token ?? '',
    clientId: principal.principal,
    scopes: principal.scopes ?? [],
    ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
    ...(principal.claims !== undefined ? { extra: { ...principal.claims } } : {}),
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
