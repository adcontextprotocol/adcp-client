/**
 * Regression test for adcontextprotocol/adcp-client#1864.
 *
 * Basic-auth (and other header-only auth) MCP agents were silently broken via
 * `SingleAgentClient.getAgentInfo` → `connectMCP`. Two defects compounded:
 *
 *   A. `getAgentInfo` did not forward `normalizedAgent.headers` to `connectMCP`.
 *   B. `connectMCP` only attached `requestInit.headers` when `authToken` was
 *      truthy; header-only auth (no token) dropped the headers on the floor.
 *
 * Symptom: the agent received an unauthenticated request on the precheck path,
 * so every `executeTask` (which always prechecks `getCapabilities`) failed even
 * though curl with the same credentials succeeded.
 *
 * This test asserts the precheck path now forwards `Authorization: Basic …`.
 * It uses a real loopback HTTP server that 401s without the header — same
 * pattern as `get-agent-info-size-limit.test.js`.
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AgentClient } = require('../../dist/lib/core/AgentClient');
const { closeMCPConnections } = require('../../dist/lib/protocols');

describe('SingleAgentClient.getAgentInfo() — header-only auth (basic, x-api-key)', () => {
  let server;
  let baseUrl;
  const credential = 'Basic ' + Buffer.from('user:pass').toString('base64');
  /** @type {Array<{ method: string, hasAuth: boolean, authHeader: string | null }>} */
  let received;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        const authHeader = req.headers['authorization'] ?? null;

        let msg = null;
        if (body) {
          try {
            msg = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end();
            return;
          }
        }

        received.push({
          method: msg?.method ?? `${req.method} ${req.url}`,
          hasAuth: Boolean(authHeader),
          authHeader,
        });

        if (authHeader !== credential) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="adcp"' });
          res.end('unauthorized');
          return;
        }

        if (msg?.method === 'initialize') {
          const protocolVersion = msg.params?.protocolVersion ?? '2025-03-26';
          const reply = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion,
              capabilities: {},
              serverInfo: { name: 'stub-mcp-basic', version: '0.0.1' },
            },
          });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'mcp-session-id': 'test-session-basic',
          });
          res.end(reply);
          return;
        }

        if (msg?.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }

        if (msg?.method === 'tools/list') {
          const reply = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'get_adcp_capabilities',
                  description: 'stub',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(reply);
          return;
        }

        const reply = JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, result: {} });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(reply);
      });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(async () => {
    await closeMCPConnections();
    received = [];
  });

  after(async () => {
    await closeMCPConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it('forwards basic-auth Authorization header from agent.headers on the precheck path', async () => {
    const client = new AgentClient({
      id: 'basic-auth-mcp',
      agent_uri: baseUrl,
      protocol: 'mcp',
      name: 'basic-auth-test',
      headers: { Authorization: credential },
      // Intentionally no auth_token — basic auth lives in headers; setting
      // auth_token would emit a competing `Authorization: Bearer …`.
    });

    const info = await client.getAgentInfo();
    assert.strictEqual(info.protocol, 'mcp');
    assert.ok(Array.isArray(info.tools));
    assert.ok(info.tools.length > 0, 'tools/list should be reached');

    // Every request the SDK made must carry the basic-auth header. Before the
    // fix, the `tools/list` precheck arrived without `authorization` and 401'd.
    assert.ok(received.length > 0, 'server should have received at least one request');
    for (const r of received) {
      // Redact the header value in the failure message — even though the
      // credential is a hardcoded test fixture, the assertion shape becomes
      // the template for adopter copy-paste.
      assert.strictEqual(
        r.authHeader,
        credential,
        `request "${r.method}" missing expected Authorization header (header was ${r.authHeader ? 'set-but-wrong' : 'absent'})`
      );
    }
    assert.ok(
      received.some(r => r.method === 'tools/list'),
      'tools/list should appear in the wire trace'
    );
  });

  it('static bearer takes precedence over customHeaders.Authorization', async () => {
    // Lock the precedence ordering in `connectMCP`'s `authHeaders` merge:
    // `{ ...customHeaders, ...createMCPAuthHeaders(authToken) }` — the bearer
    // spread last and wins. If someone reorders the merge, this fails.
    const bearerToken = 'bearer-token-xyz';
    const client = new AgentClient({
      id: 'bearer-with-stray-basic',
      agent_uri: baseUrl,
      protocol: 'mcp',
      name: 'precedence-test',
      auth_token: bearerToken,
      headers: { Authorization: credential }, // should be overridden by auth_token
    });

    // The test server expects `Basic …` and will 401 anything else. We expect
    // this to fail (with 401) because the bearer wins — that's the assertion.
    await assert.rejects(
      () => client.getAgentInfo(),
      err => err instanceof Error,
      'expected getAgentInfo to fail because bearer overrode the basic header'
    );

    // The wire should include the authoritative bearer. A request from the
    // prior cached Basic-auth client may finish while its connection is being
    // closed, so do not infer this client's credentials from array order.
    const bearerReq = received.find(r => r.authHeader?.startsWith('Bearer '));
    assert.ok(
      bearerReq,
      `expected static bearer on the wire; got prefixes ${received
        .map(r => r.authHeader?.split(' ')[0] ?? 'none')
        .join(', ')}`
    );
  });
});
