/**
 * Integration check that MCP tool calls honor `maxResponseBytes`.
 *
 * The cap is installed via `wrapFetchWithSizeLimit` in two call sites in
 * `src/lib/protocols/mcp.ts`: line 319 (non-OAuth `connectMCPWithFallbackImpl`)
 * and line 660 (OAuth `connectMCP`). Without a live-HTTP test, dropping
 * `wrapFetchWithSizeLimit` from either site wouldn't fail any existing unit
 * test because the unit tests mock the fetch chain below the transport layer.
 *
 * This test exercises the non-OAuth path (the common path for direct-token
 * agents and unauthenticated dev setups) end-to-end against a real loopback
 * HTTP server that speaks MCP StreamableHTTP. The assertion is:
 * "calling `ProtocolClient.callTool` with `transport.maxResponseBytes` set
 * aborts with `ResponseTooLargeError` when the server's `tools/call` response
 * body exceeds the cap."
 *
 * We use a real server rather than a fetch stub so the test pins the wiring
 * seam — the exact order `wrapFetchWithSizeLimit` is composed into the MCP
 * transport chain — rather than the unit behavior of the wrapper itself
 * (already covered by response-size-limit.test.js).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { ProtocolClient, closeMCPConnections } = require('../../dist/lib/protocols');
const { ResponseTooLargeError } = require('../../dist/lib/errors');

// Minimal MCP StreamableHTTP server.
// Handles: initialize → valid InitializeResult (small, under cap)
//          notifications (no id) → 202
//          tools/call → oversized JSON-RPC result with Content-Length set
// All other methods return a null JSON-RPC result so the SDK doesn't stall.
function createMCPServer() {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      // Support batched and single JSON-RPC messages.
      const messages = Array.isArray(msg) ? msg : [msg];
      // Notifications have no `id` (or id === null) — no response body needed.
      const requests = messages.filter(m => m.id != null);

      if (requests.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }

      const responses = requests.map(rpc => {
        if (rpc.method === 'initialize') {
          return {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'test-mcp', version: '1.0.0' },
            },
          };
        }

        if (rpc.method === 'tools/call') {
          // 2 MB payload — well over any reasonable discovery cap.
          const padding = 'x'.repeat(2 * 1024 * 1024);
          return {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{ type: 'text', text: padding }],
            },
          };
        }

        // Unknown method — return null result so the SDK doesn't stall.
        return { jsonrpc: '2.0', id: rpc.id, result: null };
      });

      const responseBody =
        responses.length === 1 ? JSON.stringify(responses[0]) : JSON.stringify(responses);

      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(responseBody),
      });
      res.end(responseBody);
    });
  });
}

let server;
let agentUri;

before(async () => {
  server = createMCPServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  agentUri = `http://127.0.0.1:${port}`;
});

after(async () => {
  // Clear the MCP connection cache so the cached client pointing at our
  // now-closed loopback server doesn't leak into subsequent test runs.
  await closeMCPConnections();
  await new Promise(resolve => server.close(resolve));
});

describe('MCP tool call — maxResponseBytes', () => {
  it('aborts tools/call with ResponseTooLargeError when the response body exceeds the cap', async () => {
    // `initialize` returns ~200 bytes (well under the 64 KB cap).
    // `tools/call` returns 2 MB with Content-Length set — the pre-check in
    // `wrapFetchWithSizeLimit` cancels the body before any bytes are read.
    const agent = {
      id: 'test-mcp',
      name: 'Test MCP Agent',
      protocol: 'mcp',
      agent_uri: agentUri,
    };

    await assert.rejects(
      ProtocolClient.callTool(agent, 'check_size', {}, {
        transport: { maxResponseBytes: 64 * 1024 },
      }),
      err => {
        assert.ok(
          err instanceof ResponseTooLargeError,
          `expected ResponseTooLargeError, got ${err?.constructor?.name}: ${err?.message}`
        );
        assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
        assert.strictEqual(err.limit, 64 * 1024);
        // Server sets Content-Length → pre-check fires, bytesRead is 0.
        assert.strictEqual(err.bytesRead, 0);
        assert.ok(
          err.declaredContentLength > 64 * 1024,
          `declaredContentLength ${err.declaredContentLength} should exceed limit`
        );
        return true;
      }
    );
  });
});
