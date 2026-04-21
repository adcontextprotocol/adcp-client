/**
 * End-to-end integration tests for OAuth 2.0 client credentials support.
 *
 * Unit tests (`test/oauth-client-credentials.test.js`) cover the exchange
 * helper with a stubbed fetch. This file covers the HTTP wire boundary
 * the unit tests cannot:
 * - `ProtocolClient.callTool` actually fetches a token, attaches it as a
 *   bearer, and the MCP server sees it.
 * - A mid-session token rotation triggers the 401-retry path
 *   (`src/lib/protocols/index.ts`) and the force-refresh.
 * - Concurrent callers coalesce onto one exchange.
 *
 * Pattern lifted from `test/request-signing-agent-integration.test.js`:
 * two in-process http stubs on ephemeral `127.0.0.1:0` ports, cleaned up
 * per-test.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { ProtocolClient } = require('../dist/lib/protocols/index.js');
const { closeMCPConnections } = require('../dist/lib/protocols/mcp.js');

/**
 * Minimal OAuth 2.0 client credentials token endpoint. Each call returns
 * a fresh `access_token`; `state.issued` lets tests assert how many
 * exchanges happened.
 */
async function startTokenServer() {
  const state = { issued: 0, lastRequest: undefined };
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      state.issued++;
      state.lastRequest = { body, authorization: req.headers.authorization };
      const token = `tok_${state.issued}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}/token`,
    state,
    stop: () => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

/**
 * Minimal MCP stub that gates every request on a bearer token. The set of
 * *accepted* tokens is mutable — tests rotate it to simulate the AS
 * rotating a session out from under us.
 */
async function startMcpStubWithBearerGate(initialAcceptedTokens) {
  const state = {
    acceptedTokens: new Set(initialAcceptedTokens),
    calls: [],
  };

  const createServer = entry => {
    const mcp = new McpServer({ name: 'cc-stub', version: '1.0.0' });
    mcp.tool('ping', {}, async () => {
      entry.toolName = 'ping';
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    });
    return mcp;
  };

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url || (req.url !== '/mcp' && req.url !== '/mcp/')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
    state.calls.push({ bearer, toolName: undefined });
    if (!state.acceptedTokens.has(bearer)) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer error="invalid_token"',
      });
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    const entry = state.calls[state.calls.length - 1];
    const mcp = createServer(entry);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await mcp.close();
    }
  });

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address();
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    state,
    stop: () => {
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
      return new Promise(resolve => httpServer.close(() => resolve()));
    },
  };
}

function makeAgent({ agentUrl, tokenUrl, idSuffix = '' }) {
  return {
    id: `cc-test${idSuffix}`,
    name: 'CC Test Agent',
    agent_uri: agentUrl,
    protocol: 'mcp',
    oauth_client_credentials: {
      token_endpoint: tokenUrl,
      client_id: 'test-client',
      client_secret: 'test-secret',
    },
  };
}

async function resetGlobalState() {
  await closeMCPConnections();
}

describe('CC integration: token exchange + bearer attach', () => {
  test('first call exchanges a token and the MCP server sees it on the wire', async () => {
    await resetGlobalState();
    const tokenServer = await startTokenServer();
    const mcpServer = await startMcpStubWithBearerGate(['tok_1']);
    try {
      const agent = makeAgent({ agentUrl: mcpServer.url, tokenUrl: tokenServer.url });

      const result = await ProtocolClient.callTool(agent, 'ping', {});
      assert.ok(result, 'tool call returned a response');

      assert.strictEqual(tokenServer.state.issued, 1, 'exactly one token exchange');
      // The MCP SDK does an initialize handshake + the tools/call, so one
      // logical tool call produces multiple HTTP requests. Assert every
      // request carried the exchanged bearer rather than counting them.
      assert.ok(mcpServer.state.calls.length >= 1, 'at least one MCP request observed');
      for (const call of mcpServer.state.calls) {
        assert.strictEqual(call.bearer, 'tok_1', 'every MCP request carried the exchanged bearer');
      }
      assert.strictEqual(agent.oauth_tokens.access_token, 'tok_1', 'agent config has the fresh token');
    } finally {
      await closeMCPConnections();
      await mcpServer.stop();
      await tokenServer.stop();
    }
  });

  test('warm cache: second call within expiry skews reuses the cached token', async () => {
    await resetGlobalState();
    const tokenServer = await startTokenServer();
    const mcpServer = await startMcpStubWithBearerGate(['tok_1']);
    try {
      const agent = makeAgent({ agentUrl: mcpServer.url, tokenUrl: tokenServer.url });

      await ProtocolClient.callTool(agent, 'ping', {});
      await ProtocolClient.callTool(agent, 'ping', {});

      assert.strictEqual(tokenServer.state.issued, 1, 'second call reused the cached token (no re-exchange)');
      // Every MCP request across both logical calls uses the same bearer.
      for (const call of mcpServer.state.calls) {
        assert.strictEqual(call.bearer, 'tok_1');
      }
    } finally {
      await closeMCPConnections();
      await mcpServer.stop();
      await tokenServer.stop();
    }
  });
});

