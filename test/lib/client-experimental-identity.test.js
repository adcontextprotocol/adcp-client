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

describe('inline relationship check matches the pinned preview schema', () => {
  const { isPreviewPrincipalRelationship } = require('../../dist/lib/core/TaskExecutor.js');
  const { identityPreviewSchemaErrors } = require('../../dist/lib/signing/server.js');
  const corpus = [
    { status: 'pending' },
    { status: 'active', expires_at: '2026-10-13T00:00:00Z' },
    { status: 'suspended', expires_at: '2026-10-13T00:00:00.123+02:00' },
    { status: 'blocked', ext: {} },
    {
      status: 'pending',
      setup: { message: 'Apply', url: 'https://seller.example.com/apply', expires_at: '2026-10-14T00:00:00Z' },
    },
    { status: 'pending', extra: true },
    { status: 'approved' },
    {},
    { status: 'active', expires_at: '2026-13-45T99:99:99Z' },
    { status: 'active', expires_at: '2026-02-30T00:00:00Z' },
    { status: 'active', expires_at: 'tomorrow' },
    { status: 'pending', setup: {} },
    { status: 'pending', setup: { message: 1 } },
    { status: 'pending', setup: { message: 'x', url: 'not a url' } },
    { status: 'active', ext: [] },
    'active',
  ];
  for (const value of corpus) {
    it(`agrees on ${JSON.stringify(value)}`, () => {
      const schemaValid = identityPreviewSchemaErrors(value, 'core/principal-relationship.json').length === 0;
      assert.equal(isPreviewPrincipalRelationship(value), schemaValid);
    });
  }
});

describe('experimentalAgentIdentity is automatic for Web Bot Auth signers', () => {
  it('enables the relationship check when request_signing.profile is web-bot-auth', () => {
    const { SingleAgentClient } = require('../../dist/lib/index.js');
    const { generateKeyPairSync } = require('node:crypto');
    const { publicDirectoryKey } = require('../../dist/lib/signing/client.js');
    const key = generateKeyPairSync('ed25519').privateKey;
    const client = new SingleAgentClient({
      id: 'seller',
      name: 'Seller',
      agent_uri: 'https://seller.example.com/mcp',
      protocol: 'mcp',
      request_signing: {
        profile: 'web-bot-auth',
        kid: publicDirectoryKey(key).kid,
        alg: 'ed25519',
        private_key: key.export({ format: 'jwk' }),
        agent_url: 'https://buyer.example.com',
      },
    });
    assert.equal(client.executor.config.experimentalAgentIdentity, true);
  });
});
