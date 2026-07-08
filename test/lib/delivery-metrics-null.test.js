/**
 * Delivery metrics allow null for "not applicable" video-only metrics.
 *
 * Sellers running non-video inventory (display, audio-only, DOOH-without-video)
 * legitimately return null for `quartile_data` and `completion_rate` — the
 * "not applicable" signal. The schema must accept null for these fields while
 * still enforcing the [0, 1] bound on non-null `completion_rate` values.
 *
 * Fixture mirrors the shape that threw WebhookPayloadValidationError in
 * ingestStorefrontRoutePollReport (Sentry AGENTIC-API-9P): a display buy
 * whose totals and per-package rows carry null video metrics.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DeliveryMetricsSchema, GetMediaBuyDeliveryResponseSchema } = require('../../dist/lib/types/schemas.generated');

describe('DeliveryMetrics null-for-not-applicable', () => {
  it('accepts null completion_rate and null quartile_data', () => {
    const result = DeliveryMetricsSchema.safeParse({
      impressions: 1000,
      spend: 12.5,
      completion_rate: null,
      quartile_data: null,
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it('still accepts populated video metrics', () => {
    const result = DeliveryMetricsSchema.safeParse({
      impressions: 1000,
      completion_rate: 0.82,
      quartile_data: { q1_views: 900, q2_views: 850, q3_views: 800, q4_views: 780 },
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it('still rejects an out-of-range non-null completion_rate', () => {
    const result = DeliveryMetricsSchema.safeParse({ completion_rate: 1.5 });
    assert.equal(result.success, false);
  });

  it('does not broaden the type beyond null (rejects strings)', () => {
    const rate = DeliveryMetricsSchema.safeParse({ completion_rate: 'n/a' });
    const quartiles = DeliveryMetricsSchema.safeParse({ quartile_data: 'n/a' });
    assert.equal(rate.success, false);
    assert.equal(quartiles.success, false);
  });

  it('validates a get_media_buy_delivery response with null video metrics on a display buy', () => {
    const result = GetMediaBuyDeliveryResponseSchema.safeParse({
      status: 'completed',
      reporting_period: {
        start: '2026-07-01T00:00:00Z',
        end: '2026-07-02T00:00:00Z',
      },
      media_buy_deliveries: [
        {
          media_buy_id: 'mb_display_1',
          status: 'active',
          totals: {
            impressions: 500000,
            spend: 1250.0,
            clicks: 1200,
            quartile_data: null,
          },
          by_package: [
            {
              package_id: 'pkg_display_1',
              impressions: 500000,
              spend: 1250.0,
              completion_rate: null,
              quartile_data: null,
            },
          ],
        },
      ],
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
});
