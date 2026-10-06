const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { callMCPToolWithOAuth, connectMCP } = require('../../dist/lib/advanced.js');
const { AdCPClient } = require('../../dist/lib/index.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');
const {
  startWebOAuthFlow,
  completeWebOAuthFlow,
  InMemoryPendingFlowStore,
  MCPOAuthProvider,
  createFileOAuthStorage,
  createNonInteractiveOAuthProvider,
} = require('../../dist/lib/auth/oauth');

function createRefreshProvider(issuer) {
  let tokens = {
    access_token: 'expired-token',
    refresh_token: 'refresh-token',
    token_type: 'Bearer',
    issuer,
  };
  return {
    get redirectUrl() {
      return 'http://127.0.0.1/oauth/callback';
    },
    get clientMetadata() {
      return {
        client_name: 'scoped-fetch-test',
        redirect_uris: [this.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    async clientInformation() {
      return { client_id: 'scoped-fetch-client' };
    },
    async tokens() {
      return tokens;
    },
    async saveTokens(nextTokens) {
      tokens = nextTokens;
    },
    async redirectToAuthorization() {
      throw new Error('refresh should not start an interactive authorization flow');
    },
    async saveCodeVerifier() {},
    async codeVerifier() {
      return 'verifier';
    },
    async invalidateCredentials() {},
  };
}

function createOAuthAgent(url, issuer, id = 'scoped-fetch-agent') {
  return {
    id,
    name: 'Scoped Fetch Agent',
    agent_uri: url,
    protocol: 'mcp',
    oauth_tokens: {
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      issuer,
    },
    oauth_client: { client_id: 'scoped-fetch-client' },
  };
}

function createPingStoryboard() {
  return {
    id: 'scoped_fetch_oauth_refresh',
    version: '1.0.0',
    title: 'Scoped fetch OAuth refresh',
    category: 'integration',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'refresh',
        title: 'Refresh and call',
        steps: [
          {
            id: 'ping',
            title: 'Ping through the storyboard client',
            task: 'ping',
            sample_request: {},
            validations: [],
          },
        ],
      },
    ],
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function startOAuthServer(era) {
  const state = {
    origin: '',
    tokenCalls: 0,
    authorizationCalls: 0,
    registrationCalls: 0,
    refreshCalls: 0,
    clientCredentialsCalls: 0,
    lastRefreshResource: null,
  };
  let modernHandler;
  let closeModernHandler = async () => {};

  if (era === 'modern') {
    const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
    const { toNodeHandler } = require('@modelcontextprotocol/node');
    const handler = createMcpHandler(
      () => {
        const mcp = new McpServer({ name: 'scoped-fetch-modern', version: '1.0.0' });
        mcp.registerTool('ping', {}, async () => ({
          content: [{ type: 'text', text: 'pong' }],
          structuredContent: { ok: true },
        }));
        return mcp;
      },
      { legacy: 'reject' }
    );
    modernHandler = toNodeHandler(handler);
    closeModernHandler = () => handler.close();
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, state.origin).pathname;

    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, {
        resource: `${state.origin}/mcp`,
        authorization_servers: [state.authorizationServer ?? state.origin],
      });
      return;
    }
    if (path.startsWith('/.well-known/oauth-authorization-server')) {
      json(res, 200, {
        issuer: state.origin,
        authorization_endpoint: `${state.origin}/authorize`,
        token_endpoint: `${state.origin}/token`,
        registration_endpoint: `${state.origin}/register`,
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (path === '/register' && req.method === 'POST') {
      state.registrationCalls++;
      json(res, 201, {
        ...JSON.parse(await readBody(req)),
        client_id: 'registered-client',
        client_secret: 'registered-secret',
      });
      return;
    }
    if (path === '/token' && req.method === 'POST') {
      state.tokenCalls++;
      const body = new URLSearchParams(await readBody(req));
      if (body.get('grant_type') === 'refresh_token') {
        assert.equal(body.get('refresh_token'), 'refresh-token');
        state.lastRefreshResource = body.get('resource');
        state.refreshCalls++;
      } else if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('code'), 'authorization-code');
        assert.ok(body.get('code_verifier'));
        state.authorizationCalls++;
      } else {
        assert.equal(body.get('grant_type'), 'client_credentials');
        state.clientCredentialsCalls++;
      }
      json(res, 200, {
        access_token: 'fresh-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      return;
    }
    if (path !== '/mcp' && path !== '/mcp/') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (req.headers.authorization !== 'Bearer fresh-token') {
      res.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${state.origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end('unauthorized');
      return;
    }

    if (era === 'modern') {
      await modernHandler(req, res);
      return;
    }

    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const parsedBody = req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined;
    const mcp = new McpServer({ name: 'scoped-fetch-legacy', version: '1.0.0' });
    mcp.registerTool('ping', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
      structuredContent: { ok: true },
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      await mcp.close();
    }
  });

  state.origin = await listen(server);
  return {
    url: `${state.origin}/mcp`,
    state,
    stop: async () => {
      await closeModernHandler();
      await closeServer(server);
    },
  };
}

async function startA2AServer() {
  const state = { origin: '', cardCalls: 0, sendCalls: 0 };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, state.origin).pathname;
    if (path.endsWith('/.well-known/agent-card.json') || path.endsWith('/.well-known/agent.json')) {
      state.cardCalls++;
      json(res, 200, {
        name: 'Scoped Fetch A2A',
        description: 'A2A scoped-fetch fixture',
        url: `${state.origin}/a2a`,
        version: '1.0.0',
        protocolVersion: '0.3.0',
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        capabilities: { streaming: false, pushNotifications: false },
        skills: [{ id: 'ping', name: 'ping', description: 'ping', tags: ['test'] }],
      });
      return;
    }
    if (path === '/a2a' && req.method === 'POST') {
      const rpc = JSON.parse(await readBody(req));
      state.sendCalls++;
      json(res, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          kind: 'task',
          id: `task-${state.sendCalls}`,
          contextId: 'scoped-fetch-context',
          status: { state: 'completed', timestamp: new Date().toISOString() },
          artifacts: [{ artifactId: 'result', parts: [{ kind: 'data', data: { ok: true } }] }],
        },
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  state.origin = await listen(server);
  return {
    url: `${state.origin}/a2a`,
    state,
    stop: () => closeServer(server),
  };
}

async function withGlobalFetchGuard(run) {
  const originalFetch = global.fetch;
  const fetchedUrls = [];
  const fetchFn = async (input, init) => {
    fetchedUrls.push(String(input instanceof Request ? input.url : input));
    return originalFetch(input, init);
  };
  global.fetch = async () => {
    throw new Error('global fetch must not be used when fetchFn is supplied');
  };
  try {
    await run(fetchFn, fetchedUrls);
  } finally {
    global.fetch = originalFetch;
  }
}

async function callWithSavedProvider(era, server, agent, storage) {
  const authProvider = createNonInteractiveOAuthProvider(agent, { storage, allowHttp: true });
  if (era === 'modern')
    return callMCPToolWithOAuth({
      agentUrl: server.url,
      toolName: 'ping',
      args: {},
      authProvider,
      allowPrivateIp: true,
    });
  const { client } = await connectMCP({ agentUrl: server.url, authProvider, allowPrivateIp: true });
  try {
    return await client.callTool({ name: 'ping', arguments: {} });
  } finally {
    await client.close();
  }
}

for (const era of ['modern', 'legacy']) {
  test(`${era} refreshes web-flow credentials with a trailing-slash issuer`, async () => {
    const server = await startOAuthServer(era);
    const directory = await mkdtemp(join(tmpdir(), 'adcp-web-issuer-'));
    const storage = createFileOAuthStorage({ configPath: join(directory, 'agents.json') });
    const agent = {
      id: 'web-refresh',
      name: 'Web refresh',
      protocol: 'mcp',
      agent_uri: server.url,
      oauth_client: { client_id: 'web-client' },
    };
    const pendingFlowStore = new InMemoryPendingFlowStore();
    try {
      await storage.saveAgent(agent);
      const flow = await startWebOAuthFlow({
        agent,
        agentStorage: storage,
        pendingFlowStore,
        redirectUri: 'http://127.0.0.1/oauth/callback',
        allowHttp: true,
      });
      await completeWebOAuthFlow({
        state: flow.state,
        expectedState: flow.state,
        code: 'authorization-code',
        agentStorage: storage,
        pendingFlowStore,
        allowHttp: true,
      });
      let reloaded = await storage.loadAgent(agent.id);
      assert.equal(reloaded.oauth_tokens.issuer, `${server.state.origin}/`);
      reloaded.oauth_tokens.access_token = 'expired-token';
      await storage.saveAgent(reloaded);
      assert.equal((await callWithSavedProvider(era, server, reloaded, storage)).content[0].text, 'pong');
      assert.equal(server.state.refreshCalls, 1);
      reloaded = await storage.loadAgent(agent.id);
      assert.equal((await callWithSavedProvider(era, server, reloaded, storage)).content[0].text, 'pong');
      assert.equal(server.state.refreshCalls, 1);
    } finally {
      await closeMCPConnections();
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`${era} rediscovery recovers after a rejected noninteractive AS change`, async () => {
    const server = await startOAuthServer(era);
    const attacker = await startOAuthServer(era);
    const directory = await mkdtemp(join(tmpdir(), 'adcp-issuer-recovery-'));
    const storage = createFileOAuthStorage({ configPath: join(directory, 'agents.json') });
    const agent = createOAuthAgent(server.url, server.state.origin, 'issuer-recovery');
    try {
      await storage.saveAgent(agent);
      server.state.authorizationServer = attacker.state.origin;
      await assert.rejects(
        () => callWithSavedProvider(era, server, agent, storage),
        error => error.code === 'interactive_required'
      );
      assert.equal(attacker.state.tokenCalls, 0);
      let reloaded = await storage.loadAgent(agent.id);
      assert.equal(reloaded.oauth_discovery_state, undefined);
      assert.equal(reloaded.oauth_code_verifier, undefined);
      assert.equal(reloaded.oauth_code_verifier, undefined);
      delete server.state.authorizationServer;
      assert.equal((await callWithSavedProvider(era, server, reloaded, storage)).content[0].text, 'pong');
      assert.equal(server.state.refreshCalls, 1);
      assert.equal(attacker.state.tokenCalls, 0);
    } finally {
      await closeMCPConnections();
      await server.stop();
      await attacker.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const era of ['modern', 'legacy']) {
  for (const confidential of [false, true]) {
    for (const issuer of [undefined, 'https://original-as.example']) {
      test(`${era} does not forward ${issuer ? 'differently bound' : 'unbound'} stored ${confidential ? 'client secrets' : 'refresh tokens'} to a discovered server`, async () => {
        await closeMCPConnections();
        const server = await startOAuthServer(era);
        const agent = createOAuthAgent(server.url, issuer);
        agent.oauth_client = {
          client_id: 'scoped-fetch-client',
          ...(confidential && { client_secret: 'saved-secret' }),
          issuer,
        };
        const authProvider = createNonInteractiveOAuthProvider(agent, { allowHttp: true });
        try {
          await assert.rejects(
            async () => {
              if (era === 'modern') {
                await callMCPToolWithOAuth({ agentUrl: server.url, toolName: 'ping', args: {}, authProvider });
              } else {
                const { client } = await connectMCP({ agentUrl: server.url, authProvider });
                await client.close();
              }
            },
            error => error.code === (issuer ? 'interactive_required' : 'oauth_issuer_required')
          );
          assert.equal(server.state.tokenCalls, 0, 'no secret-bearing token request may reach the discovered server');
        } finally {
          await closeMCPConnections();
          await server.stop();
        }
      });
    }
  }
}

for (const era of ['modern', 'legacy']) {
  test(`${era} persists upstream login and refresh issuer bindings across reloads`, async () => {
    await closeMCPConnections();
    const server = await startOAuthServer(era);
    const attacker = await startOAuthServer(era);
    const directory = await mkdtemp(join(tmpdir(), 'adcp-issuer-roundtrip-'));
    const storage = createFileOAuthStorage({ configPath: join(directory, 'agents.json') });
    const agent = { id: `issuer-${era}`, name: 'Issuer roundtrip', agent_uri: server.url, protocol: 'mcp' };
    let authorizationUrl;
    const flowHandler = {
      getRedirectUrl: () => 'http://127.0.0.1/oauth/callback',
      redirectToAuthorization: async url => {
        authorizationUrl = url;
      },
      cleanup: async () => {},
    };
    const provider = MCPOAuthProvider.forCLI(agent, flowHandler, storage, undefined, { allowHttp: true });
    const { auth } =
      era === 'modern' ? require('@modelcontextprotocol/client') : require('@modelcontextprotocol/sdk/client/auth.js');
    const call = async currentAgent => {
      const authProvider = createNonInteractiveOAuthProvider(currentAgent, { storage, allowHttp: true });
      if (era === 'modern') {
        return callMCPToolWithOAuth({ agentUrl: server.url, toolName: 'ping', args: {}, authProvider });
      }
      const { client } = await connectMCP({ agentUrl: server.url, authProvider });
      try {
        return await client.callTool({ name: 'ping', arguments: {} });
      } finally {
        await client.close();
      }
    };
    try {
      const options = {
        serverUrl: server.url,
        resourceMetadataUrl: new URL(`${server.state.origin}/.well-known/oauth-protected-resource/mcp`),
      };
      assert.equal(await auth(provider, options), 'REDIRECT');
      assert.equal(server.state.registrationCalls, 1);
      assert.equal(authorizationUrl.origin, server.state.origin);
      assert.equal(new URL(agent.oauth_client.issuer).origin, server.state.origin);
      const pending = await storage.loadAgent(agent.id);
      assert.equal(new URL(pending.oauth_discovery_state.authorizationServerUrl).origin, server.state.origin);
      // Discovery changes while the browser is away. A new provider must retain the original AS.
      server.state.authorizationServer = attacker.state.origin;
      const callbackProvider = MCPOAuthProvider.forCLI(pending, flowHandler, storage, undefined, { allowHttp: true });
      assert.equal(await auth(callbackProvider, { ...options, authorizationCode: 'authorization-code' }), 'AUTHORIZED');
      assert.equal(attacker.state.tokenCalls, 0);
      assert.equal(attacker.state.registrationCalls, 0);
      delete server.state.authorizationServer;
      Object.assign(agent, pending);
      assert.equal(server.state.authorizationCalls, 1);
      assert.equal(new URL(agent.oauth_tokens.issuer).origin, server.state.origin);
      assert.equal((await provider.tokens()).refresh_token, 'refresh-token');
      let reloaded = await storage.loadAgent(agent.id);
      assert.equal((await call(reloaded)).content[0].text, 'pong');
      assert.equal(server.state.refreshCalls, 0);
      // The resource server rejects this access token, driving the official transport's refresh path.
      reloaded.oauth_tokens.access_token = 'expired-token';
      await storage.saveAgent(reloaded);
      assert.equal((await call(reloaded)).content[0].text, 'pong');
      assert.equal(server.state.refreshCalls, 1);
      reloaded = await storage.loadAgent(agent.id);
      assert.equal(new URL(reloaded.oauth_tokens.issuer).origin, server.state.origin);
      assert.equal(reloaded.oauth_tokens.access_token, 'fresh-token');
      assert.equal(reloaded.oauth_discovery_state, undefined);
      assert.equal(reloaded.oauth_code_verifier, undefined);
      assert.equal((await call(reloaded)).content[0].text, 'pong');
      assert.equal(server.state.refreshCalls, 1);
      assert.equal(server.state.tokenCalls, 2);
    } finally {
      await closeMCPConnections();
      await server.stop();
      await attacker.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('modern OAuth refresh uses the scoped fetcher instead of global fetch', async () => {
  await closeMCPConnections();
  const server = await startOAuthServer('modern');
  try {
    await withGlobalFetchGuard(async (fetchFn, fetchedUrls) => {
      const result = await callMCPToolWithOAuth({
        agentUrl: server.url,
        toolName: 'ping',
        args: {},
        authProvider: createRefreshProvider(server.state.origin),
        fetchFn,
      });
      assert.equal(result.content[0].text, 'pong');
      assert.ok(
        fetchedUrls.some(url => url.endsWith('/token')),
        'scoped fetcher should perform the token exchange'
      );
    });
    assert.equal(server.state.refreshCalls, 1);
  } finally {
    await closeMCPConnections();
    await server.stop();
  }
});

test('legacy OAuth refresh uses the scoped fetcher instead of global fetch', async () => {
  await closeMCPConnections();
  const server = await startOAuthServer('legacy');
  try {
    await withGlobalFetchGuard(async (fetchFn, fetchedUrls) => {
      const { client } = await connectMCP({
        agentUrl: server.url,
        authProvider: createRefreshProvider(server.state.origin),
        fetchFn,
      });
      try {
        const result = await client.callTool({ name: 'ping', arguments: {} });
        assert.equal(result.content[0].text, 'pong');
      } finally {
        await client.close();
      }
      assert.ok(
        fetchedUrls.some(url => url.endsWith('/token')),
        'scoped fetcher should perform the token exchange'
      );
    });
    assert.equal(server.state.refreshCalls, 1);
  } finally {
    await closeMCPConnections();
    await server.stop();
  }
});

test('AdCPClient tools/list and OAuth refresh use the scoped fetcher instead of global fetch', async () => {
  await closeMCPConnections();
  const server = await startOAuthServer('modern');
  try {
    await withGlobalFetchGuard(async (fetchFn, fetchedUrls) => {
      const agent = createOAuthAgent(server.url, server.state.origin);
      agent.oauth_resource = `${server.state.origin}/canonical-resource`;
      const client = new AdCPClient([agent], {
        transport: { fetchFn },
      });

      const info = await client.agent('scoped-fetch-agent').getAgentInfo();

      assert.ok(info.tools.some(tool => tool.name === 'ping'));
      assert.ok(
        fetchedUrls.some(url => url.endsWith('/token')),
        'scoped fetcher should refresh the access token'
      );
      assert.ok(
        fetchedUrls.some(url => url.endsWith('/mcp')),
        'scoped fetcher should perform MCP discovery and listing'
      );
    });
    assert.equal(server.state.refreshCalls, 1);
    assert.equal(server.state.lastRefreshResource, `${server.state.origin}/canonical-resource`);
  } finally {
    await closeMCPConnections();
    await server.stop();
  }
});

test('AdCPClient non-OAuth MCP discovery also uses the scoped fetcher', async () => {
  await closeMCPConnections();
  const server = await startOAuthServer('modern');
  try {
    await withGlobalFetchGuard(async (fetchFn, fetchedUrls) => {
      const client = new AdCPClient(
        [
          {
            id: 'scoped-fetch-static',
            name: 'Scoped Fetch Static Agent',
            agent_uri: server.url,
            protocol: 'mcp',
            auth_token: 'fresh-token',
          },
        ],
        { transport: { fetchFn } }
      );

      const info = await client.agent('scoped-fetch-static').getAgentInfo();

      assert.ok(info.tools.some(tool => tool.name === 'ping'));
      assert.ok(fetchedUrls.some(url => url.endsWith('/mcp')));
    });
    assert.equal(server.state.refreshCalls, 0);
  } finally {
    await closeMCPConnections();
    await server.stop();
  }
});

test('AdCPClient client-credentials discovery uses the scoped fetcher for the token exchange', async () => {
  await closeMCPConnections();
  const server = await startOAuthServer('modern');
  try {
    await withGlobalFetchGuard(async (fetchFn, fetchedUrls) => {
      const client = new AdCPClient(
        [
          {
            id: 'scoped-fetch-client-credentials',
            name: 'Scoped Fetch Client Credentials Agent',
            agent_uri: server.url,
            protocol: 'mcp',
            oauth_client_credentials: {
              client_id: 'client-id',
              client_secret: 'client-secret',
              token_endpoint: `${server.state.origin}/token`,
            },
          },
        ],
        { transport: { fetchFn } }
      );

      const info = await client.agent('scoped-fetch-client-credentials').getAgentInfo();

      assert.ok(info.tools.some(tool => tool.name === 'ping'));
      assert.ok(fetchedUrls.some(url => url.endsWith('/token')));
    });
    assert.equal(server.state.clientCredentialsCalls, 1);
  } finally {
    await closeMCPConnections();
    await server.stop();
  }
});

test('storyboard runner uses the scoped fetcher for OAuth refresh and tool calls', async () => {
  await closeMCPConnections();
  const server = await startOAuthServer('modern');
  try {
    await withGlobalFetchGuard(async (fetchFn, fetchedUrls) => {
      const result = await runStoryboardStep(server.url, createPingStoryboard(), 'ping', {
        protocol: 'mcp',
        allow_http: true,
        auth: {
          type: 'oauth',
          tokens: createOAuthAgent(server.url, server.state.origin).oauth_tokens,
          client: { client_id: 'scoped-fetch-client' },
        },
        transport: { fetchFn },
      });

      assert.equal(result.passed, true, result.error);
      assert.ok(
        fetchedUrls.some(url => url.endsWith('/token')),
        'scoped fetcher should refresh the access token'
      );
      assert.ok(
        fetchedUrls.some(url => url.endsWith('/mcp')),
        'scoped fetcher should perform the storyboard call'
      );
    });
    assert.equal(server.state.refreshCalls, 1);
  } finally {
    await closeMCPConnections();
    await server.stop();
  }
});

test('AdCPClient A2A card discovery and message/send use the scoped fetcher', async () => {
  const server = await startA2AServer();
  try {
    await withGlobalFetchGuard(async (fetchFn, fetchedUrls) => {
      const client = new AdCPClient(
        [{ id: 'scoped-fetch-a2a', name: 'Scoped Fetch A2A', agent_uri: server.url, protocol: 'a2a' }],
        { transport: { fetchFn }, validation: { requests: 'off', responses: 'off' } }
      );
      const agent = client.agent('scoped-fetch-a2a');

      const info = await agent.getAgentInfo();
      const result = await agent.executeTask('ping', {});

      assert.ok(info.tools.some(tool => tool.name === 'ping'));
      assert.equal(result.success, true, result.error);
      assert.ok(fetchedUrls.some(url => url.includes('/.well-known/agent')));
      assert.ok(fetchedUrls.some(url => url.endsWith('/a2a')));
    });
    assert.ok(server.state.cardCalls >= 1);
    assert.equal(server.state.sendCalls, 1);
  } finally {
    await server.stop();
  }
});
