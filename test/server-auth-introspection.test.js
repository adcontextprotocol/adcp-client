const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');

/**
 * Tests for `verifyIntrospection` — the RFC 7662 bearer verification
 * authenticator used by agents that proxy upstream platform tokens
 * (Snap, Meta, TikTok, …) rather than minting their own JWTs.
 *
 * A local http.createServer acts as the upstream introspection endpoint
 * so we exercise the real fetch() path without mocks — the round-trip
 * is the surface most likely to break (content-type handling, Basic
 * auth encoding, timeout behavior, JSON contract).
 */

const { verifyIntrospection, AuthError } = require('../dist/lib/server/index.js');

function startIntrospectionServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/introspect` }));
  });
}

describe('verifyIntrospection — construction', () => {
  it('throws when introspectionUrl is not a valid URL', () => {
    assert.throws(
      () => verifyIntrospection({ introspectionUrl: 'not-a-url', clientId: 'c', clientSecret: 's' }),
      /not a valid URL/
    );
  });

  it('throws when introspectionUrl is http:// to a non-loopback host', () => {
    assert.throws(
      () => verifyIntrospection({ introspectionUrl: 'http://auth.example.com/introspect', clientId: 'c', clientSecret: 's' }),
      /must use https/
    );
  });

  it('allows http:// to localhost / 127.0.0.1 (dev)', () => {
    verifyIntrospection({ introspectionUrl: 'http://localhost:3000/introspect', clientId: 'c', clientSecret: 's' });
    verifyIntrospection({ introspectionUrl: 'http://127.0.0.1:3000/introspect', clientId: 'c', clientSecret: 's' });
  });

  it('throws when clientId or clientSecret missing', () => {
    assert.throws(
      () => verifyIntrospection({ introspectionUrl: 'https://auth.example.com/introspect', clientId: '', clientSecret: 's' }),
      /clientId.*clientSecret/
    );
    assert.throws(
      () => verifyIntrospection({ introspectionUrl: 'https://auth.example.com/introspect', clientId: 'c', clientSecret: '' }),
      /clientId.*clientSecret/
    );
  });
});

describe('verifyIntrospection — authentication flow', () => {
  let upstream;
  let calls;

  beforeEach(async () => {
    calls = [];
    upstream = await startIntrospectionServer((req, res, body) => {
      calls.push({ url: req.url, headers: req.headers, body });
      // Default: echo based on token string.
      const params = new URLSearchParams(body);
      const token = params.get('token');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (token === 'good_token') {
        res.end(
          JSON.stringify({
            active: true,
            sub: 'user_123',
            scope: 'read write',
            client_id: 'buyer_agent_42',
            exp: Math.floor(Date.now() / 1000) + 3600,
          })
        );
      } else if (token === 'revoked_token') {
        res.end(JSON.stringify({ active: false }));
      } else {
        res.end(JSON.stringify({ active: false }));
      }
    });
  });

  after(() => upstream && upstream.server.close());

  it('returns null when no bearer header is present', async () => {
    const auth = verifyIntrospection({ introspectionUrl: upstream.url, clientId: 'c', clientSecret: 's' });
    const result = await auth({ headers: {} });
    assert.strictEqual(result, null);
    assert.strictEqual(calls.length, 0, 'should not introspect when no token is presented');
  });

  it('accepts an active token and populates principal + scopes + expiresAt', async () => {
    const auth = verifyIntrospection({ introspectionUrl: upstream.url, clientId: 'c', clientSecret: 's' });
    const result = await auth({ headers: { authorization: 'Bearer good_token' } });
    assert.strictEqual(result.principal, 'user_123');
    assert.strictEqual(result.token, 'good_token');
    assert.deepStrictEqual(result.scopes, ['read', 'write']);
    assert.ok(result.expiresAt && result.expiresAt > Date.now() / 1000);
    assert.strictEqual(calls.length, 1);
  });

  it('sends Basic auth by default with RFC 6749 §2.3.1 form-urlencoded creds', async () => {
    // Use a secret that actually exercises formUrlEncode — a bare `'my-secret'`
    // passes whether the wrapper fires or not. Characters we MUST see encoded:
    //   `:` (conflicts with Basic-auth delimiter) → `%3A`
    //   `!` (form-urlencoded reserves it) → `%21`
    //   `+` (form-urlencoded meaning, must be percent-encoded) → `%2B`
    //   ` ` (space) → `%20`
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'client-id',
      clientSecret: "p@ss w0rd+:!'",
    });
    await auth({ headers: { authorization: 'Bearer good_token' } });
    const authHeader = calls[0].headers.authorization;
    assert.ok(authHeader.startsWith('Basic '), `expected Basic auth, got: ${authHeader}`);
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    // clientId:encodedSecret — encodedSecret is URL-encoded per RFC 6749 §2.3.1.
    // The single `:` is the Basic auth delimiter (outside the encoded secret);
    // the `:` INSIDE the secret is encoded as `%3A`. If formUrlEncode is ever
    // removed, this assertion breaks — secret's `:` would clash with the
    // delimiter and ASes would see a different username/password split.
    assert.strictEqual(decoded, "client-id:p%40ss%20w0rd%2B%3A%21%27");
  });

  it('sends client creds in body when clientAuth: "body"', async () => {
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'my-client',
      clientSecret: 'my-secret',
      clientAuth: 'body',
    });
    await auth({ headers: { authorization: 'Bearer good_token' } });
    assert.strictEqual(calls[0].headers.authorization, undefined, 'should NOT send Basic auth in body mode');
    const body = new URLSearchParams(calls[0].body);
    assert.strictEqual(body.get('client_id'), 'my-client');
    assert.strictEqual(body.get('client_secret'), 'my-secret');
  });

  it('sends token + token_type_hint in body', async () => {
    const auth = verifyIntrospection({ introspectionUrl: upstream.url, clientId: 'c', clientSecret: 's' });
    await auth({ headers: { authorization: 'Bearer good_token' } });
    const body = new URLSearchParams(calls[0].body);
    assert.strictEqual(body.get('token'), 'good_token');
    assert.strictEqual(body.get('token_type_hint'), 'access_token');
  });

  it('rejects inactive token with AuthError + sanitized message', async () => {
    const auth = verifyIntrospection({ introspectionUrl: upstream.url, clientId: 'c', clientSecret: 's' });
    await assert.rejects(
      () => auth({ headers: { authorization: 'Bearer revoked_token' } }),
      err => {
        assert.ok(err instanceof AuthError);
        assert.strictEqual(err.publicMessage, 'Token validation failed.');
        return true;
      }
    );
  });

  it('rejects on missing required scope (insufficient_scope)', async () => {
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      requiredScopes: ['admin'],
    });
    await assert.rejects(
      () => auth({ headers: { authorization: 'Bearer good_token' } }),
      err => err instanceof AuthError && err.publicMessage === 'Insufficient scope.'
    );
  });

  it('accepts when all required scopes are present', async () => {
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      requiredScopes: ['read'],
    });
    const result = await auth({ headers: { authorization: 'Bearer good_token' } });
    assert.strictEqual(result.principal, 'user_123');
  });
});

describe('verifyIntrospection — audience binding', () => {
  let upstream;
  let audienceResponse;

  before(async () => {
    upstream = await startIntrospectionServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(audienceResponse));
    });
  });

  after(() => upstream.server.close());

  it('accepts when aud claim matches the configured audience (string)', async () => {
    audienceResponse = { active: true, sub: 'u', aud: 'https://seller.example.com/mcp' };
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      audience: 'https://seller.example.com/mcp',
    });
    const result = await auth({ headers: { authorization: 'Bearer tok' } });
    assert.strictEqual(result.principal, 'u');
  });

  it('accepts when aud claim is an array containing the configured audience', async () => {
    audienceResponse = {
      active: true,
      sub: 'u',
      aud: ['https://other.example.com/mcp', 'https://seller.example.com/mcp'],
    };
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      audience: 'https://seller.example.com/mcp',
    });
    const result = await auth({ headers: { authorization: 'Bearer tok' } });
    assert.strictEqual(result.principal, 'u');
  });

  it('rejects when aud claim does not match', async () => {
    audienceResponse = { active: true, sub: 'u', aud: 'https://attacker.example/mcp' };
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      audience: 'https://seller.example.com/mcp',
    });
    await assert.rejects(
      () => auth({ headers: { authorization: 'Bearer tok' } }),
      err => err instanceof AuthError
    );
  });

  it('rejects when aud is missing but audience was required', async () => {
    audienceResponse = { active: true, sub: 'u' };
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      audience: 'https://seller.example.com/mcp',
    });
    await assert.rejects(
      () => auth({ headers: { authorization: 'Bearer tok' } }),
      err => err instanceof AuthError
    );
  });
});

describe('verifyIntrospection — error handling', () => {
  it('fails closed on HTTP 5xx from upstream', async () => {
    const upstream = await startIntrospectionServer((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal"}');
    });
    try {
      const auth = verifyIntrospection({ introspectionUrl: upstream.url, clientId: 'c', clientSecret: 's' });
      await assert.rejects(
        () => auth({ headers: { authorization: 'Bearer tok' } }),
        err => {
          assert.ok(err instanceof AuthError);
          assert.strictEqual(err.publicMessage, 'Token validation failed.');
          // Upstream body must NOT leak — only generic message.
          assert.ok(!err.publicMessage.includes('internal'));
          return true;
        }
      );
    } finally {
      upstream.server.close();
    }
  });

  it('fails closed on non-JSON content-type', async () => {
    const upstream = await startIntrospectionServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>oops</html>');
    });
    try {
      const auth = verifyIntrospection({ introspectionUrl: upstream.url, clientId: 'c', clientSecret: 's' });
      await assert.rejects(
        () => auth({ headers: { authorization: 'Bearer tok' } }),
        err => err instanceof AuthError
      );
    } finally {
      upstream.server.close();
    }
  });

  it('fails closed on missing active field', async () => {
    const upstream = await startIntrospectionServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sub: 'u' })); // no active field
    });
    try {
      const auth = verifyIntrospection({ introspectionUrl: upstream.url, clientId: 'c', clientSecret: 's' });
      await assert.rejects(
        () => auth({ headers: { authorization: 'Bearer tok' } }),
        err => err instanceof AuthError
      );
    } finally {
      upstream.server.close();
    }
  });

  it('fails closed on timeout', async () => {
    // Server that never responds.
    const server = http.createServer((req, res) => {
      // intentionally hang
    });
    await new Promise(r => server.listen(0, r));
    try {
      const auth = verifyIntrospection({
        introspectionUrl: `http://127.0.0.1:${server.address().port}/introspect`,
        clientId: 'c',
        clientSecret: 's',
        timeoutMs: 100,
      });
      await assert.rejects(
        () => auth({ headers: { authorization: 'Bearer tok' } }),
        err => err instanceof AuthError
      );
    } finally {
      // closeAllConnections BEFORE close — otherwise close() hangs waiting
      // for the still-open (aborted-by-client) connection to drain.
      server.closeAllConnections?.();
      server.close();
    }
  });
});

