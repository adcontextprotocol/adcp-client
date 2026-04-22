const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  exchangeClientCredentials,
  ensureClientCredentialsTokens,
  ClientCredentialsExchangeError,
  MissingEnvSecretError,
  resolveSecret,
  isEnvSecretReference,
  toEnvSecretReference,
} = require('../dist/lib/auth/oauth/index.js');
const { getAuthToken } = require('../dist/lib/auth/index.js');
const { createTestClient } = require('../dist/lib/testing/client.js');

/**
 * Tiny fetch stub factory — returns a function with a `.calls` array. Lets
 * tests assert on the exact request the library builds without intercepting
 * the global fetch or pulling in a mocking framework.
 */
function makeFetchStub(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const res = await handler(url, init);
    if (res instanceof Response) return res;
    return new Response(res.body ?? '', {
      status: res.status ?? 200,
      headers: res.headers ?? {},
    });
  };
  fn.calls = calls;
  return fn;
}

/** Parse the form body the library sent into URLSearchParams for semantic asserts. */
function parseBody(call) {
  return new URLSearchParams(call.init.body);
}

/** Decode the Basic-auth header the library sent into a raw "id:secret" string. */
function decodeBasic(call) {
  const header = call.init.headers.authorization;
  assert.ok(header && header.startsWith('Basic '), 'expected Basic auth header');
  return Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
}

describe('secret resolver', () => {
  it('returns literal values unchanged', () => {
    assert.strictEqual(resolveSecret('plaintext-secret'), 'plaintext-secret');
  });

  it('resolves $ENV:VAR references from process.env', () => {
    process.env.__TEST_CC_SECRET = 's3cret';
    try {
      assert.strictEqual(resolveSecret('$ENV:__TEST_CC_SECRET'), 's3cret');
    } finally {
      delete process.env.__TEST_CC_SECRET;
    }
  });

  it("distinguishes 'unset' from 'empty' env vars", () => {
    delete process.env.__TEST_CC_MISSING;
    assert.throws(
      () => resolveSecret('$ENV:__TEST_CC_MISSING'),
      err => err instanceof MissingEnvSecretError && err.reason === 'unset'
    );
    process.env.__TEST_CC_EMPTY = '';
    try {
      assert.throws(
        () => resolveSecret('$ENV:__TEST_CC_EMPTY'),
        err => err instanceof MissingEnvSecretError && err.reason === 'empty'
      );
    } finally {
      delete process.env.__TEST_CC_EMPTY;
    }
  });

  it('trims whitespace in env var names (common paste mistake)', () => {
    process.env.__TEST_CC_WS = 'ok';
    try {
      assert.strictEqual(resolveSecret('$ENV: __TEST_CC_WS'), 'ok');
    } finally {
      delete process.env.__TEST_CC_WS;
    }
  });

  it('rejects empty $ENV: reference', () => {
    assert.throws(() => resolveSecret('$ENV:'), /expected '\$ENV:VAR_NAME'/);
  });

  it('detects env references via isEnvSecretReference', () => {
    assert.strictEqual(isEnvSecretReference('$ENV:FOO'), true);
    assert.strictEqual(isEnvSecretReference('literal'), false);
  });

  it('builds env references via toEnvSecretReference', () => {
    assert.strictEqual(toEnvSecretReference('FOO'), '$ENV:FOO');
  });
});

