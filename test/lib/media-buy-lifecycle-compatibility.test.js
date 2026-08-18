process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { AgentClient } = require('../../dist/lib/core/AgentClient');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { adcpError } = require('../../dist/lib/server/errors');

async function withDualSurfaceSeller(serverAdcpVersion, buyerAdcpVersion, run) {
  const calls = [];
  const supportedVersions = ['3.0.24', '3.1.15', '3.2.0-beta.1'].filter(version => {
    if (serverAdcpVersion.startsWith('3.0.')) return version.startsWith('3.0.');
    if (serverAdcpVersion.startsWith('3.1.')) return !version.startsWith('3.2.');
    return true;
  });
  const server = createAdcpServer({
    name: 'dual-surface-seller',
    version: '1.0.0',
    adcpVersion: serverAdcpVersion,
    capabilities: { supported_versions: supportedVersions },
    validation: { requests: 'off', responses: 'off' },
    mediaBuy: {
      listProducts: async params => {
        calls.push(['list_products', params.adcp_version, params.adcp_major_version]);
        return {
          outcome: 'listed',
          products: [],
          feed_version: 'feed-modern',
          cache_scope: 'public',
        };
      },
      requestProposals: async () =>
        adcpError('TERMS_REJECTED', { message: 'fixture rejection', recovery: 'correctable' }),
      getProducts: async params => {
        calls.push(['get_products', params.adcp_version, params.adcp_major_version]);
        return { products: [], cache_scope: 'public' };
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: `buyer-${buyerAdcpVersion}`, version: '1.0.0' });
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
  const buyer = AgentClient.fromMCPClient(mcpClient, {
    adcpVersion: buyerAdcpVersion,
    validation: { requests: 'off', responses: 'off' },
  });
  try {
    await run({ buyer, mcpClient, calls });
  } finally {
    await Promise.allSettled([mcpClient.close(), server.close()]);
  }
}

test('SDK buyer uses the compact lifecycle against a 3.2 seller profile', async () => {
  await withDualSurfaceSeller('3.2.0-beta.1', '3.2.0-beta.1', async ({ buyer, mcpClient, calls }) => {
    const listed = await mcpClient.listTools();
    assert.ok(listed.tools.some(tool => tool.name === 'list_products'));
    assert.ok(!listed.tools.some(tool => tool.name === 'get_products'));

    const result = await buyer.listProducts({ max_results: 10 });
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.strictEqual(result.data.feed_version, 'feed-modern');
    assert.deepStrictEqual(calls, [['list_products', '3.2-beta.1', 3]]);

    const rejected = await mcpClient.callTool({
      name: 'request_proposals',
      arguments: { idempotency_key: 'proposal-error-key-0001', brief: 'test' },
    });
    assert.strictEqual(rejected.isError, true);
    // InMemoryTransport supplies no authenticated principal. The official
    // MCP client must still receive the framework's structured auth error;
    // declaring a success-only outputSchema would make the SDK reject this
    // response before it reached the caller.
    assert.strictEqual(rejected.structuredContent.adcp_error.code, 'AUTH_MISSING');
  });
});

for (const adcpVersion of ['3.1.15', '3.0.24']) {
  test(`SDK buyer pinned to ${adcpVersion} can call a 3.2 seller's hidden legacy facade`, async () => {
    await withDualSurfaceSeller('3.2.0-beta.1', adcpVersion, async ({ buyer, mcpClient, calls }) => {
      const listed = await mcpClient.listTools();
      assert.ok(!listed.tools.some(tool => tool.name === 'get_products'));

      const result = await buyer.getProducts({ buying_mode: 'wholesale' });
      assert.strictEqual(result.success, true, JSON.stringify(result));
      const expectedWireClaim = adcpVersion === '3.1.15' ? ['get_products', '3.1', 3] : ['get_products', undefined, 3];
      assert.deepStrictEqual(calls, [expectedWireClaim]);
    });
  });

  test(`SDK buyer and seller pinned to ${adcpVersion} use the advertised legacy facade`, async () => {
    await withDualSurfaceSeller(adcpVersion, adcpVersion, async ({ buyer, mcpClient, calls }) => {
      const listed = await mcpClient.listTools();
      assert.ok(listed.tools.some(tool => tool.name === 'get_products'));
      assert.ok(!listed.tools.some(tool => tool.name === 'list_products'));

      const result = await buyer.getProducts({ buying_mode: 'wholesale' });
      assert.strictEqual(result.success, true, JSON.stringify(result));
      const expectedWireClaim = adcpVersion === '3.1.15' ? ['get_products', '3.1', 3] : ['get_products', undefined, 3];
      assert.deepStrictEqual(calls, [expectedWireClaim]);
    });
  });
}
