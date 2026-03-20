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
      buying_mode: 'brief',
      brief: 'Looking for premium display inventory in US',
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
      account: { account_id: 'acc_123' },
      media_buy_ids: ['mb_123', 'mb_456'],
      include_snapshot: true,
    };

    const result = schemas.GetMediaBuysRequestSchema.safeParse(validRequest);
    assert.ok(result.success, `GetMediaBuysRequest validation should succeed: ${JSON.stringify(result.error?.issues)}`);
  });

  test('GetMediaBuysRequestSchema validates request with only required account field', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({ account: { account_id: 'acc_123' } });
    assert.ok(
      result.success,
      `GetMediaBuysRequest with only account should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysRequestSchema validates status_filter as single value', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({
      account: { account_id: 'acc_123' },
      status_filter: 'active',
    });
    assert.ok(
      result.success,
      `GetMediaBuysRequest with single status_filter should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysRequestSchema validates status_filter as array', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({
      account: { account_id: 'acc_123' },
      status_filter: ['active', 'paused'],
    });
    assert.ok(
      result.success,
      `GetMediaBuysRequest with array status_filter should succeed: ${JSON.stringify(result.error?.issues)}`
    );
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
    assert.ok(
      result.success,
      `GetMediaBuysResponse validation should succeed: ${JSON.stringify(result.error?.issues)}`
    );
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
                spend: 1250.5,
                delivery_status: 'delivering',
                pacing_index: 1.05,
              },
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetMediaBuysResponse with snapshot should succeed: ${JSON.stringify(result.error?.issues)}`
    );
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

  test('GetMediaBuysResponseSchema rejects media buy missing required fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // Missing required: status, currency, total_budget, packages
    const invalidResponse = {
      media_buys: [
        {
          media_buy_id: 'mb_123',
          // status, currency, total_budget, packages all missing
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(invalidResponse);
    assert.ok(!result.success, 'GetMediaBuysResponse with missing required fields should fail');
  });

  test('GetCreativeFeaturesRequestSchema validates valid request', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.GetCreativeFeaturesRequestSchema, 'GetCreativeFeaturesRequestSchema should exist');

    const result = schemas.GetCreativeFeaturesRequestSchema.safeParse({
      creative_manifest: {
        format_id: { agent_url: 'https://creative.example.com', id: 'display_300x250' },
        assets: { banner: { url: 'https://example.com/banner.jpg' } },
      },
      feature_ids: ['viewability', 'brand_safety'],
    });
    assert.ok(
      result.success,
      `GetCreativeFeaturesRequest validation should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetCreativeFeaturesResponseSchema is importable', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    assert.ok(schemas.GetCreativeFeaturesResponseSchema, 'GetCreativeFeaturesResponseSchema should exist');
    assert.ok(typeof schemas.GetCreativeFeaturesResponseSchema.safeParse === 'function');
  });

  test('object schemas preserve unknown fields (passthrough)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // BrandReferenceSchema is a simple object schema — unknown fields should be preserved
    const input = {
      domain: 'example.com',
      brand_id: 'brand_123',
      platform_specific_field: 'should be kept',
    };

    const result = schemas.BrandReferenceSchema.safeParse(input);
    assert.ok(
      result.success,
      `BrandReference with extra field should succeed: ${JSON.stringify(result.error?.issues)}`
    );
    assert.strictEqual(
      result.data.platform_specific_field,
      'should be kept',
      'Extra field should be preserved after parsing'
    );
  });

  test('nested object schemas preserve unknown fields (passthrough)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // MediaBuySchema contains nested objects — verify unknown fields are kept at all levels
    const result = schemas.MediaBuySchema.safeParse({
      media_buy_id: 'mb_123',
      status: 'active',
      promoted_offering: 'Test Campaign',
      total_budget: 10000,
      packages: [],
      vendor_extension: 'top-level extra field',
    });

    assert.ok(result.success, `MediaBuy with extra field should succeed: ${JSON.stringify(result.error?.issues)}`);
    assert.strictEqual(
      result.data.vendor_extension,
      'top-level extra field',
      'Top-level extra field should be preserved'
    );
  });

  test('inline nested object schemas preserve unknown fields (passthrough)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // ProvenanceSchema has inline z.object() definitions for ai_tool, declared_by, c2pa, etc.
    // These nested objects must also have .passthrough() so their unknown fields are kept.
    const result = schemas.ProvenanceSchema.safeParse({
      ai_tool: {
        name: 'DALL-E',
        provider: 'OpenAI',
        extra_platform_field: 'should be kept inside nested object',
      },
    });

    assert.ok(
      result.success,
      `Provenance with nested extra field should succeed: ${JSON.stringify(result.error?.issues)}`
    );
    assert.strictEqual(
      result.data.ai_tool.extra_platform_field,
      'should be kept inside nested object',
      'Unknown fields inside nested inline objects should be preserved'
    );
  });

  test('all schemas convert to JSON Schema without errors', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const { toJSONSchema } = await import('zod/v4');

    const failures = [];
    for (const [name, value] of Object.entries(schemas)) {
      if (!name.endsWith('Schema')) continue;
      if (!value || typeof value.safeParse !== 'function') continue;

      try {
        toJSONSchema(value);
      } catch (err) {
        failures.push({ name, error: err.message });
      }
    }

    assert.strictEqual(
      failures.length,
      0,
      `${failures.length} schemas failed JSON Schema conversion:\n` +
        failures.map(f => `  ${f.name}: ${f.error}`).join('\n')
    );
  });

  test('schemas with record types have .shape access (not ZodIntersection)', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // These schemas previously lost .shape due to .and(z.record(...)) intersections
    const schemasToCheck = [
      'UpdateMediaBuyRequestSchema',
      'PackageUpdateSchema',
      'ProvidePerformanceFeedbackRequestSchema',
      // MediaBuyFeaturesSchema uses z.record(z.string(), z.boolean()) which is a typed
      // record — correctly kept as intersection to preserve the value type constraint.
    ];

    for (const name of schemasToCheck) {
      const schema = schemas[name];
      assert.ok(schema, `${name} should exist in generated schemas`);

      assert.ok(
        schema.shape !== undefined,
        `${name} should have .shape (got ${schema.constructor?.name || typeof schema})`
      );
    }
  });

  test('record schemas preserve value types after undefined removal', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    // GeographicBreakdownSupportSchema.metro was z.record(z.string(), z.union([z.boolean(), z.undefined()]))
    // Should now be z.record(z.string(), z.boolean()), not z.record(z.string(), z.unknown())
    const geo = schemas.GeographicBreakdownSupportSchema;
    const result = geo.safeParse({ metro: { NYC: 'not-a-boolean' } });
    assert.ok(!result.success, 'metro record should reject non-boolean values');

    const valid = geo.safeParse({ metro: { NYC: true } });
    assert.ok(valid.success, 'metro record should accept boolean values');
  });
});
