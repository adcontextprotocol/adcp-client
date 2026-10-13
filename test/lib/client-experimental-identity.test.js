// Experimental AdCP 3.3: a client opted into agent identity accepts the draft
// get_principal `relationship` (validated against the pinned preview schema)
// under strict 3.2 response validation; without the opt-in it is rejected.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { AgentClient } = require('../../dist/lib/index.js');

async function pair(relationship) {
  const server = new McpServer({ name: 'identity-preview', version: '1.0.0' });
  server.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: '{}' }],
    structuredContent: {
      adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      supported_protocols: ['media_buy'],
    },
  }));
  server.registerTool('get_principal', { inputSchema: {} }, async () => {
    const payload = { result: { kind: 'unconfigured', relationship } };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'test', version: '1.0.0' });
  await mcpClient.connect(clientTransport);
  return { mcpClient, server };
}

async function getPrincipal(relationship, validation) {
  const { mcpClient, server } = await pair(relationship);
  try {
    const agent = AgentClient.fromMCPClient(mcpClient, {
      validation: { requests: 'off', responses: 'strict', logSchemaViolations: false, ...validation },
      validateFeatures: false,
    });
    return await agent.getPrincipal({});
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

describe('validation.experimentalAgentIdentity', () => {
  it('accepts and preserves a valid draft relationship', async () => {
    const result = await getPrincipal(
      { status: 'pending', setup: { message: 'Apply', url: 'https://seller.example.com/apply' } },
      { experimentalAgentIdentity: true }
    );
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.result.relationship.status, 'pending');
  });

  it('still rejects an invalid draft relationship', async () => {
    const result = await getPrincipal({ status: 'approved' }, { experimentalAgentIdentity: true });
    assert.equal(result.success, false);
  });

  it('keeps 3.2 behavior without the opt-in', async () => {
    const result = await getPrincipal({ status: 'pending' }, {});
    assert.equal(result.success, false);
  });
});
