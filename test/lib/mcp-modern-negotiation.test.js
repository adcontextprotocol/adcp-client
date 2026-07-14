/**
 * MCP 2026-07-28 client negotiation.
 *
 * The remote client should use the v2 SDK for modern-only servers while
 * preserving the v1 client path for legacy servers (including 2025 Tasks).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

const { callMCPTool, closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { callMCPToolWithOAuth } = require('../../dist/lib/protocols/mcp.js');
const { callMCPToolWithTasks } = require('../../dist/lib/protocols/mcp-tasks.js');

function createStaticOAuthProvider(token) {
  return {
    get redirectUrl() {
      return undefined;
    },
    get clientMetadata() {
      return { client_name: 'modern-oauth-test', redirect_uris: [] };
    },
    async clientInformation() {
      return { client_id: 'modern_oauth_client' };
    },
    async tokens() {
      return { access_token: token, token_type: 'Bearer' };
    },
    async saveTokens() {},
    async redirectToAuthorization() {
      throw new Error('unexpected interactive OAuth flow');
    },
    async saveCodeVerifier() {},
    async codeVerifier() {
      return 'verifier';
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

test('remote MCP client negotiates 2026-07-28 with a modern-only server', async t => {
  const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
  const { toNodeHandler } = require('@modelcontextprotocol/node');

  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'modern-only-test', version: '1.0.0' });
      server.registerTool('echo', { description: 'Echo a fixed modern result' }, async () => ({
        content: [{ type: 'text', text: 'modern' }],
      }));
      return server;
    },
    { legacy: 'reject' }
  );
  const nodeHandler = toNodeHandler(handler);
  const receivedAuthTokens = [];
  const receivedAuthorizationHeaders = [];
  const receivedBaggageHeaders = [];
  const httpServer = createServer((req, res) => {
    receivedAuthTokens.push(req.headers['x-adcp-auth']);
    receivedAuthorizationHeaders.push(req.headers.authorization);
    receivedBaggageHeaders.push(req.headers.baggage);
    void nodeHandler(req, res);
  });
  const url = await listen(httpServer);

  t.after(async () => {
    await closeMCPConnections();
    await handler.close();
    await closeServer(httpServer);
  });

  const debugLogs = [];
  const result = await callMCPToolWithTasks(url, 'echo', {}, 'modern-test-token', debugLogs);
  const directResult = await callMCPTool(url, 'echo', {}, 'modern-test-token', debugLogs, {
    authorization: 'Bearer stale-static-token',
    'X-Adcp-Auth': 'stale-static-token',
  });
  await callMCPTool(url, 'echo', {}, undefined, debugLogs, { baggage: 'tenant=one' });
  await callMCPTool(url, 'echo', {}, undefined, debugLogs, { baggage: 'tenant=two' });
  const oauthResult = await callMCPToolWithOAuth({
    agentUrl: url,
    toolName: 'echo',
    args: {},
    authProvider: createStaticOAuthProvider('modern-oauth-token'),
    customHeaders: { Authorization: 'Bearer stale-custom-token', 'x-routing-key': 'route-a' },
  });

  const { AgentClient } = require('../../dist/lib/core/AgentClient.js');
  const agentClient = new AgentClient({
    id: 'modern-only-agent-client',
    name: 'modern-only-agent-client',
    protocol: 'mcp',
    agent_uri: url,
  });
  const agentInfo = await agentClient.getAgentInfo();

  assert.equal(result.content[0].text, 'modern');
  assert.equal(directResult.content[0].text, 'modern');
  assert.equal(oauthResult.content[0].text, 'modern');
  assert.ok(
    agentInfo.tools.some(tool => tool.name === 'echo'),
    'high-level discovery should list modern tools'
  );
  assert.ok(receivedAuthTokens.length >= 2, 'discovery and tool calls should both reach the server');
  assert.ok(
    receivedAuthTokens.filter(Boolean).every(token => token === 'modern-test-token'),
    'static auth must be sent consistently'
  );
  assert.ok(
    receivedAuthorizationHeaders.includes('Bearer modern-oauth-token'),
    'OAuth bearer must reach modern server'
  );
  assert.ok(
    !receivedAuthorizationHeaders.includes('Bearer stale-custom-token'),
    'OAuth must override custom Authorization'
  );
  assert.ok(
    !receivedAuthorizationHeaders.includes('Bearer stale-static-token') &&
      !receivedAuthTokens.includes('stale-static-token'),
    'static auth must override mixed-case custom auth headers'
  );
  assert.ok(
    receivedBaggageHeaders.includes('tenant=one') && receivedBaggageHeaders.includes('tenant=two'),
    'explicit baggage must participate in connection identity and remain request-specific'
  );
  assert.ok(
    debugLogs.some(entry => entry.message.includes('Negotiated protocol 2026-07-28')),
    'expected the v2 client to negotiate the modern protocol era'
  );
  assert.ok(
    !debugLogs.some(entry => entry.message.includes('preserving the v1 Tasks path')),
    'modern servers must not fall back to the v1 client'
  );
  assert.ok(
    debugLogs.some(entry => entry.message === 'MCP: Tool echo response received (success)'),
    'modern calls should preserve the existing response debug log contract'
  );
});

test('remote MCP client preserves the v1 path for a legacy server', async t => {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

  const httpServer = createServer(async (req, res) => {
    const server = new McpServer({ name: 'legacy-test', version: '1.0.0' });
    server.registerTool('echo', { description: 'Echo a fixed legacy result' }, async () => ({
      content: [{ type: 'text', text: 'legacy' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await server.close();
    }
  });
  const url = await listen(httpServer);

  t.after(async () => {
    await closeMCPConnections();
    await closeServer(httpServer);
  });

  const debugLogs = [];
  const result = await callMCPToolWithTasks(url, 'echo', {}, undefined, debugLogs);

  assert.equal(result.content[0].text, 'legacy');
  assert.ok(
    debugLogs.some(entry => entry.message.includes('preserving the v1 Tasks path')),
    'legacy servers should retain the v1 client and Tasks compatibility path'
  );
});

test('modern client never forwards credentials across redirects', async t => {
  let redirectedRequests = 0;
  const sink = createServer((req, res) => {
    redirectedRequests++;
    res.writeHead(500);
    res.end();
  });
  const sinkUrl = await listen(sink);
  const redirector = createServer((_req, res) => {
    res.writeHead(307, { Location: sinkUrl });
    res.end();
  });
  const redirectUrl = await listen(redirector);

  t.after(async () => {
    await closeMCPConnections();
    await closeServer(redirector);
    await closeServer(sink);
  });

  await assert.rejects(() =>
    callMCPTool(redirectUrl, 'echo', {}, 'redirect-secret', [], { 'x-tenant-secret': 'tenant-secret' })
  );
  assert.equal(redirectedRequests, 0, 'redirect target must never receive credential-bearing MCP requests');
});

test('serve exposes AdCP tools to a client pinned to MCP 2026-07-28', async t => {
  const { serve, InMemoryStateStore } = require('../../dist/lib/index.js');
  const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

  const httpServer = serve(
    () =>
      createAdcpServer({
        name: 'modern-adcp-test',
        version: '1.0.0',
        stateStore: new InMemoryStateStore(),
        instructions: async () => 'Use AdCP tools with explicit account context.',
      }),
    { port: 0, onListening: () => {} }
  );
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    if (httpServer.listening) resolve();
    else httpServer.once('listening', resolve);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');

  const client = new Client(
    { name: 'pinned-modern-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));

  t.after(async () => {
    await client.close().catch(() => {});
    await closeServer(httpServer);
  });

  await client.connect(transport);
  assert.equal(client.getProtocolEra(), 'modern');
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
  assert.equal(client.getInstructions(), 'Use AdCP tools with explicit account context.');

  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'get_adcp_capabilities'));

  const result = await client.callTool({ name: 'get_adcp_capabilities', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent, 'AdCP response should retain structured content on the modern route');

  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const malformed = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.error.code, -32700);

  const wrongMediaType = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{not-json',
  });
  assert.equal(wrongMediaType.status, 415);

  const legacyRebinding = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'legacy-rebinding-test', version: '1.0.0' },
      },
    }),
  });
  assert.equal(legacyRebinding.status, 403, 'legacy-shaped requests must receive the same Origin guard');

  const hostileClient = new Client(
    { name: 'hostile-origin-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  const hostileTransport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Origin: 'https://evil.example' } },
  });
  await assert.rejects(() => hostileClient.connect(hostileTransport));
  await hostileClient.close().catch(() => {});
});

test('modern serving honors per-request tool visibility', async t => {
  const { serve, InMemoryStateStore } = require('../../dist/lib/index.js');
  const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');
  const { setToolVisibilityResolver } = require('../../dist/lib/server/adcp-server.js');
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

  const httpServer = serve(
    () => {
      const server = createAdcpServer({
        name: 'modern-visibility-test',
        version: '1.0.0',
        stateStore: new InMemoryStateStore(),
      });
      setToolVisibilityResolver(server, ({ toolName }) => toolName !== 'get_adcp_capabilities');
      return server;
    },
    { port: 0, onListening: () => {} }
  );
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    if (httpServer.listening) resolve();
    else httpServer.once('listening', resolve);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');

  const client = new Client(
    { name: 'modern-visibility-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  t.after(async () => {
    await client.close().catch(() => {});
    await closeServer(httpServer);
  });

  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(!listed.tools.some(tool => tool.name === 'get_adcp_capabilities'));
  await assert.rejects(() => client.callTool({ name: 'get_adcp_capabilities', arguments: {} }));
});
