const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const {
  serve,
  verifyApiKey,
  verifyBearer,
  anyOf,
  respondUnauthorized,
  extractBearerToken,
  createAdcpServer,
  AuthError,
  DEFAULT_JWT_ALGORITHMS,
} = require('../dist/lib/server/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAgent() {
  return createAdcpServer({
    name: 'Test Agent',
    version: '1.0.0',
    mediaBuy: {
      getProducts: async () => ({ products: [] }),
    },
  });
}

async function startServer(options) {
  return new Promise(resolve => {
    const srv = serve(() => createAgent(), {
      port: 0,
      ...options,
      onListening: url => resolve({ server: srv, url, port: new URL(url).port }),
    });
  });
}

function fetchPath(port, path, init = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

// ---------------------------------------------------------------------------
// extractBearerToken
// ---------------------------------------------------------------------------

describe('extractBearerToken', () => {
  it('reads Authorization: Bearer <token>', () => {
    const req = { headers: { authorization: 'Bearer abc123' } };
    assert.strictEqual(extractBearerToken(req), 'abc123');
  });

  it('is case-insensitive on the "Bearer" prefix', () => {
    const req = { headers: { authorization: 'bearer abc' } };
    assert.strictEqual(extractBearerToken(req), 'abc');
  });

  it('accepts tab as separator', () => {
    const req = { headers: { authorization: 'Bearer\tabc' } };
    assert.strictEqual(extractBearerToken(req), 'abc');
  });

  it('rejects "Bearer" without a token', () => {
    assert.strictEqual(extractBearerToken({ headers: { authorization: 'Bearer ' } }), null);
    assert.strictEqual(extractBearerToken({ headers: { authorization: 'Bearer   ' } }), null);
  });

  it('rejects non-whitespace separators', () => {
    // "Bearer_abc" — underscore is not a valid separator
    assert.strictEqual(extractBearerToken({ headers: { authorization: 'Bearer_abc' } }), null);
  });

  it('falls back to legacy x-adcp-auth header', () => {
    const req = { headers: { 'x-adcp-auth': 'legacy_token' } };
    assert.strictEqual(extractBearerToken(req), 'legacy_token');
  });

  it('returns null when no auth header present', () => {
    const req = { headers: {} };
    assert.strictEqual(extractBearerToken(req), null);
  });
});

// ---------------------------------------------------------------------------
// verifyApiKey
// ---------------------------------------------------------------------------

describe('verifyApiKey', () => {
  it('accepts known keys and populates token on the principal', async () => {
    const auth = verifyApiKey({ keys: { sk_test: { principal: 'acct_1' } } });
    const result = await auth({ headers: { authorization: 'Bearer sk_test' } });
    assert.strictEqual(result.principal, 'acct_1');
    assert.strictEqual(result.token, 'sk_test');
  });

  it('returns null for unknown keys (falls through in anyOf)', async () => {
    const auth = verifyApiKey({ keys: { sk_test: { principal: 'acct_1' } } });
    const result = await auth({ headers: { authorization: 'Bearer wrong' } });
    assert.strictEqual(result, null);
  });

  it('delegates to verify() when static map misses', async () => {
    let called = 0;
    const auth = verifyApiKey({
      keys: { sk_static: { principal: 'static' } },
      verify: async token => {
        called += 1;
        return token === 'sk_dynamic' ? { principal: 'dynamic' } : null;
      },
    });
    const result = await auth({ headers: { authorization: 'Bearer sk_dynamic' } });
    assert.strictEqual(result.principal, 'dynamic');
    assert.strictEqual(result.token, 'sk_dynamic');
    assert.strictEqual(called, 1);
  });

  it('throws if neither keys nor verify provided', () => {
    assert.throws(() => verifyApiKey({}), /provide at least one of/);
  });
});

// ---------------------------------------------------------------------------
// anyOf combinator
// ---------------------------------------------------------------------------

describe('anyOf', () => {
  it('returns the first successful authenticator result', async () => {
    const auth = anyOf(
      async () => null,
      async () => ({ principal: 'b' }),
      async () => ({ principal: 'c' })
    );
    assert.deepStrictEqual(await auth({ headers: {} }), { principal: 'b' });
  });

  it('returns null when all authenticators return null', async () => {
    const auth = anyOf(
      async () => null,
      async () => null
    );
    assert.strictEqual(await auth({ headers: {} }), null);
  });

  it('wraps rejections in a sanitized AuthError (no leak of internal messages)', async () => {
    const auth = anyOf(
      async () => null,
      async () => {
        throw new Error('expected audience https://real.example/mcp');
      }
    );
    await assert.rejects(
      () => auth({ headers: {} }),
      err => {
        assert.ok(err instanceof AuthError, 'should be AuthError');
        assert.strictEqual(err.publicMessage, 'Credentials rejected.');
        assert.doesNotMatch(err.message, /audience/i);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// verifyBearer — JWT validation with JWKS (local, no network)
// ---------------------------------------------------------------------------

describe('verifyBearer', () => {
  let jose;
  let keyPair;
  let jwksServer;
  let jwksPort;

  before(async () => {
    jose = await import('jose');
    keyPair = await jose.generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const jwk = await jose.exportJWK(keyPair.publicKey);
    jwk.kid = 'test-kid';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const http = require('http');
    jwksServer = http.createServer((req, res) => {
      if (req.url === '/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise(r => jwksServer.listen(0, r));
    jwksPort = jwksServer.address().port;
  });

  after(() => jwksServer && jwksServer.close());

  function buildOptions(overrides) {
    return {
      jwksUri: `http://127.0.0.1:${jwksPort}/jwks.json`,
      issuer: 'https://iss.example',
      audience: 'https://svc.example/mcp',
      ...overrides,
    };
  }

  async function mint(payload, alg = 'RS256') {
    return new jose.SignJWT(payload)
      .setProtectedHeader({ alg, kid: 'test-kid' })
      .setIssuer('https://iss.example')
      .setAudience('https://svc.example/mcp')
      .setExpirationTime('5m')
      .setIssuedAt()
      .sign(keyPair.privateKey);
  }

  it('accepts a valid RS256 token and surfaces claims + scopes', async () => {
    const token = await mint({ sub: 'user_1', scope: 'read write' });
    const auth = verifyBearer(buildOptions());
    const result = await auth({ headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(result.principal, 'user_1');
    assert.strictEqual(result.token, token);
    assert.deepStrictEqual(result.scopes, ['read', 'write']);
    assert.ok(result.expiresAt && result.expiresAt > Date.now() / 1000);
  });

  it('extracts scopes from `scp` claim (array form, Azure/Okta)', async () => {
    const token = await mint({ sub: 'u', scp: ['read', 'write'] });
    const auth = verifyBearer(buildOptions());
    const result = await auth({ headers: { authorization: `Bearer ${token}` } });
    assert.deepStrictEqual(result.scopes, ['read', 'write']);
  });

  it('extracts scopes from `scp` claim (string form)', async () => {
    const token = await mint({ sub: 'u', scp: 'read write' });
    const auth = verifyBearer(buildOptions());
    const result = await auth({ headers: { authorization: `Bearer ${token}` } });
    assert.deepStrictEqual(result.scopes, ['read', 'write']);
  });

  it('rejects a token with missing required scope (insufficient_scope class)', async () => {
    const token = await mint({ sub: 'u', scope: 'read' });
    const auth = verifyBearer(buildOptions({ requiredScopes: ['write'] }));
    await assert.rejects(
      () => auth({ headers: { authorization: `Bearer ${token}` } }),
      err => err instanceof AuthError && err.publicMessage === 'Insufficient scope.'
    );
  });

  it('wraps jose errors in AuthError with a sanitized message', async () => {
    // Token with wrong audience
    const badToken = await new jose.SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer('https://iss.example')
      .setAudience('https://wrong.example/mcp')
      .setExpirationTime('5m')
      .sign(keyPair.privateKey);
    const auth = verifyBearer(buildOptions());
    await assert.rejects(
      () => auth({ headers: { authorization: `Bearer ${badToken}` } }),
      err => {
        assert.ok(err instanceof AuthError, 'should be AuthError');
        assert.strictEqual(err.publicMessage, 'Token validation failed.');
        assert.doesNotMatch(err.message, /audience|https:/i);
        return true;
      }
    );
  });

  it('exposes DEFAULT_JWT_ALGORITHMS with asymmetric algs only', () => {
    assert.ok(DEFAULT_JWT_ALGORITHMS.includes('RS256'));
    assert.ok(DEFAULT_JWT_ALGORITHMS.includes('ES256'));
    assert.ok(DEFAULT_JWT_ALGORITHMS.includes('EdDSA'));
    assert.ok(
      !DEFAULT_JWT_ALGORITHMS.some(a => a.startsWith('HS')),
      'HS-family algorithms must not be default-allowed'
    );
  });
});

// ---------------------------------------------------------------------------
// serve() integration — real HTTP
// ---------------------------------------------------------------------------

describe('serve() + authenticate', () => {
  let ctx;

  before(async () => {
    ctx = await startServer({
      authenticate: verifyApiKey({ keys: { sk_live: { principal: 'acct_live' } } }),
    });
  });

  after(() => ctx.server.close());

  it('responds 401 with WWW-Authenticate on missing credentials', async () => {
    const res = await fetchPath(ctx.port, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.strictEqual(res.status, 401);
    const www = res.headers.get('www-authenticate');
    assert.ok(www, 'WWW-Authenticate header must be present');
    assert.match(www, /^Bearer /);
    assert.match(www, /realm="mcp"/);
    assert.match(www, /error="invalid_token"/);
  });

  it('does not reflect Host header into realm (prevents phishing display)', async () => {
    const res = await fetchPath(ctx.port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'evil.example',
      },
    });
    const www = res.headers.get('www-authenticate');
    assert.doesNotMatch(www, /evil\.example/);
  });

  it('responds 401 on wrong API key', async () => {
    const res = await fetchPath(ctx.port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong_key',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.strictEqual(res.status, 401);
    assert.ok(res.headers.get('www-authenticate'));
  });

  it('passes through to MCP when a known API key is presented', async () => {
    const res = await fetchPath(ctx.port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer sk_live',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.strictEqual(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// publicUrl / protectedResource
// ---------------------------------------------------------------------------

describe('serve() + publicUrl + protectedResource', () => {
  it('throws when protectedResource is set without publicUrl', () => {
    assert.throws(
      () =>
        serve(() => createAgent(), {
          port: 0,
          authenticate: verifyApiKey({ keys: { sk: { principal: 'p' } } }),
          protectedResource: { authorization_servers: ['https://auth.example'] },
        }),
      /publicUrl/
    );
  });

  it('throws when publicUrl path does not match mount path', () => {
    assert.throws(
      () =>
        serve(() => createAgent(), {
          port: 0,
          publicUrl: 'https://svc.example/different',
          protectedResource: { authorization_servers: ['https://auth.example'] },
        }),
      /path/
    );
  });

  it('serves the metadata with publicUrl as `resource` (not Host-derived)', async () => {
    const ctx = await startServer({
      publicUrl: 'https://canonical.example/mcp',
      authenticate: verifyApiKey({ keys: { sk: { principal: 'p' } } }),
      protectedResource: {
        authorization_servers: ['https://auth.example'],
        scopes_supported: ['read', 'write'],
      },
    });
    try {
      // Even when an attacker sends a different Host, `resource` stays canonical.
      const res = await fetchPath(ctx.port, '/.well-known/oauth-protected-resource/mcp', {
        headers: { host: 'evil.example' },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.resource, 'https://canonical.example/mcp');
      assert.deepStrictEqual(body.authorization_servers, ['https://auth.example']);
      assert.deepStrictEqual(body.bearer_methods_supported, ['header']);
    } finally {
      ctx.server.close();
    }
  });

  it('includes resource_metadata in WWW-Authenticate pointing at the canonical origin', async () => {
    const ctx = await startServer({
      publicUrl: 'https://canonical.example/mcp',
      authenticate: verifyApiKey({ keys: { sk: { principal: 'p' } } }),
      protectedResource: { authorization_servers: ['https://auth.example'] },
    });
    try {
      const res = await fetchPath(ctx.port, '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.strictEqual(res.status, 401);
      const www = res.headers.get('www-authenticate');
      assert.match(
        www,
        /resource_metadata="https:\/\/canonical\.example\/\.well-known\/oauth-protected-resource\/mcp"/
      );
    } finally {
      ctx.server.close();
    }
  });

  it('serves metadata without authentication (RFC 9728 requirement)', async () => {
    const ctx = await startServer({
      publicUrl: 'https://canonical.example/mcp',
      authenticate: verifyApiKey({ keys: { sk: { principal: 'p' } } }),
      protectedResource: { authorization_servers: ['https://auth.example'] },
    });
    try {
      // No Authorization header — must still succeed.
      const res = await fetchPath(ctx.port, '/.well-known/oauth-protected-resource/mcp');
      assert.strictEqual(res.status, 200);
    } finally {
      ctx.server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// req.auth propagation to MCP tool handlers
// ---------------------------------------------------------------------------

describe('serve() propagates AuthInfo to MCP handlers via req.auth', () => {
  let ctx;
  let seenAuth;

  before(async () => {
    seenAuth = null;
    const { createAdcpServer } = require('../dist/lib/server/index.js');
    const createAgentWithCapture = () =>
      createAdcpServer({
        name: 'Capture',
        version: '1.0.0',
        mediaBuy: {
          getProducts: async (_input, extra) => {
            seenAuth = extra && extra.authInfo;
            return { products: [] };
          },
        },
      });
    ctx = await new Promise(resolve => {
      const srv = serve(() => createAgentWithCapture(), {
        port: 0,
        authenticate: verifyApiKey({ keys: { sk_live: { principal: 'acct_live', scopes: ['read'] } } }),
        onListening: url => resolve({ server: srv, url, port: new URL(url).port }),
      });
    });
  });

  after(() => ctx.server.close());

  it('tool handler sees authInfo.clientId, token and scopes', async () => {
    const res = await fetchPath(ctx.port, '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer sk_live',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_products',
          arguments: { buying_mode: 'brief', brief: 'test', promoted_offering: 'test' },
        },
      }),
    });
    const text = await res.text();
    assert.strictEqual(res.status, 200, `tools/call failed: ${text}`);
    assert.ok(seenAuth, `tool handler should have received authInfo. Response: ${text}`);
    assert.strictEqual(seenAuth.clientId, 'acct_live');
    assert.strictEqual(seenAuth.token, 'sk_live');
    assert.deepStrictEqual(seenAuth.scopes, ['read']);
  });
});

// ---------------------------------------------------------------------------
// respondUnauthorized direct
// ---------------------------------------------------------------------------

describe('respondUnauthorized', () => {
  it('sends 401 with well-formed WWW-Authenticate and stable realm', () => {
    let headers = {};
    let status;
    let body = '';
    const res = {
      writeHead(s, h) {
        status = s;
        headers = h;
      },
      end(b) {
        body = b;
      },
    };
    respondUnauthorized({ headers: { host: 'agent.example' } }, res, {
      error: 'invalid_token',
      errorDescription: 'nope',
    });
    assert.strictEqual(status, 401);
    assert.match(headers['WWW-Authenticate'], /realm="mcp"/);
    assert.doesNotMatch(headers['WWW-Authenticate'], /agent\.example/);
    assert.match(headers['WWW-Authenticate'], /error="invalid_token"/);
    assert.match(headers['WWW-Authenticate'], /error_description="nope"/);
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.error, 'invalid_token');
  });

  it('escapes backslashes and quotes in all quoted params', () => {
    let headers = {};
    const res = {
      writeHead(_s, h) {
        headers = h;
      },
      end() {},
    };
    respondUnauthorized({ headers: {} }, res, {
      errorDescription: 'needs \\ and " escaping',
      resourceMetadata: 'https://x.example/".wk',
    });
    assert.match(headers['WWW-Authenticate'], /error_description="needs \\\\ and \\" escaping"/);
    assert.match(headers['WWW-Authenticate'], /resource_metadata="https:\/\/x\.example\/\\"\.wk"/);
  });

  it('supports 403 for valid-but-unauthorized', () => {
    let status;
    const res = {
      writeHead(s) {
        status = s;
      },
      end() {},
    };
    respondUnauthorized({ headers: {} }, res, { status: 403 });
    assert.strictEqual(status, 403);
  });
});
