/**
 * Which reporting-subscription wire fields a served release defines.
 *
 * Fields settled after AdCP 3.3.0-beta.1 (adcontextprotocol/adcp#8585, #8588) are emitted only
 * when the served release's own bundled schema declares them: earlier response shapes are
 * closed (`additionalProperties: false`). The answer comes from the bundle, not from a
 * version literal, so a release cut without these fields never opens the gate. A response
 * without a served release (a direct handler call outside protocol dispatch) gets none of
 * them; read the internal state APIs for the complete record.
 */
import { getSchemaDocumentByRef } from '../validation/schema-loader';

export interface ReportingSubscriptionReleaseFieldsV1 {
  /** `reporting-delivery-offering.json` `standard_dimensions` / `unmapped_dimensions`. */
  offeringDimensions: boolean;
  /** `reporting-subscription-state.json` `inactive_intervals`. */
  inactiveIntervals: boolean;
  /** `reporting-subscription-state.json` `prior_versions[].configuration`. */
  priorVersionConfiguration: boolean;
  /** `reporting-subscription-coverage.json` `timezone_cutovers[].previous_timezone`. */
  cutoverPreviousTimezone: boolean;
  /** `reporting-subscription-coverage.json` `offering_id` on cutovers and gaps. */
  perOfferingEntries: boolean;
  /** `reporting-subscription-coverage.json` `status: "inactive"` with `deactivated_at` (adcp#8613). */
  inactiveCoverageStatus: boolean;
}

const NONE: ReportingSubscriptionReleaseFieldsV1 = Object.freeze({
  offeringDimensions: false,
  inactiveIntervals: false,
  priorVersionConfiguration: false,
  cutoverPreviousTimezone: false,
  perOfferingEntries: false,
  inactiveCoverageStatus: false,
});

const cache = new Map<string, ReportingSubscriptionReleaseFieldsV1>();

type Schema = Readonly<Record<string, unknown>> | undefined;
const properties = (schema: Schema): Record<string, unknown> =>
  ((schema?.properties as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
const itemProperties = (schema: Schema, field: string): Record<string, unknown> =>
  properties((properties(schema)[field] as { items?: Schema } | undefined)?.items);

function read(ref: string, version: string): Schema {
  try {
    return getSchemaDocumentByRef(ref, version)?.schema;
  } catch {
    return undefined;
  }
}

/** The settled fields the served release's bundle defines; none when no release is served. */
export function reportingSubscriptionReleaseFieldsV1(
  servedAdcpVersion: string | undefined
): ReportingSubscriptionReleaseFieldsV1 {
  if (servedAdcpVersion === undefined) return NONE;
  const cached = cache.get(servedAdcpVersion);
  if (cached) return cached;
  const offering = read('core/reporting-delivery-offering.json', servedAdcpVersion);
  const state = read('core/reporting-subscription-state.json', servedAdcpVersion);
  const coverage = read('core/reporting-subscription-coverage.json', servedAdcpVersion);
  const result = Object.freeze({
    offeringDimensions: 'standard_dimensions' in properties(offering),
    inactiveIntervals: 'inactive_intervals' in properties(state),
    priorVersionConfiguration: 'configuration' in itemProperties(state, 'prior_versions'),
    cutoverPreviousTimezone: 'previous_timezone' in itemProperties(coverage, 'timezone_cutovers'),
    perOfferingEntries:
      'offering_id' in itemProperties(coverage, 'timezone_cutovers') &&
      'offering_id' in itemProperties(coverage, 'gaps'),
    inactiveCoverageStatus:
      'deactivated_at' in properties(coverage) &&
      ((properties(coverage).status as { enum?: unknown[] } | undefined)?.enum ?? []).includes('inactive'),
  });
  if (cache.size > 64) cache.clear();
  cache.set(servedAdcpVersion, result);
  return result;
}

/** Project a `subscription_coverage[]` entry onto the fields a release defines. */
export function reportingSubscriptionCoverageForReleaseV1<T extends Record<string, unknown>>(
  entry: T,
  fields: ReportingSubscriptionReleaseFieldsV1
): T {
  const copy = structuredClone(entry) as Record<string, unknown>;
  if (copy.status === 'inactive' && !fields.inactiveCoverageStatus) {
    // Earlier releases have no inactive value: report the account-level state as before.
    const open = ((copy.excluded as Array<Record<string, unknown>> | undefined) ?? []).filter(
      item => item.until === undefined && item.media_buy_id === undefined
    );
    copy.status = open.some(item => item.reason === 'action_required')
      ? 'action_required'
      : open.length > 0
        ? 'excluded'
        : 'active';
    delete copy.deactivated_at;
  }
  if (Array.isArray(copy.timezone_cutovers)) {
    copy.timezone_cutovers = (copy.timezone_cutovers as Array<Record<string, unknown>>).map(cutover => {
      const next = { ...cutover };
      if (!fields.cutoverPreviousTimezone) delete next.previous_timezone;
      if (!fields.perOfferingEntries) delete next.offering_id;
      return next;
    });
  }
  if (Array.isArray(copy.gaps) && !fields.perOfferingEntries) {
    copy.gaps = (copy.gaps as Array<Record<string, unknown>>).map(({ offering_id: _offering, ...gap }) => gap);
  }
  return copy as T;
}

/** Project a principal configuration's `reporting_subscriptions` onto a release. */
export function reportingSubscriptionStatesForReleaseV1<T extends { reporting_subscriptions?: unknown }>(
  configuration: T,
  fields: ReportingSubscriptionReleaseFieldsV1
): T {
  if (!Array.isArray(configuration.reporting_subscriptions)) return configuration;
  return {
    ...configuration,
    reporting_subscriptions: (configuration.reporting_subscriptions as Array<Record<string, unknown>>).map(state => {
      const next = { ...state };
      if (!fields.inactiveIntervals) delete next.inactive_intervals;
      if (!fields.priorVersionConfiguration && Array.isArray(next.prior_versions)) {
        next.prior_versions = (next.prior_versions as Array<Record<string, unknown>>).map(
          ({ configuration: _configuration, ...prior }) => prior
        );
      }
      return next;
    }),
  };
}
