// End-to-end test for AgentClient.getProducts() auto-wiring of the
// v1→v2 format_options projection. Proves the V2 mental-model
// experience works without the buyer calling withFormatOptions
// explicitly.
//
// Mocks the seller via an in-process MCP server, exercises both the
// default-projection and opt-out paths, and checks:
//   - every returned product has at least one canonical format_options entry
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

async function buildMockSeller(getProductsResponse, clientConfig = {}) {
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
  const agent = AgentClient.fromMCPClient(mcpClient, {
    validation: { responses: 'off' },
    ...clientConfig,
  });
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

  test('Optimera legacy AAO discovery becomes canonical through getProducts', async () => {
    const optimeraResponse = {
      success: true,
      products: [
        {
          product_id: 'optimera_display',
          name: 'Optimera display',
          description: 'Legacy generic display image format',
          format_ids: [
            { agent_url: 'https://adcontextprotocol.org', id: 'display_image' },
            { agent_url: 'https://creative.adcontextprotocol.org', id: 'display_320x50_html' },
          ],
          pricing_options: PRICING_OPTIONS,
        },
      ],
    };
    const { agent, close } = await buildMockSeller(optimeraResponse);
    try {
      const result = await agent.getProducts({ brief: 'display inventory' });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data.products.length, 1);
      assert.strictEqual(result.data.products[0].product_id, 'optimera_display');
      assert.strictEqual(result.data.products[0].format_options.length, 2);
      assert.strictEqual(result.data.products[0].format_options[0].format_kind, 'image');
      assert.strictEqual(result.data.products[0].format_options[1].format_kind, 'html5');
      assert.strictEqual(result.data.products[0].format_options[1].params.width, 320);
      assert.strictEqual(result.data.products[0].format_options[1].params.height, 50);
      assert.strictEqual(result.data.products[0].format_ids, undefined);
      assert.deepStrictEqual(result.data.projection.diagnostics, []);
      assert.doesNotMatch(JSON.stringify(result.data), /agent_url|format_id|resolution_failure/);
    } finally {
      await close();
    }
  });

  test('Vox AAO standard ids under the seller host become canonical through getProducts', async () => {
    const voxRef = {
      agent_url: 'https://salesagent.voxmedia.com/mcp',
      id: 'display_300x250_image',
    };
    const { agent, close } = await buildMockSeller({
      success: true,
      products: [
        {
          product_id: 'vox-mrec',
          name: 'Vox MREC',
          description: 'AAO standard ID emitted under the Vox seller host',
          format_ids: [voxRef],
          pricing_options: PRICING_OPTIONS,
        },
      ],
    });
    try {
      const result = await agent.getProducts({ brief: 'Vox display inventory' });
      const option = result.data.products[0].format_options[0];

      assert.strictEqual(option.format_kind, 'image');
      assert.strictEqual(option.params.width, 300);
      assert.strictEqual(option.params.height, 250);
      assert.deepStrictEqual(result.data.projection.diagnostics, []);
      assert.doesNotMatch(JSON.stringify(result.data), /salesagent\.voxmedia\.com|agent_url|format_id/);
    } finally {
      await close();
    }
  });

  test('configured publisher catalog snapshot upgrades an exact legacy alias without exposing it', async () => {
    const legacyRef = {
      agent_url: 'https://formats.publisher.example',
      id: 'homepage_image',
      width: 1200,
      height: 628,
    };
    const response = {
      success: true,
      products: [
        {
          product_id: 'publisher-homepage',
          name: 'Publisher homepage',
          description: 'Seller-owned canonical subclass',
          format_ids: [legacyRef],
          pricing_options: PRICING_OPTIONS,
        },
      ],
    };
    const projectionCatalogs = [
      {
        source: 'aao_mirror',
        publisher_domain: 'publisher.example',
        formats: [
          {
            format_kind: 'image',
            format_option_id: 'homepage_image',
            params: { width: 1200, height: 628 },
            v1_format_ref: [legacyRef],
          },
        ],
      },
    ];
    const { agent, close } = await buildMockSeller(response, { projectionCatalogs });
    try {
      const result = await agent.getProducts({ brief: 'publisher inventory' });
      assert.strictEqual(result.data.products.length, 1);
      const option = result.data.products[0].format_options[0];
      assert.strictEqual(option.format_kind, 'image');
      assert.strictEqual(option.publisher_domain, 'publisher.example');
      assert.strictEqual(option.format_option_id, 'homepage_image');
      assert.deepStrictEqual(result.data.projection.diagnostics, []);
      assert.doesNotMatch(JSON.stringify(result.data), /formats\.publisher\.example|agent_url|v1_format_ref/);
    } finally {
      await close();
    }
  });

  test('omits valid format-agnostic legacy products with an honest portable error', async () => {
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
      assert.deepStrictEqual(result.data.products, []);
      assert.strictEqual(result.data.projection.diagnostics.length, 1);
      assert.strictEqual(result.data.errors.length, 1);
      assert.strictEqual(result.data.errors[0].code, 'CANONICAL_PRODUCT_FORMATS_UNAVAILABLE');
      assert.strictEqual(result.data.errors[0].details.product_id, 'format-agnostic');
      assert.strictEqual(result.data.errors[0].details.reason, 'legacy_format_list_empty');
      assert.strictEqual(result.data.errors[0].error, undefined);
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

  test('wholly unmappable products are omitted and surface portable projection errors', async () => {
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
      assert.strictEqual(d.field, 'products');
      assert.strictEqual(result.data.errors.length, 1);
      assert.strictEqual(result.data.errors[0].code, 'FORMAT_PROJECTION_FAILED');
      assert.strictEqual(result.data.errors[0].source, 'sdk');
      assert.strictEqual(result.data.errors[0].details.product_id, 'mystery');
      assert.doesNotMatch(JSON.stringify(result.data.errors), /obscure\.example|unknown_format_xyz|agent_url/);
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

  test('Vox bare-id discovery round-trips its exact seller tuple through every legacy write', async () => {
    let capturedCreate;
    let capturedUpdate;
    let capturedSync;
    const activities = [];
    const voxRef = {
      agent_url: 'https://salesagent.voxmedia.com/mcp',
      id: 'display_300x250_image',
    };
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
            description: 'AAO standard ID emitted under the Vox seller host',
            format_ids: [voxRef],
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
      const products = await agent.getProducts({
        buying_mode: 'brief',
        brief: 'Display',
        account: { account_id: 'acct-mcp' },
      });
      const product = products.data.products[0];
      const selectedFormats = packageRefsForFormatOptions(product, [product.format_options[0].format_option_id]);
      const persistedProduct = JSON.parse(JSON.stringify(product));
      const persistedSelectedFormats = packageRefsForFormatOptions(persistedProduct, [
        persistedProduct.format_options[0].format_option_id,
      ]);
      const creative = {
        creative_id: 'creative-mcp',
        name: 'Canonical Vox image creative',
        format_kind: 'image',
        format_option_ref: persistedSelectedFormats.format_option_refs[0],
        assets: {},
      };
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
            ...persistedSelectedFormats,
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
      assert.deepStrictEqual(capturedCreate.packages[0].format_ids[0], voxRef);
      assert.strictEqual(capturedCreate.packages[0].creatives[0].format_kind, undefined);
      assert.deepStrictEqual(capturedCreate.packages[0].creatives[0].format_id, voxRef);
      assert.strictEqual(capturedUpdate.packages[0].format_option_refs, undefined);
      assert.deepStrictEqual(capturedUpdate.packages[0].format_ids[0], voxRef);
      assert.strictEqual(capturedUpdate.packages[0].creatives[0].format_kind, undefined);
      assert.deepStrictEqual(capturedUpdate.packages[0].creatives[0].format_id, voxRef);
      assert.strictEqual(capturedSync.creatives[0].format_kind, undefined);
      assert.deepStrictEqual(capturedSync.creatives[0].format_id, voxRef);

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

  test('official MCP transport applies the configured converter to every legacy write escape hatch', async () => {
    const captured = {};
    const calls = { create: 0, update: 0, sync: 0 };
    const server = new McpServer({ name: 'canonical-mcp', version: '1.0.0' });
    server.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        adcp: { major_versions: [3] },
        supported_protocols: ['media_buy'],
        media_buy: { features: { canonical_creatives: true } },
      },
    }));
    server.registerTool('create_media_buy', { inputSchema: { packages: z.array(z.any()) } }, async args => {
      calls.create++;
      captured.create = args;
      return {
        content: [{ type: 'text', text: '{}' }],
        structuredContent: { media_buy_id: 'mb-canonical-mcp', status: 'pending_creatives', packages: [] },
      };
    });
    server.registerTool(
      'update_media_buy',
      { inputSchema: { media_buy_id: z.string(), packages: z.array(z.any()).optional() } },
      async args => {
        calls.update++;
        captured.update = args;
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: { media_buy_id: args.media_buy_id, status: 'pending_creatives', packages: [] },
        };
      }
    );
    server.registerTool(
      'sync_creatives',
      { inputSchema: { creatives: z.array(z.any()), assignments: z.array(z.any()).optional() } },
      async args => {
        calls.sync++;
        captured.sync = args;
        return {
          content: [{ type: 'text', text: '{}' }],
          structuredContent: { creatives: [] },
        };
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'canonical-mcp-client', version: '1.0.0' });
    await mcp.connect(clientTransport);
    const converter = ({ formatId }) =>
      formatId.agent_url === 'https://seller.example/formats' && formatId.id === 'homepage_takeover'
        ? {
            format_kind: 'custom',
            format_option_id: 'homepage-takeover',
            format_shape: 'homepage_takeover',
            format_schema: {
              uri: 'https://seller.example/schemas/homepage-takeover.json',
              digest: `sha256:${'b'.repeat(64)}`,
            },
            params: {},
          }
        : undefined;
    const agent = AgentClient.fromMCPClient(mcp, {
      agentName: 'Canonical MCP',
      validation: { responses: 'off' },
      legacyFormatConverter: converter,
    });
    const legacyRef = { agent_url: 'https://seller.example/formats', id: 'homepage_takeover' };
    const legacyCreative = {
      creative_id: 'legacy-custom',
      name: 'Legacy custom',
      format_id: legacyRef,
      assets: {},
    };

    try {
      await agent.createMediaBuyLegacy({
        account: { account_id: 'acct-canonical' },
        brand: { domain: 'buyer.example' },
        start_time: 'asap',
        end_time: '2027-12-31T00:00:00Z',
        packages: [
          {
            buyer_ref: 'pkg-custom',
            product_id: 'custom-product',
            pricing_option_id: 'po_cpm',
            budget: 1000,
            format_ids: [legacyRef],
            creatives: [legacyCreative],
          },
        ],
      });
      await agent.updateMediaBuyLegacy({
        media_buy_id: 'mb-canonical-mcp',
        packages: [{ package_id: 'pkg-custom', format_ids: [legacyRef], creatives: [legacyCreative] }],
      });
      await agent.syncCreativesLegacy({
        account: { account_id: 'acct-canonical' },
        creatives: [legacyCreative],
        assignments: [{ creative_id: legacyCreative.creative_id, package_id: 'pkg-custom' }],
      });

      for (const params of [captured.create, captured.update]) {
        assert.strictEqual(params.packages[0].format_ids, undefined);
        assert.strictEqual(params.packages[0].format_option_refs[0].format_option_id, 'homepage-takeover');
        assert.strictEqual(params.packages[0].creatives[0].format_id, undefined);
        assert.strictEqual(params.packages[0].creatives[0].format_kind, 'custom');
      }
      assert.strictEqual(captured.sync.creatives[0].format_id, undefined);
      assert.strictEqual(captured.sync.creatives[0].format_kind, 'custom');
      assert.deepStrictEqual(calls, { create: 1, update: 1, sync: 1 });

      const invalidAgent = AgentClient.fromMCPClient(mcp, {
        agentName: 'Invalid converter MCP',
        validation: { responses: 'off' },
        legacyFormatConverter: () => {
          throw new Error('converter must fail before dispatch');
        },
      });
      await assert.rejects(() =>
        invalidAgent.createMediaBuyLegacy({
          account: { account_id: 'acct-canonical' },
          brand: { domain: 'buyer.example' },
          start_time: 'asap',
          end_time: '2027-12-31T00:00:00Z',
          packages: [
            {
              product_id: 'custom-product',
              pricing_option_id: 'po_cpm',
              budget: 1000,
              format_ids: [legacyRef],
              creatives: [legacyCreative],
            },
          ],
        })
      );
      assert.strictEqual(calls.create, 1, 'invalid configured conversion must not dispatch create_media_buy');
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