describe('exchangeClientCredentials — happy path', () => {
  it('sends Basic Auth and parses a successful response', async () => {
    const fetchStub = makeFetchStub(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'at_abc',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'adcp',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );

    const tokens = await exchangeClientCredentials(
      {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'my-id',
        client_secret: 'my-secret',
        scope: 'adcp',
      },
      { fetch: fetchStub }
    );

    assert.strictEqual(fetchStub.calls.length, 1);
    const call = fetchStub.calls[0];
    assert.strictEqual(call.url, 'https://auth.example.com/token');
    assert.strictEqual(call.init.method, 'POST');
    assert.strictEqual(decodeBasic(call), 'my-id:my-secret');
    const body = parseBody(call);
    assert.strictEqual(body.get('grant_type'), 'client_credentials');
    assert.strictEqual(body.get('scope'), 'adcp');
    assert.strictEqual(body.has('client_id'), false);
    assert.strictEqual(body.has('client_secret'), false);
    assert.strictEqual(tokens.access_token, 'at_abc');
    assert.strictEqual(tokens.expires_in, 3600);
    assert.ok(tokens.expires_at);
  });

  it('sends credentials in the body when auth_method is "body"', async () => {
    const fetchStub = makeFetchStub(
      async () => new Response(JSON.stringify({ access_token: 'at_xyz' }), { status: 200 })
    );

    await exchangeClientCredentials(
      {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'my-id',
        client_secret: 'my-secret',
        auth_method: 'body',
      },
      { fetch: fetchStub }
    );

    const call = fetchStub.calls[0];
    assert.strictEqual(call.init.headers.authorization, undefined);
    const body = parseBody(call);
    assert.strictEqual(body.get('client_id'), 'my-id');
    assert.strictEqual(body.get('client_secret'), 'my-secret');
  });

  it('forwards RFC 8707 resource indicator (single URI)', async () => {
    const fetchStub = makeFetchStub(async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }));

    await exchangeClientCredentials(
      {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
        resource: 'https://agent.example.com/mcp',
      },
      { fetch: fetchStub }
    );

    const body = parseBody(fetchStub.calls[0]);
    assert.deepStrictEqual(body.getAll('resource'), ['https://agent.example.com/mcp']);
  });

  it('forwards RFC 8707 resource indicator (multiple URIs)', async () => {
    const fetchStub = makeFetchStub(async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }));

    await exchangeClientCredentials(
      {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
        resource: ['https://a.example.com', 'https://b.example.com'],
      },
      { fetch: fetchStub }
    );

    const body = parseBody(fetchStub.calls[0]);
    assert.deepStrictEqual(body.getAll('resource'), ['https://a.example.com', 'https://b.example.com']);
  });

  it('forwards audience parameter', async () => {
    const fetchStub = makeFetchStub(async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }));

    await exchangeClientCredentials(
      {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
        audience: 'https://api.example.com',
      },
      { fetch: fetchStub }
    );

    assert.strictEqual(parseBody(fetchStub.calls[0]).get('audience'), 'https://api.example.com');
  });
});

describe('exchangeClientCredentials — RFC 6749 §2.3.1 encoding', () => {
  // Secrets can legally contain characters where RFC 3986 percent-encoding
  // (encodeURIComponent) and RFC 6749 application/x-www-form-urlencoded
  // diverge. A spec-conformant server encodes its stored secret the RFC 6749
  // way, so the client must too — otherwise Basic auth silently mismatches.
  it("encodes space as '+' (not %20) per form-urlencoded spec", async () => {
    const fetchStub = makeFetchStub(async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }));

    await exchangeClientCredentials(
      {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'client id',
        client_secret: 'sec ret',
      },
      { fetch: fetchStub }
    );

    // Raw header inspection: decoded Basic must carry '+' where RFC 6749 mandates it.
    const header = fetchStub.calls[0].init.headers.authorization;
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
    assert.strictEqual(decoded, 'client+id:sec+ret');
  });

  it("percent-encodes !'()* (which encodeURIComponent leaves alone)", async () => {
    const fetchStub = makeFetchStub(async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }));

    await exchangeClientCredentials(
      {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'a',
        client_secret: "secret!'()*",
      },
      { fetch: fetchStub }
    );

    const decoded = decodeBasic(fetchStub.calls[0]);
    assert.strictEqual(decoded, 'a:secret%21%27%28%29%2A');
  });
});

