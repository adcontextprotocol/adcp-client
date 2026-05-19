/**
 * Regression test for adcontextprotocol/adcp-client#1869.
 *
 * When `connectMCP` receives a 401 from the agent, the rethrown error must
 * include the auth scheme the SDK actually used. The pre-fix behavior was a
 * bare `Error POSTing to endpoint (HTTP 401): unauthorized` with no clue
 * about whether the SDK selected bearer / basic / oauth / none — which sent
 * the #1864 reporter chasing the wrong root cause for 30+ minutes.
 *
 * This test stands up an MCP loopback server that always returns 401, then
 * exercises three credential shapes (bearer / header-only / none) and
 * asserts the wrapped error tags each one correctly. The OAuth path is not
 * exercised here — it requires `UnauthorizedError` semantics from the MCP
 * SDK's auth flow, which is tested separately.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { connectMCP, closeMCPConnections } = require('../../dist/lib/protocols');

describe('connectMCP — 401 errors carry auth-scheme context', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end('unauthorized');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    closeMCPConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it('wraps bearer-auth 401s with scheme="bearer"', async () => {
    await assert.rejects(
      () => connectMCP({ agentUrl: baseUrl, authToken: 'wrong-token' }),
      err => {
        assert.strictEqual(err.code, 'MCP_AUTH_REJECTED');
        assert.strictEqual(err.scheme, 'bearer');
        assert.match(err.message, /HTTP 401/);
        assert.match(err.message, /scheme: bearer/);
        assert.ok(err.cause, 'cause should be the original transport error');
        return true;
      }
    );
  });

  it('wraps header-only 401s with scheme="header"', async () => {
    await assert.rejects(
      () =>
        connectMCP({
          agentUrl: baseUrl,
          customHeaders: { Authorization: 'Basic ' + Buffer.from('user:wrong').toString('base64') },
        }),
      err => {
        assert.strictEqual(err.code, 'MCP_AUTH_REJECTED');
        assert.strictEqual(err.scheme, 'header');
        assert.match(err.message, /scheme: header/);
        assert.match(err.message, /--auth-scheme basic/);
        return true;
      }
    );
  });

  it('wraps unauthenticated 401s with scheme="none"', async () => {
    await assert.rejects(
      () => connectMCP({ agentUrl: baseUrl }),
      err => {
        assert.strictEqual(err.code, 'MCP_AUTH_REJECTED');
        assert.strictEqual(err.scheme, 'none');
        assert.match(err.message, /scheme: none/);
        assert.match(err.message, /No credentials were sent/);
        return true;
      }
    );
  });

  it('exposes the agent URL on the wrapped error', async () => {
    await assert.rejects(
      () => connectMCP({ agentUrl: baseUrl, authToken: 'wrong' }),
      err => {
        assert.strictEqual(err.agentUrl, baseUrl);
        return true;
      }
    );
  });

  it('does not leak the credential value in the error message', async () => {
    const sensitiveToken = 'super-secret-token-do-not-leak';
    await assert.rejects(
      () => connectMCP({ agentUrl: baseUrl, authToken: sensitiveToken }),
      err => {
        assert.ok(!err.message.includes(sensitiveToken), `bearer token leaked into error message: ${err.message}`);
        return true;
      }
    );

    const sensitiveBasic = 'Basic ' + Buffer.from('user:sensitive-password').toString('base64');
    await assert.rejects(
      () =>
        connectMCP({
          agentUrl: baseUrl,
          customHeaders: { Authorization: sensitiveBasic },
        }),
      err => {
        assert.ok(!err.message.includes(sensitiveBasic), `basic credential leaked into error message: ${err.message}`);
        assert.ok(
          !err.message.includes('sensitive-password'),
          `basic credential (post-decode) leaked into error message: ${err.message}`
        );
        return true;
      }
    );
  });
});
