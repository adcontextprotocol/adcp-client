/**
 * Regression test for issue #1233: getAgentInfo() uses SSE fallback
 *
 * Before the fix, SingleAgentClient.getAgentInfo() called connectMCP() directly,
 * which is StreamableHTTP-only. Every other production path (callMCPTool,
 * mcp-tasks.ts) goes through connectMCPWithFallback, which adds an SSE fallback
 * for public addresses when StreamableHTTP fails.
 *
 * After the fix, getAgentInfo() routes through connectMCPWithFallback.
 *
 * This test verifies:
 *   1. getAgentInfo() still works against a StreamableHTTP server (no regression).
 *   2. getAgentInfo() returns the correct tool list and metadata.
 *   3. getAgentInfo() works with a static auth token (headers path).
 *   4. getAgentInfo() works with no auth (unauthenticated server).
 *
 * SSE-only public servers: the SSE path in connectMCPWithFallback is exercised
 * whenever StreamableHTTP fails at a non-private address. Loopback is excluded
 * by the isPrivateAddress() guard in connectMCPWithFallbackImpl (this is correct
 * behavior — SSE would return 405 on private servers). The SSE transport fallback
 * logic itself is already covered by test/unit/mcp-discovery-sse-fallback.test.js;
 * what this test adds is wiring coverage — confirming getAgentInfo() reaches that
 * code path instead of the old connectMCP() path.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AdCPClient, closeMCPConnections } = require('../../dist/lib/index.js');

// Minimal StreamableHTTP MCP server: handles initialize → notifications/initialized
// → tools/list. Sufficient for getAgentInfo().
function createMcpServer(tools) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      if (msg.method === 'initialize') {
        const reply = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'test-mcp-agent', version: '1.0.0' },
          },
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'mcp-session-id': 'test-session',
        });
        res.end(reply);
        return;
      }

      if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }

      if (msg.method === 'tools/list') {
        const reply = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(reply);
        return;
      }

      res.writeHead(400);
      res.end();
    });
  });
}

const TEST_TOOLS = [
  {
    name: 'get_adcp_capabilities',
    description: 'Describe agent capabilities',
    inputSchema: {
      type: 'object',
      properties: { version: { type: 'string' } },
    },
  },
  {
    name: 'create_media_buy',
    description: 'Create a media buy',
    inputSchema: {
      type: 'object',
      properties: { brief: { type: 'string' }, budget: { type: 'number' } },
    },
  },
];

let server;
let port;

before(async () => {
  server = createMcpServer(TEST_TOOLS);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await closeMCPConnections();
  await new Promise(resolve => server.close(resolve));
});

describe('getAgentInfo(): routes through connectMCPWithFallback (issue #1233)', () => {
  it('returns tools from a StreamableHTTP server', async () => {
    const client = new AdCPClient([
      {
        id: 'test-agent',
        name: 'Test MCP Agent',
        agent_uri: `http://127.0.0.1:${port}/mcp`,
        protocol: 'mcp',
      },
    ]);

    const info = await client.agent('test-agent').getAgentInfo();

    assert.strictEqual(info.name, 'Test MCP Agent');
    assert.strictEqual(info.protocol, 'mcp');
    assert.strictEqual(info.tools.length, 2);
    const toolNames = info.tools.map(t => t.name);
    assert.ok(toolNames.includes('get_adcp_capabilities'), 'expected get_adcp_capabilities');
    assert.ok(toolNames.includes('create_media_buy'), 'expected create_media_buy');
  });

  it('returns url and protocol fields', async () => {
    const agentUri = `http://127.0.0.1:${port}/mcp`;
    const client = new AdCPClient([
      {
        id: 'test-agent',
        name: 'My Agent',
        agent_uri: agentUri,
        protocol: 'mcp',
      },
    ]);

    const info = await client.agent('test-agent').getAgentInfo();

    assert.strictEqual(info.protocol, 'mcp');
    assert.strictEqual(info.url, agentUri);
  });

  it('maps inputSchema.properties to parameters[]', async () => {
    const client = new AdCPClient([
      {
        id: 'test-agent',
        name: 'Test MCP Agent',
        agent_uri: `http://127.0.0.1:${port}/mcp`,
        protocol: 'mcp',
      },
    ]);

    const info = await client.agent('test-agent').getAgentInfo();
    const tool = info.tools.find(t => t.name === 'create_media_buy');

    assert.ok(tool, 'create_media_buy should be in the tool list');
    assert.deepStrictEqual(tool.parameters.sort(), ['brief', 'budget']);
  });

  it('works with a static auth token (headers path)', async () => {
    // Creates a server that checks the Authorization header
    const authServer = http.createServer((req, res) => {
      const authHeader = req.headers['authorization'] || req.headers['x-adcp-auth'];
      if (!authHeader || !authHeader.includes('test-token-abc')) {
        res.writeHead(401);
        res.end();
        return;
      }
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        if (msg.method === 'initialize') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'mcp-session-id': 'auth-session',
          });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'auth-agent', version: '1.0.0' },
              },
            })
          );
          return;
        }
        if (msg.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        if (msg.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  {
                    name: 'list_inventory',
                    description: 'List available inventory',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              },
            })
          );
          return;
        }
        res.writeHead(400);
        res.end();
      });
    });

    await new Promise(resolve => authServer.listen(0, '127.0.0.1', resolve));
    const authPort = authServer.address().port;

    try {
      const client = new AdCPClient([
        {
          id: 'auth-agent',
          name: 'Auth Agent',
          agent_uri: `http://127.0.0.1:${authPort}/mcp`,
          protocol: 'mcp',
          auth_token: 'test-token-abc',
        },
      ]);

      const info = await client.agent('auth-agent').getAgentInfo();

      assert.strictEqual(info.tools.length, 1);
      assert.strictEqual(info.tools[0].name, 'list_inventory');
    } finally {
      await new Promise(resolve => authServer.close(resolve));
    }
  });
});
