/**
 * Sensible defaults for ReportingCapabilities — a required field on Product
 * with 6 required sub-fields. Spread into your product definitions:
 *
 * @example
 * ```typescript
 * const product = {
 *   product_id: 'display-1',
 *   name: 'Display Ads',
 *   reporting_capabilities: DEFAULT_REPORTING_CAPABILITIES,
 * };
 * ```
 */

import type { ReportingCapabilities } from '../types/core.generated';

export const DEFAULT_REPORTING_CAPABILITIES: ReportingCapabilities = {
  available_reporting_frequencies: ['daily'],
  expected_delay_minutes: 240,
  timezone: 'UTC',
  supports_webhooks: false,
  available_metrics: ['impressions', 'spend', 'clicks'],
  date_range_support: 'date_range',
};
