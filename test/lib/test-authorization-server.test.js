/**
 * End-to-end smoke for the test authorization server fixture.
 *
 * The fixture exists so sellers can grade `security_baseline`,
 * `signed-requests`, and other auth-requiring storyboards locally. If
 * any of the three surfaces below break, those storyboards either can't
 * discover the AS (metadata) or can't verify its tokens (JWKS round-trip
 * or token mint).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createTestAuthorizationServer } = require('../../dist/lib/compliance-fixtures');
const { verifyBearer } = require('../../dist/lib/server/auth');
const { createRemoteJWKSet, jwtVerify } = require('jose');

let authServer;

before(async () => {
  authServer = await createTestAuthorizationServer({
    subjects: {
      'acme-buyer': { buyer_id: 'acme-buyer', brand_domain: 'acmeoutdoor.example' },
    },
  });
});

after(async () => {
  if (authServer) await authServer.close();
});

test('serves RFC 8414 authorization-server metadata', async () => {
  const res = await fetch(authServer.metadataUrl);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.issuer, authServer.issuer);
  assert.strictEqual(body.token_endpoint, authServer.tokenEndpoint);
  assert.strictEqual(body.jwks_uri, authServer.jwksUri);
  assert.deepStrictEqual(body.grant_types_supported, ['client_credentials']);
});

test('serves JWKS with a signing key', async () => {
  const res = await fetch(authServer.jwksUri);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.keys));
  assert.strictEqual(body.keys.length, 1);
  assert.strictEqual(body.keys[0].use, 'sig');
  assert.strictEqual(body.keys[0].alg, 'RS256');
  assert.ok(body.keys[0].kid);
});

test('issueToken mints a JWT that verifies against the advertised JWKS', async () => {
  const audience = 'https://my-agent.example.com/mcp';
  const token = await authServer.issueToken({
    sub: 'acme-buyer',
    aud: audience,
    scope: 'adcp:read adcp:write',
  });

  const jwks = createRemoteJWKSet(new URL(authServer.jwksUri));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: authServer.issuer,
    audience,
  });

  assert.strictEqual(payload.sub, 'acme-buyer');
  assert.strictEqual(payload.brand_domain, 'acmeoutdoor.example', 'preseeded claim merged');
  assert.strictEqual(payload.scope, 'adcp:read adcp:write');
});

test('token endpoint issues tokens via client_credentials', async () => {
  const audience = 'https://my-agent.example.com/mcp';
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    resource: audience,
    client_id: 'acme-buyer',
    scope: 'adcp:read',
  });
  const res = await fetch(authServer.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.token_type, 'Bearer');
  assert.strictEqual(body.scope, 'adcp:read');

  const jwks = createRemoteJWKSet(new URL(authServer.jwksUri));
  const { payload } = await jwtVerify(body.access_token, jwks, {
    issuer: authServer.issuer,
    audience,
  });
  assert.strictEqual(payload.sub, 'acme-buyer');
});

test('token endpoint rejects unsupported grant types', async () => {
  const res = await fetch(authServer.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&username=x&password=y',
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'unsupported_grant_type');
});

test('issued tokens pass verifyBearer', async () => {
  const audience = 'https://my-agent.example.com/mcp';
  const token = await authServer.issueToken({ sub: 'acme-buyer', aud: audience, scope: 'adcp:read' });

  const authenticator = verifyBearer({
    jwksUri: authServer.jwksUri,
    issuer: authServer.issuer,
    audience,
  });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const principal = await authenticator(req);
  assert.ok(principal, 'verifyBearer returns a principal for a valid fixture token');
  assert.strictEqual(principal.principal, 'acme-buyer');
  assert.deepStrictEqual(principal.scopes, ['adcp:read']);
});