describe('exchangeClientCredentials — endpoint validation', () => {
  it('rejects http:// token endpoints with a typed error', async () => {
    const fetchStub = makeFetchStub(async () => new Response('{}'));
    await assert.rejects(
      () =>
        exchangeClientCredentials(
          {
            token_endpoint: 'http://auth.example.com/token',
            client_id: 'id',
            client_secret: 'secret',
          },
          { fetch: fetchStub }
        ),
      err => err instanceof ClientCredentialsExchangeError && err.kind === 'malformed' && /HTTPS/.test(err.message)
    );
    assert.strictEqual(fetchStub.calls.length, 0, 'must not hit the network with a plaintext endpoint');
  });

  it('rejects http://localhost by default (SSRF guard) but allows it when allowPrivateIp is set', async () => {
    const fetchStub = makeFetchStub(async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }));
    const creds = { token_endpoint: 'http://localhost:8080/token', client_id: 'id', client_secret: 'secret' };

    await assert.rejects(
      () => exchangeClientCredentials(creds, { fetch: fetchStub }),
      err => err instanceof ClientCredentialsExchangeError && /private or loopback/.test(err.message)
    );
    assert.strictEqual(fetchStub.calls.length, 0);

    // Operator opt-in: the CLI sets this for operator-driven flows.
    await exchangeClientCredentials(creds, { fetch: fetchStub, allowPrivateIp: true });
    await exchangeClientCredentials(
      { token_endpoint: 'http://127.0.0.1:8080/token', client_id: 'id', client_secret: 'secret' },
      { fetch: fetchStub, allowPrivateIp: true }
    );
    assert.strictEqual(fetchStub.calls.length, 2);
  });

  it('rejects token endpoints that carry user:pass@ userinfo', async () => {
    const fetchStub = makeFetchStub(async () => new Response('{}'));
    await assert.rejects(
      () =>
        exchangeClientCredentials(
          {
            token_endpoint: 'https://user:pass@auth.example.com/token',
            client_id: 'id',
            client_secret: 'secret',
          },
          { fetch: fetchStub, allowPrivateIp: true }
        ),
      err => err instanceof ClientCredentialsExchangeError && err.kind === 'malformed' && /userinfo/i.test(err.message)
    );
    assert.strictEqual(fetchStub.calls.length, 0);
  });
});

describe('exchangeClientCredentials — error shapes', () => {
  it('maps invalid_client to kind="oauth" with AS error code surfaced', async () => {
    const fetchStub = makeFetchStub(
      async () =>
        new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Bad secret' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
    );

    await assert.rejects(
      () =>
        exchangeClientCredentials(
          { token_endpoint: 'https://auth.example.com/token', client_id: 'id', client_secret: 'wrong' },
          { fetch: fetchStub }
        ),
      err =>
        err instanceof ClientCredentialsExchangeError &&
        err.kind === 'oauth' &&
        err.oauthError === 'invalid_client' &&
        err.oauthErrorDescription === 'Bad secret' &&
        err.httpStatus === 401
    );
  });

  it('maps a 200-without-access_token to kind="malformed"', async () => {
    const fetchStub = makeFetchStub(
      async () => new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200 })
    );

    await assert.rejects(
      () =>
        exchangeClientCredentials(
          { token_endpoint: 'https://auth.example.com/token', client_id: 'id', client_secret: 'secret' },
          { fetch: fetchStub }
        ),
      err => err instanceof ClientCredentialsExchangeError && err.kind === 'malformed'
    );
  });

  it('maps a timeout to kind="network"', async () => {
    const fetchStub = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

    await assert.rejects(
      () =>
        exchangeClientCredentials(
          { token_endpoint: 'https://auth.example.com/token', client_id: 'id', client_secret: 'secret' },
          { fetch: fetchStub, timeoutMs: 50 }
        ),
      err =>
        err instanceof ClientCredentialsExchangeError &&
        err.kind === 'network' &&
        /did not respond within 50ms/.test(err.message)
    );
  });

  it('maps a fetch throw (DNS failure, conn refused) to kind="network"', async () => {
    const fetchStub = async () => {
      const err = new Error('ECONNREFUSED');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    };

    await assert.rejects(
      () =>
        exchangeClientCredentials(
          { token_endpoint: 'https://auth.example.com/token', client_id: 'id', client_secret: 'secret' },
          { fetch: fetchStub }
        ),
      err => err instanceof ClientCredentialsExchangeError && err.kind === 'network'
    );
  });

  it('strips control characters and ANSI escapes from AS error_description', async () => {
    // Simulated compromised / hostile AS that tries to emit terminal escapes.
    const hostile = '\u001b[31mBAD\u001b[0m\r\nfake log line';
    const fetchStub = makeFetchStub(
      async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: hostile }), { status: 401 })
    );

    let captured;
    try {
      await exchangeClientCredentials(
        { token_endpoint: 'https://auth.example.com/token', client_id: 'id', client_secret: 'secret' },
        { fetch: fetchStub }
      );
    } catch (err) {
      captured = err;
    }
    assert.ok(captured instanceof ClientCredentialsExchangeError);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(captured.oauthErrorDescription, /[\x00-\x1F\x7F-\x9F]/);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(captured.message, /[\x00-\x1F\x7F-\x9F]/);
  });
});

