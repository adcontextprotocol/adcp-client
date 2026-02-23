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

  test('GetProductsRequestSchema validates valid request (if available)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // GetProductsRequestSchema may not be generated due to complex discriminated unions in v3 schemas
    if (!schemas.GetProductsRequestSchema) {
      console.log('⏭️  GetProductsRequestSchema not available - skipping validation test');
      return;
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

  test('GetProductsResponseSchema validates response (if available)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // GetProductsResponseSchema may not be generated due to complex discriminated unions in v3 schemas
    if (!schemas.GetProductsResponseSchema) {
      console.log('⏭️  GetProductsResponseSchema not available - skipping validation test');
      return;
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

  test('GetMediaBuysRequestSchema validates valid request', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.GetMediaBuysRequestSchema, 'GetMediaBuysRequestSchema should exist');

    const validRequest = {
      media_buy_ids: ['mb_123', 'mb_456'],
      include_snapshot: true,
    };

    const result = schemas.GetMediaBuysRequestSchema.safeParse(validRequest);
    assert.ok(result.success, `GetMediaBuysRequest validation should succeed: ${JSON.stringify(result.error?.issues)}`);
  });

  test('GetMediaBuysRequestSchema validates empty request (all fields optional)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({});
    assert.ok(result.success, `GetMediaBuysRequest with no fields should succeed: ${JSON.stringify(result.error?.issues)}`);
  });

  test('GetMediaBuysRequestSchema validates status_filter as single value', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({
      status_filter: 'active',
    });
    assert.ok(result.success, `GetMediaBuysRequest with single status_filter should succeed: ${JSON.stringify(result.error?.issues)}`);
  });

  test('GetMediaBuysRequestSchema validates status_filter as array', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({
      status_filter: ['active', 'paused'],
    });
    assert.ok(result.success, `GetMediaBuysRequest with array status_filter should succeed: ${JSON.stringify(result.error?.issues)}`);
  });

  test('GetMediaBuysResponseSchema validates valid response', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.GetMediaBuysResponseSchema, 'GetMediaBuysResponseSchema should exist');

    const validResponse = {
      media_buys: [
        {
          media_buy_id: 'mb_123',
          buyer_ref: 'buyer-ref-1',
          buyer_campaign_ref: 'Q4_Campaign',
          status: 'active',
          currency: 'USD',
          total_budget: 50000,
          packages: [
            {
              package_id: 'pkg_1',
              budget: 25000,
              creative_approvals: [
                {
                  creative_id: 'cr_1',
                  approval_status: 'approved',
                },
              ],
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(result.success, `GetMediaBuysResponse validation should succeed: ${JSON.stringify(result.error?.issues)}`);
  });

  test('GetMediaBuysResponseSchema validates response with snapshot', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validResponse = {
      media_buys: [
        {
          media_buy_id: 'mb_123',
          status: 'active',
          currency: 'USD',
          total_budget: 50000,
          packages: [
            {
              package_id: 'pkg_1',
              snapshot: {
                as_of: '2026-02-22T12:00:00Z',
                staleness_seconds: 900,
                impressions: 12500,
                spend: 1250.50,
                delivery_status: 'delivering',
                pacing_index: 1.05,
              },
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(result.success, `GetMediaBuysResponse with snapshot should succeed: ${JSON.stringify(result.error?.issues)}`);
  });

  test('GetMediaBuysResponseSchema rejects invalid creative approval status', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const invalidResponse = {
      media_buys: [
        {
          media_buy_id: 'mb_123',
          status: 'active',
          currency: 'USD',
          total_budget: 50000,
          packages: [
            {
              package_id: 'pkg_1',
              creative_approvals: [
                {
                  creative_id: 'cr_1',
                  approval_status: 'invalid_status',
                },
              ],
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(invalidResponse);
    assert.ok(!result.success, 'GetMediaBuysResponse with invalid approval_status should fail');
  });
});
