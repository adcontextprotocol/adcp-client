/**
 * Backward Compatibility Schema Tests
 *
 * Verifies that v3-required fields which were absent in v2.5/v2.6 schemas
 * are treated as optional during response validation. Real agents implementing
 * older spec versions must not cause hard validation failures.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

describe('Backward compat: get_media_buy_delivery schema', () => {
  let schemas;

  test('GetMediaBuyDeliveryResponseSchema is importable', async () => {
    schemas = await import('../../dist/lib/types/schemas.generated.js');
    assert.ok(schemas.GetMediaBuyDeliveryResponseSchema, 'Schema should exist');
  });

  test('accepts by_package without rate (v2.5/v2.6 agent response)', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');

    const response = {
      reporting_period: { start: '2026-02-13T00:00:00Z', end: '2026-03-04T00:00:00Z' },
      currency: 'USD',
      media_buy_deliveries: [
        {
          media_buy_id: 'mb_e3ea59fce51a',
          status: 'completed',
          totals: { impressions: 309188, spend: 948.4 },
          by_package: [
            {
              // Missing rate - exactly the real Planet Nine failure case
              package_id: 'pkg_prod_f195cdc6_8e19c5b9_1',
              impressions: 309188,
              spend: 948.4,
              pacing_index: 0,
              pricing_model: 'cpm',
              currency: 'EUR',
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuyDeliveryResponseSchema.safeParse(response);
    assert.ok(result.success, `Should accept missing rate: ${JSON.stringify(result.error?.issues)}`);
  });

  test('accepts by_package without pricing_model (v2 agent response)', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');

    const response = {
      reporting_period: { start: '2026-02-13T00:00:00Z', end: '2026-03-04T00:00:00Z' },
      currency: 'USD',
      media_buy_deliveries: [
        {
          media_buy_id: 'mb_test',
          status: 'active',
          totals: { impressions: 100, spend: 5.0 },
          by_package: [
            {
              package_id: 'pkg_001',
              impressions: 100,
              spend: 5.0,
              // No pricing_model, rate, or currency - pure v2 by_package
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuyDeliveryResponseSchema.safeParse(response);
    assert.ok(
      result.success,
      `Should accept missing pricing_model/rate/currency: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('accepts by_package with some packages missing rate and some having it', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');

    // Second real failure case from logs: by_package[1] has no rate but by_package[0] does
    const response = {
      reporting_period: { start: '2026-02-13T00:00:00Z', end: '2026-03-04T00:00:00Z' },
      currency: 'USD',
      media_buy_deliveries: [
        {
          media_buy_id: 'mb_6aede37757b9',
          status: 'active',
          totals: { impressions: 309188, spend: 948.4 },
          by_package: [
            {
              package_id: 'pkg_prod_850cfa44_ff600151_1',
              impressions: 154594,
              spend: 474.2,
              pacing_index: 1,
              pricing_model: 'cpm',
              rate: 5.7, // has rate
              currency: 'EUR',
            },
            {
              package_id: 'pkg_prod_aec72200_fb37ca4d_2',
              impressions: 154594,
              spend: 474.2,
              pacing_index: 1,
              pricing_model: 'cpm',
              // no rate
              currency: 'EUR',
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuyDeliveryResponseSchema.safeParse(response);
    assert.ok(
      result.success,
      `Mixed rate presence should pass: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('accepts by_keyword items without keyword field (v2 agent)', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');

    const response = {
      reporting_period: { start: '2026-02-13T00:00:00Z', end: '2026-03-04T00:00:00Z' },
      currency: 'USD',
      media_buy_deliveries: [
        {
          media_buy_id: 'mb_test',
          status: 'active',
          totals: { impressions: 100, spend: 5.0 },
          by_package: [
            {
              package_id: 'pkg_001',
              impressions: 100,
              spend: 5.0,
              by_keyword: [
                // v2 agent provides keyword breakdowns but without keyword/match_type IDs
                { impressions: 50, spend: 2.5 },
                { impressions: 50, spend: 2.5 },
              ],
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuyDeliveryResponseSchema.safeParse(response);
    assert.ok(
      result.success,
      `Should accept by_keyword without keyword ID: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('still accepts fully compliant v3 response with all fields', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');

    const response = {
      reporting_period: { start: '2026-02-13T00:00:00Z', end: '2026-03-04T00:00:00Z' },
      currency: 'USD',
      media_buy_deliveries: [
        {
          media_buy_id: 'mb_full',
          status: 'completed',
          totals: { impressions: 100000, spend: 500.0 },
          by_package: [
            {
              package_id: 'pkg_full',
              impressions: 100000,
              spend: 500.0,
              pricing_model: 'cpm',
              rate: 5.0,
              currency: 'USD',
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuyDeliveryResponseSchema.safeParse(response);
    assert.ok(result.success, `Full v3 response should still pass: ${JSON.stringify(result.error?.issues)}`);
  });
});

describe('Backward compat: get_media_buys schema', () => {
  let schemas;

  test('GetMediaBuysResponseSchema is importable', async () => {
    schemas = await import('../../dist/lib/types/schemas.generated.js');
    assert.ok(schemas.GetMediaBuysResponseSchema, 'Schema should exist');
  });

  test('accepts media_buy without total_budget (v2 agent response)', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');

    const response = {
      media_buys: [
        {
          media_buy_id: 'mb_test',
          status: 'active',
          currency: 'USD',
          // No total_budget - v2 agents may not include this
          packages: [],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(response);
    assert.ok(
      result.success,
      `Should accept missing total_budget: ${JSON.stringify(result.error?.issues)}`
    );
  });

  test('accepts creative_approvals without approval_status (v2 agent response)', async () => {
    if (!schemas) schemas = await import('../../dist/lib/types/schemas.generated.js');

    const response = {
      media_buys: [
        {
          media_buy_id: 'mb_test',
          status: 'active',
          currency: 'USD',
          packages: [
            {
              package_id: 'pkg_001',
              creative_approvals: [
                {
                  creative_id: 'cr_001',
                  // No approval_status - v2 agents may not include this
                },
              ],
            },
          ],
        },
      ],
    };

    const result = schemas.GetMediaBuysResponseSchema.safeParse(response);
    assert.ok(
      result.success,
      `Should accept creative_approvals without approval_status: ${JSON.stringify(result.error?.issues)}`
    );
  });
});
