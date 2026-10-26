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
const { DEFAULT_MAX_RESPONSE_BYTES } = require('../../dist/lib/protocols/responseSizeLimit');

let server;
let baseUrl;
// Octets the `/sse-flood` route has pushed at the client, across reconnects,
// and a hook the test arms to observe the client closing the stream on it.
let sseFloodBytes = 0;
// MCP `initialize` handshakes the stub has served. One per cached connection,
// so it reads as "how many distinct sessions did the client open?".
let initializeCount = 0;
let sseFloodTorndown = () => {};

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
        initializeCount += 1;
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
        if (req.url === '/sse-flood') {
          // A peer that answers a tool call with an endless `text/event-stream`
          // body. Before adcp-client#3253 this content type was exempt from the
          // cap, so changing one response header was a free opt-out.
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const frame = `: ${'x'.repeat(64 * 1024)}\n\n`;
          const pump = setInterval(() => {
            if (res.writableEnded || res.destroyed) return clearInterval(pump);
            // Keep writing through backpressure: a mock that stops on a false
            // return never exceeds the cap and would not test it.
            for (let i = 0; i < 8; i += 1) {
              sseFloodBytes += Buffer.byteLength(frame);
              res.write(frame);
            }
          }, 1);
          res.on('close', () => {
            if (!res.writableEnded) sseFloodTorndown();
            clearInterval(pump);
          });
          return;
        }
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
  await closeMCPConnections();
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
        assert.match(err.message, /Raise transport\.maxResponseBytes per client or per call/);
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
    // is defensive against future cache-key changes. `closeMCPConnections` is
    // async and bumps the connection generation: without the await the next
    // connect races the teardown and fails with "MCP connection completed
    // after connection teardown".
    await closeMCPConnections();

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

  it('caps a tools/call response at 4 MiB when no transport option is supplied', async () => {
    // The regression this change exists for: the hosted grader never opted
    // into a cap, so a ~17.8 MB `get_products` reply went straight into
    // memory. Note the absence of a `transport` argument below — if the
    // default is removed, this test buffers 5 MB and passes silently, so the
    // `limit` assertion is what keeps it honest.
    await closeMCPConnections();

    await assert.rejects(
      () =>
        ProtocolClient.callTool(
          { id: 'vendor-default', name: 'Stub MCP Default', protocol: 'mcp', agent_uri: `${baseUrl}/big` },
          'get_adcp_capabilities',
          {}
        ),
      err => {
        assert.ok(
          err instanceof ResponseTooLargeError,
          `expected ResponseTooLargeError, got ${err?.constructor?.name}: ${err?.message}`
        );
        assert.strictEqual(err.limit, DEFAULT_MAX_RESPONSE_BYTES);
        assert.strictEqual(err.limit, 4 * 1024 * 1024);
        return true;
      }
    );
  });

  it('gives calls with different caps different cached connections', async () => {
    // `wrapFetchWithSizeLimit` decides once per request whether to enforce,
    // and a long-lived GET listener issues exactly one request — at connect
    // time. If the connection cache ignored the cap, one
    // `maxResponseBytes: 0` call would hand an unwrapped session listener to
    // every later caller that reused the connection, turning a per-call
    // opt-out into a per-session one.
    await closeMCPConnections();
    const agent = { id: 'vendor-cache', name: 'Stub MCP Cache', protocol: 'mcp', agent_uri: `${baseUrl}/small` };

    // Era negotiation can handshake more than once per connection, so count
    // the delta rather than an absolute: non-zero means a new session.
    async function handshakesFor(transport) {
      const before = initializeCount;
      await ProtocolClient.callTool(
        agent,
        'get_adcp_capabilities',
        {},
        {
          transport: { connectionReuse: 'process', ...transport },
        }
      );
      return initializeCount - before;
    }

    assert.ok((await handshakesFor(undefined)) > 0, 'first call opens a session');
    assert.strictEqual(await handshakesFor(undefined), 0, 'same policy reuses the session');
    assert.strictEqual(
      await handshakesFor({ maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES }),
      0,
      'an explicit cap equal to the default is the same policy'
    );

    assert.ok(
      (await handshakesFor({ maxResponseBytes: 32 * 1024 * 1024 })) > 0,
      'a different cap must not inherit the first session'
    );
    assert.strictEqual(await handshakesFor({ maxResponseBytes: 32 * 1024 * 1024 }), 0, 'and then reuses its own');

    assert.ok((await handshakesFor({ maxResponseBytes: 0 })) > 0, 'an opt-out must not inherit a capped session');
    assert.strictEqual(await handshakesFor(undefined), 0, 'and the default-cap session is still there to come back to');
  });

  it('refuses an endless text/event-stream reply instead of letting it opt out of the cap', async () => {
    // Before adcp-client#3253 a peer could escape the cap entirely by
    // answering with `Content-Type: text/event-stream`. Two things must hold
    // now: the stream is torn down at the cumulative allowance rather than
    // drained for the whole request deadline, and the caller gets the typed
    // `ResponseTooLargeError` rather than the timeout the MCP SDK would
    // otherwise surface (it classifies a failed SSE read as a disconnect and
    // reconnects).
    await closeMCPConnections();
    sseFloodBytes = 0;
    let tornDownAt = 0;
    sseFloodTorndown = () => {
      tornDownAt = tornDownAt || Date.now();
    };

    const cap = 128 * 1024;
    const started = Date.now();
    await assert.rejects(
      () =>
        ProtocolClient.callTool(
          { id: 'vendor-sse', name: 'Stub MCP SSE', protocol: 'mcp', agent_uri: `${baseUrl}/sse-flood` },
          'get_adcp_capabilities',
          {},
          { transport: { maxResponseBytes: cap, requestTimeoutMs: 8_000 } }
        ),
      err => {
        assert.ok(
          err instanceof ResponseTooLargeError,
          `expected ResponseTooLargeError, got ${err?.constructor?.name}: ${err?.message}`
        );
        assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
        return true;
      }
    );

    // Teardown is what bounds memory, and it has to happen while the request
    // is still in flight — a cap that only fired at the deadline would never
    // fire at all on a stream that never ends.
    assert.ok(tornDownAt > 0, 'the server must have seen its peer close the stream');
    assert.ok(
      tornDownAt - started < 5_000,
      `teardown must happen well inside the 8 s deadline (${tornDownAt - started}ms)`
    );
    assert.ok(
      sseFloodBytes < 64 * 1024 * 1024,
      `the cap must tear the stream down, not drain it (server pushed ${sseFloodBytes} bytes)`
    );
  });
});
