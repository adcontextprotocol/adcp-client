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

describe('applyVersionEnvelope — single chokepoint for all 4 wire-injection sites', () => {
  test('caller args win over envelope (regression: #1072)', () => {
    const { applyVersionEnvelope } = require('../../dist/lib/protocols/index.js');
    const merged = applyVersionEnvelope({ brief: 'probe', adcp_major_version: 99 }, { adcp_major_version: 3 });
    assert.strictEqual(merged.adcp_major_version, 99);
    assert.strictEqual(merged.brief, 'probe');
  });

  test('envelope fills fields the caller did not set', () => {
    const { applyVersionEnvelope } = require('../../dist/lib/protocols/index.js');
    const merged = applyVersionEnvelope({ brief: 'normal' }, { adcp_major_version: 3, adcp_version: '3.1' });
    assert.strictEqual(merged.adcp_major_version, 3);
    assert.strictEqual(merged.adcp_version, '3.1');
    assert.strictEqual(merged.brief, 'normal');
  });

  test('asymmetric override: caller integer + SDK 3.1 string both reach wire', () => {
    // Protocol-expert ask: a 3.1-pinned buyer that supplies only the
    // integer (caller-overrides the integer, SDK still adds the string)
    // produces a dual-field disagreement on the wire — exactly what the
    // server-side check in createAdcpServer is designed to catch.
    const { applyVersionEnvelope } = require('../../dist/lib/protocols/index.js');
    const merged = applyVersionEnvelope(
      { brief: 'probe', adcp_major_version: 99 },
      { adcp_major_version: 3, adcp_version: '3.1' }
    );
    assert.strictEqual(merged.adcp_major_version, 99, 'caller integer wins');
    assert.strictEqual(merged.adcp_version, '3.1', 'SDK fills string when caller did not');
  });

  test('caller adcp_version string also wins', () => {
    const { applyVersionEnvelope } = require('../../dist/lib/protocols/index.js');
    const merged = applyVersionEnvelope({ adcp_version: '99.0' }, { adcp_major_version: 3, adcp_version: '3.1' });
    assert.strictEqual(merged.adcp_version, '99.0');
    assert.strictEqual(merged.adcp_major_version, 3, 'envelope still fills the integer the caller did not set');
  });

  test('empty envelope (v2 servers) leaves args untouched', () => {
    const { applyVersionEnvelope } = require('../../dist/lib/protocols/index.js');
    const merged = applyVersionEnvelope({ brief: 'v2-call' }, {});
    assert.deepStrictEqual(merged, { brief: 'v2-call' });
  });
});

describe('AdCP 3.2 strict compact request envelopes', () => {
  const account = { brand: { domain: 'buyer.example' }, operator: 'buyer.example' };
  const idempotency_key = 'compact-envelope-test-0001';
  const compactRequests = {
    buy_products: {
      idempotency_key,
      account,
      feed_version: 'feed-1',
      purchases: [{ product_id: 'product-1', pricing_option_id: 'price-1' }],
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-09-02T00:00:00Z',
    },
    accept_proposal: {
      idempotency_key,
      account,
      proposal_id: 'proposal-1',
      proposal_terms_digest: `sha256:${'A'.repeat(43)}`,
    },
    control_media_buy: {
      idempotency_key,
      account,
      media_buy_id: 'media-buy-1',
      revision: 1,
      paused: true,
    },
  };

  test('A2A removes only the SDK-injected major from strict compact schemas', () => {
    const { prepareProtocolToolCall } = require('../../dist/lib/protocols/index.js');
    const agent = { id: 'strict-a2a', name: 'strict-a2a', agent_uri: 'https://seller.example/a2a', protocol: 'a2a' };

    for (const [toolName, request] of Object.entries(compactRequests)) {
      const prepared = prepareProtocolToolCall(agent, request, { toolName, adcpVersion: '3.2.0-beta.0' }).args;
      assert.strictEqual(prepared.adcp_version, '3.2-beta.0', `${toolName} keeps the release pin`);
      assert.strictEqual(
        Object.hasOwn(prepared, 'adcp_major_version'),
        false,
        `${toolName} omits the SDK-injected deprecated integer`
      );
    }
  });

  test('A2A preserves the SDK-injected major restored by the beta.1 compact schemas', () => {
    const { prepareProtocolToolCall } = require('../../dist/lib/protocols/index.js');
    const { validateRequest } = require('../../dist/lib/validation/schema-validator.js');
    const agent = { id: 'beta1-a2a', name: 'beta1-a2a', agent_uri: 'https://seller.example/a2a', protocol: 'a2a' };

    for (const [toolName, request] of Object.entries(compactRequests)) {
      const prepared = prepareProtocolToolCall(agent, request, { toolName, adcpVersion: '3.2.0-rc.1' }).args;
      assert.strictEqual(prepared.adcp_version, '3.2-rc.1', `${toolName} keeps the release pin`);
      assert.strictEqual(prepared.adcp_major_version, 3, `${toolName} keeps the SDK-injected major`);
      const validation = validateRequest(toolName, prepared, '3.2.0-rc.1');
      assert.strictEqual(validation.valid, true, `${toolName}: ${JSON.stringify(validation.issues)}`);
    }
  });

  test('A2A preserves an explicit caller major for version-negotiation probes', () => {
    const { prepareProtocolToolCall } = require('../../dist/lib/protocols/index.js');
    const agent = { id: 'probe-a2a', name: 'probe-a2a', agent_uri: 'https://seller.example/a2a', protocol: 'a2a' };

    for (const [toolName, request] of Object.entries(compactRequests)) {
      const prepared = prepareProtocolToolCall(
        agent,
        { ...request, adcp_major_version: 99 },
        { toolName, adcpVersion: '3.2.0-beta.0' }
      ).args;
      assert.strictEqual(prepared.adcp_major_version, 99, `${toolName} preserves the caller's probe value`);
    }
  });

  test('the compatibility exception does not remove the major from other 3.2 tools', () => {
    const { prepareProtocolToolCall } = require('../../dist/lib/protocols/index.js');
    const agent = { id: 'normal-a2a', name: 'normal-a2a', agent_uri: 'https://seller.example/a2a', protocol: 'a2a' };
    const prepared = prepareProtocolToolCall(
      agent,
      {},
      { toolName: 'list_products', adcpVersion: '3.2.0-beta.0' }
    ).args;

    assert.strictEqual(prepared.adcp_major_version, 3);
    assert.strictEqual(prepared.adcp_version, '3.2-beta.0');
  });
});

describe('ADCP_ENVELOPE_FIELDS — strip-path carve-outs', () => {
  test('adcp_version is preserved by SingleAgentClient strip path', () => {
    // Defends the same caller-override path against schema stripping by
    // strict MCP agents that publish per-tool input schemas. Mirrors the
    // existing adcp_major_version carve-out.
    const { ADCP_ENVELOPE_FIELDS } = require('../../dist/lib/types/adcp.js');
    assert.ok(ADCP_ENVELOPE_FIELDS.has('adcp_version'), 'adcp_version must be in ADCP_ENVELOPE_FIELDS');
    assert.ok(ADCP_ENVELOPE_FIELDS.has('adcp_major_version'), 'adcp_major_version must remain in ADCP_ENVELOPE_FIELDS');
  });
});
