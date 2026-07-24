// End-to-end test for AgentClient.getProducts() auto-wiring of the
// v1→v2 format_options projection. Proves the V2 mental-model
// experience works without the buyer calling withFormatOptions
// explicitly.
//
// Mocks the seller via an in-process MCP server, exercises both the
// default-projection and opt-out paths, and checks:
//   - format_options[] is populated on every product by default
//   - format_ids[] is removed from the primary SDK surface
//   - projection.diagnostics surfaces on result.data.projection
//   - getProductsLegacy() returns the raw wire shape

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const z = require('zod');

const { AgentClient, packageRefsForFormatOptions } = require('../../dist/lib/index.js');

/**
 * Build a mock seller that returns the supplied get_products response
 * verbatim. Returns `{ agent, close }` where `agent` is a connected
 * `AgentClient` wired to the mock.
 */
const PRICING_OPTIONS = [{ pricing_option_id: 'po_cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }];

async function buildMockSeller(getProductsResponse) {
  const server = new McpServer({ name: 'autowire-test', version: '1.0.0' });
  server.registerTool(
    'get_products',
    { inputSchema: { brief: z.string().optional(), adcp_major_version: z.number().optional() } },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(getProductsResponse) }],
      structuredContent: getProductsResponse,
    })
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
  await mcpClient.connect(clientTransport);
  const agent = AgentClient.fromMCPClient(mcpClient, { validation: { responses: 'off' } });
  return {
    agent,
    close: async () => {
      await mcpClient.close();
      await server.close();
    },
  };
}

