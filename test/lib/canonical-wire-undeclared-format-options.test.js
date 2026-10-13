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

const {
  AgentClient,
  canonicalFormatLegacyResolverFromRoutes,
  createProductCache,
  legacyRoutesForProduct,
  packageRefsForFormatOptions,
} = require('../../dist/lib/index.js');

const AAO = 'https://creative.adcontextprotocol.org/';
const PRICING_OPTIONS = [{ pricing_option_id: 'po_cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }];
const ACCOUNT = { account_id: 'acct-canonical' };

async function canonicalSeller(products, config = {}, { cacheScope, conditional = false, version = '3.2.1' } = {}) {
  const captured = { productReads: [] };
  const server = new McpServer({ name: 'canonical-seller', version: '1.0.0' });
  server.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => {
    const capabilities = {
      adcp: { major_versions: [3], supported_versions: [version] },
      supported_protocols: ['media_buy'],
      media_buy: { features: { canonical_creatives: !version.startsWith('3.0') } },
    };
    return { content: [{ type: 'text', text: '{}' }], structuredContent: capabilities };
  });
  server.registerTool(
    'get_products',
    {
      inputSchema: {
        brief: z.string().optional(),
        if_wholesale_feed_version: z.string().optional(),
        if_pricing_version: z.string().optional(),
      },
    },
    async args => {
      captured.productReads.push(args);
      return {
        content: [{ type: 'text', text: '{}' }],
        structuredContent: {
          ...(conditional && args.if_wholesale_feed_version === 'feed-1' ? { unchanged: true } : { products }),
          ...(cacheScope && { cache_scope: cacheScope, wholesale_feed_version: 'feed-1', pricing_version: 'price-1' }),
        },
      };
    }
  );
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
  const agent = AgentClient.fromMCPClient(mcp, { validation: { responses: 'off' }, ...config });
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
  test("legacy wire still downgrades selected options to the seller's format_ids", async () => {
    const formatId = { agent_url: AAO, id: 'display_300x250_image' };
    const seller = await canonicalSeller([legacyOnlyProduct('legacy-shaped', [formatId])], {}, { version: '3.0.25' });
    try {
      const products = await seller.agent.getProducts({ buying_mode: 'brief', brief: 'Display', account: ACCOUNT });
      const product = products.data.products[0];
      const selected = packageRefsForFormatOptions(product, [product.format_options[0].format_option_id]);
      await seller.agent.createMediaBuy(mediaBuy({ product_id: product.product_id, ...selected }));
      const pkg = seller.captured.create.packages[0];
      assert.deepStrictEqual(pkg.format_ids, [formatId]);
      assert.strictEqual(pkg.format_option_refs, undefined);
      assert.strictEqual(pkg.format_kind, undefined);
    } finally {
      await seller.close();
    }
  });

  for (const cacheScope of [undefined, 'account']) {
    test(`preserves seller origin with a product cache (${cacheScope ?? 'uncacheable response'})`, async () => {
      const seller = await canonicalSeller(
        [legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }])],
        { productCache: createProductCache() },
        { cacheScope }
      );
      try {
        const request = { buying_mode: 'brief', brief: 'Display', account: ACCOUNT };
        const first = await seller.agent.getProducts(request);
        const product = first.data.products[0];
        const selected = packageRefsForFormatOptions(product, [product.format_options[0].format_option_id]);
        await seller.agent.createMediaBuy(mediaBuy({ product_id: product.product_id, ...selected }));
        assert.strictEqual(seller.captured.create.packages[0].format_option_refs, undefined);
        assert.strictEqual(seller.captured.create.packages[0].format_kind, product.format_options[0].format_kind);

        // Cache hits restore discovery routes from cloned canonical products,
        // including the original seller evidence held outside the wire data.
        const cached = await seller.agent.getProducts(request);
        assert.strictEqual(seller.captured.productReads.length, cacheScope ? 1 : 2);
        const cachedProduct = cached.data.products[0];
        const cachedSelected = packageRefsForFormatOptions(cachedProduct, [
          cachedProduct.format_options[0].format_option_id,
        ]);
        await seller.agent.createMediaBuy(mediaBuy({ product_id: cachedProduct.product_id, ...cachedSelected }));
        const pkg = seller.captured.create.packages[0];
        assert.strictEqual(pkg.format_option_refs, undefined);
        assert.strictEqual(pkg.format_kind, product.format_options[0].format_kind);
        assert.deepStrictEqual(pkg.params, product.format_options[0].params);
        assert.deepStrictEqual(
          Reflect.ownKeys(cachedProduct.format_options[0]),
          Reflect.ownKeys(product.format_options[0])
        );
      } finally {
        await seller.close();
      }
    });
  }

  test('conditional cache revalidation preserves undeclared selectors', async () => {
    const seller = await canonicalSeller(
      [legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }])],
      { productCache: createProductCache({ accountTtl: 0 }) },
      { cacheScope: 'account', conditional: true }
    );
    try {
      const request = { buying_mode: 'brief', brief: 'Display', account: ACCOUNT };
      await seller.agent.getProducts(request);
      const revalidated = await seller.agent.getProducts(request);
      assert.strictEqual(seller.captured.productReads.length, 2);
      assert.strictEqual(seller.captured.productReads[1].if_wholesale_feed_version, 'feed-1');
      const product = revalidated.data.products[0];
      const selected = packageRefsForFormatOptions(product, [product.format_options[0].format_option_id]);
      await seller.agent.createMediaBuy(mediaBuy({ product_id: product.product_id, ...selected }));
      const pkg = seller.captured.create.packages[0];
      assert.strictEqual(pkg.format_option_refs, undefined);
      assert.strictEqual(pkg.format_kind, product.format_options[0].format_kind);
      assert.deepStrictEqual(pkg.params, product.format_options[0].params);
    } finally {
      await seller.close();
    }
  });

  test('fresh seller declarations replace cached undeclared evidence', async () => {
    const products = [legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }])];
    const seller = await canonicalSeller(
      products,
      { productCache: createProductCache({ accountTtl: 0 }) },
      { cacheScope: 'account' }
    );
    try {
      const request = { buying_mode: 'brief', brief: 'Display', account: ACCOUNT };
      const first = await seller.agent.getProducts(request);
      const option = first.data.products[0].format_options[0];
      products[0] = {
        ...products[0],
        format_options: [
          {
            format_option_id: option.format_option_id,
            format_kind: option.format_kind,
            params: option.params,
            v1_format_ref: [{ agent_url: AAO, id: 'display_300x250_image' }],
          },
        ],
      };
      delete products[0].format_ids;
      const refreshed = await seller.agent.getProducts(request);
      const product = refreshed.data.products[0];
      const selected = packageRefsForFormatOptions(product, [option.format_option_id]);
      await seller.agent.createMediaBuy(mediaBuy({ product_id: product.product_id, ...selected }));
      assert.strictEqual(seller.captured.productReads.length, 2);
      assert.deepStrictEqual(seller.captured.create.packages[0].format_option_refs, selected.format_option_refs);
      assert.strictEqual(seller.captured.create.packages[0].format_kind, undefined);
    } finally {
      await seller.close();
    }
  });

  test('creative normalization does not reintroduce undeclared pins', async () => {
    const seller = await canonicalSeller(
      [legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }])],
      { validation: { requests: 'off', responses: 'off' } }
    );
    try {
      const products = await seller.agent.getProducts({ buying_mode: 'brief', brief: 'Display', account: ACCOUNT });
      const product = products.data.products[0];
      const selected = packageRefsForFormatOptions(product, [product.format_options[0].format_option_id]);
      const creative = {
        creative_id: 'legacy-creative',
        name: 'Image for normalization',
        format_id: { agent_url: AAO, id: 'display_300x250_image' },
        assets: {},
      };
      await seller.agent.createMediaBuy(
        mediaBuy({ product_id: product.product_id, ...selected, creatives: [creative] })
      );
      await seller.agent.syncCreatives({ account: ACCOUNT, creatives: [creative] });
      for (const wireCreative of [seller.captured.create.packages[0].creatives[0], seller.captured.sync.creatives[0]]) {
        assert.strictEqual(wireCreative.format_kind, 'image');
        assert.strictEqual(wireCreative.format_id, undefined);
        assert.strictEqual(wireCreative.format_option_ref, undefined);
      }
    } finally {
      await seller.close();
    }
  });

  test('undeclared custom formats fail before dispatch instead of losing schema identity', async () => {
    const seller = await canonicalSeller(
      [legacyOnlyProduct('custom-product', [{ agent_url: 'https://seller.example', id: 'takeover' }])],
      {
        legacyFormatConverter: () => ({
          format_option_id: 'takeover',
          format_kind: 'custom',
          format_shape: 'homepage_takeover',
          format_schema: {
            uri: 'https://seller.example/formats/takeover.json',
            digest: `sha256:${'a'.repeat(64)}`,
          },
          params: {},
        }),
      }
    );
    try {
      const products = await seller.agent.getProducts({ buying_mode: 'brief', brief: 'Takeover', account: ACCOUNT });
      const product = products.data.products[0];
      const selected = packageRefsForFormatOptions(product, ['takeover']);
      const isProjectionError = error => error.code === 'ADCP_CREATIVE_FORMAT_PROJECTION_FAILED';
      await assert.rejects(
        seller.agent.createMediaBuy(mediaBuy({ product_id: product.product_id, ...selected })),
        isProjectionError
      );
      await assert.rejects(
        seller.agent.syncCreatives({
          account: ACCOUNT,
          creatives: [
            {
              creative_id: 'custom-creative',
              name: 'Takeover',
              format_kind: 'custom',
              format_option_ref: selected.format_option_refs[0],
              assets: {},
            },
          ],
        }),
        isProjectionError
      );
      assert.strictEqual(seller.captured.create, undefined);
      assert.strictEqual(seller.captured.sync, undefined);
    } finally {
      await seller.close();
    }
  });

  test("discovery under one account does not rewrite another account's format selection", async () => {
    const seller = await canonicalSeller([
      legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }]),
    ]);
    try {
      const products = await seller.agent.getProducts({ buying_mode: 'brief', brief: 'Display', account: ACCOUNT });
      const product = products.data.products[0];
      const selected = packageRefsForFormatOptions(product, [product.format_options[0].format_option_id]);
      await seller.agent.createMediaBuy({
        ...mediaBuy({ product_id: product.product_id, ...selected }),
        account: { account_id: 'another-account' },
      });
      assert.deepStrictEqual(seller.captured.create.packages[0].format_option_refs, selected.format_option_refs);
      assert.strictEqual(seller.captured.create.packages[0].format_kind, undefined);
    } finally {
      await seller.close();
    }
  });

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
        format_options: [
          {
            format_option_id: declaredId,
            format_kind: 'image',
            params: { width: 300, height: 250 },
            v1_format_ref: [{ agent_url: AAO, id: 'display_300x250_image' }],
          },
        ],
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

