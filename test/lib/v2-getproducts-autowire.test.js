// End-to-end test for AgentClient.getProducts() auto-wiring of the
// v1→v2 format_options projection. Proves the V2 mental-model
// experience works without the buyer calling withFormatOptions
// explicitly.
//
// Mocks the seller via an in-process MCP server, exercises both the
// default-projection and opt-out paths, and checks:
//   - format_options[] is populated on every product by default
//   - format_ids[] is preserved (additive)
//   - projection.diagnostics surfaces on result.data.projection
//   - { project: false } returns the raw wire shape

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const z = require('zod');

const { AgentClient } = require('../../dist/lib/index.js');
const { betaProjectionSkipReason } = require('./helpers/optional-3-1-beta.js');

/**
 * Build a mock seller that returns the supplied get_products response
 * verbatim. Returns `{ agent, close }` where `agent` is a connected
 * `AgentClient` wired to the mock.
 */
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

describe('AgentClient.getProducts — auto-wired v1→v2 projection', { skip: betaProjectionSkipReason() }, () => {
  test('v1 seller response gains format_options[] by default; format_ids preserved', async () => {
    const v1Response = {
      success: true,
      products: [
        {
          product_id: 'iab_mrec',
          name: 'IAB MREC',
          description: 'standard banner',
          format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
        },
      ],
    };
    const { agent, close } = await buildMockSeller(v1Response);
    try {
      const result = await agent.getProducts({ brief: 'test' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');

      const product = result.data.products[0];
      // Original format_ids preserved.
      assert.strictEqual(product.format_ids[0].id, 'display_300x250_image');
      // New format_options populated by projection.
      assert.strictEqual(product.format_options.length, 1);
      assert.strictEqual(product.format_options[0].format_kind, 'image');

      // Projection envelope present with empty diagnostics (clean match).
      assert.ok(result.data.projection, 'projection envelope must be present');
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
        },
      ],
    };
    const { agent, close } = await buildMockSeller(partial);
    try {
      const result = await agent.getProducts({ brief: 'test' });
      const product = result.data.products[0];
      assert.strictEqual(product.format_options.length, 0);
      assert.strictEqual(result.data.projection.diagnostics.length, 1);
      const d = result.data.projection.diagnostics[0];
      assert.strictEqual(d.source, 'sdk');
      assert.strictEqual(d.code, 'FORMAT_PROJECTION_FAILED');
      assert.ok(d.field.includes('mystery'));
    } finally {
      await close();
    }
  });

  test('{ project: false } opt-out returns the raw wire shape (no projection envelope)', async () => {
    const v1Response = {
      success: true,
      products: [
        {
          product_id: 'iab_mrec',
          name: 'IAB MREC',
          description: '',
          format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
        },
      ],
    };
    const { agent, close } = await buildMockSeller(v1Response);
    try {
      const result = await agent.getProducts({ brief: 'test' }, undefined, { project: false });
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
});
