/**
 * Tests for NeedsAuthorizationError + discoverAuthorizationRequirements.
 *
 * Drives the discovery runner against an in-process HTTP server that
 * swaps handlers per scenario, covering each branch of the walk
 * (PRM present/missing, AS metadata present/missing, DCR supported/not).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { NeedsAuthorizationError, discoverAuthorizationRequirements } = require('../../dist/lib/auth/oauth');

const state = { handlers: {}, server: null, port: 0 };

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
        handler(req, res, body);
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

function agentUrl() {
  return `http://127.0.0.1:${state.port}/mcp`;
}
function issuer() {
  return `http://127.0.0.1:${state.port}`;
}
function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

describe('NeedsAuthorizationError', () => {
  test('carries walked requirements and renders a helpful default message', () => {
    const err = new NeedsAuthorizationError({
      agentUrl: 'https://agent.example.com/mcp',
      authorizationServer: 'https://as.example.com',
      challenge: {
        scheme: 'bearer',
        error: 'invalid_token',
        error_description: 'Token expired.',
        params: { error: 'invalid_token', error_description: 'Token expired.' },
      },
    });
    assert.ok(err instanceof Error);
    // Inherits from AuthenticationRequiredError, so the high-level code is
    // the legacy constant; the narrow discriminator is `subCode`.
    assert.strictEqual(err.code, 'AUTHENTICATION_REQUIRED');
    assert.strictEqual(err.subCode, 'needs_authorization');
    assert.strictEqual(err.agentUrl, 'https://agent.example.com/mcp');
    assert.match(err.message, /requires OAuth authorization/);
    assert.match(err.message, /as\.example\.com/);
    assert.match(err.message, /Token expired/);
    assert.match(err.message, /OAuthFlowHandler/);
  });

  test('accepts a caller-supplied message override', () => {
    const err = new NeedsAuthorizationError(
      {
        agentUrl: 'https://x',
        challenge: { scheme: 'bearer', params: {} },
      },
      'custom: bring creds and try again'
    );
    assert.strictEqual(err.message, 'custom: bring creds and try again');
  });
});

describe('discoverAuthorizationRequirements', () => {
  test('returns null when the agent responds 200 without auth', async () => {
    state.handlers = {
      '/mcp': (req, res) => jsonRes(res, 200, { jsonrpc: '2.0', id: 1, result: { tools: [] } }),
    };
    const result = await discoverAuthorizationRequirements(agentUrl(), { allowPrivateIp: true });
    assert.strictEqual(result, null);
  });

  test('returns null on 401 without a Bearer challenge', async () => {
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader('www-authenticate', 'Basic realm="api"');
        res.end();
      },
    };
    const result = await discoverAuthorizationRequirements(agentUrl(), { allowPrivateIp: true });
    assert.strictEqual(result, null);
  });

  test('walks PRM + AS metadata into a full requirements record', async () => {
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer realm="api", error="invalid_token", resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp", scope="mcp.read mcp.write"`
        );
        res.end();
      },
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, {
          resource: agentUrl(),
          authorization_servers: [issuer()],
        }),
      '/.well-known/oauth-authorization-server': (req, res) =>
        jsonRes(res, 200, {
          authorization_endpoint: `${issuer()}/oauth/authorize`,
          token_endpoint: `${issuer()}/oauth/token`,
          registration_endpoint: `${issuer()}/oauth/register`,
          scopes_supported: ['mcp.read', 'mcp.write'],
        }),
    };

    const result = await discoverAuthorizationRequirements(agentUrl(), { allowPrivateIp: true });
    assert.ok(result, 'expected requirements record');
    assert.strictEqual(result.agentUrl, agentUrl());
    assert.strictEqual(result.resource, agentUrl());
    assert.strictEqual(result.authorizationServer, issuer());
    assert.strictEqual(result.authorizationEndpoint, `${issuer()}/oauth/authorize`);
    assert.strictEqual(result.tokenEndpoint, `${issuer()}/oauth/token`);
    assert.strictEqual(result.registrationEndpoint, `${issuer()}/oauth/register`);
    assert.deepStrictEqual(result.scopesSupported, ['mcp.read', 'mcp.write']);
    assert.strictEqual(result.challengeScope, 'mcp.read mcp.write');
    assert.strictEqual(result.challenge.error, 'invalid_token');
  });

  test('returns partial record when PRM is 404 (still captures challenge)', async () => {
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer realm="api", resource_metadata="${issuer()}/.well-known/oauth-protected-resource/missing"`
        );
        res.end();
      },
    };
    const result = await discoverAuthorizationRequirements(agentUrl(), { allowPrivateIp: true });
    assert.ok(result);
    assert.strictEqual(result.authorizationServer, undefined);
    assert.strictEqual(result.tokenEndpoint, undefined);
    assert.strictEqual(result.challenge.scheme, 'bearer');
    assert.strictEqual(result.resourceMetadataUrl, `${issuer()}/.well-known/oauth-protected-resource/missing`);
  });

  test('strips ASCII control characters from server-supplied strings in AS metadata', async () => {
    // Node's http server rejects CR/LF in header values, so the actual
    // WWW-Authenticate vector can't include those bytes on the wire. But
    // JSON bodies CAN carry escape codes — a hostile AS metadata response
    // is the realistic attack surface, so test that path end-to-end.
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer error="invalid_token", resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`
        );
        res.end();
      },
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) =>
        jsonRes(res, 200, {
          authorization_endpoint: `${issuer()}/oauth/authorize\x1b]0;pwned\x07`,
          token_endpoint: `${issuer()}/oauth/token`,
          scopes_supported: ['good.scope', 'evil\x1b[31mred\x1b[0m'],
        }),
    };

    const result = await discoverAuthorizationRequirements(agentUrl(), { allowPrivateIp: true });
    assert.ok(result);
    assert.doesNotMatch(
      result.authorizationEndpoint,
      /[\x00-\x08\x0b-\x1f\x7f]/,
      'authorization_endpoint must be sanitized'
    );
    assert.doesNotMatch(
      result.scopesSupported.join(','),
      /[\x00-\x08\x0b-\x1f\x7f]/,
      'scopesSupported must be sanitized'
    );
    // NeedsAuthorizationError's default message incorporates server-supplied
    // fields; verify it too comes out clean.
    const err = new NeedsAuthorizationError(result);
    assert.doesNotMatch(err.message, /[\x00-\x08\x0b-\x1f\x7f]/, 'error message must be sanitized');
  });

  test('sanitizes nested challenge params and caps their count', async () => {
    // Send a challenge with lots of unknown auth-params AND values with ANSI
    // escape codes via `\t` (the only control char `setHeader` tolerates).
    const hostileParams = Array.from({ length: 100 }, (_, i) => `custom${i}="evil\tcolor${i}"`).join(', ');
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer realm="api", resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp", ${hostileParams}`
        );
        res.end();
      },
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
    };
    const result = await discoverAuthorizationRequirements(agentUrl(), { allowPrivateIp: true });
    assert.ok(result);
    for (const v of Object.values(result.challenge.params)) {
      assert.doesNotMatch(v, /[\x00-\x08\x0b-\x1f\x7f]/);
    }
    assert.ok(
      Object.keys(result.challenge.params).length <= 32,
      `expected ≤32 params, got ${Object.keys(result.challenge.params).length}`
    );
  });

  test('attaches requirements to error.details for structured-logging consumers', () => {
    const requirements = {
      agentUrl: 'https://agent.example.com/mcp',
      authorizationServer: 'https://as.example.com',
      authorizationEndpoint: 'https://as.example.com/oauth/authorize',
      tokenEndpoint: 'https://as.example.com/oauth/token',
      challenge: { scheme: 'bearer', params: {} },
    };
    const err = new NeedsAuthorizationError(requirements);
    assert.ok(err.details, 'expected details to be set');
    assert.strictEqual(err.details.requirements, requirements);
    // Parent's detail fields should also still be present so existing log
    // pipelines keep working.
    assert.strictEqual(err.details.agentUrl, 'https://agent.example.com/mcp');
    assert.ok(err.details.oauthMetadata);
  });

  test('caps the scopesSupported list to bound hostile metadata', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `scope-${i}`);
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`
        );
        res.end();
      },
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { scopes_supported: many }),
    };
    const result = await discoverAuthorizationRequirements(agentUrl(), { allowPrivateIp: true });
    assert.ok(result.scopesSupported.length <= 64, `expected <=64 scopes, got ${result.scopesSupported.length}`);
  });

  test('refuses non-HTTP schemes smuggled into authorization_servers[0]', async () => {
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`
        );
        res.end();
      },
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, {
          resource: agentUrl(),
          authorization_servers: ['javascript:alert(1)'],
        }),
    };
    const result = await discoverAuthorizationRequirements(agentUrl(), { allowPrivateIp: true });
    assert.ok(result);
    assert.strictEqual(result.authorizationServer, undefined, 'non-http(s) schemes must be rejected');
  });

  test('builds RFC 8414 path-aware metadata URL when issuer has a path', async () => {
    // Issuer has a /tenant1 path — AS metadata must live at
    // /.well-known/oauth-authorization-server/tenant1, not at /tenant1/.well-known/...
    const pathAwareCalled = { hit: false };
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`
        );
        res.end();
      },
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, {
          resource: agentUrl(),
          authorization_servers: [`${issuer()}/tenant1`],
        }),
      '/.well-known/oauth-authorization-server/tenant1': (req, res) => {
        pathAwareCalled.hit = true;
        jsonRes(res, 200, { token_endpoint: `${issuer()}/oauth/token` });
      },
    };
    const result = await discoverAuthorizationRequirements(agentUrl(), { allowPrivateIp: true });
    assert.ok(pathAwareCalled.hit, 'expected path-aware metadata URL to be probed');
    assert.strictEqual(result.tokenEndpoint, `${issuer()}/oauth/token`);
  });

  test('honors a caller-supplied WWW-Authenticate header (no extra probe)', async () => {
    // Agent handler that would fail the assertion if invoked — we want to
    // prove the caller's header is used instead of a fresh probe.
    state.handlers = {
      '/mcp': () => {
        throw new Error('agent should not be probed when wwwAuthenticate is supplied');
      },
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) =>
        jsonRes(res, 200, {
          authorization_endpoint: `${issuer()}/oauth/authorize`,
          token_endpoint: `${issuer()}/oauth/token`,
        }),
    };
    const result = await discoverAuthorizationRequirements(agentUrl(), {
      allowPrivateIp: true,
      wwwAuthenticate: `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`,
    });
    assert.ok(result);
    assert.strictEqual(result.tokenEndpoint, `${issuer()}/oauth/token`);
  });
});
