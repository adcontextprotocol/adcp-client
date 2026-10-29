/**
 * Bridge from subscription coverage to the consumer runtime's `ExpectedReportingPeriod`
 * (experimental `media_buy.reporting_subscriptions`).
 */
import type { ReportingSubscription, ReportingSubscriptionState } from '../../types/core.generated';
import type { ExpectedReportingCoverage, ExpectedReportingPeriod } from '../reconciliation';
import type { ExpectedSubscriptionObligationV1, ReportingSubscriptionVersionRecordV1 } from './coverage';
import type { ReportingSubscriptionDestinationMethodV1 } from './selection';

/**
 * The coverage function's version records from the seller readback plus the buyer's own
 * records of each version's configuration (the readback carries only the current one).
 */
export function reportingSubscriptionVersionRecordsV1(input: {
  state: ReportingSubscriptionState;
  /** Every version the buyer sent, keyed by `subscription_version`. */
  configurations: Readonly<Record<number, ReportingSubscription>>;
  /** Pattern and transport of the destination each version named. */
  destinationMethods?: Readonly<Record<number, ReportingSubscriptionDestinationMethodV1>>;
  /** In-place deactivations the buyer observed and later reversed. */
  inactiveIntervals?: ReadonlyArray<{ subscription_version: number; from: string; until?: string }>;
}): ReportingSubscriptionVersionRecordV1[] {
  const { state } = input;
  const entries = [
    ...[...(state.prior_versions ?? [])].reverse().map(prior => ({
      version: prior.subscription_version,
      accepted_at: prior.accepted_at,
      superseded_at: prior.superseded_at as string | undefined,
      deactivated_at: undefined as string | undefined,
    })),
    {
      version: state.subscription_version,
      accepted_at: state.accepted_at,
      superseded_at: undefined as string | undefined,
      deactivated_at: state.deactivated_at,
    },
  ];
  return entries.map(entry => {
    const configuration = input.configurations[entry.version];
    if (!configuration) {
      throw new TypeError(
        `No recorded configuration for ${state.subscription_id} version ${entry.version}; keep every version you send`
      );
    }
    const intervals = (input.inactiveIntervals ?? [])
      .filter(item => item.subscription_version === entry.version)
      .map(({ from, until }) => ({ from, ...(until !== undefined ? { until } : {}) }));
    const method = input.destinationMethods?.[entry.version];
    return {
      subscription_version: entry.version,
      accepted_at: entry.accepted_at,
      ...(entry.superseded_at !== undefined ? { superseded_at: entry.superseded_at } : {}),
      ...(entry.deactivated_at !== undefined ? { deactivated_at: entry.deactivated_at } : {}),
      ...(intervals.length > 0 ? { inactive_intervals: intervals } : {}),
      configuration: structuredClone({
        ...configuration,
        active: entry.deactivated_at === undefined ? true : false,
      }),
      ...(method ? { destination_method: method } : {}),
    };
  });
}

/** Per-offering pins an obligation must match beyond what coverage determines. */
export type SubscriptionExpectationTemplateV1 = Omit<
  ExpectedReportingPeriod,
  | 'deliveryConfigId'
  | 'deliveryConfigVersion'
  | 'reportDefinitionId'
  | 'mediaBuyIds'
  | 'periodStart'
  | 'periodEnd'
  | 'coverage'
> & {
  /** Defaults to full coverage of exactly the owed buys, with no package-level detail. */
  coverage?: ExpectedReportingCoverage;
};

/**
 * Turn owed obligations (from `groupExpectedSubscriptionPeriodsV1`) into the consumer
 * runtime's expected periods. `template` supplies the pins coverage cannot know: the
 * reporting profile and schema pins of the offering, the destination, verification profile,
 * finality and reconciliation mode.
 */
export function subscriptionExpectedReportingPeriodsV1(
  obligations: readonly ExpectedSubscriptionObligationV1[],
  template: (obligation: ExpectedSubscriptionObligationV1) => SubscriptionExpectationTemplateV1
): ExpectedReportingPeriod[] {
  return obligations.map(obligation => {
    const pins = template(obligation);
    const { coverage, ...rest } = pins;
    return {
      ...structuredClone(rest),
      deliveryConfigId: obligation.subscription_id,
      deliveryConfigVersion: obligation.subscription_version,
      reportDefinitionId: obligation.report_definition_id,
      mediaBuyIds: [...obligation.media_buy_ids],
      periodStart: obligation.period_start,
      periodEnd: obligation.period_end,
      coverage: coverage
        ? structuredClone(coverage)
        : {
            status: 'full',
            media_buy_ids: [...obligation.media_buy_ids],
            fully_covered_media_buy_ids: [...obligation.media_buy_ids],
            partially_covered_media_buy_ids: [],
            unsupported_media_buy_ids: [],
            unknown_media_buy_ids: [],
            package_ids: [],
            covered_package_ids: [],
            unsupported_package_ids: [],
            unknown_package_ids: [],
          },
    } as ExpectedReportingPeriod;
  });
}
