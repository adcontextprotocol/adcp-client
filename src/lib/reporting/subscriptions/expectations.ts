/**
 * Bridge from subscription coverage to the consumer runtime's `ExpectedReportingPeriod`
 * (experimental `media_buy.reporting_subscriptions`).
 */
import type { ReportingSubscription, ReportingSubscriptionState } from '../../types/core.generated';
import type { ExpectedReportingCoverage, ExpectedReportingPeriod } from '../reconciliation';
import type { ExpectedSubscriptionObligationV1, ReportingSubscriptionVersionRecordV1 } from './coverage';
import type { ReportingSubscriptionDestinationMethodV1 } from './selection';

/**
 * The coverage function's version records from the seller readback. Each version's
 * configuration comes from the buyer's own records when given, else from the readback: the
 * current `configuration`, and `prior_versions[].configuration` from sellers on
 * 3.3.0-beta.2 or later (adcp#8588). Pass the readback's `inactive_intervals` to
 * `expectedSubscriptionPeriods` unchanged.
 */
export function reportingSubscriptionVersionRecordsV1(input: {
  state: ReportingSubscriptionState;
  /** Versions the buyer sent, keyed by `subscription_version`. Required for a version the readback does not carry. */
  configurations?: Readonly<Record<number, ReportingSubscription>>;
  /** Pattern and transport of the destination each version named. */
  destinationMethods?: Readonly<Record<number, ReportingSubscriptionDestinationMethodV1>>;
}): ReportingSubscriptionVersionRecordV1[] {
  const { state } = input;
  // TODO(3.3.0-beta.2): read prior_versions[].configuration from the generated type.
  const priors = (state.prior_versions ?? []) as ReadonlyArray<
    NonNullable<ReportingSubscriptionState['prior_versions']>[number] & { configuration?: ReportingSubscription }
  >;
  const entries = [
    ...[...priors].reverse().map(prior => ({
      version: prior.subscription_version,
      accepted_at: prior.accepted_at,
      superseded_at: prior.superseded_at as string | undefined,
      deactivated_at: undefined as string | undefined,
      published: prior.configuration,
    })),
    {
      version: state.subscription_version,
      accepted_at: state.accepted_at,
      superseded_at: undefined as string | undefined,
      deactivated_at: state.deactivated_at,
      published: state.configuration as ReportingSubscription | undefined,
    },
  ];
  return entries.map(entry => {
    const configuration = input.configurations?.[entry.version] ?? entry.published;
    if (!configuration) {
      throw new TypeError(
        `No configuration for ${state.subscription_id} version ${entry.version}: the readback does not carry it, so keep every version you send`
      );
    }
    const method = input.destinationMethods?.[entry.version];
    return {
      subscription_version: entry.version,
      accepted_at: entry.accepted_at,
      ...(entry.superseded_at !== undefined ? { superseded_at: entry.superseded_at } : {}),
      ...(entry.deactivated_at !== undefined ? { deactivated_at: entry.deactivated_at } : {}),
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
  /**
   * The coverage the obligation must report. Required: the seller reports package-level
   * detail and `partial` coverage for package-level `offering_unsupported` exceptions, so no
   * default could match a real obligation.
   */
  coverage: ExpectedReportingCoverage;
};

/**
 * Turn owed obligations (from `groupExpectedSubscriptionPeriodsV1`) into the consumer
 * runtime's expected periods. `template` supplies the pins coverage cannot know: the
 * reporting profile and schema pins of the offering, the destination, verification profile,
 * finality and reconciliation mode, and the coverage the obligation must report (its package
 * sets, and `partial` where packages carry an `offering_unsupported` exception).
 */
export function subscriptionExpectedReportingPeriodsV1(
  obligations: readonly ExpectedSubscriptionObligationV1[],
  template: (obligation: ExpectedSubscriptionObligationV1) => SubscriptionExpectationTemplateV1
): ExpectedReportingPeriod[] {
  return obligations.map(obligation => {
    const pins = template(obligation);
    const { coverage, ...rest } = pins;
    if (!coverage || typeof coverage !== 'object') {
      throw new TypeError(
        `The expectation template must supply coverage for ${obligation.subscription_id} ${obligation.period_start}`
      );
    }
    return {
      ...structuredClone(rest),
      deliveryConfigId: obligation.subscription_id,
      deliveryConfigVersion: obligation.subscription_version,
      reportDefinitionId: obligation.report_definition_id,
      mediaBuyIds: [...obligation.media_buy_ids],
      periodStart: obligation.period_start,
      periodEnd: obligation.period_end,
      coverage: structuredClone(coverage),
    } as ExpectedReportingPeriod;
  });
}
