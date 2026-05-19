/**
 * Regression tests for #1864: custom headers (including Authorization: Basic)
 * must be forwarded to the MCP server on the connectMCP path (used by
 * getAgentInfo / SingleAgentClient.getCapabilities).
 *
 * Prior to the fix, connectMCP only set requestInit.headers inside
 * `else if (authToken)` — pure-header auth schemes (Basic, x-api-key, etc.)
 * were silently dropped, breaking every basic-auth MCP agent on every
 * executeTask precheck. The connectMCPWithFallback path (used by callMCPTool)
 * was already correct and does not need coverage here.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { connectMCP, closeMCPConnections } = require('../../dist/lib/protocols/mcp');
const { AgentClient } = require('../../dist/lib/core/AgentClient');

// Minimal MCP-over-StreamableHTTP server: handles initialize + notifications/initialized + tools/list.
function createMcpServer(onRequest) {
  return http.createServer((req, res) => {
    onRequest(req);
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end();
      }
      if (!msg || typeof msg !== 'object') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, result: {} }));
      }
      const id = msg.id ?? null;
      let result;
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'test', version: '1.0.0' },
          capabilities: { tools: {} },
        };
      } else if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        return res.end();
      } else if (msg.method === 'tools/list') {
        result = { tools: [] };
      } else {
        result = {};
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
}

describe('connectMCP — custom headers forwarding (issue #1864)', () => {
  let server;
  let baseUrl;
  // Per-test capture callback — reassigned in each test to avoid mutating
  // server listener state between tests.
  let captureHeader = () => {};

  before(async () => {
    server = createMcpServer(req => captureHeader(req));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  });

  after(async () => {
    await closeMCPConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it('forwards Authorization: Basic header when no authToken or authProvider is set', async () => {
    const capturedAuths = [];
    captureHeader = req => capturedAuths.push(req.headers.authorization ?? '');

    const basicCred = 'Basic ' + Buffer.from('user:pass').toString('base64');
    const { client } = await connectMCP({
      agentUrl: baseUrl,
      customHeaders: { Authorization: basicCred },
    });
    await client.close();

    assert.ok(
      capturedAuths.some(h => h === basicCred),
      `expected server to receive Authorization: Basic header. Got: ${JSON.stringify(capturedAuths)}`
    );
  });

  it('forwards custom x-api-key header when no authToken is set', async () => {
    const seenXApiKey = [];
    captureHeader = req => seenXApiKey.push(req.headers['x-api-key'] ?? '');

    const { client } = await connectMCP({
      agentUrl: baseUrl,
      customHeaders: { 'x-api-key': 'tenant-key-123' },
    });
    await client.close();

    assert.ok(
      seenXApiKey.some(v => v === 'tenant-key-123'),
      `expected server to receive x-api-key header. Got: ${JSON.stringify(seenXApiKey)}`
    );
  });
});

describe('SingleAgentClient.getAgentInfo() — custom headers forwarded (issue #1864, Defect A)', () => {
  let server;
  let baseUrl;
  const seenAuths = [];

  before(async () => {
    server = createMcpServer(req => {
      seenAuths.push(req.headers.authorization ?? '');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  });

  after(async () => {
    await closeMCPConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it('sends Authorization: Basic header on the getAgentInfo (tools/list) request', async () => {
    seenAuths.length = 0;
    const basicCred = 'Basic ' + Buffer.from('agent-user:agent-pass').toString('base64');

    const client = new AgentClient(
      {
        id: 'basic-auth-agent',
        protocol: 'mcp',
        agent_uri: baseUrl,
        name: 'Basic Auth Test Agent',
        headers: { Authorization: basicCred },
        // auth_token intentionally absent — CLI suppresses it for basic-auth
      },
      {}
    );

    const info = await client.getAgentInfo();

    assert.strictEqual(info.protocol, 'mcp');
    assert.ok(Array.isArray(info.tools));
    assert.ok(
      seenAuths.some(h => h === basicCred),
      `getAgentInfo must forward Authorization: Basic to the MCP server on the tools/list request. ` +
        `Saw: ${JSON.stringify(seenAuths)} — regression means Defect A is back`
    );
  });
});