describe('ensureClientCredentialsTokens', () => {
  it('returns cached tokens without hitting the network when not expired', async () => {
    const fetchStub = makeFetchStub(async () => {
      throw new Error('fetch should not have been called');
    });

    const agent = {
      id: 'a',
      name: 'a',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      oauth_client_credentials: {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
      },
      oauth_tokens: {
        access_token: 'cached_at',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      },
    };

    const tokens = await ensureClientCredentialsTokens(agent, { fetch: fetchStub });
    assert.strictEqual(tokens.access_token, 'cached_at');
    assert.strictEqual(fetchStub.calls.length, 0);
  });

  it('re-exchanges when the cached token is within the expiration skew', async () => {
    const fetchStub = makeFetchStub(
      async () => new Response(JSON.stringify({ access_token: 'fresh_at', expires_in: 3600 }), { status: 200 })
    );

    const agent = {
      id: 'a',
      name: 'a',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      oauth_client_credentials: {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
      },
      oauth_tokens: {
        access_token: 'stale_at',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      },
    };

    const tokens = await ensureClientCredentialsTokens(agent, { fetch: fetchStub });
    assert.strictEqual(tokens.access_token, 'fresh_at');
    assert.strictEqual(agent.oauth_tokens.access_token, 'fresh_at');
    assert.strictEqual(fetchStub.calls.length, 1);
  });

  it('persists refreshed tokens via the storage backend', async () => {
    const fetchStub = makeFetchStub(
      async () => new Response(JSON.stringify({ access_token: 'fresh_at', expires_in: 3600 }), { status: 200 })
    );
    const saved = [];
    const storage = {
      async loadAgent() {
        return undefined;
      },
      async saveAgent(agent) {
        saved.push(JSON.parse(JSON.stringify(agent)));
      },
    };

    const agent = {
      id: 'a',
      name: 'a',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      oauth_client_credentials: {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
      },
    };

    await ensureClientCredentialsTokens(agent, { fetch: fetchStub, storage });
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].oauth_tokens.access_token, 'fresh_at');
  });

  it('forces re-exchange when force=true even on a warm cache', async () => {
    const fetchStub = makeFetchStub(
      async () => new Response(JSON.stringify({ access_token: 'forced_at' }), { status: 200 })
    );

    const agent = {
      id: 'a',
      name: 'a',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      oauth_client_credentials: {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
      },
      oauth_tokens: {
        access_token: 'cached_at',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      },
    };

    const tokens = await ensureClientCredentialsTokens(agent, { fetch: fetchStub, force: true });
    assert.strictEqual(tokens.access_token, 'forced_at');
  });

  it('throws when called on an agent without oauth_client_credentials', async () => {
    const agent = {
      id: 'a',
      name: 'a',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
    };
    await assert.rejects(() => ensureClientCredentialsTokens(agent), /no oauth_client_credentials configured/);
  });

  it('coalesces concurrent refreshes for the same agent into a single POST', async () => {
    // Simulate a storyboard fan-out firing parallel tool calls that all
    // observe an expired cache. Without coalescing every call races its own
    // token POST.
    let hits = 0;
    const fetchStub = async () => {
      hits++;
      await new Promise(r => setTimeout(r, 25));
      return new Response(JSON.stringify({ access_token: 'coalesced_at' }), { status: 200 });
    };

    const agent = {
      id: 'unique-agent-id',
      name: 'a',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      oauth_client_credentials: {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
      },
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ensureClientCredentialsTokens(agent, { fetch: fetchStub }))
    );
    assert.strictEqual(hits, 1, 'expected a single upstream POST across all 10 concurrent callers');
    for (const t of results) assert.strictEqual(t.access_token, 'coalesced_at');
  });
});

