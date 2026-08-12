const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { ADCPMultiAgentClient } = require('../../dist/lib/index.js');
const { testCapabilityDiscovery } = require('../../dist/lib/testing/scenarios/capabilities.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { probeModernMCPConnection } = require('../../dist/lib/protocols/mcp-modern.js');

const REQUIRED_MEDIA_TYPES = ['application/json', 'text/event-stream'];

function hasRequiredAccept(value) {
  const mediaTypes = String(value ?? '')
    .split(',')
    .map(part => part.trim().split(';', 1)[0].toLowerCase());
  return REQUIRED_MEDIA_TYPES.every(type => mediaTypes.includes(type));
}

async function startStrictAcceptServer({ alwaysReject = false } = {}) {
  const requests = [];
  const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
  const { toNodeHandler } = require('@modelcontextprotocol/node');
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'strict-accept-seller', version: '1.0.0' });
    server.registerTool('get_adcp_capabilities', { description: 'AdCP capabilities' }, async () => {
      const payload = {
        status: 'completed',
        adcp_version: '3.1',
        adcp: {
          major_versions: [3],
          supported_versions: ['3.1'],
          idempotency: { supported: true, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        specialisms: [],
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    });
    server.registerTool('get_products', { description: 'Products' }, async () => ({
      content: [{ type: 'text', text: JSON.stringify({ status: 'completed', products: [] }) }],
      structuredContent: { status: 'completed', products: [] },
    }));
    return server;
  });
  const serveMcp = toNodeHandler(handler);

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/mcp' && req.url !== '/mcp/') {
      res.writeHead(404).end('not found');
      return;
    }
    requests.push(req.headers.accept);
    if (alwaysReject || !hasRequiredAccept(req.headers.accept)) {
      res.writeHead(406, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Accept must include application/json and text/event-stream' }));
      return;
    }
    await serveMcp(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    requests,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('capability discovery and normal MCP calls send both Streamable HTTP Accept media types', async t => {
  const seller = await startStrictAcceptServer();
  t.after(async () => {
    await closeMCPConnections();
    await seller.close();
  });

  const discovery = await testCapabilityDiscovery(seller.url, { protocol: 'mcp' });
  assert.ok(discovery.profile, 'testCapabilityDiscovery should return the discovered profile');
  assert.ok(
    discovery.steps.every(step => step.passed),
    JSON.stringify(discovery.steps, null, 2)
  );

  await closeMCPConnections();
  const client = new ADCPMultiAgentClient([
    {
      id: 'strict-accept',
      name: 'Strict Accept seller',
      agent_uri: seller.url,
      protocol: 'mcp',
    },
  ]);
  const result = await client.agent('strict-accept').getAdcpCapabilities({});
  assert.strictEqual(result.success, true, result.error);

  assert.ok(seller.requests.length > 0, 'server should receive MCP requests');
  for (const accept of seller.requests) {
    assert.ok(hasRequiredAccept(accept), `incomplete Accept header: ${accept}`);
  }
});

test('a 406 response remains a visible transport error', async t => {
  const seller = await startStrictAcceptServer({ alwaysReject: true });
  t.after(async () => {
    await closeMCPConnections();
    await seller.close();
  });

  await assert.rejects(
    () => probeModernMCPConnection(seller.url),
    error => {
      const serialized = `${error?.message ?? error} ${error?.status ?? ''} ${error?.cause?.status ?? ''}`;
      return /406|Not Acceptable/i.test(serialized);
    }
  );
  assert.ok(seller.requests.length > 0);
  assert.ok(seller.requests.every(hasRequiredAccept));
});
