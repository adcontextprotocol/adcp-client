/**
 * Adopter-facing Socket Mode client.
 *
 * Opens an outbound WebSocket from your dev/staging environment to a
 * remote AdCP runner (typically Addie at agenticadvertising.org) and
 * exposes your existing MCP `Server` over it. The remote runner can
 * then drive `tools/list`, `tools/call`, etc. against your server
 * exactly as if it had reached you over HTTP — no public DNS, no
 * inbound exposure.
 *
 * Three-line integration:
 *
 * ```ts
 * import { ConformanceClient } from '@adcp/sdk/server';
 * import { mcpServer } from './my-mcp-server';
 *
 * const client = new ConformanceClient({
 *   url: 'wss://addie.agenticadvertising.org/conformance/connect',
 *   token: process.env.ADCP_CONFORMANCE_TOKEN!,
 *   server: mcpServer,
 * });
 * await client.start();
 * ```
 *
 * Reconnect: exponential backoff capped at 30s. Stop via `close()` to
 * opt out of further reconnect attempts.
 *
 * Dev/staging only by design — production deployments must not expose
 * `comply_test_controller` on any surface, including this channel.
 * See [adcontextprotocol/adcp#3986](https://github.com/adcontextprotocol/adcp/issues/3986).
 */

import WebSocket from 'ws';
import type { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { WebSocketTransport } from './ws-transport';

export type ConformanceStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ConformanceClientOptions {
  /**
   * The remote runner's WebSocket URL. For Addie this is
   * `wss://addie.agenticadvertising.org/conformance/connect` in
   * production, `ws://localhost:3000/conformance/connect` in dev.
   */
  url: string;

  /**
   * Adopter-account-bound token issued by the runner. For Addie, ask in
   * chat ("give me a fresh conformance token") or POST /api/conformance/token.
   * Tokens are short-lived (typically 1h); on expiry, re-request and
   * pass the new token via a fresh `ConformanceClient`.
   */
  token: string;

  /**
   * Your existing MCP server. The same instance you'd connect to
   * `StreamableHTTPServerTransport` for normal traffic — this client
   * exposes it bidirectionally over the outbound WebSocket.
   */
  server: MCPServer;

  /**
   * If true (default), reconnect on disconnect with exponential backoff
   * up to 30s. Set false for one-shot connections.
   */
  reconnect?: boolean;

  /**
   * Status callback. Fires on every state transition. Useful for
   * surfacing connection state in dev tooling or CI logs.
   */
  onStatus?: (status: ConformanceStatus, detail?: { error?: Error; attempt?: number }) => void;
}

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class ConformanceClient {
  private status: ConformanceStatus = 'idle';
  private socket?: WebSocket;
  private transport?: WebSocketTransport;
  private stopped = false;
  private reconnectAttempt = 0;
  private readonly opts: Required<Pick<ConformanceClientOptions, 'reconnect'>> & ConformanceClientOptions;

  constructor(opts: ConformanceClientOptions) {
    this.opts = { reconnect: true, ...opts };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.transport) {
      await this.transport.close();
    } else if (this.socket) {
      this.socket.close(1000, 'adopter close');
    }
    this.setStatus('idle');
  }

  getStatus(): ConformanceStatus {
    return this.status;
  }

  private async connect(): Promise<void> {
    this.setStatus('connecting');
    const url = new URL(this.opts.url);
    url.searchParams.set('token', this.opts.token);
    const socket = new WebSocket(url.toString());
    this.socket = socket;
    const transport = new WebSocketTransport(socket);
    this.transport = transport;

    socket.once('close', () => {
      this.setStatus('disconnected');
      if (!this.stopped && this.opts.reconnect) {
        void this.scheduleReconnect();
      }
    });

    try {
      await this.opts.server.connect(transport);
      this.reconnectAttempt = 0;
      this.setStatus('connected');
    } catch (err) {
      this.setStatus('error', { error: err as Error });
      socket.close(1011, 'connect failed');
      if (!this.stopped && this.opts.reconnect) {
        void this.scheduleReconnect();
      }
      throw err;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.reconnectAttempt += 1;
    const delay = Math.min(RECONNECT_INITIAL_MS * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_MS);
    this.setStatus('connecting', { attempt: this.reconnectAttempt });
    await new Promise(r => setTimeout(r, delay));
    if (this.stopped) return;
    try {
      await this.connect();
    } catch {
      // setStatus already invoked; loop continues via the close handler
    }
  }

  private setStatus(status: ConformanceStatus, detail?: { error?: Error; attempt?: number }): void {
    this.status = status;
    this.opts.onStatus?.(status, detail);
  }
}