describe('getAuthToken integration with client credentials', () => {
  it('returns the cached CC access_token as the bearer (not auth_token)', () => {
    const agent = {
      id: 'a',
      name: 'a',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      auth_token: 'legacy_bearer',
      oauth_client_credentials: {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
      },
      oauth_tokens: { access_token: 'cc_access_token', token_type: 'Bearer' },
    };
    assert.strictEqual(getAuthToken(agent), 'cc_access_token');
  });

  it('falls back to auth_token when no CC cached tokens exist yet', () => {
    const agent = {
      id: 'a',
      name: 'a',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      auth_token: 'legacy_bearer',
      oauth_client_credentials: {
        token_endpoint: 'https://auth.example.com/token',
        client_id: 'id',
        client_secret: 'secret',
      },
    };
    assert.strictEqual(getAuthToken(agent), 'legacy_bearer');
  });

  it('does NOT surface authorization-code oauth_tokens (those go via OAuth provider path)', () => {
    const agent = {
      id: 'a',
      name: 'a',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      auth_token: 'legacy_bearer',
      oauth_tokens: { access_token: 'ac_access_token', token_type: 'Bearer' },
    };
    assert.strictEqual(getAuthToken(agent), 'legacy_bearer');
  });
});

describe('createTestClient — oauth_client_credentials auth type', () => {
  it('builds an agent config carrying oauth_client_credentials for library-level refresh', () => {
    const client = createTestClient('https://agent.example.com/mcp', 'mcp', {
      auth: {
        type: 'oauth_client_credentials',
        credentials: {
          token_endpoint: 'https://auth.example.com/token',
          client_id: 'id',
          client_secret: 'secret',
          scope: 'adcp',
        },
        tokens: { access_token: 'seeded_at', token_type: 'Bearer' },
      },
    });
    const agentConfig = client.getAgent();
    assert.strictEqual(agentConfig.oauth_client_credentials.token_endpoint, 'https://auth.example.com/token');
    assert.strictEqual(agentConfig.oauth_client_credentials.client_id, 'id');
    assert.strictEqual(agentConfig.oauth_tokens.access_token, 'seeded_at');
  });

  it('omits oauth_tokens when caller does not seed the cache', () => {
    const client = createTestClient('https://agent.example.com/mcp', 'mcp', {
      auth: {
        type: 'oauth_client_credentials',
        credentials: {
          token_endpoint: 'https://auth.example.com/token',
          client_id: 'id',
          client_secret: 'secret',
        },
      },
    });
    const agentConfig = client.getAgent();
    assert.ok(agentConfig.oauth_client_credentials);
    assert.strictEqual(agentConfig.oauth_tokens, undefined);
  });
});
