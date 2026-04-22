/**
 * Tests for the diagnose-auth runner.
 *
 * Uses a real in-process HTTP server so we exercise the actual
 * ssrfSafeFetch path (with --allow-http for loopback). Each scenario
 * drives a specific hypothesis branch in the ranking logic.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { runAuthDiagnosis } = require('../../dist/lib/auth/oauth');

// ---------------------------------------------------------------------------
// Test fixture: a single HTTP server that routes agent + AS + PRM paths
// based on mutable response handlers. Scenarios swap handlers per test.
// ---------------------------------------------------------------------------

const state = {
  handlers: {},
  server: null,
  port: 0,
};

function makeJWT(claims) {
  const b64 = o =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature`;
}

before(async () => {
  state.server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const handler = state.handlers[path];
    if (!handler) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        handler(req, res, body);
      } catch (err) {
        // Test fixture: swallow error into a generic 500 so CodeQL doesn't
        // flag exception-text reflection; real failures surface via the
        // assertion phase of the driving test.
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

function tokenEndpoint() {
  return `http://127.0.0.1:${state.port}/oauth/token`;
}

function issuer() {
  return `http://127.0.0.1:${state.port}`;
}

function setHandlers(handlers) {
  state.handlers = handlers;
}

// JSON helper
function jsonRes(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('runAuthDiagnosis: H1 resource URL mismatch', () => {
  test('flags H1 when PRM advertises a different resource URL', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, {
          resource: 'https://wrong-host.example.com/mcp',
          authorization_servers: [issuer()],
        }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        res.end();
      },
    });

    const report = await runAuthDiagnosis(
      { id: 'test', name: 'test', agent_uri: agentUrl(), protocol: 'mcp' },
      { allowPrivateIp: true, skipToolCall: true }
    );

    const h1 = report.hypotheses.find(h => h.id === 'H1');
    assert.strictEqual(h1.verdict, 'likely');
    assert.match(h1.summary, /does not match agent URL/);
  });

  test('rules out H1 when PRM resource matches agent URL', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        res.end();
      },
    });

    const report = await runAuthDiagnosis(
      { id: 'test', name: 'test', agent_uri: agentUrl(), protocol: 'mcp' },
      { allowPrivateIp: true, skipToolCall: true }
    );

    const h1 = report.hypotheses.find(h => h.id === 'H1');
    assert.strictEqual(h1.verdict, 'ruled_out');
  });
});

describe('runAuthDiagnosis: H4 missing WWW-Authenticate', () => {
  test('flags H4 when the 401 has no WWW-Authenticate header', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.end();
      },
    });

    const report = await runAuthDiagnosis(
      { id: 'test', name: 'test', agent_uri: agentUrl(), protocol: 'mcp' },
      { allowPrivateIp: true, skipToolCall: true }
    );

    const h4 = report.hypotheses.find(h => h.id === 'H4');
    assert.strictEqual(h4.verdict, 'likely');
    assert.match(h4.summary, /RFC 6750/);
  });

  test('rules out H4 when the 401 carries a WWW-Authenticate header', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer realm="api", error="invalid_token", resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`
        );
        res.end();
      },
    });

    const report = await runAuthDiagnosis(
      { id: 'test', name: 'test', agent_uri: agentUrl(), protocol: 'mcp' },
      { allowPrivateIp: true, skipToolCall: true }
    );

    const h4 = report.hypotheses.find(h => h.id === 'H4');
    assert.strictEqual(h4.verdict, 'ruled_out');
  });
});

describe('runAuthDiagnosis: H5 token audience mismatch', () => {
  test('flags H5 when saved token aud does not match expected resource', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        res.end();
      },
    });

    const token = makeJWT({ aud: 'https://someone-else.example.com', iss: issuer() });
    const report = await runAuthDiagnosis(
      {
        id: 'test',
        name: 'test',
        agent_uri: agentUrl(),
        protocol: 'mcp',
        oauth_tokens: { access_token: token },
      },
      { allowPrivateIp: true, skipRefresh: true, skipToolCall: true }
    );

    const h5 = report.hypotheses.find(h => h.id === 'H5');
    assert.strictEqual(h5.verdict, 'likely');
  });

  test('rules out H5 when saved token aud matches the advertised resource', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        res.end();
      },
    });

    const token = makeJWT({ aud: agentUrl(), iss: issuer() });
    const report = await runAuthDiagnosis(
      {
        id: 'test',
        name: 'test',
        agent_uri: agentUrl(),
        protocol: 'mcp',
        oauth_tokens: { access_token: token },
      },
      { allowPrivateIp: true, skipRefresh: true, skipToolCall: true }
    );

    const h5 = report.hypotheses.find(h => h.id === 'H5');
    assert.strictEqual(h5.verdict, 'ruled_out');
  });
});

describe('runAuthDiagnosis: H6 agent ignores audience', () => {
  test('flags H6 when tool_call succeeds despite aud mismatch', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/mcp': (req, res, body) => {
        const parsed = JSON.parse(body);
        // Return 200 regardless of whether the token aud is right —
        // this is the permissive-agent bug H6 is designed to catch.
        jsonRes(res, 200, {
          jsonrpc: '2.0',
          id: parsed.id,
          result: { isError: false, structuredContent: { products: [] } },
        });
      },
    });

    const token = makeJWT({ aud: 'https://wrong.example.com', iss: issuer() });
    const report = await runAuthDiagnosis(
      {
        id: 'test',
        name: 'test',
        agent_uri: agentUrl(),
        protocol: 'mcp',
        oauth_tokens: { access_token: token },
      },
      { allowPrivateIp: true, skipRefresh: true }
    );

    const h6 = report.hypotheses.find(h => h.id === 'H6');
    assert.strictEqual(h6.verdict, 'likely');
    assert.match(h6.summary, /not enforcing audience/);
  });
});

describe('runAuthDiagnosis: H2 refresh grant ignoring resource', () => {
  test('flags H2 when a refresh with resource indicator yields a token with wrong aud', async () => {
    let refreshCallSawResource = false;
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/oauth/token': (req, res, body) => {
        const params = new URLSearchParams(body);
        if (params.get('resource')) refreshCallSawResource = true;
        // AS ignores the `resource` param and emits a token with wrong aud —
        // this is the H2 signature.
        jsonRes(res, 200, {
          access_token: makeJWT({ aud: 'https://wrong.example.com', iss: issuer() }),
          token_type: 'Bearer',
          expires_in: 3600,
        });
      },
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        res.end();
      },
    });

    const report = await runAuthDiagnosis(
      {
        id: 'test',
        name: 'test',
        agent_uri: agentUrl(),
        protocol: 'mcp',
        oauth_tokens: { access_token: makeJWT({ aud: agentUrl() }), refresh_token: 'rt-1' },
        oauth_client: { client_id: 'test-client', redirect_uris: [] },
      },
      { allowPrivateIp: true, skipToolCall: true }
    );

    assert.strictEqual(refreshCallSawResource, true, 'runner should send resource param on refresh');
    const h2 = report.hypotheses.find(h => h.id === 'H2');
    assert.strictEqual(h2.verdict, 'likely');
  });
});

describe('runAuthDiagnosis: token redaction', () => {
  test('redacts access_token/refresh_token in the token-refresh capture by default', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/oauth/token': (req, res) =>
        jsonRes(res, 200, {
          access_token: makeJWT({ aud: agentUrl() }),
          refresh_token: 'super-secret-refresh',
          id_token: 'super-secret-id',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        res.end();
      },
    });

    const report = await runAuthDiagnosis(
      {
        id: 'test',
        name: 'test',
        agent_uri: agentUrl(),
        protocol: 'mcp',
        oauth_tokens: { access_token: makeJWT({ aud: agentUrl() }), refresh_token: 'rt-1' },
        oauth_client: { client_id: 'c', redirect_uris: [] },
      },
      { allowPrivateIp: true, skipToolCall: true }
    );

    const refreshStep = report.steps.find(s => s.name === 'token_refresh_attempt');
    const body = refreshStep.http.body;
    assert.match(body.access_token, /^<redacted length=\d+>$/);
    assert.match(body.refresh_token, /^<redacted length=\d+>$/);
    assert.match(body.id_token, /^<redacted length=\d+>$/);
    // Non-token fields preserved
    assert.strictEqual(body.token_type, 'Bearer');
    assert.strictEqual(body.expires_in, 3600);
  });

  test('includeTokens: true keeps raw token material in the capture', async () => {
    const realAccessToken = makeJWT({ aud: agentUrl() });
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/oauth/token': (req, res) =>
        jsonRes(res, 200, {
          access_token: realAccessToken,
          refresh_token: 'super-secret-refresh',
        }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.end();
      },
    });

    const report = await runAuthDiagnosis(
      {
        id: 'test',
        name: 'test',
        agent_uri: agentUrl(),
        protocol: 'mcp',
        oauth_tokens: { access_token: makeJWT({ aud: agentUrl() }), refresh_token: 'rt-1' },
        oauth_client: { client_id: 'c', redirect_uris: [] },
      },
      { allowPrivateIp: true, skipToolCall: true, includeTokens: true }
    );

    const refreshStep = report.steps.find(s => s.name === 'token_refresh_attempt');
    assert.strictEqual(refreshStep.http.body.access_token, realAccessToken);
    assert.strictEqual(refreshStep.http.body.refresh_token, 'super-secret-refresh');
  });
});

describe('runAuthDiagnosis: report shape', () => {
  test('includes every expected step when all inputs are present', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) => jsonRes(res, 200, { token_endpoint: tokenEndpoint() }),
      '/oauth/token': (req, res) =>
        jsonRes(res, 200, {
          access_token: makeJWT({ aud: agentUrl(), iss: issuer() }),
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        res.end();
      },
    });

    const report = await runAuthDiagnosis(
      {
        id: 'test-alias',
        name: 'test',
        agent_uri: agentUrl(),
        protocol: 'mcp',
        oauth_tokens: { access_token: makeJWT({ aud: agentUrl() }), refresh_token: 'rt-1' },
        oauth_client: { client_id: 'test-client', redirect_uris: [] },
      },
      { allowPrivateIp: true }
    );

    const stepNames = report.steps.map(s => s.name);
    assert.deepStrictEqual(stepNames.sort(), [
      'decode_current_token',
      'decode_refreshed_token',
      'list_tools_probe',
      'probe_authorization_server_metadata',
      'probe_protected_resource_metadata',
      'token_refresh_attempt',
      'tool_call_probe',
    ]);
    assert.strictEqual(report.aliasId, 'test-alias');
    assert.ok(report.generatedAt);
    assert.strictEqual(report.hypotheses.length, 6);
  });

  test('orders hypotheses: likely first, then possible, then ruled_out/not_observed', async () => {
    setHandlers({
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: 'https://wrong.example.com/mcp' }),
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.end();
      },
    });

    const report = await runAuthDiagnosis(
      { id: 'test', name: 'test', agent_uri: agentUrl(), protocol: 'mcp' },
      { allowPrivateIp: true, skipToolCall: true }
    );

    const verdicts = report.hypotheses.map(h => h.verdict);
    const order = { likely: 0, possible: 1, ruled_out: 2, not_observed: 3 };
    for (let i = 1; i < verdicts.length; i++) {
      assert.ok(order[verdicts[i - 1]] <= order[verdicts[i]], `verdicts out of order: ${verdicts.join(', ')}`);
    }
    // H1 + H4 should both be likely here
    assert.ok(report.hypotheses.find(h => h.id === 'H1').verdict === 'likely');
    assert.ok(report.hypotheses.find(h => h.id === 'H4').verdict === 'likely');
  });
});
