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

  // --- Lifecycle field tests ---

  test('GetMediaBuysRequestSchema validates request with include_history', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.GetMediaBuysRequestSchema.safeParse({
      account: { account_id: 'acc_123' },
      media_buy_ids: ['mb_123'],
      include_history: 10,
    });
    assert.ok(
      result.success,
      `GetMediaBuysRequest with include_history should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysResponseSchema validates response with lifecycle fields', async () => {
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
          confirmed_at: '2026-01-15T10:00:00Z',
          revision: 3,
          valid_actions: ['pause', 'cancel', 'update_budget'],
          packages: [
            {
              package_id: 'pkg_1',
              budget: 25000,
              creative_deadline: '2026-02-01T23:59:59Z',
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetMediaBuysResponse with lifecycle fields should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysResponseSchema validates canceled media buy with cancellation fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validResponse = {
      media_buys: [
        {
          media_buy_id: 'mb_456',
          status: 'canceled',
          currency: 'USD',
          total_budget: 30000,
          confirmed_at: '2026-01-10T08:00:00Z',
          canceled_at: '2026-01-20T14:30:00Z',
          canceled_by: 'buyer',
          cancellation_reason: 'Campaign strategy changed',
          revision: 5,
          valid_actions: [],
          packages: [
            {
              package_id: 'pkg_2',
              budget: 30000,
              canceled: true,
              canceled_at: '2026-01-20T14:30:00Z',
              canceled_by: 'buyer',
              cancellation_reason: 'Parent media buy canceled',
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetMediaBuysResponse with canceled media buy should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetMediaBuysResponseSchema validates response with history entries', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validResponse = {
      media_buys: [
        {
          media_buy_id: 'mb_789',
          status: 'active',
          currency: 'USD',
          total_budget: 25000,
          revision: 3,
          history: [
            { revision: 3, timestamp: '2026-01-18T12:00:00Z', action: 'resumed', actor: 'buyer-agent' },
            { revision: 2, timestamp: '2026-01-17T10:00:00Z', action: 'paused', actor: 'buyer-agent', summary: 'Paused for budget review' },
            { revision: 1, timestamp: '2026-01-15T10:00:00Z', action: 'created', summary: 'Created with 2 packages, budget $25,000' },
          ],
          packages: [{ package_id: 'pkg_1', budget: 25000 }],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(validResponse);
    assert.ok(
      result.success,
      `GetMediaBuysResponse with history should succeed: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('MediaBuySchema validates media buy with lifecycle fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.MediaBuySchema.safeParse({
      media_buy_id: 'mb_123',
      status: 'canceled',
      promoted_offering: 'Test Campaign',
      total_budget: 10000,
      confirmed_at: '2026-01-10T08:00:00Z',
      canceled_at: '2026-01-15T12:00:00Z',
      canceled_by: 'seller',
      cancellation_reason: 'Policy violation',
      revision: 4,
      packages: [],
    });
    assert.ok(
      result.success,
      `MediaBuy with lifecycle fields should succeed: ${JSON.stringify(result.error?.issues)}`
    );
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

  // ---- Audience governance schemas ----

  test('AudienceSelectorSchema validates signal-type selector', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const signalSelector = {
      type: 'signal',
      signal_id: { source: 'catalog', data_provider_domain: 'signals.example.com', id: 'ev_buyers' },
      value_type: 'binary',
      value: true,
    };

    const result = schemas.AudienceSelectorSchema.safeParse(signalSelector);
    assert.ok(result.success, `Signal selector should validate: ${JSON.stringify(result.error?.issues)}`);
    assert.strictEqual(result.data.type, 'signal');
  });

  test('AudienceSelectorSchema validates description-type selector', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const descSelector = {
      type: 'description',
      description: 'Adults aged 25-54 in urban areas',
      category: 'demographic',
    };

    const result = schemas.AudienceSelectorSchema.safeParse(descSelector);
    assert.ok(result.success, `Description selector should validate: ${JSON.stringify(result.error?.issues)}`);
    assert.strictEqual(result.data.type, 'description');
  });

  test('AudienceSelectorSchema validates categorical signal selector', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const catSelector = {
      type: 'signal',
      signal_id: { source: 'catalog', data_provider_domain: 'signals.example.com', id: 'income_bracket' },
      value_type: 'categorical',
      values: ['high', 'medium'],
    };

    const result = schemas.AudienceSelectorSchema.safeParse(catSelector);
    assert.ok(result.success, `Categorical signal selector should validate: ${JSON.stringify(result.error?.issues)}`);
  });

  test('AudienceConstraintsSchema validates include/exclude arrays', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const constraints = {
      include: [{ type: 'description', description: 'Adults 25-54 interested in home improvement' }],
      exclude: [{ type: 'description', description: 'Children under 13' }],
    };

    const result = schemas.AudienceConstraintsSchema.safeParse(constraints);
    assert.ok(result.success, `Audience constraints should validate: ${JSON.stringify(result.error?.issues)}`);
    assert.strictEqual(result.data.include.length, 1);
    assert.strictEqual(result.data.exclude.length, 1);
  });

  test('RestrictedAttributeSchema validates GDPR Article 9 categories', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validValues = [
      'racial_ethnic_origin',
      'political_opinions',
      'religious_beliefs',
      'trade_union_membership',
      'health_data',
      'sex_life_sexual_orientation',
      'genetic_data',
      'biometric_data',
    ];

    for (const value of validValues) {
      const result = schemas.RestrictedAttributeSchema.safeParse(value);
      assert.ok(result.success, `"${value}" should be a valid restricted attribute`);
    }
  });

  test('RestrictedAttributeSchema rejects invalid values', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.RestrictedAttributeSchema.safeParse('financial_status');
    assert.ok(!result.success, 'Non-enum value should be rejected');
  });

  test('MatchIdTypeSchema validates identifier types', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const validTypes = ['hashed_email', 'hashed_phone', 'rampid', 'id5', 'uid2', 'euid', 'pairid', 'maid', 'other'];

    for (const idType of validTypes) {
      const result = schemas.MatchIDTypeSchema.safeParse(idType);
      assert.ok(result.success, `"${idType}" should be a valid match ID type`);
    }
  });

  test('MatchIdTypeSchema rejects invalid values', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const result = schemas.MatchIDTypeSchema.safeParse('cookie_id');
    assert.ok(!result.success, 'Non-enum value should be rejected');
  });

  test('SyncPlansRequestSchema validates plan with audience governance fields', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const planWithAudience = {
      plans: [
        {
          plan_id: 'plan-tylenol-q4',
          brand: { domain: 'tylenol.com' },
          objectives: "Drive awareness of children's Tylenol",
          budget: { total: 500000, currency: 'USD', authority_level: 'agent_full' },
          flight: { start: '2026-04-01T00:00:00Z', end: '2026-06-30T00:00:00Z' },
          countries: ['US'],
          policy_categories: ['children_directed', 'pharmaceutical_advertising'],
          audience: {
            include: [{ type: 'description', description: 'Parents of children aged 2-12' }],
            exclude: [{ type: 'description', description: 'Children under 13' }],
          },
          restricted_attributes: ['health_data'],
          restricted_attributes_custom: ['parental_status'],
          min_audience_size: 1000,
          policy_ids: ['us_coppa_data_collection'],
        },
      ],
    };

    const result = schemas.SyncPlansRequestSchema.safeParse(planWithAudience);
    assert.ok(result.success, `Plan with audience fields should validate: ${JSON.stringify(result.error?.issues)}`);
  });

  test('SyncPlansRequestSchema rejects invalid restricted_attributes', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const plan = {
      plans: [
        {
          plan_id: 'plan-1',
          brand: { domain: 'example.com' },
          objectives: 'Test',
          budget: { total: 1000, currency: 'USD', authority_level: 'agent_full' },
          flight: { start: '2026-04-01T00:00:00Z', end: '2026-06-30T00:00:00Z' },
          restricted_attributes: ['invalid_attribute'],
        },
      ],
    };

    const result = schemas.SyncPlansRequestSchema.safeParse(plan);
    assert.ok(!result.success, 'Invalid restricted_attribute value should be rejected');
  });

  test('CheckGovernanceRequestSchema validates delivery_metrics with audience_distribution', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const request = {
      plan_id: 'plan-1',
      binding: 'committed',
      caller: 'https://seller.example.com',
      phase: 'delivery',
      delivery_metrics: {
        reporting_period: { start: '2026-04-01T00:00:00Z', end: '2026-04-08T00:00:00Z' },
        spend: 12500,
        cumulative_spend: 125000,
        impressions: 500000,
        cumulative_impressions: 5000000,
        pacing: 'on_track',
        audience_distribution: {
          baseline: 'platform',
          indices: {
            'age:18-24': 0.8,
            'age:25-34': 1.4,
            'gender:female': 1.05,
          },
          cumulative_indices: {
            'age:18-24': 0.85,
            'age:25-34': 1.35,
            'gender:female': 1.03,
          },
        },
      },
    };

    const result = schemas.CheckGovernanceRequestSchema.safeParse(request);
    assert.ok(
      result.success,
      `Delivery metrics with audience_distribution should validate: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('SyncAudiencesSuccessSchema validates response with match breakdown', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const response = {
      audiences: [
        {
          audience_id: 'existing_customers',
          action: 'updated',
          status: 'ready',
          uploaded_count: 5000,
          matched_count: 18750,
          effective_match_rate: 0.75,
          match_breakdown: [
            { id_type: 'hashed_email', submitted: 25000, matched: 17500, match_rate: 0.7 },
            { id_type: 'hashed_phone', submitted: 15000, matched: 12000, match_rate: 0.8 },
            { id_type: 'rampid', submitted: 8000, matched: 7200, match_rate: 0.9 },
          ],
        },
      ],
    };

    const result = schemas.SyncAudiencesSuccessSchema.safeParse(response);
    assert.ok(
      result.success,
      `Sync audiences with match breakdown should validate: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('GetSignalsResponseSchema validates signals with governance metadata', async () => {
    if (!schemas) {
      schemas = await import('../../dist/lib/types/schemas.generated.js');
    }

    const response = {
      signals: [
        {
          signal_agent_segment_id: 'seg-001',
          name: 'Chronic Condition Households',
          description: 'Households with modeled indicators of chronic health conditions',
          signal_type: 'marketplace',
          data_provider: 'Health Data Co',
          coverage_percentage: 8.2,
          deployments: [{ type: 'platform', platform: 'dv360', is_live: false }],
          pricing_options: [{ pricing_option_id: 'spo1', model: 'cpm', cpm: 3.5, currency: 'USD' }],
          restricted_attributes: ['health_data'],
          policy_categories: ['pharmaceutical_advertising', 'health_wellness'],
        },
      ],
    };

    const result = schemas.GetSignalsResponseSchema.safeParse(response);
    assert.ok(
      result.success,
      `Signal with governance metadata should validate: ${JSON.stringify(result.error?.issues)}`
    );
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
