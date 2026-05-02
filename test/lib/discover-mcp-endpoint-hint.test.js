/**
 * Regression test for issue #1234: discoverMCPEndpoint's "Failed to discover
 * MCP endpoint" error includes a hint pointing operators at the most common
 * cause (agent_uri registered at the host root when the MCP endpoint lives
 * at a non-standard path like /api/mcp or /v1/mcp).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { AdCPClient } = require('../../dist/lib/index.js');

describe('discoverMCPEndpoint — wrong-path hint (#1234)', () => {
  it('appends a wrong-path hint when no candidate responds with 200 or 401', async () => {
    // Stub: every POST returns 404. Discovery probes /, /mcp, /mcp/ — none
    // exists, no 401 anywhere, so we hit the generic-failure branch.
    const server = http.createServer((_, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const client = new AdCPClient([
        { id: 'no-mcp', name: 'no-mcp', protocol: 'mcp', agent_uri: baseUrl },
      ]);

      await assert.rejects(
        () => client.agent('no-mcp').getAgentInfo(),
        err => {
          assert.match(err.message, /Failed to discover MCP endpoint/);
          assert.match(
            err.message,
            /Hint:.*agent_uri.*does not include the MCP endpoint path/i,
            `expected wrong-path hint in: ${err.message}`
          );
          assert.match(err.message, /\/api\/mcp|\/v1\/mcp/, 'expected example paths in hint');
          return true;
        }
      );
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
