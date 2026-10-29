/**
 * Reporting-subscription wire fields settled after AdCP 3.3.0-beta.1 (adcontextprotocol/adcp#8585),
 * hand-modeled until the next published bundle.
 *
 * TODO(3.3.0-beta.2): regenerate types from the published bundle and replace these with the
 * generated `ReportingDeliveryOffering`, `ReportingSubscriptionState` and
 * `ReportingSubscriptionCoverage` shapes.
 */
import type {
  ReportingDeliveryOffering,
  ReportingDimension,
  ReportingSubscriptionCoverage,
  ReportingSubscriptionState,
} from '../../types/core.generated';

/** `core/reporting-delivery-offering.json` with the 3.3 subscription matching fields. */
export type ReportingDeliveryOfferingWithDimensionsV1 = ReportingDeliveryOffering & {
  /**
   * The offering's breakdown in the standard vocabulary. Empty for totals only. Sellers
   * advertising `media_buy.reporting_subscriptions` MUST include it on every offering.
   */
  standard_dimensions?: ReportingDimension[] | string[];
  /** Native report-definition dimensions with no standard mapping. Present when any exist. */
  unmapped_dimensions?: string[];
};

/** One `inactive_intervals[]` readback entry. */
export interface ReportingSubscriptionInactiveIntervalV1 {
  deactivated_at: string;
  /** Absent for the current interval while the subscription is inactive. */
  reactivated_at?: string;
}

/** `core/reporting-subscription-state.json` with `inactive_intervals`. */
export type ReportingSubscriptionStateWithIntervalsV1 = ReportingSubscriptionState & {
  inactive_intervals?: ReportingSubscriptionInactiveIntervalV1[];
};

/** One `timezone_cutovers[]` entry with `previous_timezone` and an optional `offering_id`. */
export interface ReportingSubscriptionTimezoneCutoverV1 {
  /** Sellers MUST include it. */
  previous_timezone?: string;
  /** Absent: every account_timezone offering on the account. */
  offering_id?: string;
  effective_at: string;
  timezone: string;
}

/** One `gaps[]` entry with an optional `offering_id`. */
export interface ReportingSubscriptionGapV1 {
  /** Absent: every offering on the account. */
  offering_id?: string;
  from: string;
  until: string;
  reason: 'unauthorized';
}

/** `core/reporting-subscription-coverage.json` with per-offering cutovers and gaps. */
export type ReportingSubscriptionCoverageWithOfferingsV1 = Omit<
  ReportingSubscriptionCoverage,
  'timezone_cutovers' | 'gaps'
> & {
  timezone_cutovers?: ReportingSubscriptionTimezoneCutoverV1[];
  gaps?: ReportingSubscriptionGapV1[];
};

/**
 * First release whose schemas define the fields above. Earlier response shapes are closed
 * (`additionalProperties: false`), so sellers serving an earlier release must omit them.
 *
 * TODO(3.3.0-beta.2): confirm the published release includes adcontextprotocol/adcp#8585.
 */
export const REPORTING_SUBSCRIPTION_SETTLED_FIELDS_RELEASE = '3.3.0-beta.2';

/**
 * Whether a response served at `servedAdcpVersion` may carry the fields settled after
 * 3.3.0-beta.1. A context without a served release (direct handler calls) gets them.
 */
export function servesSettledReportingSubscriptionFieldsV1(
  servedAdcpVersion: string | undefined,
  isAtLeast: (version: string, minimum: string) => boolean
): boolean {
  return servedAdcpVersion === undefined || isAtLeast(servedAdcpVersion, REPORTING_SUBSCRIPTION_SETTLED_FIELDS_RELEASE);
}

/** Remove the settled fields from a `subscription_coverage[]` entry for an earlier release. */
export function withoutSettledCoverageFieldsV1<T extends Record<string, unknown>>(entry: T): T {
  const copy = structuredClone(entry) as Record<string, unknown>;
  if (Array.isArray(copy.timezone_cutovers)) {
    copy.timezone_cutovers = (copy.timezone_cutovers as Array<Record<string, unknown>>).map(
      ({ previous_timezone: _previous, offering_id: _offering, ...rest }) => rest
    );
  }
  if (Array.isArray(copy.gaps)) {
    copy.gaps = (copy.gaps as Array<Record<string, unknown>>).map(({ offering_id: _offering, ...rest }) => rest);
  }
  return copy as T;
}