describe('AgentClient.getProducts — auto-wired v1→v2 projection', () => {
  test('v1 seller response becomes canonical-only by default', async () => {
    const v1Response = {
      success: true,
      products: [
        {
          product_id: 'iab_mrec',
          name: 'IAB MREC',
          description: 'standard banner',
          format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
          pricing_options: PRICING_OPTIONS,
        },
      ],
    };
    const { agent, close } = await buildMockSeller(v1Response);
    try {
      const result = await agent.getProducts({ brief: 'test' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');

      const product = result.data.products[0];
      assert.strictEqual(product.format_ids, undefined);
      // New format_options populated by projection.
      assert.strictEqual(product.format_options.length, 1);
      assert.strictEqual(product.format_options[0].format_kind, 'image');
      assert.strictEqual(product.format_options[0].v1_format_ref, undefined);
      assert.doesNotMatch(JSON.stringify(result.data), /agent_url|format_id/);

      // Projection envelope present with empty diagnostics (clean match).
      assert.ok(result.data.projection, 'projection envelope must be present');
      assert.deepStrictEqual(result.data.projection.diagnostics, []);
    } finally {
      await close();
    }
  });

  test('preserves legacy format-agnostic products represented by format_ids:[]', async () => {
    const response = {
      success: true,
      products: [
        {
          product_id: 'format-agnostic',
          name: 'Format agnostic',
          description: 'No creative format is required',
          format_ids: [],
          pricing_options: PRICING_OPTIONS,
        },
      ],
    };
    const { agent, close } = await buildMockSeller(response);
    try {
      const result = await agent.getProducts({ brief: 'test' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.products.length, 1);
      assert.strictEqual(result.data.products[0].product_id, 'format-agnostic');
      assert.deepStrictEqual(result.data.products[0].format_options, []);
      assert.strictEqual(result.data.products[0].format_ids, undefined);
      assert.deepStrictEqual(result.data.projection.diagnostics, []);
    } finally {
      await close();
    }
  });

  test('v2-native seller response passes through (idempotent)', async () => {
    const v2Response = {
      success: true,
      products: [
        {
          product_id: 'native_v2',
          name: 'native',
          description: 'v2-native',
          format_ids: [],
          pricing_options: PRICING_OPTIONS,
          format_options: [
            {
              format_kind: 'video_hosted',
              params: { duration_ms_exact: 30000 },
              v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'video_standard_30s' }],
            },
          ],
        },
      ],
    };
    const { agent, close } = await buildMockSeller(v2Response);
    try {
      const result = await agent.getProducts({ brief: 'test' });
      const product = result.data.products[0];
      // format_options is what the seller sent — unchanged.
      assert.strictEqual(product.format_options[0].format_kind, 'video_hosted');
      assert.strictEqual(product.format_options[0].v1_format_ref, undefined);
      assert.deepStrictEqual(result.data.projection.diagnostics, []);
    } finally {
      await close();
    }
  });

  test('projection diagnostics surface when a format_id has no v2 mapping', async () => {
    const partial = {
      success: true,
      products: [
        {
          product_id: 'mystery',
          name: 'm',
          description: 'd',
          format_ids: [{ agent_url: 'https://obscure.example/', id: 'unknown_format_xyz' }],
          pricing_options: PRICING_OPTIONS,
        },
      ],
    };
    const { agent, close } = await buildMockSeller(partial);
    try {
      const result = await agent.getProducts({ brief: 'test' });
      assert.deepStrictEqual(result.data.products, []);
      assert.strictEqual(result.data.projection.diagnostics.length, 1);
      const d = result.data.projection.diagnostics[0];
      assert.strictEqual(d.source, 'sdk');
      assert.strictEqual(d.code, 'FORMAT_PROJECTION_FAILED');
      assert.ok(d.field.includes('mystery'));
    } finally {
      await close();
    }
  });

  test('getProductsLegacy() returns the raw wire shape (no projection envelope)', async () => {
    const v1Response = {
      success: true,
      products: [
        {
          product_id: 'iab_mrec',
          name: 'IAB MREC',
          description: '',
          format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
          pricing_options: PRICING_OPTIONS,
        },
      ],
    };
    const { agent, close } = await buildMockSeller(v1Response);
    try {
      const result = await agent.getProductsLegacy({ brief: 'test' });
      assert.strictEqual(result.success, true);
      // format_ids preserved; no format_options added.
      assert.strictEqual(result.data.products[0].format_ids[0].id, 'display_300x250_image');
      assert.strictEqual(result.data.products[0].format_options, undefined);
      // No projection envelope.
      assert.strictEqual(result.data.projection, undefined);
    } finally {
      await close();
    }
  });

  test('official MCP transport downgrades canonical package and creative selectors for a legacy seller', async () => {
    let capturedCreate;
    let capturedUpdate;
    let capturedSync;
    const activities = [];
    const server = new McpServer({ name: 'legacy-mcp', version: '1.0.0' });
    server.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        adcp: { major_versions: [3] },
        supported_protocols: ['media_buy'],
        media_buy: { features: { canonical_creatives: false } },
      },
    }));
    server.registerTool('get_products', { inputSchema: { brief: z.string().optional() } }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        products: [
          {
            product_id: 'legacy-mcp-product',
            name: 'Legacy MCP Product',
            description: 'Legacy named-format fixture',
            format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
            pricing_options: PRICING_OPTIONS,
          },
        ],
      },
    }));
    server.registerTool('create_media_buy', { inputSchema: { packages: z.array(z.any()).optional() } }, async args => {
      capturedCreate = args;
      return {
        content: [{ type: 'text', text: '{}' }],
        structuredContent: { media_buy_id: 'mb-legacy-mcp', status: 'pending_creatives', packages: [] },
      };
    });
    server.registerTool(
      'update_media_buy',
      { inputSchema: { media_buy_id: z.string(), packages: z.array(z.any()).optional() } },
      async args => {
        capturedUpdate = args;
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: { media_buy_id: args.media_buy_id, status: 'pending_creatives', packages: [] },
        };
      }
    );
    server.registerTool(
      'sync_creatives',
      {
        inputSchema: {
          creatives: z.array(z.any()),
          assignments: z.array(z.any()).optional(),
        },
      },
      async args => {
        capturedSync = args;
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: { creatives: [] },
        };
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'legacy-mcp-client', version: '1.0.0' });
    await mcp.connect(clientTransport);
    const agent = AgentClient.fromMCPClient(mcp, {
      agentName: 'Legacy MCP',
      validation: { responses: 'off' },
      onActivity: activity => activities.push(activity),
    });

    try {
      const products = await agent.getProducts({ buying_mode: 'brief', brief: 'Display' });
      const product = products.data.products[0];
      const selectedFormats = packageRefsForFormatOptions(product, [product.format_options[0].format_option_id]);
      const creative = { creative_id: 'creative-mcp', name: 'Canonical image', format_kind: 'image', assets: {} };
      const result = await agent.createMediaBuy({
        account: { account_id: 'acct-mcp' },
        brand: { domain: 'buyer.example' },
        start_time: 'asap',
        end_time: '2027-12-31T00:00:00Z',
        packages: [
          {
            buyer_ref: 'pkg-mcp',
            product_id: product.product_id,
            pricing_option_id: 'po_cpm',
            budget: 1000,
            ...selectedFormats,
            creatives: [creative],
          },
        ],
      });
      const updated = await agent.updateMediaBuy({
        media_buy_id: 'mb-legacy-mcp',
        packages: [{ package_id: 'pkg-mcp', ...selectedFormats, creatives: [creative] }],
      });
      const synced = await agent.syncCreatives(
        {
          account: { account_id: 'acct-mcp' },
          creatives: [creative],
          assignments: [{ creative_id: creative.creative_id, package_id: 'pkg-mcp' }],
        },
        undefined,
        {
          creativeFormatProjection: {
            selectorContainers: [{ package_id: 'pkg-mcp', ...selectedFormats }],
          },
        }
      );
      assert.strictEqual(result.success, true);
      assert.strictEqual(updated.success, true);
      assert.strictEqual(synced.success, true);
      assert.strictEqual(capturedCreate.packages[0].format_option_refs, undefined);
      assert.strictEqual(capturedCreate.packages[0].format_ids[0].id, 'display_300x250_image');
      assert.strictEqual(capturedCreate.packages[0].creatives[0].format_kind, undefined);
      assert.strictEqual(capturedCreate.packages[0].creatives[0].format_id.id, 'display_300x250_image');
      assert.strictEqual(capturedUpdate.packages[0].format_option_refs, undefined);
      assert.strictEqual(capturedUpdate.packages[0].format_ids[0].id, 'display_300x250_image');
      assert.strictEqual(capturedUpdate.packages[0].creatives[0].format_kind, undefined);
      assert.strictEqual(capturedUpdate.packages[0].creatives[0].format_id.id, 'display_300x250_image');
      assert.strictEqual(capturedSync.creatives[0].format_kind, undefined);
      assert.strictEqual(capturedSync.creatives[0].format_id.id, 'display_300x250_image');

      const creativeActivityJson = JSON.stringify(
        activities.filter(activity =>
          ['get_products', 'create_media_buy', 'update_media_buy', 'sync_creatives'].includes(activity.task_type)
        )
      );
      assert.doesNotMatch(creativeActivityJson, /"(?:format_id|format_ids|v1_format_ref|agent_url|_message)"\s*:/);
    } finally {
      await mcp.close();
      await server.close();
    }
  });

  test('canonical list_creatives removes legacy transport messages for sync and webhook completions', async () => {
    const listedCreative = {
      creative_id: 'listed-legacy',
      name: 'Listed legacy',
      format_id: { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' },
      status: 'approved',
      created_date: '2026-01-01T00:00:00.000Z',
      updated_date: '2026-01-01T00:00:00.000Z',
      assets: {},
    };
    const listResponse = {
      _message: 'legacy transport message',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [listedCreative],
    };
    const handlerCalls = [];
    const server = new McpServer({ name: 'legacy-list-mcp', version: '1.0.0' });
    server.registerTool('list_creatives', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: listResponse,
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'legacy-list-client', version: '1.0.0' });
    await mcp.connect(clientTransport);
    const agent = AgentClient.fromMCPClient(mcp, {
      validation: { responses: 'off' },
      handlers: { onListCreativesStatusChange: response => handlerCalls.push(response) },
    });

    try {
      const result = await agent.listCreatives({});
      assert.strictEqual(result.data._message, undefined);
      assert.strictEqual(handlerCalls[0]._message, undefined);
      assert.strictEqual(result.data.creatives[0].format_kind, 'image');
      assert.doesNotMatch(JSON.stringify(result.data), /"(?:format_id|agent_url|_message)"\s*:/);

      const handled = await agent.handleWebhook(
        {
          idempotency_key: 'legacy-list-event',
          operation_id: 'legacy-list-operation',
          task_id: 'legacy-list-task',
          task_type: 'list_creatives',
          status: 'completed',
          timestamp: '2026-07-24T12:00:00.000Z',
          result: listResponse,
        },
        'list_creatives',
        'legacy-list-operation'
      );
      assert.strictEqual(handled, true);
      assert.strictEqual(handlerCalls[1]._message, undefined);
      assert.strictEqual(handlerCalls[1].creatives[0].format_kind, 'image');
      assert.doesNotMatch(JSON.stringify(handlerCalls[1]), /"(?:format_id|agent_url|_message)"\s*:/);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});
