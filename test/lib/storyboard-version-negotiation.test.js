const assert = require('node:assert');
const { describe, test } = require('node:test');

describe('storyboard runner AdCP version negotiation', () => {
  test('major-only version envelope suppresses exact adcp_version while preserving legacy marker', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { ProtocolClient } = require('../../dist/lib/index.js');
    const z = require('zod');

    let captured;
    const server = new McpServer({ name: 'storyboard-version-test', version: '1.0.0' });
    server.registerTool(
      'get_adcp_capabilities',
      {
        inputSchema: {
          adcp_major_version: z.number().optional(),
          adcp_version: z.string().optional(),
        },
      },
      async args => {
        captured = args;
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: {
            status: 'completed',
            adcp: { major_versions: [3] },
            supported_protocols: ['media_buy'],
          },
        };
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    await ProtocolClient.callTool(
      {
        id: 'storyboard-version-test',
        protocol: 'mcp',
        agent_uri: 'in-process://storyboard-version-test',
        _inProcessMcpClient: mcpClient,
      },
      'get_adcp_capabilities',
      {},
      { adcpVersion: '3.1.0-beta.2', versionEnvelope: 'major-only' }
    );

    assert.strictEqual(captured.adcp_major_version, 3);
    assert.strictEqual(captured.adcp_version, undefined);

    await mcpClient.close();
    await server.close();
  });

  test('compliance negotiation uses major-only envelope for strict 3.0 capability profiles', () => {
    const { applyNegotiatedComplianceVersionOptions } = require('../../dist/lib/testing/compliance/comply.js');

    const options = applyNegotiatedComplianceVersionOptions(
      {
        name: 'Strict 3.0',
        tools: ['get_adcp_capabilities', 'get_products'],
        adcp_version: 'v3',
        adcp_major_versions: [3],
        supported_protocols: ['media_buy'],
        library_version: '@adcp/sdk@7.11.1',
      },
      { adcpVersion: '3.1.0-beta.2', versionEnvelope: 'auto' },
      { complianceVersion: '3.1.0-beta.2' }
    );

    assert.strictEqual(options.versionEnvelope, 'major-only');
    assert.strictEqual(options._serverAdcpVersion, '3.0');
  });

  test('pre-3.1 build_version is positive downgrade evidence', () => {
    const { applyNegotiatedComplianceVersionOptions } = require('../../dist/lib/testing/compliance/comply.js');

    const options = applyNegotiatedComplianceVersionOptions(
      {
        name: 'Strict 3.0',
        tools: ['get_adcp_capabilities', 'get_products'],
        adcp_version: 'v3',
        adcp_major_versions: [3],
        adcp_build_version: '3.0.18',
        supported_protocols: ['media_buy'],
      },
      { adcpVersion: '3.1.0-beta.2', versionEnvelope: 'auto' },
      { complianceVersion: '3.1.0-beta.2' }
    );

    assert.strictEqual(options.versionEnvelope, 'major-only');
    assert.strictEqual(options._serverAdcpVersion, '3.0.18');
  });
});
