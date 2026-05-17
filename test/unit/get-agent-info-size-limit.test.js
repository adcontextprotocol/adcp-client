/**
 * Integration check that `SingleAgentClient.getAgentInfo()` honors
 * `transport.maxResponseBytes` on both the MCP `tools/list` path and the A2A
 * `fromCardUrl` discovery path.
 *
 * Closes adcontextprotocol/adcp-client#1799 — prior to this regression test
 * `getAgentInfo` called `mcpClient.listTools()` and `A2AClient.fromCardUrl`
 * without entering the `withResponseSizeLimit` ALS slot, so the cap was
 * dormant for the discovery body even when set on the client.
 *
 * Pattern mirrors `a2a-card-size-limit.test.js` and `mcp-tool-size-limit.test.js`
 * — real loopback HTTP server, no MCP/A2A SDK on the server side.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AgentClient } = require('../../dist/lib/core/AgentClient');
const { ResponseTooLargeError } = require('../../dist/lib/errors');

describe('SingleAgentClient.getAgentInfo() — maxResponseBytes (A2A discovery)', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/.well-known/agent.json' || req.url === '/.well-known/agent-card.json') {
        const padding = 'x'.repeat(5 * 1024 * 1024);
        const body = JSON.stringify({
          name: 'oversized-discovery',
          url: `${baseUrl}/a2a`,
          description: padding,
        });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('aborts the agent-card fetch with ResponseTooLargeError when the card exceeds the cap', async () => {
    const client = new AgentClient(
      { id: 'oversized-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' },
      { transport: { maxResponseBytes: 64 * 1024 } }
    );

    await assert.rejects(
      () => client.getAgentInfo(),
      err => {
        assert.ok(
          err instanceof ResponseTooLargeError,
          `expected ResponseTooLargeError, got ${err?.constructor?.name}: ${err?.message}`
        );
        assert.strictEqual(err.code, 'RESPONSE_TOO_LARGE');
        assert.strictEqual(err.limit, 64 * 1024);
        return true;
      }
    );
  });

  it('lets the agent card flow through unchanged when the cap is generous', async () => {
    const client = new AgentClient(
      { id: 'small-a2a', agent_uri: baseUrl, protocol: 'a2a', name: 'test' },
      { transport: { maxResponseBytes: 16 * 1024 * 1024 } }
    );

    const info = await client.getAgentInfo();
    assert.strictEqual(info.protocol, 'a2a');
    assert.ok(Array.isArray(info.tools));
  });
});
