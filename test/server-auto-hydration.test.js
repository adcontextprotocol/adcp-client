process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createAdcpServerFromPlatform,
  createCtxMetadataStore,
  getHydratedLegacyFormatIds,
  memoryCtxMetadataStore,
} = require('../dist/lib/server/legacy/v5');

function makePlatform({ getProductsImpl, createMediaBuyImpl, updateMediaBuyImpl, getMediaBuysImpl }) {
  return {
    capabilities: {
      adcp_version: '3.0.0',
      specialisms: ['sales-non-guaranteed'],
      pricingModels: ['cpm'],
      channels: ['display'],
      formats: [{ format_id: 'display_300x250' }],
      idempotency: { replay_ttl_seconds: 86400 },
    },
    accounts: {
      resolution: 'derived',
      resolve: async () => ({ id: 'acct_default', operator: 'test', ctx_metadata: {} }),
      upsert: async () => ({ ok: true, items: [] }),
      list: async () => ({ items: [], nextCursor: null }),
    },
    sales: {
      getProducts: getProductsImpl,
      createMediaBuy: createMediaBuyImpl,
      updateMediaBuy: updateMediaBuyImpl ?? (async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] })),
      getMediaBuyDelivery: async () => ({ deliveries: [] }),
      getMediaBuys: getMediaBuysImpl ?? (async () => ({ media_buys: [] })),
    },
  };
}

