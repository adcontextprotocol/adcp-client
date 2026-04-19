/**
 * Pre-flight integration test: AgentClient → SingleAgentClient → 401 →
 * NeedsAuthorizationError.
 *
 * The inner-path hook in `ProtocolClient.callTool` is covered elsewhere.
 * This test covers the PRE-flight path in `SingleAgentClient.discoverMCPEndpoint`,
 * which fires before the inner call — the scenario that revealed the bug
 * during end-to-end testing against a local OAuth-gated MCP fake.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AdCPClient } = require('../../dist/lib/index');
const { NeedsAuthorizationError } = require('../../dist/lib/auth/oauth');
const { AuthenticationRequiredError } = require('../../dist/lib/errors');

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

describe('SingleAgentClient pre-flight discovery: 401 → NeedsAuthorizationError', () => {
  test('throws NeedsAuthorizationError (IS-A AuthenticationRequiredError) with walked chain', async () => {
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer realm="mcp-test", error="invalid_token", resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`
        );
        res.end();
      },
      '/.well-known/oauth-protected-resource/mcp': (req, res) =>
        jsonRes(res, 200, { resource: agentUrl(), authorization_servers: [issuer()] }),
      '/.well-known/oauth-authorization-server': (req, res) =>
        jsonRes(res, 200, {
          authorization_endpoint: `${issuer()}/oauth/authorize`,
          token_endpoint: `${issuer()}/oauth/token`,
          registration_endpoint: `${issuer()}/oauth/register`,
          scopes_supported: ['mcp.read'],
        }),
    };

    const client = new AdCPClient([
      {
        id: 'test-agent',
        name: 'test',
        agent_uri: agentUrl(),
        protocol: 'mcp',
      },
    ]);
    const agentClient = client.agent('test-agent');

    await assert.rejects(
      () => agentClient.executeTask('get_products', { brief: 'test' }),
      err => {
        assert.ok(
          err instanceof NeedsAuthorizationError,
          `expected NeedsAuthorizationError, got ${err.constructor.name}: ${err.message}`
        );
        // Backward compat: the richer class IS-A AuthenticationRequiredError
        // so existing catch sites continue to match.
        assert.ok(err instanceof AuthenticationRequiredError, 'must also be an AuthenticationRequiredError');
        assert.strictEqual(err.requirements.authorizationServer, issuer());
        assert.strictEqual(err.requirements.registrationEndpoint, `${issuer()}/oauth/register`);
        assert.strictEqual(err.subCode, 'needs_authorization');
        return true;
      }
    );
  });

  test('falls back to plain AuthenticationRequiredError when discovery walk yields nothing', async () => {
    // 401 without a resource_metadata hint and no PRM endpoint → walk returns null.
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        // No www-authenticate at all — walk returns null, so we fall back.
        res.end();
      },
    };

    const client = new AdCPClient([
      {
        id: 'test-agent',
        name: 'test',
        agent_uri: agentUrl(),
        protocol: 'mcp',
      },
    ]);
    const agentClient = client.agent('test-agent');

    await assert.rejects(
      () => agentClient.executeTask('get_products', { brief: 'test' }),
      err => {
        assert.ok(err instanceof AuthenticationRequiredError, `expected AuthenticationRequiredError`);
        assert.ok(!(err instanceof NeedsAuthorizationError), `must NOT upgrade when walk yielded nothing`);
        return true;
      }
    );
  });
});
