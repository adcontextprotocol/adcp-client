const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { callMCPToolWithOAuth, closeMCPConnections, closeOAuthConnections } = require('../../dist/lib/protocols/mcp.js');
const { ProtocolClient } = require('../../dist/lib/protocols/index.js');
const { SingleAgentClient } = require('../../dist/lib/index.js');

function createStaticOAuthProvider(token) {
  return {
    get redirectUrl() {
      return undefined;
    },
    get clientMetadata() {
      return {
        client_name: 'oauth-cache-test',
        redirect_uris: [],
      };
    },
    async clientInformation() {
      return { client_id: `client_${token}` };
    },
    async tokens() {
      return { access_token: token, token_type: 'Bearer' };
    },
    async saveTokens(tokens) {
      token = tokens.access_token;
    },
    async redirectToAuthorization() {
      throw new Error('unexpected interactive OAuth flow');
    },
    async saveCodeVerifier() {},
    async codeVerifier() {
      return 'verifier';
    },
    async invalidateCredentials() {},
  };
}

function countMethod(state, parsedBody) {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  for (const message of messages) {
    if (message?.method) {
      state.methodCounts.set(message.method, (state.methodCounts.get(message.method) ?? 0) + 1);
    }
  }
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body ? JSON.parse(body) : undefined;
}

async function startMcpOAuthStub() {
  const state = {
    authHeaders: [],
    methodCounts: new Map(),
    toolCalls: 0,
  };

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url || (req.url !== '/mcp' && req.url !== '/mcp/')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    state.authHeaders.push(req.headers.authorization ?? '');
    const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
    if (parsedBody) countMethod(state, parsedBody);

    const mcp = new McpServer({ name: 'oauth-cache-stub', version: '1.0.0' });
    mcp.registerTool('ping', { inputSchema: {} }, async () => {
      state.toolCalls++;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
      }
      res.end(error instanceof Error ? error.stack : String(error));
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

function isInitializeRequest(parsedBody) {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  return messages.some(message => message?.method === 'initialize');
}

function registerSessionTools(mcp, state) {
  for (const toolName of ['ping', 'get_products', 'create_media_buy', 'sync_creatives']) {
    mcp.registerTool(toolName, { inputSchema: {} }, async () => {
      state.toolCalls++;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: toolName }) }] };
    });
  }
}

async function startStatefulMcpOAuthStub() {
  const sessions = new Map();
  const state = {
    authHeaders: [],
    methodCounts: new Map(),
    sessionHeaders: [],
    initializedSessionIds: [],
    toolCalls: 0,
  };

  async function createSession() {
    const mcp = new McpServer({ name: 'oauth-stateful-cache-stub', version: '1.0.0' });
    registerSessionTools(mcp, state);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sessionId => {
        state.initializedSessionIds.push(sessionId);
        sessions.set(sessionId, { mcp, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await mcp.connect(transport);
    return { mcp, transport };
  }

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url || (req.url !== '/mcp' && req.url !== '/mcp/')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    state.authHeaders.push(req.headers.authorization ?? '');
    const sessionHeader = req.headers['mcp-session-id'];
    if (sessionHeader) state.sessionHeaders.push(sessionHeader);

    const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
    if (parsedBody) countMethod(state, parsedBody);

    const isInit = parsedBody ? isInitializeRequest(parsedBody) : false;
    let session;
    if (typeof sessionHeader === 'string') {
      session = sessions.get(sessionHeader);
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
        return;
      }
    } else if (isInit) {
      session = await createSession();
    } else {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Mcp-Session-Id header is required' },
          id: null,
        })
      );
      return;
    }

    try {
      await session.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
      }
      res.end(error instanceof Error ? error.stack : String(error));
    }
  });

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address();
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    state,
    stop: async () => {
      for (const { mcp, transport } of [...sessions.values()]) {
        await transport.close().catch(() => {});
        await mcp.close().catch(() => {});
      }
      sessions.clear();
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
      await new Promise(resolve => httpServer.close(() => resolve()));
    },
  };
}

function resetStatefulMcpCounters(state) {
  state.authHeaders.length = 0;
  state.methodCounts.clear();
  state.sessionHeaders.length = 0;
  state.initializedSessionIds.length = 0;
  state.toolCalls = 0;
}

test('OAuth MCP calls reuse one initialized session for the same provider', async () => {
  await closeMCPConnections();
  const server = await startMcpOAuthStub();
  const authProvider = createStaticOAuthProvider('tok_same');

  try {
    await callMCPToolWithOAuth({ agentUrl: server.url, toolName: 'ping', args: {}, authProvider });
    await callMCPToolWithOAuth({ agentUrl: server.url, toolName: 'ping', args: {}, authProvider });

    assert.strictEqual(server.state.methodCounts.get('initialize'), 1, 'same OAuth provider should initialize once');
    assert.strictEqual(
      server.state.methodCounts.get('tools/call'),
      2,
      'both logical tool calls should reach the server'
    );
    assert.ok(
      server.state.authHeaders.every(header => header === 'Bearer tok_same'),
      `expected every request to use tok_same, saw ${JSON.stringify(server.state.authHeaders)}`
    );

    await closeMCPConnections();
    await callMCPToolWithOAuth({ agentUrl: server.url, toolName: 'ping', args: {}, authProvider });
    assert.strictEqual(
      server.state.methodCounts.get('initialize'),
      2,
      'closeMCPConnections should drain the OAuth cache'
    );
  } finally {
    await closeMCPConnections();
    await server.stop();
  }
});

