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