describe('createAdcpServerFromPlatform — auto-hydration of products', () => {
  it('preserves the exact owner-qualified legacy route across discovery storage and create', async () => {
    const refs = {
      a: { agent_url: 'https://formats-a.example/catalog', id: 'shared_takeover' },
      b: { agent_url: 'https://formats-b.example/catalog', id: 'shared_takeover' },
    };
    let selectedRoutes;
    let updatedRoutes;
    const platform = makePlatform({
      getProductsImpl: async () => ({
        cache_scope: 'account',
        products: Object.entries(refs).map(([owner, ref]) => ({
          product_id: `product-${owner}`,
          name: `Product ${owner}`,
          format_ids: [ref],
        })),
      }),
      createMediaBuyImpl: async req => {
        selectedRoutes = getHydratedLegacyFormatIds(req.packages[0].product);
        return { media_buy_id: 'mb-owner-route', status: 'pending_creatives', packages: [] };
      },
      updateMediaBuyImpl: async (_mediaBuyId, req) => {
        updatedRoutes = getHydratedLegacyFormatIds(req.new_packages[0].product);
        return { media_buy_id: 'mb-owner-route', status: 'active', packages: [] };
      },
    });
    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Legacy route hydration',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
      legacyCreativeFormatResolver: async ({ formatId }) => ({
        format_option_id: `takeover-${new URL(formatId.agent_url).hostname[8]}`,
        format_kind: 'custom',
        format_shape: 'takeover',
        format_schema: {
          uri: 'https://schemas.example/takeover.json',
          digest: `sha256:${'a'.repeat(64)}`,
        },
        params: {},
      }),
    });

    const discovered = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'owner-specific takeover' } },
    });
    assert.notStrictEqual(discovered.isError, true, JSON.stringify(discovered.structuredContent));
    assert.strictEqual(discovered.structuredContent.products[1].format_ids, undefined);

    const created = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_owner_route',
          packages: [{ buyer_ref: 'pkg_owner_route', product_id: 'product-b' }],
          idempotency_key: 'idem_owner_route',
        },
      },
    });
    assert.notStrictEqual(created.isError, true, JSON.stringify(created.structuredContent));
    assert.deepStrictEqual(selectedRoutes, [refs.b]);

    const updated = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'update_media_buy',
        arguments: {
          media_buy_id: 'mb-owner-route',
          idempotency_key: 'idem_owner_route_update',
          new_packages: [{ buyer_ref: 'pkg_owner_route_update', product_id: 'product-a' }],
        },
      },
    });
    assert.notStrictEqual(updated.isError, true, JSON.stringify(updated.structuredContent));
    assert.deepStrictEqual(updatedRoutes, [refs.a]);
  });

  it('rejects adopter injection of the SDK-private legacy route sidecar at product and placement scope', async () => {
    let createCalls = 0;
    const forgedRoutes = {
      formatIds: [{ agent_url: 'http://127.0.0.1/internal', id: 'forged' }],
    };
    for (const injectedProduct of [
      {
        product_id: 'injected-product-route',
        name: 'Injected product route',
        format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
        __adcp_private_legacy_format_routes: forgedRoutes,
      },
      {
        product_id: 'injected-placement-route',
        name: 'Injected placement route',
        format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
        placements: [
          {
            placement_id: 'sidebar',
            format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
            __adcp_private_legacy_format_routes: {
              ...forgedRoutes,
            },
          },
        ],
      },
    ]) {
      const platform = makePlatform({
        getProductsImpl: async () => ({ products: [injectedProduct] }),
        createMediaBuyImpl: async () => {
          createCalls += 1;
          return { media_buy_id: 'must-not-run', status: 'active', packages: [] };
        },
      });
      const server = createAdcpServerFromPlatform(platform, {
        name: 'Reserved route injection',
        version: '1.0.0',
        ctxMetadata: createCtxMetadataStore({ backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }) }),
        validation: { requests: 'off', responses: 'off' },
      });

      const result = await server.dispatchTestRequest({
        method: 'tools/call',
        params: { name: 'get_products', arguments: { brief: 'injected' } },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    }
    assert.strictEqual(createCalls, 0);
  });

  it('createMediaBuy receives req.packages[i].product hydrated from prior getProducts', async () => {
    let observedPackages;
    let getProductsAccountId;

    const platform = makePlatform({
      getProductsImpl: async (req, ctx) => {
        getProductsAccountId = ctx.account?.id;
        return {
          products: [
            {
              product_id: 'prod_a',
              name: 'Sports Display Auction',
              format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
              delivery_type: 'non_guaranteed',
              pricing_options: [{ pricing_option_id: 'po1', model: 'cpm' }],
              ctx_metadata: { gam: { ad_unit_ids: ['au_123'] } },
            },
          ],
        };
      },
      createMediaBuyImpl: async (req, ctx) => {
        observedPackages = req.packages;
        return { media_buy_id: 'mb_1', status: 'pending_creatives', packages: [] };
      },
    });

    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    // Step 1: getProducts — SDK auto-stores Product wire shape + ctx_metadata
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'sports display', promoted_offering: 'shoes' } },
    });

    // Simulate an older/custom store reattaching the pre-migration product
    // shape. The platform handler boundary must still remain canonical.
    await ctxMetadata.setResource(
      'acct_default',
      'product',
      'prod_a',
      {
        product_id: 'prod_a',
        name: 'Sports Display Auction',
        format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
        format_options: [
          {
            format_kind: 'image',
            params: { width: 300, height: 250 },
            v1_format_ref: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
          },
        ],
      },
      { gam: { ad_unit_ids: ['au_123'] } }
    );

    // Step 2: createMediaBuy referencing prod_a — SDK auto-hydrates pkg.product
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_auto_hydrate_test',
          packages: [{ buyer_ref: 'pk_1', product_id: 'prod_a' }],
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          budget: { total: 1000, currency: 'USD' },
          idempotency_key: 'idem_auto_hydrate_001',
        },
      },
    });

    assert.ok(observedPackages, 'createMediaBuy should have been invoked');
    assert.equal(observedPackages.length, 1);
    void getProductsAccountId; // captured for diagnostic; assertion below is canonical
    const pkg = observedPackages[0];
    assert.equal(pkg.product_id, 'prod_a', 'wire product_id preserved');
    assert.ok(pkg.product, 'pkg.product should be hydrated by SDK');
    assert.equal(pkg.product.product_id, 'prod_a', 'hydrated product carries product_id');
    assert.equal(pkg.product.name, 'Sports Display Auction', 'hydrated product carries wire fields (name)');
    assert.deepEqual(
      pkg.product.format_options,
      [{ format_kind: 'image', params: { width: 300, height: 250 } }],
      'hydrated product carries canonical format options'
    );
    assert.equal(pkg.product.format_ids, undefined, 'hydrated product does not expose legacy format_ids');
    assert.equal(
      pkg.product.format_options[0].v1_format_ref,
      undefined,
      'hydrated declarations do not expose legacy v1 refs'
    );
    assert.deepEqual(
      pkg.product.ctx_metadata,
      { gam: { ad_unit_ids: ['au_123'] } },
      'hydrated product carries ctx_metadata blob'
    );
  });

  it('semantically converts a legacy-only custom product during hydration', async () => {
    let hydratedProduct;
    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [] }),
      createMediaBuyImpl: async req => {
        hydratedProduct = req.packages[0].product;
        return { media_buy_id: 'mb_custom_hydration', status: 'pending_creatives', packages: [] };
      },
    });
    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });
    await ctxMetadata.setResource(
      'acct_default',
      'product',
      'prod_custom',
      {
        product_id: 'prod_custom',
        name: 'Custom takeover',
        description: 'Legacy-only stored product',
        format_ids: [{ agent_url: 'https://seller.example/custom', id: 'homepage_takeover' }],
      },
      { upstream_product_id: 'custom-42' }
    );
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Custom hydration',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
      legacyCreativeFormatConverter: ({ formatId }) =>
        formatId.id === 'homepage_takeover'
          ? {
              format_option_id: 'homepage-takeover',
              format_kind: 'custom',
              format_shape: 'takeover',
              format_schema: {
                uri: 'https://seller.example/formats/homepage_takeover.json',
                digest: `sha256:${'a'.repeat(64)}`,
              },
              params: {},
            }
          : undefined,
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          packages: [{ product_id: 'prod_custom' }],
          idempotency_key: 'custom-hydration-create',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(hydratedProduct);
    assert.strictEqual(hydratedProduct.format_ids, undefined);
    assert.strictEqual(hydratedProduct.format_options[0].format_kind, 'custom');
    assert.strictEqual(hydratedProduct.format_options[0].format_option_id, 'homepage-takeover');
    assert.strictEqual(hydratedProduct.format_options[0].v1_format_ref, undefined);
    assert.deepStrictEqual(hydratedProduct.ctx_metadata, { upstream_product_id: 'custom-42' });
  });

  it('downgrades persisted canonical custom product and creative through the explicit resolver', async () => {
    const canonicalProduct = {
      product_id: 'prod_persisted_custom',
      name: 'Persisted custom takeover',
      description: 'No hidden v1 metadata survives persistence',
      format_options: [
        {
          format_kind: 'custom',
          format_option_id: 'homepage-takeover',
          format_shape: 'takeover',
          format_schema: {
            uri: 'https://seller.example/formats/homepage_takeover.json',
            digest: `sha256:${'a'.repeat(64)}`,
          },
          params: {},
        },
      ],
    };
    let hydratedProduct;
    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [canonicalProduct], cache_scope: 'account' }),
      createMediaBuyImpl: async req => {
        hydratedProduct = req.packages[0].product;
        return {
          media_buy_id: 'mb_persisted_custom',
          packages: [
            {
              package_id: 'pkg_persisted_custom',
              product: hydratedProduct,
              creatives: [
                {
                  creative_id: 'creative_persisted_custom',
                  name: 'Persisted custom creative',
                  format_kind: 'custom',
                  format_option_ref: { scope: 'product', format_option_id: 'homepage-takeover' },
                  assets: {},
                },
              ],
            },
          ],
        };
      },
    });
    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });
    const resolver = context => {
      if (
        (context.source === 'product' && context.declaration.format_option_id === 'homepage-takeover') ||
        (context.source === 'creative' && context.creative.format_option_ref?.format_option_id === 'homepage-takeover')
      ) {
        return { agent_url: 'https://seller.example/formats', id: 'homepage_takeover' };
      }
      return undefined;
    };
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Persisted custom downgrade',
      version: '1.0.0',
      adcpVersion: '3.0.12',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
      canonicalFormatLegacyResolver: resolver,
    });

    const products = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'custom' } },
    });
    assert.notStrictEqual(products.isError, true, JSON.stringify(products.structuredContent));
    assert.deepStrictEqual(products.structuredContent.products[0].format_ids, [
      { agent_url: 'https://seller.example/formats', id: 'homepage_takeover' },
    ]);

    // Force a JSON persistence round-trip so no SDK-private WeakMap mapping
    // can participate in the subsequent hydration/downgrade.
    await ctxMetadata.setResource(
      'acct_default',
      'product',
      canonicalProduct.product_id,
      JSON.parse(JSON.stringify(canonicalProduct))
    );
    const created = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          packages: [{ product_id: canonicalProduct.product_id }],
          idempotency_key: 'persisted-custom-create',
        },
      },
    });

    assert.notStrictEqual(created.isError, true, JSON.stringify(created.structuredContent));
    assert.strictEqual(hydratedProduct.format_options[0].format_kind, 'custom');
    assert.strictEqual(hydratedProduct.format_ids, undefined);
    const wirePackage = created.structuredContent.packages[0];
    assert.deepStrictEqual(wirePackage.product.format_ids, [
      { agent_url: 'https://seller.example/formats', id: 'homepage_takeover' },
    ]);
    assert.strictEqual(wirePackage.product.format_options, undefined);
    assert.deepStrictEqual(wirePackage.creatives[0].format_id, {
      agent_url: 'https://seller.example/formats',
      id: 'homepage_takeover',
    });
    assert.strictEqual(wirePackage.creatives[0].format_kind, undefined);
  });

  it('errors cleanly when the canonical legacy resolver returns ambiguous creative refs', async () => {
    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [] }),
      createMediaBuyImpl: async () => ({
        media_buy_id: 'mb_ambiguous_custom',
        packages: [
          {
            package_id: 'pkg_ambiguous_custom',
            creatives: [
              {
                creative_id: 'creative_ambiguous_custom',
                format_kind: 'custom',
                assets: {},
              },
            ],
          },
        ],
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Ambiguous custom downgrade',
      version: '1.0.0',
      adcpVersion: '3.0.12',
      validation: { requests: 'off', responses: 'off' },
      canonicalFormatLegacyResolver: () => [
        { agent_url: 'https://seller.example/formats', id: 'custom_a' },
        { agent_url: 'https://seller.example/formats', id: 'custom_b' },
      ],
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { packages: [], idempotency_key: 'ambiguous-custom-create' },
      },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent.adcp_error.code, 'INVALID_REQUEST');
    assert.match(result.structuredContent.adcp_error.message, /cannot be represented on the configured legacy wire/);
  });

  it('does not hydrate when ctxMetadata store is not wired', async () => {
    let observedPackages;
    const platform = makePlatform({
      getProductsImpl: async () => ({
        products: [
          {
            product_id: 'prod_a',
            name: 'A',
            format_options: [{ format_kind: 'image', params: {} }],
            delivery_type: 'guaranteed',
            ctx_metadata: { x: 1 },
          },
        ],
      }),
      createMediaBuyImpl: async (req, ctx) => {
        observedPackages = req.packages;
        return { media_buy_id: 'mb_1', status: 'pending_creatives', packages: [] };
      },
    });

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'b', promoted_offering: 'o' } },
    });
    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_no_store',
          packages: [{ buyer_ref: 'pk_1', product_id: 'prod_a' }],
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          budget: { total: 1000, currency: 'USD' },
          idempotency_key: 'idem_test_no_store_001',
        },
      },
    });

    assert.ok(observedPackages);
    assert.equal(observedPackages[0].product_id, 'prod_a');
    assert.equal(observedPackages[0].product, undefined, 'no hydration when no store');
  });

  it('falls back gracefully when product was never seen by getProducts', async () => {
    let observedPackages;
    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [] }),
      createMediaBuyImpl: async (req, ctx) => {
        observedPackages = req.packages;
        return { media_buy_id: 'mb_1', status: 'pending_creatives', packages: [] };
      },
    });

    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          buyer_ref: 'br_unseen',
          packages: [{ buyer_ref: 'pk_1', product_id: 'prod_unknown' }],
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          budget: { total: 1000, currency: 'USD' },
          idempotency_key: 'idem_test_unseen_001',
        },
      },
    });

    assert.ok(observedPackages);
    assert.equal(observedPackages[0].product_id, 'prod_unknown');
    assert.equal(
      observedPackages[0].product,
      undefined,
      'no hydration for unseen product — publisher falls back to its own DB'
    );
  });

  it('auto-stores media buys returned from getMediaBuys', async () => {
    let storeWasCalledWith;
    const platform = makePlatform({
      getProductsImpl: async () => ({ products: [] }),
      createMediaBuyImpl: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
      getMediaBuysImpl: async () => ({
        media_buys: [{ media_buy_id: 'mb_existing', status: 'active', ctx_metadata: { gam_order_id: 'gam_42' } }],
      }),
    });

    const ctxMetadata = createCtxMetadataStore({
      backend: memoryCtxMetadataStore({ sweepIntervalMs: 0 }),
    });

    // Patch into the store to observe the auto-store call. Auto-store path
    // uses `setResource` so prior publisher `set()` values aren't clobbered.
    const origSetResource = ctxMetadata.setResource.bind(ctxMetadata);
    ctxMetadata.setResource = async (...args) => {
      storeWasCalledWith = args;
      return origSetResource(...args);
    };

    const server = createAdcpServerFromPlatform(platform, {
      name: 'Test',
      version: '1.0.0',
      ctxMetadata,
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_media_buys', arguments: {} },
    });

    assert.ok(storeWasCalledWith, 'auto-store called for media_buys');
    // setResource(accountId, kind, id, resource, publisherCtxMetadata)
    assert.equal(storeWasCalledWith[1], 'media_buy');
    assert.equal(storeWasCalledWith[2], 'mb_existing');
    assert.equal(storeWasCalledWith[3].media_buy_id, 'mb_existing', 'resource carries media_buy_id');
    assert.equal(storeWasCalledWith[3].status, 'active', 'resource carries wire status');
    assert.equal(storeWasCalledWith[3].ctx_metadata, undefined, 'ctx_metadata stripped from resource');
    assert.deepEqual(storeWasCalledWith[4], { gam_order_id: 'gam_42' }, 'publisher ctx_metadata passed as 5th arg');
  });
});
