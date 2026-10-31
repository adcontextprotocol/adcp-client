/**
 * Which reporting-subscription wire fields a served release defines.
 *
 * Fields settled after AdCP 3.3.0-beta.1 (adcontextprotocol/adcp#8585, #8588, #8613, #8619) are
 * emitted only when the served release's own bundled schema declares them: earlier response
 * shapes are closed (`additionalProperties: false`). The answer comes from the bundle, not from
 * a version literal, so a release cut without these fields never opens the gate. The SDK's own
 * pin (3.3.0-beta.3) defines all of them; the gate stays for callers served an older release
 * (an external schema root, for example). A response without a served release (a direct
 * handler call outside protocol dispatch) is the pinned release, as in the Python SDK.
 */
import { canonicalize } from '../utils/jcs';
import { ADCP_VERSION } from '../version';
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
  /** `reporting-subscription-coverage.json` `excluded[].offering_id`. */
  perOfferingExclusions: boolean;
  /** `reporting-subscription-coverage.json` `status: "inactive"` with `deactivated_at` (adcp#8613). */
  inactiveCoverageStatus: boolean;
  /**
   * `reporting-subscription-state.json` `prior_versions_count`, `accounts_with_exceptions_count` and
   * `accounts_unauthorized_count` (adcp#8619): each bounded list carries its total.
   */
  readbackCounts: boolean;
}

const cache = new Map<string, ReportingSubscriptionReleaseFieldsV1>();

type Schema = Readonly<Record<string, unknown>> | undefined;
const properties = (schema: Schema): Record<string, unknown> =>
  ((schema?.properties as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
/** A local `#/definitions/...` reference resolved within the same document (beta.3 names its item shapes). */
function local(root: Schema, schema: Schema): Schema {
  const ref = (schema as { $ref?: unknown } | undefined)?.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/definitions/')) return schema;
  return (root?.definitions as Record<string, Schema> | undefined)?.[ref.slice('#/definitions/'.length)];
}
const itemProperties = (schema: Schema, field: string): Record<string, unknown> =>
  properties(local(schema, (properties(schema)[field] as { items?: Schema } | undefined)?.items));

function read(ref: string, version: string): Schema {
  try {
    return getSchemaDocumentByRef(ref, version)?.schema;
  } catch {
    return undefined;
  }
}

/** The settled fields the served release's bundle defines; absent means the SDK's pinned release. */
export function reportingSubscriptionReleaseFieldsV1(
  servedAdcpVersion: string | undefined = ADCP_VERSION
): ReportingSubscriptionReleaseFieldsV1 {
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
    perOfferingExclusions: 'offering_id' in itemProperties(coverage, 'excluded'),
    inactiveCoverageStatus:
      'deactivated_at' in properties(coverage) &&
      ((properties(coverage).status as { enum?: unknown[] } | undefined)?.enum ?? []).includes('inactive'),
    readbackCounts:
      'prior_versions_count' in properties(state) &&
      'accounts_with_exceptions_count' in properties(state) &&
      'accounts_unauthorized_count' in properties(state),
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
  if (Array.isArray(copy.excluded) && !fields.perOfferingExclusions) {
    copy.excluded = collapsePerOfferingExclusions(copy.excluded as Array<Record<string, unknown>>);
  }
  if (Array.isArray(copy.gaps) && !fields.perOfferingEntries) {
    copy.gaps = (copy.gaps as Array<Record<string, unknown>>).map(({ offering_id: _offering, ...gap }) => gap);
  }
  return copy as T;
}

/** The readback's bounded lists and their totals (adcp#8619). */
const READBACK_LISTS = [
  ['prior_versions', 'prior_versions_count'],
  ['accounts_with_exceptions', 'accounts_with_exceptions_count'],
  ['accounts_unauthorized', 'accounts_unauthorized_count'],
] as const;

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
      for (const [list, count] of READBACK_LISTS) {
        if (!fields.readbackCounts || !Array.isArray(next[list])) delete next[count];
        // A record written before the counts existed lists every entry it has, so its length is the total.
        else if (typeof next[count] !== 'number') next[count] = (next[list] as unknown[]).length;
      }
      return next;
    }),
  };
}

/**
 * For a release whose `excluded[]` has no `offering_id`: fold the per-offering entries of one
 * condition back into a single account-wide (or buy-wide) entry cut at the latest of their
 * instants, which is what the engine wrote before it emitted per-offering entries. It removes no
 * period a per-offering entry keeps owed on the latest calendar.
 */
function collapsePerOfferingExclusions(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const groups = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (entry.offering_id === undefined) {
      out.push(entry);
      continue;
    }
    const { offering_id: _offering, from, until, ...condition } = entry;
    const key = canonicalize(condition);
    const group = groups.get(key);
    if (!group) {
      const first = { ...condition, from, ...(until !== undefined ? { until } : {}) };
      groups.set(key, first);
      out.push(first);
      continue;
    }
    if (Date.parse(from as string) > Date.parse(group.from as string)) group.from = from;
    if (until === undefined || group.until === undefined) delete group.until;
    else if (Date.parse(until as string) > Date.parse(group.until as string)) group.until = until;
  }
  return out;
}
