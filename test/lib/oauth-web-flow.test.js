/**
 * Tests for the web (server-side) OAuth flow helpers.
 *
 * Drives `startWebOAuthFlow` and `completeWebOAuthFlow` against an
 * in-process HTTP server that plays the AS + PRM endpoints. The goal
 * is to lock in the bits the SDK is responsible for — PRM resolution,
 * scope priority, resource forwarding into token exchange, atomic
 * consume, error envelope plumbing — without re-testing the MCP SDK
 * primitives underneath.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  startWebOAuthFlow,
  completeWebOAuthFlow,
  safeReturnTo,
  InMemoryPendingFlowStore,
  InvalidOrExpiredFlowError,
  StateMismatchError,
  TokenExchangeError,
  ProtectedResourceMetadataError,
  AgentVanishedDuringFlowError,
  ConfidentialClientNotAllowedError,
} = require('../../dist/lib/auth/oauth');

const state = {
  server: null,
  port: 0,
  handlers: {},
  lastTokenRequest: null,
  lastRegisterRequest: null,
};

before(async () => {
  state.server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const handler = state.handlers[url.pathname];
    if (!handler) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        handler(req, res, body, url);
      } catch (err) {
        console.error('test fixture handler threw:', err);
        res.statusCode = 500;
        res.end('test fixture error');
      }
    });
  });
  await new Promise(r => state.server.listen(0, '127.0.0.1', r));
  state.port = state.server.address().port;
});

after(async () => {
  await new Promise(r => state.server.close(r));
});

beforeEach(() => {
  state.handlers = {};
  state.lastTokenRequest = null;
  state.lastRegisterRequest = null;
});

function origin() {
  return `http://127.0.0.1:${state.port}`;
}
function agentUrl() {
  return `${origin()}/mcp`;
}
function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function makeAgent(overrides = {}) {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    agent_uri: agentUrl(),
    protocol: 'mcp',
    oauth_client: { client_id: 'pre-registered-client' },
    ...overrides,
  };
}

function installStandardASHandlers({ tokenEndpointAuthMethods, registrationEndpoint, registrationResponse } = {}) {
  state.handlers['/.well-known/oauth-authorization-server'] = (req, res) =>
    jsonRes(res, 200, {
      issuer: origin(),
      authorization_endpoint: `${origin()}/oauth/authorize`,
      token_endpoint: `${origin()}/oauth/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: tokenEndpointAuthMethods ?? ['none'],
      ...(registrationEndpoint ? { registration_endpoint: `${origin()}/oauth/register` } : {}),
      scopes_supported: ['mcp.read', 'mcp.write'],
    });
  state.handlers['/oauth/token'] = (req, res, body) => {
    const params = new URLSearchParams(body);
    state.lastTokenRequest = {
      headers: req.headers,
      params: Object.fromEntries(params),
    };
    jsonRes(res, 200, {
      access_token: 'issued-access-token',
      refresh_token: 'issued-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: params.get('scope') ?? undefined,
    });
  };
  if (registrationEndpoint) {
    state.handlers['/oauth/register'] = (req, res, body) => {
      state.lastRegisterRequest = JSON.parse(body);
      const merged = { ...JSON.parse(body), ...(registrationResponse ?? {}) };
      jsonRes(res, 201, {
        client_id: 'dyn-registered-client',
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...merged,
      });
    };
  }
}

describe('startWebOAuthFlow', () => {
  test('prefers PRM.resource over the server-derived fallback', async () => {
    // The agent_uri carries a trailing slash; the PRM advertises the
    // canonical no-slash form. The local-guess path would be `/mcp/`
    // and PRM is `/mcp` — different strings so we can verify which one
    // landed on the wire. (`checkResourceAllowed` allows requested-longer
    // -than-configured paths.)
    const slashedAgentUrl = `${origin()}/mcp/`;
    const prmResource = `${origin()}/mcp`;
    // The MCP SDK strips the trailing slash from agent_uri's pathname
    // when building the well-known URL — handler registers at /mcp not /mcp/.
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, {
        resource: prmResource,
        authorization_servers: [origin()],
      });
    installStandardASHandlers();

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const result = await startWebOAuthFlow({
      agent: makeAgent({ agent_uri: slashedAgentUrl }),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
    });

    const url = new URL(result.authorizationUrl);
    assert.strictEqual(url.searchParams.get('resource'), prmResource);
    assert.strictEqual(url.searchParams.get('state'), result.state);
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://localhost:9999/callback');
    assert.ok(url.searchParams.get('code_challenge'), 'PKCE code_challenge missing');
  });

  test('falls back to server-derived resource on a 404 PRM (RFC 9728 optional)', async () => {
    installStandardASHandlers();
    const pendingFlowStore = new InMemoryPendingFlowStore();
    const result = await startWebOAuthFlow({
      agent: makeAgent(),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
    });

    const resource = new URL(result.authorizationUrl).searchParams.get('resource');
    assert.ok(resource, 'resource indicator missing');
    assert.ok(resource.startsWith(origin()), `expected resource to start with ${origin()}, got ${resource}`);
  });

  test('throws ProtectedResourceMetadataError on a malformed PRM body', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{not valid json');
    };
    installStandardASHandlers();

    await assert.rejects(
      () =>
        startWebOAuthFlow({
          agent: makeAgent(),
          redirectUri: 'http://localhost:9999/callback',
          pendingFlowStore: new InMemoryPendingFlowStore(),
        }),
      err => err instanceof ProtectedResourceMetadataError
    );
  });

  test('throws ProtectedResourceMetadataError when PRM advertises a foreign resource origin', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, {
        resource: 'https://victim-bank.example/',
        authorization_servers: [origin()],
      });
    installStandardASHandlers();

    await assert.rejects(
      () =>
        startWebOAuthFlow({
          agent: makeAgent(),
          redirectUri: 'http://localhost:9999/callback',
          pendingFlowStore: new InMemoryPendingFlowStore(),
        }),
      err => err instanceof ProtectedResourceMetadataError && /does not share an origin/.test(err.message)
    );
  });

  test('caller scopeHint overrides PRM.scopes_supported (SEP-835)', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, {
        resource: agentUrl(),
        authorization_servers: [origin()],
        scopes_supported: ['mcp.read', 'mcp.write'],
      });
    installStandardASHandlers();

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const result = await startWebOAuthFlow({
      agent: makeAgent(),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
      scopeHint: 'mcp.read',
    });

    assert.strictEqual(new URL(result.authorizationUrl).searchParams.get('scope'), 'mcp.read');
  });

  test('uses PRM.scopes_supported when no scopeHint is provided', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, {
        resource: agentUrl(),
        authorization_servers: [origin()],
        scopes_supported: ['mcp.read', 'mcp.write'],
      });
    installStandardASHandlers();

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const result = await startWebOAuthFlow({
      agent: makeAgent(),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
    });

    assert.strictEqual(new URL(result.authorizationUrl).searchParams.get('scope'), 'mcp.read mcp.write');
  });

  test('persists the pending flow keyed by state with PKCE verifier and resource', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers();

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const result = await startWebOAuthFlow({
      agent: makeAgent(),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
      carry: { return_to: '/dashboard' },
    });

    const flow = await pendingFlowStore.consume(result.state);
    assert.ok(flow, 'flow not found in store');
    assert.strictEqual(flow.agentId, 'test-agent');
    assert.strictEqual(flow.agentUrl, agentUrl());
    assert.strictEqual(flow.redirectUri, 'http://localhost:9999/callback');
    assert.strictEqual(flow.resource, agentUrl());
    assert.strictEqual(flow.authorizationServerUrl, `${origin()}/`);
    assert.deepStrictEqual(flow.carry, { return_to: '/dashboard' });
    assert.ok(flow.codeVerifier && flow.codeVerifier.length > 0, 'code verifier missing');
  });

  test('runs dynamic client registration when agent has no oauth_client', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers({ registrationEndpoint: true });

    const agent = makeAgent({ oauth_client: undefined });
    const savedAgents = [];
    const agentStorage = {
      loadAgent: async () => agent,
      saveAgent: async a => {
        savedAgents.push(JSON.parse(JSON.stringify(a)));
      },
    };

    const result = await startWebOAuthFlow({
      agent,
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore: new InMemoryPendingFlowStore(),
      agentStorage,
    });

    assert.ok(state.lastRegisterRequest, 'DCR not invoked');
    assert.deepStrictEqual(state.lastRegisterRequest.redirect_uris, ['http://localhost:9999/callback']);
    assert.strictEqual(new URL(result.authorizationUrl).searchParams.get('client_id'), 'dyn-registered-client');
    assert.ok(savedAgents.length >= 1, 'agentStorage.saveAgent not called');
    assert.strictEqual(savedAgents[0].oauth_client.client_id, 'dyn-registered-client');
  });

  test('throws ConfidentialClientNotAllowedError when DCR returns a client_secret without opt-in', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers({
      registrationEndpoint: true,
      registrationResponse: { client_secret: 'oh-no-its-confidential', client_secret_expires_at: 0 },
    });

    await assert.rejects(
      () =>
        startWebOAuthFlow({
          agent: makeAgent({ oauth_client: undefined }),
          redirectUri: 'http://localhost:9999/callback',
          pendingFlowStore: new InMemoryPendingFlowStore(),
        }),
      err => err instanceof ConfidentialClientNotAllowedError
    );
  });

  test('allowConfidentialClient: true permits the secret and persists it', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers({
      registrationEndpoint: true,
      registrationResponse: { client_secret: 'consenting-secret', client_secret_expires_at: 0 },
    });

    const agent = makeAgent({ oauth_client: undefined });
    const savedAgents = [];
    const agentStorage = {
      loadAgent: async () => agent,
      saveAgent: async a => savedAgents.push(JSON.parse(JSON.stringify(a))),
    };

    await startWebOAuthFlow({
      agent,
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore: new InMemoryPendingFlowStore(),
      agentStorage,
      allowConfidentialClient: true,
    });

    assert.strictEqual(savedAgents[0].oauth_client.client_secret, 'consenting-secret');
  });

  test('throws when agent has no oauth_client and AS does not advertise DCR', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers({ registrationEndpoint: false });

    await assert.rejects(
      () =>
        startWebOAuthFlow({
          agent: makeAgent({ oauth_client: undefined }),
          redirectUri: 'http://localhost:9999/callback',
          pendingFlowStore: new InMemoryPendingFlowStore(),
        }),
      /dynamic client registration/i
    );
  });
});

describe('completeWebOAuthFlow', () => {
  test('exchanges the code, forwards resource, persists tokens via agentStorage', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers();

    const agent = makeAgent();
    const savedAgents = [];
    const agentStorage = {
      loadAgent: async () => agent,
      saveAgent: async a => savedAgents.push(JSON.parse(JSON.stringify(a))),
    };
    const pendingFlowStore = new InMemoryPendingFlowStore();

    const start = await startWebOAuthFlow({
      agent,
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
      carry: { return_to: '/dashboard' },
    });

    const completion = await completeWebOAuthFlow({
      state: start.state,
      code: 'auth-code-from-as',
      pendingFlowStore,
      agentStorage,
    });

    assert.strictEqual(completion.tokens.access_token, 'issued-access-token');
    assert.strictEqual(completion.tokens.refresh_token, 'issued-refresh-token');
    assert.deepStrictEqual(completion.carry, { return_to: '/dashboard' });
    assert.strictEqual(completion.persisted, true);

    assert.ok(state.lastTokenRequest, 'token endpoint never hit');
    assert.strictEqual(state.lastTokenRequest.params.grant_type, 'authorization_code');
    assert.strictEqual(state.lastTokenRequest.params.code, 'auth-code-from-as');
    assert.strictEqual(state.lastTokenRequest.params.resource, agentUrl());
    assert.strictEqual(state.lastTokenRequest.params.redirect_uri, 'http://localhost:9999/callback');
    assert.ok(state.lastTokenRequest.params.code_verifier, 'PKCE verifier missing on token exchange');

    assert.ok(savedAgents.length >= 1);
    const last = savedAgents[savedAgents.length - 1];
    assert.strictEqual(last.oauth_tokens.access_token, 'issued-access-token');
  });

  test('returns persisted=false when no agentStorage is provided', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers();

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const start = await startWebOAuthFlow({
      agent: makeAgent(),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
    });
    const completion = await completeWebOAuthFlow({
      state: start.state,
      code: 'c',
      pendingFlowStore,
    });
    assert.strictEqual(completion.persisted, false);
  });

  test('throws AgentVanishedDuringFlowError when agentStorage.loadAgent returns undefined', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers();

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const agent = makeAgent();
    const start = await startWebOAuthFlow({
      agent,
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
    });

    const agentStorage = {
      loadAgent: async () => undefined,
      saveAgent: async () => {
        throw new Error('should never be called');
      },
    };

    await assert.rejects(
      () =>
        completeWebOAuthFlow({
          state: start.state,
          code: 'c',
          pendingFlowStore,
          agentStorage,
        }),
      err => err instanceof AgentVanishedDuringFlowError && err.agentId === 'test-agent'
    );
  });

  test('throws StateMismatchError when expectedState differs', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers();

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const start = await startWebOAuthFlow({
      agent: makeAgent(),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
    });

    await assert.rejects(
      () =>
        completeWebOAuthFlow({
          state: start.state,
          code: 'c',
          pendingFlowStore,
          expectedState: 'different-cookie-value',
        }),
      err => err instanceof StateMismatchError
    );
  });

  test('expectedState matching the supplied state succeeds', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    installStandardASHandlers();

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const start = await startWebOAuthFlow({
      agent: makeAgent(),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
    });

    const completion = await completeWebOAuthFlow({
      state: start.state,
      code: 'c',
      pendingFlowStore,
      expectedState: start.state,
    });
    assert.strictEqual(completion.tokens.access_token, 'issued-access-token');
  });

  test('throws TokenExchangeError carrying status + body on AS rejection (with token redaction)', async () => {
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });
    state.handlers['/.well-known/oauth-authorization-server'] = (req, res) =>
      jsonRes(res, 200, {
        issuer: origin(),
        authorization_endpoint: `${origin()}/oauth/authorize`,
        token_endpoint: `${origin()}/oauth/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp.read'],
      });
    state.handlers['/oauth/token'] = (req, res) => {
      // AS error response that *also* echoes a refresh token in the body
      // — we want to confirm redaction does its job.
      jsonRes(res, 400, {
        error: 'invalid_grant',
        error_description: 'authorization code expired',
        refresh_token: 'leaked-refresh-token',
      });
    };

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const start = await startWebOAuthFlow({
      agent: makeAgent(),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
    });

    await assert.rejects(
      () =>
        completeWebOAuthFlow({
          state: start.state,
          code: 'expired-code',
          pendingFlowStore,
        }),
      err => {
        if (!(err instanceof TokenExchangeError)) return false;
        assert.strictEqual(err.oauthErrorCode, 'invalid_grant');
        assert.match(err.message, /invalid_grant/);
        assert.doesNotMatch(err.body, /leaked-refresh-token/);
        assert.doesNotMatch(err.message, /leaked-refresh-token/);
        return true;
      }
    );
  });

  test('throws InvalidOrExpiredFlowError on unknown state', async () => {
    await assert.rejects(
      () =>
        completeWebOAuthFlow({
          state: 'never-existed',
          code: 'x',
          pendingFlowStore: new InMemoryPendingFlowStore(),
        }),
      err => err instanceof InvalidOrExpiredFlowError
    );
  });

  test('throws InvalidOrExpiredFlowError on expired flow', async () => {
    installStandardASHandlers();
    state.handlers['/.well-known/oauth-protected-resource/mcp'] = (req, res) =>
      jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [origin()] });

    const pendingFlowStore = new InMemoryPendingFlowStore();
    const start = await startWebOAuthFlow({
      agent: makeAgent(),
      redirectUri: 'http://localhost:9999/callback',
      pendingFlowStore,
      ttlMs: 1,
    });

    await new Promise(r => setTimeout(r, 10));

    await assert.rejects(
      () =>
        completeWebOAuthFlow({
          state: start.state,
          code: 'auth-code',
          pendingFlowStore,
        }),
      err => err instanceof InvalidOrExpiredFlowError
    );
  });
});

describe('PendingWebFlowStore contract (run against any implementation)', () => {
  /**
   * Reusable contract test. Adopters implementing a Postgres or Redis
   * `PendingWebFlowStore` SHOULD run this against their store to prove
   * the atomic-consume contract. The in-memory reference passes by
   * construction; a `SELECT then DELETE` Postgres impl will fail it.
   */
  function runContract(name, factory) {
    describe(name, () => {
      test('consume returns null for absent state', async () => {
        const store = await factory();
        assert.strictEqual(await store.consume('does-not-exist'), null);
      });

      test('consume returns the row exactly once', async () => {
        const store = await factory();
        const flow = makePendingFlow('one-shot', 60_000);
        await store.put(flow);

        const first = await store.consume('one-shot');
        assert.ok(first);
        assert.strictEqual(first.agentId, 'test-agent');

        const second = await store.consume('one-shot');
        assert.strictEqual(second, null);
      });

      test('consume returns null for expired rows', async () => {
        const store = await factory();
        await store.put(makePendingFlow('expired', -1));
        assert.strictEqual(await store.consume('expired'), null);
      });

      test('put rejects duplicate state', async () => {
        const store = await factory();
        await store.put(makePendingFlow('dup', 60_000));
        await assert.rejects(() => store.put(makePendingFlow('dup', 60_000)));
      });

      test('parallel consume of the same state yields exactly one non-null', async () => {
        const store = await factory();
        await store.put(makePendingFlow('race', 60_000));
        const results = await Promise.all([store.consume('race'), store.consume('race')]);
        const wins = results.filter(r => r !== null);
        assert.strictEqual(wins.length, 1, 'two consumers won the race');
      });
    });
  }

  function makePendingFlow(stateValue, ttlMs) {
    const now = new Date();
    return {
      state: stateValue,
      agentId: 'test-agent',
      agentUrl: 'https://agent.example/mcp',
      codeVerifier: 'pkce-verifier',
      redirectUri: 'https://callback.example/cb',
      resource: 'https://agent.example/mcp',
      scope: 'mcp.read',
      authorizationServerUrl: 'https://as.example/',
      clientInformation: { client_id: 'c' },
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      carry: undefined,
    };
  }

  runContract('InMemoryPendingFlowStore', async () => new InMemoryPendingFlowStore());
});

