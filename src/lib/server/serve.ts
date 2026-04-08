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
 * const server = createTaskCapableServer('My Agent', '1.0.0');
 * server.tool('get_signals', 'Discover audiences.', schema, handler);
 *
 * serve(server); // listening on http://localhost:3001/mcp
 * ```
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer, type Server as HttpServer } from 'http';

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
 * @param createAgent - Factory function that returns a configured McpServer,
 *   OR a pre-built McpServer instance. A factory is recommended so each
 *   request gets a fresh server instance.
 * @param options - Port, path, and callback configuration.
 * @returns The http.Server instance (already listening).
 */
export function serve(createAgent: McpServer | (() => McpServer), options?: ServeOptions): HttpServer {
  const port = options?.port ?? (process.env.PORT ? parseInt(process.env.PORT) : 3001);
  const mountPath = options?.path ?? '/mcp';

  const getAgent = typeof createAgent === 'function' ? createAgent : () => createAgent;

  const httpServer = createServer(async (req, res) => {
    const url = req.url || '';
    if (url === mountPath || url === `${mountPath}/`) {
      const agentServer = getAgent();
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
    const url = `http://localhost:${port}${mountPath}`;
    if (options?.onListening) {
      options.onListening(url);
    } else {
      console.log(`AdCP agent running at ${url}`);
      console.log(`\nTest with:\n  npx @adcp/client ${url}`);
    }
  });

  return httpServer;
}
