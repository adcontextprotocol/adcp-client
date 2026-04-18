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
  it('accepts known keys from the static map', async () => {
    const auth = verifyApiKey({ keys: { sk_test: { principal: 'acct_1' } } });
    const result = await auth({ headers: { authorization: 'Bearer sk_test' } });
    assert.deepStrictEqual(result, { principal: 'acct_1' });
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
    assert.deepStrictEqual(await auth({ headers: { authorization: 'Bearer sk_dynamic' } }), {
      principal: 'dynamic',
    });
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

  it('propagates the last error when no authenticator succeeded', async () => {
    const auth = anyOf(
      async () => null,
      async () => {
        throw new Error('bad token');
      }
    );
    await assert.rejects(() => auth({ headers: {} }), /bad token/);
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
    assert.match(www, /realm="/);
    assert.match(www, /error="invalid_token"/);
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
// Protected-resource metadata
// ---------------------------------------------------------------------------

describe('serve() + protectedResource', () => {
  let ctx;

  before(async () => {
    ctx = await startServer({
      authenticate: verifyApiKey({ keys: { sk: { principal: 'p' } } }),
      protectedResource: {
        authorization_servers: ['https://auth.example'],
        scopes_supported: ['read', 'write'],
      },
    });
  });

  after(() => ctx.server.close());

  it('serves the metadata at /.well-known/oauth-protected-resource<mountPath>', async () => {
    const res = await fetchPath(ctx.port, '/.well-known/oauth-protected-resource/mcp');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.authorization_servers, ['https://auth.example']);
    assert.deepStrictEqual(body.scopes_supported, ['read', 'write']);
    assert.deepStrictEqual(body.bearer_methods_supported, ['header']);
  });

  it("the `resource` field matches the request's canonical URL (RFC 9728)", async () => {
    const res = await fetchPath(ctx.port, '/.well-known/oauth-protected-resource/mcp');
    const body = await res.json();
    // This is the bug we found in the wild: advertising a resource URL that
    // doesn't match the host being called breaks RFC 8707 audience binding.
    assert.strictEqual(body.resource, `http://127.0.0.1:${ctx.port}/mcp`);
  });

  it('honors X-Forwarded-Proto so TLS-terminating proxies get https resource URLs', async () => {
    const res = await fetchPath(ctx.port, '/.well-known/oauth-protected-resource/mcp', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const body = await res.json();
    assert.strictEqual(body.resource, `https://127.0.0.1:${ctx.port}/mcp`);
  });

  it('401 includes resource_metadata pointer in WWW-Authenticate', async () => {
    const res = await fetchPath(ctx.port, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.strictEqual(res.status, 401);
    const www = res.headers.get('www-authenticate');
    assert.match(www, /resource_metadata="/);
  });
});

// ---------------------------------------------------------------------------
// respondUnauthorized direct
// ---------------------------------------------------------------------------

describe('respondUnauthorized', () => {
  it('sends 401 with well-formed WWW-Authenticate', () => {
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
    assert.match(headers['WWW-Authenticate'], /realm="agent.example"/);
    assert.match(headers['WWW-Authenticate'], /error="invalid_token"/);
    assert.match(headers['WWW-Authenticate'], /error_description="nope"/);
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.error, 'invalid_token');
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
