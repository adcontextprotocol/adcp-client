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
      status: 'pending_activation', // Must match enum value
      promoted_offering: 'Nike Spring Collection 2024',
      total_budget: 50000,
      packages: [],
    };

    const result = schemas.MediaBuySchema.safeParse(validMediaBuy);
    assert.ok(
      result.success,
      `MediaBuy validation should succeed: ${JSON.stringify(result.error?.issues || result.error)}`
    );
  });

  test('GetProductsRequestSchema validates valid request', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validRequest = {
      brief: 'Looking for premium display inventory in US',
      brand_manifest: {
        name: 'Nike',
        url: 'https://nike.com',
      },
    };

    const result = schemas.GetProductsRequestSchema.safeParse(validRequest);
    assert.ok(
      result.success,
      `GetProductsRequest validation should succeed: ${JSON.stringify(result.error?.issues || result.error)}`
    );
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
      products: [],
    };

    const result = schemas.GetProductsResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetProductsResponse validation should succeed: ${JSON.stringify(result.error?.issues || result.error)}`
    );
  });

  test('CreativeAssetSchema is importable and has parse method', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.CreativeAssetSchema, 'CreativeAssetSchema should exist');
    assert.ok(
      typeof schemas.CreativeAssetSchema.safeParse === 'function',
      'CreativeAssetSchema should have safeParse method'
    );
  });

  test('ListAuthorizedPropertiesResponseSchema accepts empty publisher_domains array', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // Test agents may return empty arrays when not authorized for any publishers
    const responseWithEmptyDomains = {
      publisher_domains: [],
    };

    const result = schemas.ListAuthorizedPropertiesResponseSchema.safeParse(responseWithEmptyDomains);
    assert.ok(
      result.success,
      `ListAuthorizedPropertiesResponse should accept empty publisher_domains: ${JSON.stringify(result.error?.issues || result.error)}`
    );
  });

  test('ListAuthorizedPropertiesResponseSchema accepts non-empty publisher_domains array', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const responseWithDomains = {
      publisher_domains: ['cnn.com', 'nytimes.com'],
    };

    const result = schemas.ListAuthorizedPropertiesResponseSchema.safeParse(responseWithDomains);
    assert.ok(
      result.success,
      `ListAuthorizedPropertiesResponse should accept non-empty publisher_domains: ${JSON.stringify(result.error?.issues || result.error)}`
    );
  });

  test('ListAuthorizedPropertiesResponseSchema rejects invalid element types', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // publisher_domains should only contain strings
    const responseWithInvalidTypes = {
      publisher_domains: [123, null, { domain: 'example.com' }],
    };

    const result = schemas.ListAuthorizedPropertiesResponseSchema.safeParse(responseWithInvalidTypes);
    assert.ok(!result.success, 'Should reject non-string elements in publisher_domains');
  });
});
