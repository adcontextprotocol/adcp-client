/**
 * Regression test for issue #1233: getAgentInfo() lacked the SSE-fallback /
 * StreamableHTTP-retry semantics that withCachedConnection has.
 *
 * Verifies the fix by exercising the StreamableHTTP retry path: the server
 * fails the second initialize POST (the one getAgentInfo issues after
 * discovery) with a 400, then accepts the retry. Before the fix, getAgentInfo
 * called connectMCP which has no retry — first error was fatal. After the fix,
 * it routes through connectMCPWithFallback which retries once on
 * StreamableHTTPError.
 *
 * Also pins issue #1234: when discovery exhausts every candidate with no 401,
 * the error message contains a hint that agent_uri probably points at the
 * wrong path.
 *
 * Pattern: real loopback HTTP server speaking minimal StreamableHTTP JSON-RPC,
 * mirroring `test/unit/mcp-tool-size-limit.test.js`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AdCPClient } = require('../../dist/lib/index.js');
const { closeMCPConnections } = require('../../dist/lib/protocols');
const { connectMCPWithFallback } = require('../../dist/lib/protocols/mcp.js');

let server;
let baseUrl;
let initCount = 0;

before(async () => {
  server = http.createServer((req, res) => {
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
        initCount++;
        // Fail the second initialize (getAgentInfo's fresh connection) once.
        // The retry path inside connectMCPWithFallback should reissue it and
        // see the success response below.
        if (initCount === 2) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Session not found' } }));
          return;
        }
        const protocolVersion = msg.params?.protocolVersion ?? '2025-03-26';
        const reply = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'stub-mcp', version: '0.0.1' },
          },
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'mcp-session-id': `test-session-${initCount}`,
        });
        res.end(reply);
        return;
      }

      if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }

      if (msg.method === 'tools/list') {
        const reply = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              { name: 'get_products', description: 'Get products', inputSchema: { type: 'object', properties: { brief: { type: 'string' } } } },
              { name: 'get_adcp_capabilities', description: 'Capabilities', inputSchema: { type: 'object' } },
            ],
          },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(reply);
        return;
      }

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

describe('getAgentInfo() — connectMCPWithFallback wiring (#1233)', () => {
  it('recovers from a transient 400 on the post-discovery initialize via the StreamableHTTP retry path', async () => {
    initCount = 0;
    const client = new AdCPClient([
      { id: 'stub', name: 'stub-mcp', protocol: 'mcp', agent_uri: `${baseUrl}/mcp` },
    ]);

    const info = await client.agent('stub').getAgentInfo();

    assert.strictEqual(info.protocol, 'mcp');
    assert.strictEqual(info.tools.length, 2);
    assert.deepStrictEqual(
      info.tools.map(t => t.name).sort(),
      ['get_adcp_capabilities', 'get_products']
    );
    // The server returns 400 on the second initialize. Reaching listTools
    // requires the retry-on-StreamableHTTPError path to succeed — which only
    // exists in connectMCPWithFallback, not connectMCP. The exact count
    // depends on discovery internals; the behavior assertion (tools returned)
    // is what pins the fix.
    assert.ok(initCount >= 2, `expected at least 2 initialize calls, got ${initCount}`);
  });
});

describe('connectMCPWithFallback — SSE fallback fires for non-private addresses (#1233)', () => {
  // The isPrivateAddress() gate skips SSE fallback for loopback to surface
  // StreamableHTTP failures locally. To pin SSE-fallback behavior we mock
  // global fetch and use a public-looking URL so the gate doesn't fire.
  // We don't need the SSE handshake to complete — we only need to confirm
  // a GET was issued after the POST failed, which is the signal that the
  // SSE transport was constructed and tried.
  it('falls back to SSE GET after StreamableHTTP POST fails on a public URL', async () => {
    const originalFetch = globalThis.fetch;
    let postCount = 0;
    let getCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? input?.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        postCount++;
        return new Response('not found', { status: 404, headers: { 'content-type': 'application/json' } });
      }
      getCount++;
      // Returning 404 on GET means SSE also fails — that's fine. We're only
      // checking that the SSE GET was issued, proving the fallback path ran.
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    };
    try {
      await assert.rejects(
        connectMCPWithFallback(new URL('https://agent.example.test/mcp'), {}, [], 'sse-fallback-pin'),
        () => true
      );
      assert.ok(postCount >= 1, `expected at least 1 POST (StreamableHTTP), got ${postCount}`);
      assert.ok(getCount >= 1, `expected at least 1 GET (SSE fallback), got ${getCount}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does NOT fall back to SSE for loopback addresses (gate preserved)', async () => {
    const originalFetch = globalThis.fetch;
    let getCount = 0;
    globalThis.fetch = async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') getCount++;
      return new Response('not found', { status: 404 });
    };
    try {
      await assert.rejects(
        connectMCPWithFallback(new URL('http://127.0.0.1:1/mcp'), {}, [], 'loopback-no-sse'),
        () => true
      );
      assert.strictEqual(getCount, 0, 'SSE fallback must not fire for loopback addresses');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('discoverMCPEndpoint — wrong-path hint (#1234)', () => {
  it('appends a wrong-path hint when no candidate responds with 200 or 401', async () => {
    // Empty stub server: every POST returns 404, no MCP endpoint anywhere.
    const noMcpServer = http.createServer((_, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise(resolve => noMcpServer.listen(0, '127.0.0.1', resolve));
    const { port } = noMcpServer.address();
    const noMcpBase = `http://127.0.0.1:${port}`;

    try {
      const client = new AdCPClient([
        { id: 'no-mcp', name: 'no-mcp', protocol: 'mcp', agent_uri: noMcpBase },
      ]);

      await assert.rejects(
        () => client.agent('no-mcp').getAgentInfo(),
        err => {
          assert.match(err.message, /Failed to discover MCP endpoint/);
          assert.match(
            err.message,
            /Hint:.*agent_uri.*does not include the MCP endpoint path/i,
            `expected wrong-path hint in: ${err.message}`
          );
          assert.match(err.message, /\/api\/mcp|\/v1\/mcp/, 'expected example paths in hint');
          return true;
        }
      );
    } finally {
      await new Promise(resolve => noMcpServer.close(resolve));
    }
  });
});