describe('safeReturnTo', () => {
  test('accepts simple absolute paths', () => {
    assert.strictEqual(safeReturnTo('/dashboard'), '/dashboard');
    assert.strictEqual(safeReturnTo('/foo?bar=1'), '/foo?bar=1');
  });

  test('rejects protocol-relative URLs (//evil.example)', () => {
    assert.strictEqual(safeReturnTo('//evil.example/'), undefined);
  });

  test('rejects path-traversal protocol smuggling (/\\\\evil)', () => {
    assert.strictEqual(safeReturnTo('/\\evil.example'), undefined);
  });

  test('rejects absolute URLs by default', () => {
    assert.strictEqual(safeReturnTo('https://evil.example/dashboard'), undefined);
  });

  test('rejects non-string and empty values', () => {
    assert.strictEqual(safeReturnTo(undefined), undefined);
    assert.strictEqual(safeReturnTo(null), undefined);
    assert.strictEqual(safeReturnTo(''), undefined);
    assert.strictEqual(safeReturnTo({ foo: 'bar' }), undefined);
  });

  test('honors allowedReturnHosts allowlist for absolute URLs', () => {
    assert.strictEqual(
      safeReturnTo('https://app.example.com/dashboard', { allowedReturnHosts: ['app.example.com'] }),
      'https://app.example.com/dashboard'
    );
    assert.strictEqual(safeReturnTo('https://evil.example/', { allowedReturnHosts: ['app.example.com'] }), undefined);
  });

  test('rejects non-http(s) schemes even if host appears in allowlist', () => {
    assert.strictEqual(safeReturnTo('javascript:alert(1)', { allowedReturnHosts: ['app.example.com'] }), undefined);
  });
});
