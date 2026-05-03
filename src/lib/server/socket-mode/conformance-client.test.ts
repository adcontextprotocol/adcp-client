import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ConformanceClient } from './conformance-client';

class TestServerSideTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (msg: JSONRPCMessage) => void;
  sessionId?: string = 'test';
  private closed = false;

  constructor(private socket: WebSocket) {}

  async start(): Promise<void> {
    this.socket.on('message', data => {
      try {
        const parsed = JSONRPCMessageSchema.safeParse(JSON.parse(data.toString('utf-8')));
        if (parsed.success) this.onmessage?.(parsed.data);
        else this.onerror?.(new Error(parsed.error.message));
      } catch (err) {
        this.onerror?.(err as Error);
      }
    });
    this.socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(msg), err => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

let httpServer: HttpServer;
let wss: WebSocketServer;
let port: number;
let acceptedConnections: WebSocket[] = [];
let serverSideClients: MCPClient[] = [];

beforeAll(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (_req, socket, head) => {
    wss.handleUpgrade(_req, socket, head, async ws => {
      acceptedConnections.push(ws);
      const transport = new TestServerSideTransport(ws);
      const client = new MCPClient({ name: 'runner-test', version: '0.0.1' }, { capabilities: {} });
      serverSideClients.push(client);
      try {
        await client.connect(transport);
      } catch {
        ws.close();
      }
    });
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await Promise.all(
    acceptedConnections.map(
      c =>
        new Promise<void>(r => {
          c.close();
          r();
        })
    )
  );
  wss.close();
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
});

function buildAdopterServer(): MCPServer {
  const server = new MCPServer({ name: 'adopter-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'ping', description: 'health', inputSchema: { type: 'object', properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    if (req.params.name === 'ping') {
      return { content: [{ type: 'text' as const, text: 'pong' }] };
    }
    throw new Error(`unknown tool ${req.params.name}`);
  });
  return server;
}

describe('ConformanceClient', () => {
  it('connects, exposes the adopter MCP server, and serves tools/list + tools/call', async () => {
    const idx = acceptedConnections.length;
    const client = new ConformanceClient({
      url: `ws://127.0.0.1:${port}/conformance/connect`,
      token: 'irrelevant-for-this-test',
      server: buildAdopterServer(),
      reconnect: false,
    });
    await client.start();
    expect(client.getStatus()).toBe('connected');

    // wait for the server-side client to finish initialize
    const deadline = Date.now() + 2000;
    while (serverSideClients.length <= idx && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    const runner = serverSideClients[idx];
    expect(runner).toBeTruthy();

    const listed = await runner.listTools();
    expect(listed.tools.map(t => t.name)).toEqual(['ping']);

    const called = await runner.callTool({ name: 'ping', arguments: {} });
    const content = (called.content as Array<{ text: string }>) ?? [];
    expect(content[0]?.text).toBe('pong');

    await client.close();
  });

  it('emits status transitions via onStatus', async () => {
    const transitions: string[] = [];
    const client = new ConformanceClient({
      url: `ws://127.0.0.1:${port}/conformance/connect`,
      token: 't',
      server: buildAdopterServer(),
      reconnect: false,
      onStatus: s => transitions.push(s),
    });
    await client.start();
    await client.close();
    expect(transitions).toContain('connecting');
    expect(transitions).toContain('connected');
    expect(transitions).toContain('idle');
  });

  it('reports error status when the URL is unreachable (no reconnect)', async () => {
    const client = new ConformanceClient({
      url: `ws://127.0.0.1:1/conformance/connect`,
      token: 't',
      server: buildAdopterServer(),
      reconnect: false,
    });
    await expect(client.start()).rejects.toThrow();
    expect(['error', 'disconnected']).toContain(client.getStatus());
  });
});
