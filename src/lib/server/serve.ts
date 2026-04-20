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
 *   server.tool('get_signals', 'Discover audiences.', schema, handler);
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
import { AuthError, respondUnauthorized } from './auth';
import { ADCP_PRE_TRANSPORT, type AdcpPreTransport } from './create-adcp-server';

/**
 * Context passed to the agent factory on each request.
 *
 * Contains shared resources that must survive across stateless HTTP requests,
 * such as the task store for MCP Tasks protocol support.
 *
 * This helper is designed for single-tenant servers (one agent per process).
 * For multi-tenant deployments, provide a custom `TaskStore` via `ServeOptions`
 * that enforces tenant/session scoping.
 */
export interface ServeContext {
  /** Shared task store — use this when creating your McpServer so tasks persist across requests. */
  taskStore: TaskStore;
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
   */
  publicUrl?: string;

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
   */
  protectedResource?: ProtectedResourceMetadata;

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
 * @param createAgent - Factory function that returns a configured McpServer.
 *   Called once per request so each gets a fresh server instance (McpServer
 *   can only be connected once). Receives a `ServeContext` with a shared
 *   `taskStore` — pass it to `createTaskCapableServer()` so tasks persist.
 * @param options - Port, path, and callback configuration.
 * @returns The http.Server instance. Use the `onListening` callback or
 *   listen for the 'listening' event to know when it's ready.
 */
export function serve(createAgent: (ctx: ServeContext) => McpServer, options?: ServeOptions): HttpServer {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  if (envPort !== undefined && (Number.isNaN(envPort) || envPort < 0 || envPort > 65535)) {
    throw new Error(`Invalid PORT environment variable: "${process.env.PORT}"`);
  }
  const port = options?.port ?? envPort ?? 3001;
  const mountPath = options?.path ?? '/mcp';
  const taskStore = options?.taskStore ?? new InMemoryTaskStore();
  const ctx: ServeContext = { taskStore };

  if (options?.protectedResource && !options.publicUrl) {
    throw new Error(
      'serve(): `protectedResource` requires `publicUrl` (the canonical https:// URL clients use for this MCP endpoint). ' +
        'Without it, the server would advertise an attacker-controlled Host header as the OAuth resource URL.'
    );
  }

  const publicUrl = options?.publicUrl;
  let publicOrigin: string | undefined;
  if (publicUrl) {
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
    publicOrigin = parsed.origin;
  }

  if (options?.authenticate == null && process.env.NODE_ENV === 'production') {
    console.warn(
      '[adcp/serve] No `authenticate` configured — this agent will accept unauthenticated requests. ' +
        'AdCP security_baseline requires authentication in production.'
    );
  }

  const explicitPreTransport = options?.preTransport as AdcpPreTransport | undefined;

  const protectedResourcePath = `/.well-known/oauth-protected-resource${mountPath}`;
  const resourceMetadataUrl =
    options?.protectedResource && publicOrigin ? `${publicOrigin}${protectedResourcePath}` : undefined;

  const httpServer = createServer(async (req, res) => {
    const { pathname } = new URL(req.url || '', 'http://localhost');

    // RFC 9728 protected-resource metadata — intentionally auth-free so
    // clients can discover the authorization server before they have a token.
    if (options?.protectedResource && pathname === protectedResourcePath) {
      const body = {
        resource: publicUrl!,
        ...options.protectedResource,
        bearer_methods_supported: options.protectedResource.bearer_methods_supported ?? ['header'],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    if (pathname === mountPath || pathname === `${mountPath}/`) {
      // Enforce authentication before any body processing or transport work.
      if (options?.authenticate) {
        let principal: AuthPrincipal | null;
        try {
          principal = await options.authenticate(req);
        } catch (err) {
          // Surface only sanitized messages to the client; log internal cause server-side.
          const publicMessage = err instanceof AuthError ? err.publicMessage : 'Credentials rejected.';
          console.error('[adcp/auth] rejected:', err);
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
      const agentServer = createAgent(ctx);
      const attached = (agentServer as unknown as Record<symbol, unknown>)[ADCP_PRE_TRANSPORT];
      const autoWiredPreTransport = typeof attached === 'function' ? (attached as AdcpPreTransport) : undefined;
      const activePreTransport = explicitPreTransport ?? autoWiredPreTransport;

      // Buffer the request body once when preTransport middleware is wired —
      // RFC 9421 verifiers need the raw bytes for Content-Digest recompute,
      // and the MCP transport's own body read would race the verifier otherwise.
      let parsedBody: unknown;
      if (activePreTransport) {
        try {
          const raw = await bufferBody(req);
          (req as { rawBody?: string }).rawBody = raw;
          if (raw.length > 0) {
            try {
              parsedBody = JSON.parse(raw);
            } catch {
              // Non-JSON body — let transport reject as malformed JSON-RPC.
            }
          }
          const handled = await activePreTransport(req as import('http').IncomingMessage & { rawBody?: string }, res);
          if (handled) {
            // PreTransport already responded (401, etc.). Close the agent
            // before returning so the McpServer doesn't leak.
            await agentServer.close();
            return;
          }
        } catch (err) {
          // Narrow to name+code — transport errors can embed remote URLs.
          const errName = (err && (err as Error).name) || 'Error';
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
      console.log(`\nTest with:\n  npx @adcp/client ${url}`);
    }
  });

  return httpServer;
}

function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return s.slice(0, end);
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
