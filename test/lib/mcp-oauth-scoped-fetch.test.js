const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

const { callMCPToolWithOAuth, connectMCP } = require('../../dist/lib/advanced.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');

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
  const state = { origin: '', refreshCalls: 0 };
  let modernHandler;
  let closeModernHandler = async () => {};

  if (era === 'modern') {
    const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
    const { toNodeHandler } = require('@modelcontextprotocol/node');
    const handler = createMcpHandler(
      () => {
        const mcp = new McpServer({ name: 'scoped-fetch-modern', version: '1.0.0' });
        mcp.registerTool('ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
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
        authorization_servers: [state.origin],
      });
      return;
    }
    if (path.startsWith('/.well-known/oauth-authorization-server')) {
      json(res, 200, {
        issuer: state.origin,
        authorization_endpoint: `${state.origin}/authorize`,
        token_endpoint: `${state.origin}/token`,
        grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (path === '/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'refresh-token');
      state.refreshCalls++;
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
    mcp.registerTool('ping', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
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