describe('verifyIntrospection — cache', () => {
  let upstream;
  let callCount;
  let response;

  before(async () => {
    upstream = await startIntrospectionServer((req, res) => {
      callCount++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });

  after(() => upstream.server.close());

  beforeEach(() => {
    callCount = 0;
    response = { active: true, sub: 'u', scope: 'read', exp: Math.floor(Date.now() / 1000) + 3600 };
  });

  it('without cache, every request introspects', async () => {
    const auth = verifyIntrospection({ introspectionUrl: upstream.url, clientId: 'c', clientSecret: 's' });
    await auth({ headers: { authorization: 'Bearer tok' } });
    await auth({ headers: { authorization: 'Bearer tok' } });
    await auth({ headers: { authorization: 'Bearer tok' } });
    assert.strictEqual(callCount, 3);
  });

  it('with cache, repeat requests for the same token hit the cache', async () => {
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      cache: { ttlSeconds: 60 },
    });
    await auth({ headers: { authorization: 'Bearer tok' } });
    await auth({ headers: { authorization: 'Bearer tok' } });
    await auth({ headers: { authorization: 'Bearer tok' } });
    assert.strictEqual(callCount, 1, 'should only hit upstream once');
  });

  it('different tokens do NOT share a cache entry', async () => {
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      cache: { ttlSeconds: 60 },
    });
    await auth({ headers: { authorization: 'Bearer tokA' } });
    await auth({ headers: { authorization: 'Bearer tokB' } });
    assert.strictEqual(callCount, 2);
  });

  it('caps positive TTL at the token`s own remaining lifetime', async () => {
    // Token expires in 1 second; configured TTL is 1 hour. Cache entry
    // must respect the 1-second cap.
    response = { active: true, sub: 'u', exp: Math.floor(Date.now() / 1000) + 1 };
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      cache: { ttlSeconds: 3600 },
    });
    await auth({ headers: { authorization: 'Bearer tok-short' } });
    assert.strictEqual(callCount, 1);
    // Second call within 1s — cached.
    await auth({ headers: { authorization: 'Bearer tok-short' } });
    assert.strictEqual(callCount, 1);
    // Wait past expiry + a little slack. Next call re-introspects.
    await new Promise(r => setTimeout(r, 1200));
    await auth({ headers: { authorization: 'Bearer tok-short' } });
    assert.strictEqual(callCount, 2, 'cache entry should have expired with the token');
  });

  it('does NOT cache negative responses by default', async () => {
    response = { active: false };
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      cache: { ttlSeconds: 60 },
    });
    await assert.rejects(() => auth({ headers: { authorization: 'Bearer revoked' } }));
    await assert.rejects(() => auth({ headers: { authorization: 'Bearer revoked' } }));
    assert.strictEqual(callCount, 2, 'revoked token must not be cached without opt-in');
  });

  it('DOES cache negative responses when negativeTtlSeconds is set', async () => {
    response = { active: false };
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      cache: { ttlSeconds: 60, negativeTtlSeconds: 5 },
    });
    await assert.rejects(() => auth({ headers: { authorization: 'Bearer revoked' } }));
    await assert.rejects(() => auth({ headers: { authorization: 'Bearer revoked' } }));
    assert.strictEqual(callCount, 1, 'second revoked lookup should hit the negative cache');
  });

  it('caller mutations on returned principal do NOT poison the cache', async () => {
    response = {
      active: true,
      sub: 'u',
      scope: 'read',
      exp: Math.floor(Date.now() / 1000) + 3600,
      // Nested object — a shallow spread of `claims` would alias this
      // across cache entries. structuredClone is required.
      custom_claims: { tenant: 'original_tenant' },
    };
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      cache: { ttlSeconds: 60 },
    });

    const first = await auth({ headers: { authorization: 'Bearer tok-mut' } });
    // Attacker / buggy caller mutates the returned principal.
    first.scopes.push('admin');
    first.claims.scope = 'admin';
    first.claims.custom_claims.tenant = 'poisoned_tenant';

    // Cache hit on the second call must return the ORIGINAL values.
    const second = await auth({ headers: { authorization: 'Bearer tok-mut' } });
    assert.deepStrictEqual(second.scopes, ['read'], 'cached scopes must not include pushed `admin`');
    assert.strictEqual(second.claims.scope, 'read', 'cached claims.scope must not be the mutated value');
    assert.strictEqual(
      second.claims.custom_claims.tenant,
      'original_tenant',
      'nested claim must not be the poisoned value'
    );
    assert.strictEqual(callCount, 1, 'second call must have hit the cache, not re-introspected');
  });

  it('evicts oldest entries when cache is full (LRU)', async () => {
    const auth = verifyIntrospection({
      introspectionUrl: upstream.url,
      clientId: 'c',
      clientSecret: 's',
      cache: { ttlSeconds: 60, max: 2 },
    });
    await auth({ headers: { authorization: 'Bearer tok1' } });
    await auth({ headers: { authorization: 'Bearer tok2' } });
    await auth({ headers: { authorization: 'Bearer tok3' } }); // evicts tok1
    await auth({ headers: { authorization: 'Bearer tok1' } }); // re-introspects
    assert.strictEqual(callCount, 4);
  });
});

describe('verifyIntrospection — composition', () => {
  it('returns null on missing bearer header — composes with anyOf fall-through', async () => {
    // No need for an upstream — missing bearer should short-circuit BEFORE
    // the introspection call fires. Caller doesn't need a reachable URL
    // when no token is presented.
    const auth = verifyIntrospection({
      introspectionUrl: 'https://unreachable.example.invalid/introspect',
      clientId: 'c',
      clientSecret: 's',
    });
    const result = await auth({ headers: {} });
    assert.strictEqual(result, null, 'null lets anyOf try the next authenticator');
  });
});
