const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('storyboard runner AdCP version negotiation', () => {
  test('derives legacy-major-only version envelope for 3.0 storyboards', () => {
    const { applyStoryboardVersionOptions } = require('../../dist/lib/testing/storyboard/index.js');

    const options = applyStoryboardVersionOptions({ adcp_version: '3.0.12' }, {});

    assert.strictEqual(options.adcpVersion, '3.0.12');
    assert.strictEqual(options.versionEnvelope, 'auto');
  });

  test('derives explicit opt-in envelope for 3.1 storyboards', () => {
    const { applyStoryboardVersionOptions } = require('../../dist/lib/testing/storyboard/index.js');

    const options = applyStoryboardVersionOptions({ adcp_version: '3.1.0-beta.5' }, {});

    assert.strictEqual(options.adcpVersion, '3.1.0-beta.5');
    assert.strictEqual(options.versionEnvelope, 'auto');
  });

  test('caller-supplied version envelope mode wins', () => {
    const { applyStoryboardVersionOptions } = require('../../dist/lib/testing/storyboard/index.js');

    const options = applyStoryboardVersionOptions(
      { adcp_version: '3.0.12' },
      { adcpVersion: '3.0.12', versionEnvelope: 'auto' }
    );

    assert.strictEqual(options.adcpVersion, '3.0.12');
    assert.strictEqual(options.versionEnvelope, 'auto');
  });

  test('legacy v3 alias keeps integer version marker behavior', () => {
    const { applyAdcpVersionRunOptions } = require('../../dist/lib/testing/storyboard/index.js');

    const options = applyAdcpVersionRunOptions(undefined, { adcpVersion: 'v3' });

    assert.strictEqual(options.adcpVersion, 'v3');
    assert.strictEqual(options.versionEnvelope, 'auto');
  });

  test('shared test client is reused only when version options match', () => {
    const { createTestClient, getOrCreateClient } = require('../../dist/lib/testing/client.js');

    const shared = createTestClient('https://example.com/mcp', 'mcp', {
      adcpVersion: '3.1.0-beta.5',
      versionEnvelope: 'auto',
    });

    assert.strictEqual(
      getOrCreateClient('https://example.com/mcp', {
        _client: shared,
        adcpVersion: '3.1.0-beta.5',
        versionEnvelope: 'auto',
      }),
      shared
    );
    assert.notStrictEqual(
      getOrCreateClient('https://example.com/mcp', {
        _client: shared,
        adcpVersion: '3.1.0-beta.5',
        versionEnvelope: 'none',
      }),
      shared
    );
  });

  test('3.0 storyboards suppress exact adcp_version while preserving legacy major marker', async () => {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { ProtocolClient } = require('../../dist/lib/index.js');
    const z = require('zod');

    let captured;
    const server = new McpServer({ name: 'storyboard-version-test', version: '1.0.0' });
    server.registerTool(
      'get_products',
      {
        inputSchema: {
          brief: z.string().optional(),
          adcp_major_version: z.number().optional(),
          adcp_version: z.string().optional(),
        },
      },
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
      {
        id: 'storyboard-version-test',
        protocol: 'mcp',
        agent_uri: 'in-process://storyboard-version-test',
        _inProcessMcpClient: mcpClient,
      },
      'get_products',
      { brief: 'legacy 3.0 storyboard' },
      { adcpVersion: '3.0.12' }
    );

    assert.strictEqual(captured.adcp_major_version, 3);
    assert.strictEqual(captured.adcp_version, undefined);

    await mcpClient.close();
    await server.close();
  });

  test('exact seller supported_versions are matched against cache version aliases', () => {
    const { isComplianceVersionSupported } = require('../../dist/lib/testing/storyboard/index.js');

    assert.strictEqual(isComplianceVersionSupported('3.1.0-beta.5', ['3.1.0-beta.5']), true);
    assert.strictEqual(isComplianceVersionSupported('3.1.0-beta.5', ['3.1-beta.5']), true);
    assert.strictEqual(isComplianceVersionSupported('3.1.0-beta.5', ['3.1-beta']), true);
    assert.strictEqual(isComplianceVersionSupported('3.1.0-beta.5', ['3.1-beta.2']), false);
    assert.strictEqual(isComplianceVersionSupported('3.1.0-beta.5', ['3.1.0-beta.2']), false);
    assert.strictEqual(isComplianceVersionSupported('3.0.12', ['3.0.0']), true);
    assert.strictEqual(isComplianceVersionSupported('3.1.1', ['3.1.0']), true);
    assert.strictEqual(isComplianceVersionSupported('3.1.0-beta.5', ['3.0']), false);
  });

  test('capability resolution fails loudly on exact version mismatch', () => {
    const {
      CapabilityResolutionError,
      resolveStoryboardsForCapabilities,
    } = require('../../dist/lib/testing/storyboard/index.js');

    assert.throws(
      () =>
        resolveStoryboardsForCapabilities({
          supported_protocols: [],
          supported_versions: ['3.0'],
        }),
      err =>
        err instanceof CapabilityResolutionError &&
        err.code === 'unsupported_adcp_version' &&
        /Compliance cache version/.test(err.message) &&
        /supported_versions \[3\.0\]/.test(err.message)
    );
  });

  test('external compliance dir registers its sibling schema bundle', () => {
    const { loadComplianceIndex } = require('../../dist/lib/testing/storyboard/index.js');
    const {
      getValidator,
      unregisterExternalSchemaRoot,
      _resetValidationLoader,
    } = require('../../dist/lib/validation/schema-loader.js');
    const { resolveAdcpVersion } = require('../../dist/lib/utils/adcp-version-config.js');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-external-compliance-'));
    const complianceDir = path.join(tempRoot, 'package', 'compliance', 'cache', '3.0.12');
    const schemaRoot = path.join(tempRoot, 'package', 'dist', 'lib', 'schemas-data', '3.0');
    try {
      fs.mkdirSync(complianceDir, { recursive: true });
      fs.mkdirSync(path.join(schemaRoot, 'bundled', 'media-buy'), { recursive: true });
      fs.writeFileSync(
        path.join(complianceDir, 'index.json'),
        JSON.stringify({ adcp_version: '3.0.12', universal: [], protocols: [], specialisms: [] })
      );
      fs.writeFileSync(
        path.join(schemaRoot, 'bundled', 'media-buy', 'get-products-request.json'),
        JSON.stringify({
          $id: '/schemas/3.0/bundled/media-buy/get-products-request.json',
          type: 'object',
          properties: { sentinel: { const: 'external' } },
          required: ['sentinel'],
          additionalProperties: false,
        })
      );

      loadComplianceIndex({ complianceDir });

      assert.strictEqual(resolveAdcpVersion('3.0.12'), '3.0.12');
      const validator = getValidator('get_products', 'request', '3.0.12');
      assert.ok(validator, 'external 3.0 request validator should compile');
      assert.strictEqual(validator({ sentinel: 'external' }), true);
      assert.strictEqual(validator({ sentinel: 'installed-sdk-default' }), false);
    } finally {
      unregisterExternalSchemaRoot('3.0.12');
      _resetValidationLoader('3.0.12');
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
