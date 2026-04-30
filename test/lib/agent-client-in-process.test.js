/**
 * AgentClient.fromMCPClient — in-process transport integration tests.
 *
 * Verifies that the factory produces a fully functional AgentClient backed by an
 * InMemoryTransport session: idempotency key auto-injection, typed response shape,
 * error envelope propagation, and guards on HTTP-only methods.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

describe('AgentClient.fromMCPClient — in-process transport', () => {
  let McpServer, Client, InMemoryTransport, AgentClient, ProtocolClient, ADCP_MAJOR_VERSION, z;

  before(() => {
    ({ McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'));
    ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
    ({ InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js'));
    ({ AgentClient, ProtocolClient, ADCP_MAJOR_VERSION } = require('../../dist/lib/index.js'));
    z = require('zod');
  });

  /**
   * Build a minimal AdCP-compatible McpServer and return a connected [mcpClient, server] pair.
   * The server registers `get_products` (happy path) and `get_adcp_capabilities` (v3 header).
   */
  async function createInProcessPair(opts = {}) {
    const server = new McpServer({ name: 'In-process Test Agent', version: '1.0.0' });

    server.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        success: true,
        adcp: {
          major_versions: [3],
          idempotency: { replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        specialisms: [],
        ...(opts.extraCaps ?? {}),
      },
    }));

    server.registerTool(
      'get_products',
      { inputSchema: { brief: z.string().optional(), adcp_major_version: z.number().optional() } },
      async args => {
        if (opts.captureArgs) opts.captureArgs(args);
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: {
            success: true,
            products: [{ id: 'prod-1', name: 'Display', channels: ['display'] }],
          },
        };
      }
    );

    if (opts.registerError) {
      server.registerTool(
        'create_media_buy',
        {
          inputSchema: {
            brand: z.any(),
            idempotency_key: z.string().optional(),
            adcp_major_version: z.number().optional(),
          },
        },
        async args => {
          if (opts.captureArgs) opts.captureArgs(args);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: false, error: 'INVALID_PRODUCT', message: 'Product not found' }),
              },
            ],
            structuredContent: { success: false, error: 'INVALID_PRODUCT', message: 'Product not found' },
          };
        }
      );
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const mcpClient = new Client({ name: 'AdCP-Test', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    return { mcpClient, server };
  }

  it('happy path: getProducts returns typed TaskResult over in-process transport', async () => {
    const { mcpClient, server } = await createInProcessPair();

    const agent = AgentClient.fromMCPClient(mcpClient, {
      agentName: 'test-seller',
      validation: { requests: 'off', responses: 'off' },
      validateFeatures: false,
    });

    const result = await agent.getProducts({ brief: 'all' });

    assert.strictEqual(result.success, true, 'TaskResult.success should be true');
    assert.ok(result.data, 'TaskResult.data should be present');
    assert.ok(Array.isArray(result.data.products), 'products should be an array');
    assert.strictEqual(result.data.products[0].id, 'prod-1', 'product id should match');

    await mcpClient.close();
    await server.close();
  });

  it('adcp_major_version is injected into in-process tool calls', async () => {
    let captured;
    const { mcpClient, server } = await createInProcessPair({
      captureArgs: args => {
        captured = args;
      },
    });

    const agent = AgentClient.fromMCPClient(mcpClient, {
      validation: { requests: 'off', responses: 'off' },
      validateFeatures: false,
    });
    await agent.getProducts({ brief: 'test' });

    assert.ok(
      captured && typeof captured === 'object' && 'adcp_major_version' in captured,
      'adcp_major_version should be injected into in-process args'
    );
    assert.strictEqual(
      captured.adcp_major_version,
      ADCP_MAJOR_VERSION,
      `adcp_major_version should equal ADCP_MAJOR_VERSION (${ADCP_MAJOR_VERSION})`
    );

    await mcpClient.close();
    await server.close();
  });

  // Regression: #1072 — caller-supplied adcp_major_version must not be
  // overwritten by the SDK envelope (5.23→5.24 regression).
  it('caller-supplied adcp_major_version in args wins over SDK envelope (in-process path)', async () => {
    let captured;
    const { mcpClient, server } = await createInProcessPair({
      captureArgs: args => {
        captured = args;
      },
    });

    const agentConfig = {
      id: 'test',
      name: 'test',
      agent_uri: 'in-process',
      protocol: 'mcp',
      _inProcessMcpClient: mcpClient,
    };

    await ProtocolClient.callTool(agentConfig, 'get_products', { adcp_major_version: 99 });

    assert.strictEqual(
      captured?.adcp_major_version,
      99,
      'caller-supplied adcp_major_version: 99 must reach the server (SDK envelope must not overwrite)'
    );

    await mcpClient.close();
    await server.close();
  });

  it('idempotency_key is auto-injected for mutating calls', async () => {
    let captured;
    const { mcpClient, server } = await createInProcessPair({
      captureArgs: args => {
        captured = args;
      },
      registerError: true,
    });

    const agent = AgentClient.fromMCPClient(mcpClient, {
      validation: { requests: 'off', responses: 'off' },
      validateFeatures: false,
    });

    // createMediaBuy is a mutating call — SDK should auto-generate idempotency_key.
    // The fixture returns an error envelope (success=false), which the SDK must
    // surface as a non-success TaskResult — it should NOT throw. If it throws,
    // we'd be asserting against `captured` from a prior tool call, so let any
    // unexpected throw fail the test rather than swallowing it.
    const result = await agent.createMediaBuy({
      brand: { domain: 'test.example' },
      product_id: 'prod-1',
      line_items: [],
      start_time: '2026-06-01T00:00:00Z',
      end_time: '2026-06-30T23:59:59Z',
    });
    assert.strictEqual(result.success, false, 'error envelope should surface as non-success TaskResult');

    assert.ok(
      captured && typeof captured === 'object' && typeof captured.idempotency_key === 'string',
      'idempotency_key should be auto-injected for mutating calls'
    );
    assert.ok(captured.idempotency_key.length > 0, 'idempotency_key should be non-empty');

    await mcpClient.close();
    await server.close();
  });

  it('error envelope path: isError response propagates as TaskResult failure', async () => {
    const { mcpClient, server } = await createInProcessPair({ registerError: true });

    const agent = AgentClient.fromMCPClient(mcpClient, {
      validation: { requests: 'off', responses: 'off' },
      validateFeatures: false,
    });

    const result = await agent.createMediaBuy({
      brand: { domain: 'test.example' },
      product_id: 'prod-1',
      line_items: [],
      start_time: '2026-06-01T00:00:00Z',
      end_time: '2026-06-30T23:59:59Z',
    });

    // The SDK should surface the error envelope as a non-success TaskResult, not throw
    assert.strictEqual(result.success, false, 'TaskResult.success should be false for error envelopes');
    assert.ok(result.error || result.data?.error, 'error field should be present');

    await mcpClient.close();
    await server.close();
  });

  it('fromMCPClient factory — agentName and agentId are reflected on the instance', () => {
    // Synchronous factory — no server needed for this assertion.
    // Stub listTools so the fake is safe if getAgentInfo() is ever called on this instance.
    const fakeMcpClient = { callTool: async () => ({}), listTools: async () => ({ tools: [] }), transport: {} };
    const agent = AgentClient.fromMCPClient(fakeMcpClient, {
      agentName: 'my-in-process-agent',
      agentId: 'agent-42',
    });

    assert.strictEqual(agent.getAgentName(), 'my-in-process-agent');
    assert.strictEqual(agent.getAgentId(), 'agent-42');
    assert.strictEqual(agent.getProtocol(), 'mcp');
  });

  it('fromMCPClient factory — omitting agentId generates a sentinel id', () => {
    const fakeMcpClient = { callTool: async () => ({}), listTools: async () => ({ tools: [] }), transport: {} };
    const agent = AgentClient.fromMCPClient(fakeMcpClient);

    const id = agent.getAgentId();
    assert.ok(
      typeof id === 'string' && id.startsWith('in-process-'),
      `Expected id to start with "in-process-", got: ${id}`
    );
    assert.ok(id.length > 'in-process-'.length, 'Generated id should have a non-empty random suffix');
  });

  it('isSameAgentResolved — in-process agents compare by sentinel id, not URL', async () => {
    const fakeMcpClient = { callTool: async () => ({}), listTools: async () => ({ tools: [] }), transport: {} };
    const a = AgentClient.fromMCPClient(fakeMcpClient, { agentId: 'same-id' });
    const b = AgentClient.fromMCPClient(fakeMcpClient, { agentId: 'same-id' });
    const c = AgentClient.fromMCPClient(fakeMcpClient, { agentId: 'different-id' });

    assert.strictEqual(await a.isSameAgentResolved(b), true, 'Same id should match');
    assert.strictEqual(await a.isSameAgentResolved(c), false, 'Different id should not match');
  });

  describe('in-process guards — HTTP-only methods throw descriptively', () => {
    let agent;

    before(() => {
      const fakeMcpClient = { callTool: async () => ({}), listTools: async () => ({ tools: [] }), transport: {} };
      agent = AgentClient.fromMCPClient(fakeMcpClient, { agentName: 'guard-test' });
    });

    it('resolveCanonicalUrl throws InProcess guard error', async () => {
      await assert.rejects(
        () => agent.resolveCanonicalUrl(),
        err => {
          assert.ok(err.message.includes('in-process'), `Expected "in-process" in: ${err.message}`);
          return true;
        }
      );
    });

    it('getWebhookUrl throws InProcess guard error', () => {
      assert.throws(
        () => agent.getWebhookUrl('create_media_buy', 'op-1'),
        err => {
          assert.ok(err.message.includes('in-process'), `Expected "in-process" in: ${err.message}`);
          return true;
        }
      );
    });

    it('registerWebhook throws InProcess guard error', async () => {
      await assert.rejects(
        () => agent.registerWebhook('https://example.com/webhook'),
        err => {
          assert.ok(err.message.includes('in-process'), `Expected "in-process" in: ${err.message}`);
          return true;
        }
      );
    });

    it('unregisterWebhook throws InProcess guard error', async () => {
      await assert.rejects(
        () => agent.unregisterWebhook(),
        err => {
          assert.ok(err.message.includes('in-process'), `Expected "in-process" in: ${err.message}`);
          return true;
        }
      );
    });
  });
});
