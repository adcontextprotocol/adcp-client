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
import { createServer, type Server as HttpServer } from 'http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

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
   * Pre-MCP middleware — runs after path-matching but before MCP transport
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

  const httpServer = createServer(async (req, res) => {
    const { pathname } = new URL(req.url || '', 'http://localhost');
    if (pathname === mountPath || pathname === `${mountPath}/`) {
      // Buffer the request body once when preTransport middleware is wired —
      // RFC 9421 verifiers need the raw bytes for Content-Digest recompute,
      // and the MCP transport's own body read would race the verifier otherwise.
      let parsedBody: unknown;
      if (options?.preTransport) {
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
          const handled = await options.preTransport(req as import('http').IncomingMessage & { rawBody?: string }, res);
          if (handled) return;
        } catch (err) {
          console.error('preTransport middleware error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
          return;
        }
      }
      const agentServer = createAgent(ctx);
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