describe('canonical wire: persisted routes carry whether the seller declared each option', () => {
  const persist = value => JSON.parse(JSON.stringify(value));

  async function discoverAndPersist(products, config = {}) {
    const discovery = await canonicalSeller(products, config);
    try {
      const result = await discovery.agent.getProducts({ buying_mode: 'brief', brief: 'Display', account: ACCOUNT });
      const product = result.data.products[0];
      return {
        product: persist(product),
        routes: persist(legacyRoutesForProduct(product.product_id, product.format_options)),
      };
    } finally {
      await discovery.close();
    }
  }

  test('a route for an option the seller did not declare records its direct selector', async () => {
    const { product, routes } = await discoverAndPersist([
      legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }]),
    ]);
    const [option] = product.format_options;

    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].seller_declared, false);
    assert.deepStrictEqual(routes[0].canonical_selector, { format_kind: option.format_kind, params: option.params });
  });

  test('a fresh client rewrites an undeclared option from persisted routes alone', async () => {
    const products = [legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }])];
    const { product, routes } = await discoverAndPersist(products);
    const [option] = product.format_options;
    const execution = await canonicalSeller(products);
    try {
      const created = await execution.agent.createMediaBuy(
        mediaBuy({
          product_id: product.product_id,
          ...packageRefsForFormatOptions(product, [option.format_option_id]),
        }),
        undefined,
        { canonicalFormatLegacyResolver: canonicalFormatLegacyResolverFromRoutes(routes) }
      );

      assert.strictEqual(created.success, true);
      const pkg = execution.captured.create.packages[0];
      assert.strictEqual(pkg.format_option_refs, undefined);
      assert.strictEqual(pkg.format_kind, option.format_kind);
      assert.deepStrictEqual(pkg.params, option.params);
    } finally {
      await execution.close();
    }
  });

  test('a configured resolver from persisted routes also rewrites undeclared options', async () => {
    const products = [legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }])];
    const { product, routes } = await discoverAndPersist(products);
    const [option] = product.format_options;
    const execution = await canonicalSeller(products, {
      canonicalFormatLegacyResolver: canonicalFormatLegacyResolverFromRoutes(routes),
    });
    try {
      await execution.agent.createMediaBuy(
        mediaBuy({ product_id: product.product_id, ...packageRefsForFormatOptions(product, [option.format_option_id]) })
      );

      const pkg = execution.captured.create.packages[0];
      assert.strictEqual(pkg.format_option_refs, undefined);
      assert.strictEqual(pkg.format_kind, option.format_kind);
    } finally {
      await execution.close();
    }
  });

  for (const configured of [false, true]) {
    test(`persisted undeclared custom formats fail before dispatch (configured resolver: ${configured})`, async () => {
      const products = [legacyOnlyProduct('custom-product', [{ agent_url: 'https://seller.example', id: 'takeover' }])];
      const { product, routes } = await discoverAndPersist(products, {
        legacyFormatConverter: () => ({
          format_option_id: 'takeover',
          format_kind: 'custom',
          format_shape: 'homepage_takeover',
          format_schema: {
            uri: 'https://seller.example/formats/takeover.json',
            digest: `sha256:${'a'.repeat(64)}`,
          },
          params: {},
        }),
      });
      assert.strictEqual(routes.length, 1);
      assert.strictEqual(routes[0].seller_declared, false);
      assert.strictEqual(routes[0].canonical_selector, undefined);
      const resolver = { canonicalFormatLegacyResolver: canonicalFormatLegacyResolverFromRoutes(routes) };
      const execution = await canonicalSeller(products, configured ? resolver : {});
      try {
        const options = configured ? undefined : resolver;
        const selected = packageRefsForFormatOptions(product, ['takeover']);
        const pkg = mediaBuy({ product_id: product.product_id, ...selected }).packages[0];
        const isProjectionError = error => error.code === 'ADCP_CREATIVE_FORMAT_PROJECTION_FAILED';

        await assert.rejects(execution.agent.createMediaBuy(mediaBuy(pkg), undefined, options), isProjectionError);
        await assert.rejects(
          execution.agent.updateMediaBuy(
            { account: ACCOUNT, media_buy_id: 'mb-canonical', new_packages: [pkg] },
            undefined,
            options
          ),
          isProjectionError
        );
        await assert.rejects(
          execution.agent.syncCreatives(
            {
              account: ACCOUNT,
              creatives: [
                {
                  creative_id: 'custom-creative',
                  name: 'Takeover',
                  format_kind: 'custom',
                  format_option_ref: selected.format_option_refs[0],
                  assets: {},
                },
              ],
            },
            undefined,
            options
          ),
          isProjectionError
        );
        assert.strictEqual(execution.captured.create, undefined);
        assert.strictEqual(execution.captured.update, undefined);
        assert.strictEqual(execution.captured.sync, undefined);
      } finally {
        await execution.close();
      }
    });
  }

  test('persisted routes for seller-declared options keep format_option_refs', async () => {
    const declaredId = `migrated_${'b'.repeat(32)}`;
    const products = [
      {
        product_id: 'canonical-product',
        name: 'Canonical product',
        description: 'Seller-declared canonical options',
        format_options: [
          {
            format_option_id: declaredId,
            format_kind: 'image',
            params: { width: 300, height: 250 },
            v1_format_ref: [{ agent_url: AAO, id: 'display_300x250_image' }],
          },
        ],
        pricing_options: PRICING_OPTIONS,
      },
    ];
    const { product, routes } = await discoverAndPersist(products);
    assert.strictEqual(routes[0].seller_declared, true);
    assert.strictEqual(routes[0].canonical_selector, undefined);
    const execution = await canonicalSeller(products);
    try {
      await execution.agent.createMediaBuy(
        mediaBuy({ product_id: product.product_id, ...packageRefsForFormatOptions(product, [declaredId]) }),
        undefined,
        { canonicalFormatLegacyResolver: canonicalFormatLegacyResolverFromRoutes(routes) }
      );

      const pkg = execution.captured.create.packages[0];
      assert.deepStrictEqual(pkg.format_option_refs, [{ scope: 'product', format_option_id: declaredId }]);
      assert.strictEqual(pkg.format_kind, undefined);
    } finally {
      await execution.close();
    }
  });

  test('routes persisted without seller origin keep format_option_refs unchanged', async () => {
    const products = [legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }])];
    const { product, routes } = await discoverAndPersist(products);
    const [option] = product.format_options;
    const routesWithoutOrigin = routes.map(
      ({ seller_declared: _declared, canonical_selector: _selector, ...route }) => route
    );
    const execution = await canonicalSeller(products);
    try {
      await execution.agent.createMediaBuy(
        mediaBuy({
          product_id: product.product_id,
          ...packageRefsForFormatOptions(product, [option.format_option_id]),
        }),
        undefined,
        { canonicalFormatLegacyResolver: canonicalFormatLegacyResolverFromRoutes(routesWithoutOrigin) }
      );

      const pkg = execution.captured.create.packages[0];
      assert.deepStrictEqual(pkg.format_option_refs, [{ scope: 'product', format_option_id: option.format_option_id }]);
    } finally {
      await execution.close();
    }
  });

  test('fresh seller declarations without legacy aliases override configured persisted origin', async () => {
    const { product, routes } = await discoverAndPersist([
      legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }]),
    ]);
    const [option] = product.format_options;
    // The seller now declares the formerly derived option and no longer
    // advertises a legacy alias. The configured routes predate that change.
    const execution = await canonicalSeller([product], {
      canonicalFormatLegacyResolver: canonicalFormatLegacyResolverFromRoutes(routes),
    });
    try {
      const fresh = await execution.agent.getProducts({ buying_mode: 'brief', brief: 'Display', account: ACCOUNT });
      const freshProduct = fresh.data.products[0];
      const selected = packageRefsForFormatOptions(freshProduct, [option.format_option_id]);
      const creative = {
        creative_id: 'creative-fresh',
        name: 'Fresh seller declaration',
        format_kind: 'image',
        format_option_ref: selected.format_option_refs[0],
        assets: {},
      };

      await execution.agent.createMediaBuy(
        mediaBuy({ product_id: product.product_id, ...selected, creatives: [creative] })
      );
      await execution.agent.updateMediaBuy({
        account: ACCOUNT,
        media_buy_id: 'mb-canonical',
        new_packages: [mediaBuy({ product_id: product.product_id, ...selected }).packages[0]],
      });
      await execution.agent.syncCreatives({ account: ACCOUNT, creatives: [creative] });

      for (const pkg of [execution.captured.create.packages[0], execution.captured.update.new_packages[0]]) {
        assert.deepStrictEqual(pkg.format_option_refs, selected.format_option_refs);
        assert.strictEqual(pkg.format_kind, undefined);
      }
      for (const wireCreative of [
        execution.captured.create.packages[0].creatives[0],
        execution.captured.sync.creatives[0],
      ]) {
        assert.deepStrictEqual(wireCreative.format_option_ref, creative.format_option_ref);
      }
    } finally {
      await execution.close();
    }
  });

  for (const oldRouteFirst of [false, true]) {
    test(`mixed old and new routes preserve an unscoped creative pin (old route first: ${oldRouteFirst})`, async () => {
      const { product, routes } = await discoverAndPersist([
        legacyOnlyProduct('legacy-shaped', [{ agent_url: AAO, id: 'display_300x250_image' }]),
      ]);
      const [derivedRoute] = routes;
      const oldRoute = {
        product_id: 'declared-product',
        format_option_ref: derivedRoute.format_option_ref,
        format_ids: derivedRoute.format_ids,
      };
      const execution = await canonicalSeller([], {
        canonicalFormatLegacyResolver: canonicalFormatLegacyResolverFromRoutes(
          oldRouteFirst ? [oldRoute, derivedRoute] : [derivedRoute, oldRoute]
        ),
      });
      try {
        const creative = {
          creative_id: 'creative-old-route',
          name: 'Old route origin is unknown',
          format_kind: 'image',
          format_option_ref: oldRoute.format_option_ref,
          assets: {},
        };
        await execution.agent.syncCreatives({ account: ACCOUNT, creatives: [creative] }, undefined, {
          creativeFormatProjection: {
            selectorContainers: [{ product_id: oldRoute.product_id, format_option_refs: [oldRoute.format_option_ref] }],
          },
        });
        assert.deepStrictEqual(execution.captured.sync.creatives[0].format_option_ref, creative.format_option_ref);

        // A scoped selection can still use the new route's known origin.
        await execution.agent.createMediaBuy(
          mediaBuy({ product_id: product.product_id, format_option_refs: [derivedRoute.format_option_ref] })
        );
        assert.strictEqual(execution.captured.create.packages[0].format_option_refs, undefined);
        assert.strictEqual(execution.captured.create.packages[0].format_kind, 'image');

        await execution.agent.createMediaBuy(
          mediaBuy({ product_id: oldRoute.product_id, format_option_refs: [oldRoute.format_option_ref] })
        );
        assert.deepStrictEqual(execution.captured.create.packages[0].format_option_refs, [oldRoute.format_option_ref]);
      } finally {
        await execution.close();
      }
    });
  }
});
