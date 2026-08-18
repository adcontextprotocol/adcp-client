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
const { withMCPConnectionScope } = require('../../dist/lib/protocols/index.js');
const {
  probeModernMCPConnection,
  tryCallModernMCPTool,
  tryListModernMCPTools,
} = require('../../dist/lib/protocols/mcp-modern.js');

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

test('modern discovery is reused within the same authorization context', async t => {
  const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
  const { toNodeHandler } = require('@modelcontextprotocol/node');

  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'modern-discovery-cache-test', version: '1.0.0' });
      server.registerTool('echo', { description: 'Echo a fixed modern result' }, async () => ({
        content: [{ type: 'text', text: 'modern' }],
      }));
      return server;
    },
    { legacy: 'reject' }
  );
  const httpServer = createServer(toNodeHandler(handler));
  const url = await listen(httpServer);
  let discoverRequests = 0;
  let initializeRequests = 0;
  const countingFetch = async (input, init) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    if (request.method === 'POST') {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined);
      if (body?.method === 'server/discover') discoverRequests++;
      if (body?.method === 'initialize') initializeRequests++;
    }
    return fetch(input, init);
  };
  const controller = new AbortController();
  const scopedOptions = { fetchFn: countingFetch, signal: controller.signal, requestTimeoutMs: 2_000 };

  t.after(async () => {
    await closeMCPConnections();
    await handler.close();
    await closeServer(httpServer);
  });

  const probe = await probeModernMCPConnection(url, 'tenant-a-token', undefined, scopedOptions);
  assert.deepEqual(probe, { connected: true, era: 'modern' });
  assert.equal(discoverRequests, 1);

  await withMCPConnectionScope(async () => {
    const cachedAttempt = await tryCallModernMCPTool(url, 'echo', {}, 'tenant-a-token', [], undefined, scopedOptions);
    assert.equal(cachedAttempt.handled, true);
    assert.equal(discoverRequests, 2, 'the workflow should establish its own caller-owned discovery scope');
    const initializesAfterFirstToolCall = initializeRequests;

    const reusedAttempt = await tryCallModernMCPTool(url, 'echo', {}, 'tenant-a-token', [], undefined, scopedOptions);
    assert.equal(reusedAttempt.handled, true);
    assert.equal(initializeRequests, initializesAfterFirstToolCall, 'scoped modern calls should reuse one session');
  });

  const otherTenantAttempt = await tryCallModernMCPTool(
    url,
    'echo',
    {},
    'tenant-b-token',
    [],
    undefined,
    scopedOptions
  );
  assert.equal(otherTenantAttempt.handled, true);
  assert.equal(discoverRequests, 3, 'discovery results must not cross authorization contexts');

  const { AgentClient } = require('../../dist/lib/core/AgentClient.js');
  const oauthClient = new AgentClient(
    {
      id: 'oauth-discovery-cache-agent',
      name: 'oauth-discovery-cache-agent',
      protocol: 'mcp',
      agent_uri: url.replace(/\/mcp$/, ''),
      oauth_tokens: { access_token: 'oauth-discovery-token', token_type: 'Bearer' },
    },
    { transport: { fetchFn: countingFetch } }
  );
  const beforeOAuthDiscovery = discoverRequests;
  const oauthInfo = await oauthClient.getAgentInfo();
  assert.ok(oauthInfo.tools.some(tool => tool.name === 'echo'));
  assert.equal(
    discoverRequests,
    beforeOAuthDiscovery + 1,
    'OAuth endpoint probing and tool listing should share one provider-scoped discovery result'
  );
  const internalClient = oauthClient.client;
  const {
    getNonInteractiveOAuthProvider,
    shareNonInteractiveOAuthProvider,
  } = require('../../dist/lib/auth/oauth/provider-cache.js');
  const derivedAgent = { ...internalClient.normalizedAgent, agent_uri: url };
  shareNonInteractiveOAuthProvider(internalClient.normalizedAgent, derivedAgent);
  assert.strictEqual(
    getNonInteractiveOAuthProvider(internalClient.normalizedAgent),
    getNonInteractiveOAuthProvider(derivedAgent),
    'the derived agent config should retain the endpoint probe OAuth provider identity'
  );
});

