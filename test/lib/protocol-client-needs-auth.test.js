/**
 * Integration test: ProtocolClient.callTool → 401 → NeedsAuthorizationError.
 *
 * Proves the hot-path wiring: when an MCP agent responds 401 with a Bearer
 * challenge carrying `resource_metadata=…`, the library automatically walks
 * discovery and surfaces a structured error the caller can act on —
 * without the caller doing anything special.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { ProtocolClient } = require('../../dist/lib/protocols');
const { NeedsAuthorizationError, bindAgentStorage, getAgentStorage } = require('../../dist/lib/auth/oauth');

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

describe('ProtocolClient.callTool: auto-auth discovery', () => {
  test('translates MCP 401 + Bearer challenge into NeedsAuthorizationError with walked metadata', async () => {
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer realm="api", error="invalid_token", resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`
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
        }),
    };

    const agent = {
      id: 'test-agent',
      name: 'test',
      agent_uri: agentUrl(),
      protocol: 'mcp',
    };

    await assert.rejects(
      () => ProtocolClient.callTool(agent, 'get_products', { brief: 'test' }),
      err => {
        assert.ok(
          err instanceof NeedsAuthorizationError,
          `expected NeedsAuthorizationError, got ${err.constructor.name}`
        );
        assert.strictEqual(err.requirements.authorizationServer, issuer());
        assert.strictEqual(err.requirements.registrationEndpoint, `${issuer()}/oauth/register`);
        assert.strictEqual(err.requirements.challenge.error, 'invalid_token');
        return true;
      }
    );
  });

  test('bound OAuthConfigStorage survives object spread (symbol property)', async () => {
    const storage = { loadAgent: async () => undefined, saveAgent: async () => {} };
    const agent = {
      id: 'test-agent',
      name: 'test',
      agent_uri: agentUrl(),
      protocol: 'mcp',
    };
    bindAgentStorage(agent, storage);

    // Spread the agent multiple times (mirrors SingleAgentClient.normalizeAgentConfig
    // + discovery rewrites). The binding must survive every copy or the CLI /
    // library path never picks up the storage, and refreshed tokens never persist.
    const spread1 = { ...agent };
    const spread2 = { ...spread1, headers: { foo: 'bar' } };
    const spread3 = { ...spread2 };

    assert.strictEqual(getAgentStorage(spread1), storage);
    assert.strictEqual(getAgentStorage(spread2), storage);
    assert.strictEqual(getAgentStorage(spread3), storage);
    // And the binding is invisible to JSON.stringify, so the config never lands on disk.
    assert.strictEqual(JSON.stringify(spread3).includes('oauth-config-storage'), false);
  });

  test('passes through non-auth errors unchanged', async () => {
    state.handlers = {
      '/mcp': (req, res) => {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'server bug' } }));
      },
    };
    const agent = {
      id: 'test-agent',
      name: 'test',
      agent_uri: agentUrl(),
      protocol: 'mcp',
    };

    await assert.rejects(
      () => ProtocolClient.callTool(agent, 'get_products', {}),
      err => {
        assert.ok(
          !(err instanceof NeedsAuthorizationError),
          'must not be NeedsAuthorizationError for non-401 failures'
        );
        return true;
      }
    );
  });
});
