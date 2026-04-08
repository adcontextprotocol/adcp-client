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
 * function createAgent() {
 *   const server = createTaskCapableServer('My Agent', '1.0.0');
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

export interface ServeOptions {
  /** Port to listen on. Defaults to PORT env var or 3001. */
  port?: number;
  /** HTTP path to mount the MCP endpoint on. Defaults to '/mcp'. */
  path?: string;
  /** Called when the server starts listening. */
  onListening?: (url: string) => void;
}

/**
 * Start an HTTP server that serves an AdCP MCP agent.
 *
 * Creates a new MCP server instance per request (stateless), wires up the
 * StreamableHTTPServerTransport, and returns the underlying http.Server
 * for lifecycle control.
 *
 * @param createAgent - Factory function that returns a configured McpServer.
 *   Called once per request so each gets a fresh server instance (McpServer
 *   can only be connected once).
 * @param options - Port, path, and callback configuration.
 * @returns The http.Server instance. Use the `onListening` callback or
 *   listen for the 'listening' event to know when it's ready.
 */
export function serve(createAgent: () => McpServer, options?: ServeOptions): HttpServer {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  if (envPort !== undefined && (Number.isNaN(envPort) || envPort < 0 || envPort > 65535)) {
    throw new Error(`Invalid PORT environment variable: "${process.env.PORT}"`);
  }
  const port = options?.port ?? envPort ?? 3001;
  const mountPath = options?.path ?? '/mcp';

  const httpServer = createServer(async (req, res) => {
    const { pathname } = new URL(req.url || '', 'http://localhost');
    if (pathname === mountPath || pathname === `${mountPath}/`) {
      const agentServer = createAgent();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await agentServer.connect(transport);
        await transport.handleRequest(req, res);
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