test('OAuth MCP cache separates different providers for the same agent URL', async () => {
  await closeMCPConnections();
  const server = await startMcpOAuthStub();
  const providerA = createStaticOAuthProvider('tok_a');
  const providerB = createStaticOAuthProvider('tok_b');

  try {
    await callMCPToolWithOAuth({ agentUrl: server.url, toolName: 'ping', args: {}, authProvider: providerA });
    await callMCPToolWithOAuth({ agentUrl: server.url, toolName: 'ping', args: {}, authProvider: providerB });

    assert.strictEqual(server.state.methodCounts.get('initialize'), 2, 'different providers need distinct sessions');
    assert.ok(server.state.authHeaders.includes('Bearer tok_a'), 'provider A token reached the server');
    assert.ok(server.state.authHeaders.includes('Bearer tok_b'), 'provider B token reached the server');
  } finally {
    await closeOAuthConnections();
    await server.stop();
  }
});

test('ProtocolClient default OAuth path reuses the stateful MCP session across workflow tools', async () => {
  await closeMCPConnections();
  const server = await startStatefulMcpOAuthStub();
  const agent = {
    id: 'default-oauth-session',
    name: 'Default OAuth Session',
    agent_uri: server.url,
    protocol: 'mcp',
    oauth_tokens: {
      access_token: 'tok_default',
      refresh_token: 'rt_default',
      token_type: 'Bearer',
    },
    oauth_client: { client_id: 'client_default' },
  };

  try {
    await ProtocolClient.callTool(agent, 'get_products', {});
    await ProtocolClient.callTool(agent, 'create_media_buy', {});
    await ProtocolClient.callTool(agent, 'sync_creatives', {});

    assert.strictEqual(
      server.state.methodCounts.get('initialize'),
      1,
      'default ProtocolClient OAuth flow should initialize one MCP session'
    );
    assert.strictEqual(
      server.state.initializedSessionIds.length,
      1,
      'stateful MCP server should issue exactly one session id'
    );
    assert.strictEqual(server.state.methodCounts.get('tools/call'), 3, 'all workflow tools should use tools/call');
    assert.ok(
      server.state.sessionHeaders.length >= 3,
      'stateful MCP tool calls should carry the server-issued mcp-session-id'
    );
    assert.ok(
      server.state.sessionHeaders.every(sessionId => sessionId === server.state.initializedSessionIds[0]),
      `expected all calls to reuse session ${server.state.initializedSessionIds[0]}, saw ${JSON.stringify(
        server.state.sessionHeaders
      )}`
    );
    assert.ok(
      server.state.authHeaders.every(header => header === 'Bearer tok_default'),
      `expected every request to use tok_default, saw ${JSON.stringify(server.state.authHeaders)}`
    );
  } finally {
    await closeMCPConnections();
    await server.stop();
  }
});

test('SingleAgentClient default OAuth path reuses the stateful MCP session after discovery', async () => {
  await closeMCPConnections();
  const server = await startStatefulMcpOAuthStub();
  const client = new SingleAgentClient(
    {
      id: 'single-agent-default-oauth-session',
      name: 'SingleAgent Default OAuth Session',
      agent_uri: server.url,
      protocol: 'mcp',
      oauth_tokens: {
        access_token: 'tok_single_agent',
        refresh_token: 'rt_single_agent',
        token_type: 'Bearer',
      },
      oauth_client: { client_id: 'client_single_agent' },
    },
    { allowV2: true }
  );

  try {
    await client.getCapabilities();
    resetStatefulMcpCounters(server.state);

    await client.executeTask('ping', {});
    await client.executeTask('ping', {});
    await client.executeTask('ping', {});

    assert.strictEqual(
      server.state.methodCounts.get('initialize'),
      1,
      'SingleAgentClient should keep one OAuth MCP session across default executeTask calls'
    );
    assert.strictEqual(
      server.state.initializedSessionIds.length,
      1,
      'stateful MCP server should issue one session id for the executeTask workflow'
    );
    assert.strictEqual(server.state.methodCounts.get('tools/call'), 3, 'all executeTask calls should use tools/call');
    assert.ok(
      server.state.sessionHeaders.length >= 3,
      'stateful MCP executeTask calls should carry the server-issued mcp-session-id'
    );
    assert.ok(
      server.state.sessionHeaders.every(sessionId => sessionId === server.state.initializedSessionIds[0]),
      `expected all executeTask calls to reuse session ${server.state.initializedSessionIds[0]}, saw ${JSON.stringify(
        server.state.sessionHeaders
      )}`
    );
    assert.ok(
      server.state.authHeaders.every(header => header === 'Bearer tok_single_agent'),
      `expected every request to use tok_single_agent, saw ${JSON.stringify(server.state.authHeaders)}`
    );
  } finally {
    await closeMCPConnections();
    await server.stop();
  }
});