test('stale modern discovery is refreshed before read-only tool listing fails', async t => {
  const { createMcpHandler, McpServer: ModernMcpServer } = require('@modelcontextprotocol/server');
  const { toNodeHandler } = require('@modelcontextprotocol/node');
  const { McpServer: LegacyMcpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

  const modernHandler = createMcpHandler(
    () => {
      const server = new ModernMcpServer({ name: 'modern-before-downgrade', version: '1.0.0' });
      server.registerTool('echo', { description: 'Modern echo' }, async () => ({
        content: [{ type: 'text', text: 'modern' }],
      }));
      return server;
    },
    { legacy: 'reject' }
  );
  const modernNodeHandler = toNodeHandler(modernHandler);
  let useLegacy = false;
  let respondNotFound = false;
  const httpServer = createServer(async (req, res) => {
    if (respondNotFound) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!useLegacy) {
      await modernNodeHandler(req, res);
      return;
    }
    const server = new LegacyMcpServer({ name: 'legacy-after-downgrade', version: '1.0.0' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await server.close();
    }
  });
  const url = await listen(httpServer);
  let discoverRequests = 0;
  const countingFetch = async (input, init) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    if (request.method === 'POST') {
      const body = await request
        .clone()
        .json()
        .catch(() => undefined);
      if (body?.method === 'server/discover') discoverRequests++;
    }
    return fetch(input, init);
  };

  t.after(async () => {
    await closeMCPConnections();
    await modernHandler.close();
    await closeServer(httpServer);
  });

  const probe = await probeModernMCPConnection(url, undefined, undefined, { fetchFn: countingFetch });
  assert.deepEqual(probe, { connected: true, era: 'modern' });
  assert.equal(discoverRequests, 1);

  useLegacy = true;
  const listed = await tryListModernMCPTools(url, undefined, undefined, { fetchFn: countingFetch });
  assert.deepEqual(listed, { handled: false });
  assert.equal(discoverRequests, 2, 'read-only listing should re-probe after a stale modern verdict');

  useLegacy = false;
  const secondProbe = await probeModernMCPConnection(url, undefined, undefined, { fetchFn: countingFetch });
  assert.deepEqual(secondProbe, { connected: true, era: 'modern' });
  respondNotFound = true;
  const unavailable = await tryListModernMCPTools(url, undefined, undefined, { fetchFn: countingFetch });
  assert.deepEqual(unavailable, { handled: false });
  assert.equal(discoverRequests, 4, 'a failed fresh retry should retain the 404 fallback contract');
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

test('handleLegacy policy is isolated from the cached legacy classification', async t => {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

  const httpServer = createServer(async (req, res) => {
    const server = new McpServer({ name: 'legacy-policy-test', version: '1.0.0' });
    server.registerTool('echo', { description: 'Echo through the negotiated legacy era' }, async () => ({
      content: [{ type: 'text', text: 'legacy-policy' }],
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
  const scopedFetch = (input, init) => fetch(input, init);
  const controller = new AbortController();

  t.after(async () => {
    await closeMCPConnections();
    httpServer.closeAllConnections?.();
    await closeServer(httpServer);
  });

  const fallbackAttempt = await tryCallModernMCPTool(url, 'echo', {}, undefined, [], undefined, {
    fetchFn: scopedFetch,
    signal: controller.signal,
    requestTimeoutMs: 2_000,
  });
  assert.deepEqual(fallbackAttempt, { handled: false });

  const handledAttempt = await tryCallModernMCPTool(url, 'echo', {}, undefined, [], undefined, {
    fetchFn: scopedFetch,
    signal: controller.signal,
    requestTimeoutMs: 2_000,
    handleLegacy: true,
  });
  assert.equal(handledAttempt.handled, true);
  assert.equal(handledAttempt.response.content[0].text, 'legacy-policy');
});

test('modern discovery 5xx fails closed without dispatching through the v1 client', async t => {
  let discoverRequests = 0;
  let initializeRequests = 0;
  const httpServer = createServer(async (req, res) => {
    let body;
    try {
      body = JSON.parse(
        await new Promise((resolve, reject) => {
          let data = '';
          req.setEncoding('utf8');
          req.on('data', chunk => {
            data += chunk;
          });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        })
      );
    } catch {
      body = undefined;
    }
    if (body?.method === 'server/discover') discoverRequests++;
    if (body?.method === 'initialize') initializeRequests++;
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('temporarily unavailable');
  });
  const url = await listen(httpServer);

  t.after(async () => {
    await closeMCPConnections();
    await closeServer(httpServer);
  });

  await assert.rejects(
    () => callMCPToolWithTasks(url, 'echo', {}, undefined, []),
    error => error?.code === 'ERA_NEGOTIATION_FAILED' && error?.status === 503
  );
  assert.equal(discoverRequests, 1);
  assert.equal(initializeRequests, 0, 'an infrastructure failure must not be cached or retried as legacy evidence');
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
  const capabilitiesTool = listed.tools.find(tool => tool.name === 'get_adcp_capabilities');
  assert.ok(capabilitiesTool);
  assert.ok(
    capabilitiesTool.inputSchema.properties?.protocols,
    'modern tools/list must advertise the bundled AdCP input schema instead of an empty Zod fallback'
  );

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

test('modern serving honors the resolved AdCP MCP tool profile', async () => {
  const { serve, InMemoryStateStore } = require('../../dist/lib/index.js');
  const { createAdcpServer, MEDIA_BUY_MCP_TOOL_PROFILE } = require('../../dist/lib/server/create-adcp-server.js');
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

  async function listTools(mcpToolProfile) {
    let legacyCalls = 0;
    const httpServer = serve(
      () =>
        createAdcpServer({
          name: 'modern-profile-test',
          version: '1.0.0',
          adcpVersion: '3.2.0-beta.1',
          ...(mcpToolProfile !== undefined && { mcpToolProfile }),
          stateStore: new InMemoryStateStore(),
          mediaBuy: {
            listProducts: async () => ({ outcome: 'listed', products: [], feed_version: 'feed-1' }),
            requestProposals: async () => ({ outcome: 'rejected', reason: 'fixture' }),
            declineProposals: async () => ({ results: [] }),
            buyProducts: async () => ({ media_buy_id: 'mb-buy' }),
            acceptProposal: async () => ({ media_buy_id: 'mb-accept' }),
            controlMediaBuy: async () => ({ media_buy_id: 'mb-control', revision: 2 }),
            getProducts: async () => {
              legacyCalls++;
              return { products: [], cache_scope: 'public' };
            },
          },
          creative: {
            buildCreative: async () => ({ creative_manifest: { manifest_id: 'mf-1', assets: [] } }),
          },
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
      { name: 'modern-profile-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const listed = await client.listTools();
      if (mcpToolProfile === undefined) {
        await client.callTool({
          name: 'get_products',
          arguments: { buying_mode: 'brief', brief: 'legacy compatibility probe' },
        });
      }
      return { listed, legacyCalls };
    } finally {
      await client.close().catch(() => {});
      await closeServer(httpServer);
    }
  }

  const compactResult = await listTools();
  const compact = compactResult.listed;
  const compactNames = compact.tools.map(tool => tool.name);
  assert.ok(compactNames.includes('list_products'));
  assert.ok(compactNames.includes('buy_products'));
  assert.ok(!compactNames.includes('get_products'));
  assert.ok(!compactNames.includes('build_creative'));
  assert.equal(compactResult.legacyCalls, 1, 'a legacy tool hidden from discovery must remain directly callable');
  assert.ok(
    compactNames.every(name => MEDIA_BUY_MCP_TOOL_PROFILE.includes(name)),
    compactNames.join(', ')
  );
  assert.equal(compact._meta.adcp_version, '3.2.0-beta.1');
  assert.equal(compact._meta.adcp_profile, 'media-buy');
  assert.equal(
    compact.tools.find(tool => tool.name === 'list_products').description,
    'List seller products that match structured discovery criteria.'
  );
  assert.deepEqual(
    compact.tools
      .filter(tool => {
        if (typeof tool.description !== 'string' || tool.description.trim() === '') return true;
        return tool.description.trim().split(/\s+/).length >= 100;
      })
      .map(tool => tool.name),
    [],
    'every advertised official media-buy tool must have a concise description'
  );
  assert.equal(
    compact.tools.find(tool => tool.name === 'request_proposals').inputSchema.$schema,
    'https://json-schema.org/draft/2020-12/schema'
  );
  assert.match(
    compact.tools.find(tool => tool.name === 'request_proposals').inputSchema.$id,
    /\/profiles\/media-buy\//
  );
  const compactDiscoveryBytes = Buffer.byteLength(JSON.stringify(compact.tools));
  assert.ok(
    compactDiscoveryBytes <= 1024 * 1024,
    `default media-buy tools/list is ${compactDiscoveryBytes} bytes; budget is 1 MiB`
  );
  assert.ok(
    compact.tools.every(tool => tool.outputSchema === undefined),
    'the default createAdcpServer surface must advertise inputs without full response schemas'
  );

  const all = (await listTools('all')).listed;
  const allNames = all.tools.map(tool => tool.name);
  assert.ok(allNames.includes('list_products'));
  assert.ok(allNames.includes('get_products'));
  assert.ok(allNames.includes('build_creative'));
  assert.equal(
    all.tools.find(tool => tool.name === 'request_proposals').inputSchema.$schema,
    'https://json-schema.org/draft/2020-12/schema'
  );
  assert.doesNotMatch(all.tools.find(tool => tool.name === 'request_proposals').inputSchema.$id, /\/profiles\//);
  assert.equal(all._meta.adcp_version, '3.2.0-beta.1');
  assert.equal(all._meta.adcp_profile, 'all');
});

test('modern serving preserves explicitly registered custom schemas and descriptions', async t => {
  const { z } = require('zod');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
  const { wrapMcpServer } = require('../../dist/lib/server/adcp-server.js');
  const { createModernMcpServerAdapter } = require('../../dist/lib/server/mcp-modern-server.js');

  const legacy = new McpServer({ name: 'modern-output-schema-test', version: '1.0.0' });
  legacy.registerTool(
    'request_proposals',
    {
      description: 'Adopter-specific proposal bridge.',
      inputSchema: {},
      outputSchema: z.object({ placeholder: z.string() }),
    },
    async () => ({ content: [{ type: 'text', text: 'unused' }] })
  );
  const adapter = createModernMcpServerAdapter(wrapMcpServer(legacy, undefined, '3.2.0-beta.1'));
  const httpServer = createServer((req, res) => void adapter.handle(req, res));
  const url = await listen(httpServer);
  const client = new Client(
    { name: 'modern-output-schema-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );

  t.after(async () => {
    await client.close().catch(() => {});
    await adapter.close();
    await closeServer(httpServer);
  });

  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const listed = await client.listTools();
  const proposals = listed.tools.find(tool => tool.name === 'request_proposals');
  assert.equal(proposals.description, 'Adopter-specific proposal bridge.');
  assert.ok(proposals.outputSchema.properties?.placeholder);
  assert.equal(proposals.outputSchema.properties?.outcome, undefined);
});

test('modern serving forwards portable MCP App metadata for custom tools', async t => {
  const { serve, InMemoryStateStore } = require('../../dist/lib/index.js');
  const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

  const appOnlyMeta = { ui: { visibility: ['app'] } };
  const resourceMeta = {
    ui: {
      csp: {
        connectDomains: ['https://api.example.com'],
        resourceDomains: ['https://cdn.example.com'],
      },
      domain: 'creative-upload.example.com',
      prefersBorder: true,
    },
  };
  const result = text => async () => ({ content: [{ type: 'text', text }] });
  const httpServer = serve(
    () =>
      createAdcpServer({
        name: 'modern-mcp-app-test',
        version: '1.0.0',
        stateStore: new InMemoryStateStore(),
        resources: [
          {
            name: 'creative_upload',
            uri: 'ui://creative/upload',
            title: 'Creative upload',
            _meta: resourceMeta,
            handler: async () => '<!doctype html><html><body>upload</body></html>',
          },
        ],
        customTools: {
          upload_creative_asset: {
            description: 'Open the portable creative upload app',
            _meta: { ui: { resourceUri: 'ui://creative/upload' } },
            handler: result('opened'),
          },
          prepare_creative_upload: {
            _meta: appOnlyMeta,
            handler: result('prepared'),
          },
          finalize_creative_upload: {
            _meta: appOnlyMeta,
            handler: result('finalized'),
          },
        },
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
    { name: 'portable-mcp-app-client', version: '1.0.0' },
    {
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
        },
      },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    }
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  t.after(async () => {
    await client.close().catch(() => {});
    await closeServer(httpServer);
  });

  await client.connect(transport);
  const listed = await client.listTools();
  const tools = Object.fromEntries(listed.tools.map(tool => [tool.name, tool]));
  assert.deepEqual(tools.upload_creative_asset._meta, {
    ui: { resourceUri: 'ui://creative/upload' },
  });
  assert.deepEqual(tools.prepare_creative_upload._meta, appOnlyMeta);
  assert.deepEqual(tools.finalize_creative_upload._meta, appOnlyMeta);

  const listedResources = await client.listResources();
  assert.deepEqual(listedResources.resources, [
    {
      name: 'creative_upload',
      uri: 'ui://creative/upload',
      title: 'Creative upload',
      mimeType: 'text/html;profile=mcp-app',
      _meta: resourceMeta,
    },
  ]);
  const resource = await client.readResource({ uri: 'ui://creative/upload' });
  assert.deepEqual(resource.contents, [
    {
      uri: 'ui://creative/upload',
      mimeType: 'text/html;profile=mcp-app',
      text: '<!doctype html><html><body>upload</body></html>',
      _meta: resourceMeta,
    },
  ]);

  const prepared = await client.callTool({ name: 'prepare_creative_upload', arguments: {} });
  assert.equal(
    prepared.content[0].text,
    'prepared',
    'visibility metadata must not become a server-side authorization boundary'
  );

  // Capability negotiation belongs to the host. A client that does not
  // advertise MCP Apps must still receive and call the ordinary text tool;
  // the optional resource registration cannot make the server UI-only.
  const fallbackClient = new Client(
    { name: 'text-only-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  const fallbackTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  t.after(async () => fallbackClient.close().catch(() => {}));
  await fallbackClient.connect(fallbackTransport);
  const fallback = await fallbackClient.callTool({ name: 'upload_creative_asset', arguments: {} });
  assert.equal(fallback.content[0].text, 'opened');
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
        resources: [
          {
            name: 'private_app',
            uri: 'ui://private/app',
            handler: async () => '<!doctype html><html><body>private</body></html>',
          },
        ],
        customTools: {
          open_private_app: {
            _meta: { ui: { resourceUri: 'ui://private/app' } },
            handler: async () => ({ content: [{ type: 'text', text: 'private' }] }),
          },
        },
      });
      setToolVisibilityResolver(
        server,
        ({ toolName }) => toolName !== 'get_adcp_capabilities' && toolName !== 'open_private_app'
      );
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
  assert.ok(!listed.tools.some(tool => tool.name === 'open_private_app'));
  const resources = await client.listResources();
  assert.deepEqual(resources.resources, [], 'resources linked only from hidden tools must also be hidden');
  await assert.rejects(() => client.callTool({ name: 'get_adcp_capabilities', arguments: {} }));
  await assert.rejects(() => client.readResource({ uri: 'ui://private/app' }));
});
