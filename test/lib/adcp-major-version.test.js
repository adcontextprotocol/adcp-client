/**
 * Tests that adcp_major_version is injected into every tool call request.
 *
 * Per adcontextprotocol/adcp#1959, buyers declare which AdCP major version
 * their payloads conform to via adcp_major_version on every request.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('adcp_major_version on requests', () => {
  test('ADCP_MAJOR_VERSION is exported and equals 3', () => {
    const { ADCP_MAJOR_VERSION } = require('../../dist/lib/version.js');
    assert.strictEqual(ADCP_MAJOR_VERSION, 3);
    assert.strictEqual(typeof ADCP_MAJOR_VERSION, 'number');
  });

  test('ADCP_MAJOR_VERSION is re-exported from main entry point', () => {
    const { ADCP_MAJOR_VERSION } = require('../../dist/lib/index.js');
    assert.strictEqual(ADCP_MAJOR_VERSION, 3);
  });

  test('ProtocolClient injects adcp_major_version when caller does not set it', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { ProtocolClient, ADCP_MAJOR_VERSION } = require('../../dist/lib/index.js');
    const z = require('zod');

    let captured;
    const server = new McpServer({ name: 'inject-test', version: '1.0.0' });
    server.registerTool(
      'get_products',
      { inputSchema: { brief: z.string().optional(), adcp_major_version: z.number().optional() } },
      async args => {
        captured = args;
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: { success: true, products: [] },
        };
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    await ProtocolClient.callTool(
      { id: 'inject-test', protocol: 'mcp', agent_uri: 'in-process://x', _inProcessMcpClient: mcpClient },
      'get_products',
      { brief: 'test' }
    );

    assert.strictEqual(captured.adcp_major_version, ADCP_MAJOR_VERSION);

    await mcpClient.close();
    await server.close();
  });

  test('caller-provided adcp_major_version overrides the SDK pin (regression: #1072)', async () => {
    // Conformance harnesses send adcp_major_version: 99 to probe seller
    // VERSION_UNSUPPORTED. The SDK must not rewrite that value.
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { ProtocolClient } = require('../../dist/lib/index.js');
    const z = require('zod');

    let captured;
    const server = new McpServer({ name: 'override-test', version: '1.0.0' });
    server.registerTool(
      'get_products',
      { inputSchema: { brief: z.string().optional(), adcp_major_version: z.number().optional() } },
      async args => {
        captured = args;
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: { success: true, products: [] },
        };
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    await ProtocolClient.callTool(
      { id: 'override-test', protocol: 'mcp', agent_uri: 'in-process://x', _inProcessMcpClient: mcpClient },
      'get_products',
      { brief: 'probe', adcp_major_version: 99 }
    );

    assert.strictEqual(
      captured.adcp_major_version,
      99,
      'caller-supplied adcp_major_version must reach the seller for version-negotiation probes'
    );

    await mcpClient.close();
    await server.close();
  });

  test('adcp_major_version is an integer between 1 and 99 per schema', () => {
    const { ADCP_MAJOR_VERSION } = require('../../dist/lib/version.js');

    assert.ok(Number.isInteger(ADCP_MAJOR_VERSION), 'must be an integer');
    assert.ok(ADCP_MAJOR_VERSION >= 1, 'minimum is 1');
    assert.ok(ADCP_MAJOR_VERSION <= 99, 'maximum is 99');
  });
});