describe('CC integration: mid-session 401 retry', () => {
  test('mid-session token rotation: 401 triggers force-refresh and retry succeeds', async () => {
    await resetGlobalState();
    const tokenServer = await startTokenServer();
    const mcpServer = await startMcpStubWithBearerGate(['tok_1']);
    try {
      const agent = makeAgent({ agentUrl: mcpServer.url, tokenUrl: tokenServer.url });

      // Prime: first call exchanges tok_1, MCP accepts it.
      await ProtocolClient.callTool(agent, 'ping', {});
      assert.strictEqual(tokenServer.state.issued, 1);

      // Simulate the AS rotating out tok_1 and minting tok_2 — the next token
      // exchange will produce tok_2, but our cache still has tok_1.
      mcpServer.state.acceptedTokens = new Set(['tok_2']);

      // Second call: the pre-flight check sees tok_1 as "valid" (not near
      // expiry), sends it, MCP 401s. The retry path force-refreshes → gets
      // tok_2 → retries → success. Exactly one extra token POST + one extra
      // MCP call beyond the 401.
      const callsBeforeRetry = mcpServer.state.calls.length;
      const result = await ProtocolClient.callTool(agent, 'ping', {});
      assert.ok(result, 'retry succeeded');

      assert.strictEqual(tokenServer.state.issued, 2, 'force-refresh triggered a second exchange');
      // After the rotation, any MCP request that came in must either be the
      // 401 attempt with tok_1 or the retry with tok_2 — no other bearers.
      const postRotation = mcpServer.state.calls.slice(callsBeforeRetry);
      const bearers = new Set(postRotation.map(c => c.bearer));
      assert.ok(bearers.has('tok_2'), 'retry used the rotated token');
      for (const b of bearers) {
        assert.ok(b === 'tok_1' || b === 'tok_2', `unexpected bearer: ${b}`);
      }
      assert.strictEqual(agent.oauth_tokens.access_token, 'tok_2');
    } finally {
      await closeMCPConnections();
      await mcpServer.stop();
      await tokenServer.stop();
    }
  });

  test('retry that still 401s surfaces the error (no infinite loop)', async () => {
    await resetGlobalState();
    const tokenServer = await startTokenServer();
    // MCP accepts nothing → every call 401s, even the post-refresh retry.
    const mcpServer = await startMcpStubWithBearerGate([]);
    try {
      const agent = makeAgent({ agentUrl: mcpServer.url, tokenUrl: tokenServer.url });

      await assert.rejects(() => ProtocolClient.callTool(agent, 'ping', {}));

      // At most one initial exchange + one force-refresh = two token POSTs.
      // More than that means the retry loop is unbounded.
      assert.ok(
        tokenServer.state.issued <= 2,
        `expected at most 2 token exchanges, got ${tokenServer.state.issued} (retry loop is unbounded)`
      );
    } finally {
      await closeMCPConnections();
      await mcpServer.stop();
      await tokenServer.stop();
    }
  });
});

describe('CC integration: concurrent-call coalescing', () => {
  test('parallel ProtocolClient.callTool calls share one token exchange', async () => {
    await resetGlobalState();
    const tokenServer = await startTokenServer();
    const mcpServer = await startMcpStubWithBearerGate(['tok_1']);
    try {
      const agent = makeAgent({ agentUrl: mcpServer.url, tokenUrl: tokenServer.url });

      // Five parallel calls starting from a cold cache. With coalescing, the
      // first call triggers one token POST; the other four await the shared
      // in-flight promise and pick up the same token.
      await Promise.all(Array.from({ length: 5 }, () => ProtocolClient.callTool(agent, 'ping', {})));

      assert.strictEqual(tokenServer.state.issued, 1, 'expected exactly one token exchange across 5 concurrent calls');
      for (const call of mcpServer.state.calls) {
        assert.strictEqual(call.bearer, 'tok_1');
      }
    } finally {
      await closeMCPConnections();
      await mcpServer.stop();
      await tokenServer.stop();
    }
  });
});
