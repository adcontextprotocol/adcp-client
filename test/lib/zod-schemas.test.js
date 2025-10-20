const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('Zod Schema Validation', () => {
  let schemas;

  test('schemas can be imported', async () => {
    schemas = await import('../../dist/lib/types/schemas.generated.js');
    assert.ok(schemas, 'Schemas should be importable');
  });

  test('ProductSchema is importable and has parse method', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.ProductSchema, 'ProductSchema should exist');
    assert.ok(typeof schemas.ProductSchema.safeParse === 'function', 'ProductSchema should have safeParse method');
  });

  test('MediaBuySchema validates valid media buy', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validMediaBuy = {
      media_buy_id: 'mb_123',
      status: 'pending',
      promoted_offering: 'Nike Spring Collection 2024',
      total_budget: 50000,
      packages: []
    };

    const result = schemas.MediaBuySchema.safeParse(validMediaBuy);
    assert.ok(result.success, `MediaBuy validation should succeed: ${result.error?.message}`);
  });

  test('GetProductsRequestSchema validates valid request', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validRequest = {
      brief: 'Looking for premium display inventory in US',
      brand_manifest: {
        brand_name: 'Nike',
        product_catalog: []
      }
    };

    const result = schemas.GetProductsRequestSchema.safeParse(validRequest);
    assert.ok(result.success, `GetProductsRequest validation should succeed: ${result.error?.message}`);
  });

  test('ProductSchema rejects invalid product', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const invalidProduct = {
      product_id: 'prod_123',
      // Missing required fields
    };

    const result = schemas.ProductSchema.safeParse(invalidProduct);
    assert.ok(!result.success, 'Product validation should fail for invalid data');
  });

  test('GetProductsResponseSchema validates response', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validResponse = {
      products: []
    };

    const result = schemas.GetProductsResponseSchema.safeParse(validResponse);
    assert.ok(result.success, `GetProductsResponse validation should succeed: ${result.error?.message}`);
  });

  test('CreativeAssetSchema is importable and has parse method', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.CreativeAssetSchema, 'CreativeAssetSchema should exist');
    assert.ok(typeof schemas.CreativeAssetSchema.safeParse === 'function', 'CreativeAssetSchema should have safeParse method');
  });
});
