/**
 * Integration check that MCP tool calls honor `maxResponseBytes`.
 *
 * The cap is installed in `connectMCPWithFallbackImpl` (mcp.ts non-OAuth path,
 * ~line 319) as the innermost transport wrapper. `ProtocolClient.callTool` enters
 * the AsyncLocalStorage slot via `withResponseSizeLimit`, so the cap applies to
 * every fetch made by the transport during that call — including the StreamableHTTP
 * `initialize` handshake and the `tools/call` response.
 *
 * We test the wiring end-to-end against a real loopback HTTP server that speaks
 * minimal StreamableHTTP JSON-RPC. An oversized `tools/call` reply must abort with
 * `ResponseTooLargeError` before the body is buffered by the MCP SDK's JSON parser.
 *
 * **OAuth path coverage.** The OAuth path installs the same `wrapFetchWithSizeLimit`
 * wrapper independently (mcp.ts ~line 660). That path is intentionally not exercised
 * here — it requires an OAuth provider and the ALS / wrapper semantics are identical.
 *
 * **Pattern.** Mirrors `test/unit/a2a-card-size-limit.test.js` — real loopback server,
 * no MCP SDK dependency on the server side, same `before`/`after` lifecycle.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { ProtocolClient, closeMCPConnections } = require('../../dist/lib/protocols');
const { ResponseTooLargeError } = require('../../dist/lib/errors');

let server;
let baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    // Route by URL path: /big → oversized tools/call, /small → pass-through.
    const oversized = req.url === '/big';
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      if (msg.method === 'initialize') {
        // Echo the client's protocolVersion so the SDK accepts the response.
        const protocolVersion = msg.params?.protocolVersion ?? '2025-03-26';
        const reply = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion,
            capabilities: {},
            serverInfo: { name: 'stub-mcp', version: '0.0.1' },
          },
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'mcp-session-id': 'test-session-stub',
        });
        res.end(reply);
        return;
      }

      if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }

      if (msg.method === 'tools/call') {
        if (oversized) {
          // 5 MB — well above the 64 KB test cap. Setting Content-Length lets
          // the pre-check fire before any body bytes are read, making the test
          // deterministic without streaming 5 MB.
          const padding = 'x'.repeat(5 * 1024 * 1024);
          const reply = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: padding }] },
          });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(reply),
          });
          res.end(reply);
        } else {
          const reply = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'ok' }] },
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(reply);
        }
        return;
      }

      // Fallback for capability probes and unknown methods.
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: {} });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(reply);
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  closeMCPConnections();
  await new Promise(resolve => server.close(resolve));
});

describe('MCP tools/call — maxResponseBytes', () => {
  it('aborts a tools/call response with ResponseTooLargeError when it exceeds the cap', async () => {
    // Full wiring path under test:
    //   ProtocolClient.callTool
    //     → withResponseSizeLimit(64 KB)          (enters ALS slot)
    //     → callMCPToolWithTasks
    //       → withCachedConnection
    //         → connectMCPWithFallbackImpl
    //             wrapFetchWithSizeLimit(fetch)    (reads ALS slot per request)
    //         → MCPClient.connect()               (initialize — small, passes cap)
    //       → client.callTool()                   (tools/call — 5 MB declared,
    //                                              Content-Length pre-check fires)
    await assert.rejects(
      () =>
        ProtocolClient.callTool(
          { id: 'vendor-big', name: 'Stub MCP Big', protocol: 'mcp', agent_uri: `${baseUrl}/big` },
          'get_adcp_capabilities',
          {},
          { transport: { maxResponseBytes: 64 * 1024 } }
        ),
      err => {
        assert.ok(
          err instanceof ResponseTooLargeError,
          `expected ResponseTooLargeError, got ${err?.constructor?.name}: ${err?.message}`
        );
        assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
        assert.strictEqual(err.limit, 64 * 1024);
        // Server sets Content-Length so the pre-check fires before any body
        // bytes are read. `bytesRead` must be 0; `contentLengthHeader` is the
        // server's announced size.
        assert.strictEqual(err.bytesRead, 0);
        assert.ok(
          err.contentLengthHeader > 64 * 1024,
          `expected contentLengthHeader > ${64 * 1024}, got ${err.contentLengthHeader}`
        );
        return true;
      }
    );
  });

  it('lets a tools/call response through unchanged when the cap is generous', async () => {
    // Flush the cached connection from the first test so the small agent gets
    // a fresh StreamableHTTP session. The two URL paths are different (/big vs
    // /small) so they use separate connection-cache slots anyway, but clearing
    // is defensive against future cache-key changes.
    closeMCPConnections();

    // No ResponseTooLargeError — the stub returns a small 'ok' body at /small.
    const result = await ProtocolClient.callTool(
      { id: 'vendor-small', name: 'Stub MCP Small', protocol: 'mcp', agent_uri: `${baseUrl}/small` },
      'get_adcp_capabilities',
      {},
      { transport: { maxResponseBytes: 16 * 1024 * 1024 } }
    );

    // We don't assert on the result shape — the stub returns minimal JSON-RPC
    // and the response is unwrapped by the SDK. The assertion is "no
    // ResponseTooLargeError was thrown" (the rejects check above would have
    // caught it).
    assert.ok(result !== undefined, 'callTool should resolve when the cap is generous');
  });
});
