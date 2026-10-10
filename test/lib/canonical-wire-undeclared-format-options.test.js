// A seller on the canonical creative wire may still return 3.x products that
// carry only legacy `format_ids`. The SDK upgrades those products for the
// buyer and mints format_option_ids the seller never declared. Those ids are
// buyer-local handles: `format_option_refs` must match one of the seller's own
// `format_options[]` entries, so a canonical write has to address an
// undeclared option by `format_kind` + `params` instead.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const z = require('zod');

const { AgentClient, packageRefsForFormatOptions } = require('../../dist/lib/index.js');

const AAO = 'https://creative.adcontextprotocol.org/';
const PRICING_OPTIONS = [{ pricing_option_id: 'po_cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }];
const ACCOUNT = { account_id: 'acct-canonical' };

async function canonicalSeller(products) {
  const captured = {};
  const server = new McpServer({ name: 'canonical-seller', version: '1.0.0' });
  server.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => {
    const capabilities = {
      adcp: { major_versions: [3], supported_versions: ['3.2.1'] },
      supported_protocols: ['media_buy'],
      media_buy: { features: { canonical_creatives: true } },
    };
    return { content: [{ type: 'text', text: '{}' }], structuredContent: capabilities };
  });
  server.registerTool('get_products', { inputSchema: { brief: z.string().optional() } }, async () => ({
    content: [{ type: 'text', text: '{}' }],
    structuredContent: { products },
  }));
  server.registerTool('create_media_buy', { inputSchema: { packages: z.array(z.any()).optional() } }, async args => {
    captured.create = args;
    return {
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { media_buy_id: 'mb-canonical', status: 'pending_creatives', packages: [] },
    };
  });
  server.registerTool(
    'update_media_buy',
    { inputSchema: { media_buy_id: z.string(), new_packages: z.array(z.any()).optional() } },
    async args => {
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
      captured.sync = args;
      return { content: [{ type: 'text', text: '{}' }], structuredContent: { creatives: [] } };
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'canonical-buyer', version: '1.0.0' });
  await mcp.connect(clientTransport);
  const agent = AgentClient.fromMCPClient(mcp, { validation: { responses: 'off' } });
  return {
    agent,
    captured,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

function legacyOnlyProduct(productId, formatIds) {
  return {
    product_id: productId,
    name: productId,
    description: 'Legacy-shaped 3.x product on a canonical seller',
    format_ids: formatIds,
    pricing_options: PRICING_OPTIONS,
  };
}

function mediaBuy(pkg) {
  return {
    account: ACCOUNT,
    brand: { domain: 'buyer.example' },
    start_time: 'asap',
    end_time: '2027-12-31T00:00:00Z',
    packages: [{ buyer_ref: 'pkg-1', pricing_option_id: 'po_cpm', budget: 1000, ...pkg }],
  };
}

describe('canonical wire: format options the seller did not declare', () => {
  test('create and update address an undeclared option by format_kind + params', async () => {
    const seller = await canonicalSeller([
      legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }]),
    ]);
    try {
      const products = await seller.agent.getProducts({ buying_mode: 'brief', brief: 'Display', account: ACCOUNT });
      const product = products.data.products[0];
      const option = product.format_options[0];
      // Persisted products lose SDK-private metadata; the client still knows
      // this option is undeclared from discovery.
      const persisted = JSON.parse(JSON.stringify(product));
      const selected = packageRefsForFormatOptions(persisted, [option.format_option_id]);
      const creative = {
        creative_id: 'creative-1',
        name: 'Canonical image',
        format_kind: 'image',
        format_option_ref: selected.format_option_refs[0],
        assets: {},
      };

      const created = await seller.agent.createMediaBuy(
        mediaBuy({ product_id: product.product_id, ...selected, creatives: [creative] })
      );
      const updated = await seller.agent.updateMediaBuy({
        account: ACCOUNT,
        media_buy_id: 'mb-canonical',
        new_packages: [
          {
            buyer_ref: 'pkg-2',
            product_id: product.product_id,
            pricing_option_id: 'po_cpm',
            budget: 500,
            ...selected,
          },
        ],
      });

      assert.strictEqual(created.success, true);
      assert.strictEqual(updated.success, true);
      for (const pkg of [seller.captured.create.packages[0], seller.captured.update.new_packages[0]]) {
        assert.strictEqual(pkg.format_option_refs, undefined);
        assert.strictEqual(pkg.format_kind, option.format_kind);
        assert.deepStrictEqual(pkg.params, option.params);
        assert.strictEqual(pkg.format_ids, undefined);
      }
      const wireCreative = seller.captured.create.packages[0].creatives[0];
      assert.strictEqual(wireCreative.format_kind, 'image');
      assert.strictEqual(wireCreative.format_option_ref, undefined);
    } finally {
      await seller.close();
    }
  });

  test('sync_creatives drops a pin to an undeclared option', async () => {
    const seller = await canonicalSeller([
      legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }]),
    ]);
    try {
      const products = await seller.agent.getProducts({ buying_mode: 'brief', brief: 'Display', account: ACCOUNT });
      const product = products.data.products[0];
      const selected = packageRefsForFormatOptions(product, [product.format_options[0].format_option_id]);

      const synced = await seller.agent.syncCreatives(
        {
          account: ACCOUNT,
          creatives: [
            {
              creative_id: 'creative-1',
              name: 'Canonical image',
              format_kind: 'image',
              format_option_ref: selected.format_option_refs[0],
              assets: {},
            },
          ],
          assignments: [{ creative_id: 'creative-1', package_id: 'pkg-1' }],
        },
        undefined,
        {
          creativeFormatProjection: {
            selectorContainers: [{ package_id: 'pkg-1', product_id: product.product_id, ...selected }],
          },
        }
      );

      assert.strictEqual(synced.success, true);
      assert.strictEqual(seller.captured.sync.creatives[0].format_kind, 'image');
      assert.strictEqual(seller.captured.sync.creatives[0].format_option_ref, undefined);
    } finally {
      await seller.close();
    }
  });

  test('refuses before dispatch when one direct selector cannot express the undeclared options', async () => {
    const seller = await canonicalSeller([
      legacyOnlyProduct('legacy-shaped', [
        { agent_url: AAO, id: 'display_300x250_image' },
        { agent_url: AAO, id: 'display_728x90_image' },
      ]),
    ]);
    try {
      const products = await seller.agent.getProducts({ buying_mode: 'brief', brief: 'Display', account: ACCOUNT });
      const product = products.data.products[0];
      assert.strictEqual(product.format_options.length, 2);
      const selected = packageRefsForFormatOptions(
        product,
        product.format_options.map(option => option.format_option_id)
      );

      await assert.rejects(
        seller.agent.createMediaBuy(mediaBuy({ product_id: product.product_id, ...selected })),
        error => {
          assert.strictEqual(error.code, 'ADCP_CREATIVE_FORMAT_PROJECTION_FAILED');
          assert.match(error.message, /did not declare/);
          return true;
        }
      );
      assert.strictEqual(seller.captured.create, undefined);
    } finally {
      await seller.close();
    }
  });

  test('keeps format_option_refs for options the seller declared, including SDK-minted ids', async () => {
    const declaredId = `migrated_${'a'.repeat(32)}`;
    const seller = await canonicalSeller([
      {
        product_id: 'canonical-product',
        name: 'Canonical product',
        description: 'Seller-declared canonical options',
        format_options: [{ format_option_id: declaredId, format_kind: 'image', params: { width: 300, height: 250 } }],
        pricing_options: PRICING_OPTIONS,
      },
    ]);
    try {
      const products = await seller.agent.getProducts({ buying_mode: 'brief', brief: 'Display', account: ACCOUNT });
      const product = products.data.products[0];
      const selected = packageRefsForFormatOptions(product, [declaredId]);

      const created = await seller.agent.createMediaBuy(mediaBuy({ product_id: product.product_id, ...selected }));

      assert.strictEqual(created.success, true);
      const pkg = seller.captured.create.packages[0];
      assert.deepStrictEqual(pkg.format_option_refs, [{ scope: 'product', format_option_id: declaredId }]);
      assert.strictEqual(pkg.format_kind, undefined);
    } finally {
      await seller.close();
    }
  });
});
