/**
 * Buyer-computable coverage for principal-level reporting subscriptions
 * (experimental `media_buy.reporting_subscriptions`, AdCP 3.3).
 *
 * `owedSubscriptionPeriodsV1` is a pure function of plain data the buyer already holds:
 * its subscription versions and their `accepted_at`, its visible confirmed buys, the
 * account's grants and timezone, the seller's offerings, and the exceptions the seller
 * published in `get_reporting_status` `subscription_coverage`. It returns every period the
 * seller owes, period by period, so a missing report is the seller's to explain.
 *
 * The rule (`core/reporting-subscription.json` `x-adcp-validation.coverage` and `cutover`):
 *
 * 1. Each confirmed buy and each offering its packages resolve to under the version's
 *    selector is owed the complete periods of that offering's published schedule that
 *    start on or after the first boundary at or after the later of the version's
 *    `accepted_at` and the account's `authorized_at`, and that end after the buy's
 *    `confirmed_at` (so the period in which the buy is confirmed is owed in full);
 * 2. and that overlap the flight from `start_time` to the stop time, the earliest of
 *    `end_time`, the cancellation's delivery stop (`cancellation_effective_at`, else
 *    `canceled_at`; adcp#8617) and `completed_at`, with flight values taken as of the period's
 *    `scope_resolved_at` (its end) from the buy's `flight_history` (adcp#8618). A flight whose
 *    stop is at or before its start owes nothing. Periods are never clipped.
 * 3. Every change at an instant T that hands periods from an outgoing schedule to an
 *    incoming one (a new version, deactivation, a resolution change, an account timezone
 *    change) is a cutover: the outgoing schedule owes its periods that start before T in
 *    full, and the incoming schedule owes its periods that start at or after E, the end of
 *    the last of them. A billing incoming side owes the stretch from E to its first boundary
 *    as one stub period (adcp#8617). Reactivation resumes at the later of the reactivation
 *    instant and the E of the deactivation (adcp#8622).
 * 4. Each package resolves once per version, at the later of `accepted_at` and the buy's
 *    `confirmed_at`, among the offerings available then, and keeps that resolution until the
 *    offering is withdrawn (adcp#8619).
 * 5. Exceptions (`excluded[]`, `gaps[]`) and lost authority only ever remove periods.
 *
 * @packageDocumentation
 */
import { CoverageInputError } from '../../errors';
import type {
  ReportingSubscription,
  ReportingSubscriptionCoverage,
  ReportingSubscriptionState,
} from '../../types/core.generated';
import {
  assertReportingIanaTimezoneV1,
  createReportingPeriodCalendarV1,
  parseReportingPeriodDurationV1,
  type ReportingPeriodCalendarV1,
} from './calendar';
import {
  compareReportingIdsByteOrderV1,
  reportingSubscriptionScopeIncludesV1,
  resolveReportingSubscriptionPackageV1,
  type ReportingSubscriptionDestinationMethodV1,
  type ReportingSubscriptionOfferingV1,
} from './selection';

const DAY_MS = 86_400_000;
const DEFAULT_MAX_PERIODS = 100_000;
const DEFAULT_MAX_ITERATIONS = 2_000_000;

/**
 * One accepted `subscription_version`, as the buyer recorded it.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionVersionRecordV1 {
  subscription_version: number;
  /** The version's `accepted_at` from the `sync_principal`/`get_principal` readback. */
  accepted_at: string;
  /**
   * The next version's `accepted_at` (`prior_versions[].superseded_at`). Inferred from the
   * next record when absent.
   */
  superseded_at?: string;
  /** When `active: false` was applied (`deactivated_at`), for the current version. */
  deactivated_at?: string;
  /** That version's subscription, as sent (readback `configuration`). */
  configuration: ReportingSubscription;
  /**
   * `pattern` and `transport` of the destination `configuration.destination` names.
   * Required when the configuration names a destination.
   */
  destination_method?: ReportingSubscriptionDestinationMethodV1;
}

/**
 * One `flight_history[]` entry of a media buy (`core/media-buy.json`, adcp#8618): a retroactive
 * flight edit, with the flight in force before it.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionFlightHistoryEntryV1 {
  /** When the seller recorded the edit. Periods resolved after it use the later flight. */
  recorded_at: string;
  /** `start_time` in force before the edit. */
  start_time: string;
  /** Stop time in force before the edit. */
  stop_time: string;
}

/**
 * A media buy the caller can see through `get_media_buys`.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionBuyV1 {
  media_buy_id: string;
  /** Null or absent: not confirmed, so not covered. */
  confirmed_at?: string | null;
  start_time: string;
  end_time: string;
  /** `cancellation.canceled_at`: the delivery stop when `cancellation_effective_at` is absent. */
  canceled_at?: string;
  /**
   * `cancellation_effective_at` (adcp#8617): when delivery stops under the cancellation, later
   * than `canceled_at` through a notice period. When present it, not `canceled_at`, ends the flight.
   */
  cancellation_effective_at?: string;
  completed_at?: string;
  /**
   * Each package with its `reporting_delivery_offering_ids` snapshot from `get_media_buys`, fixed
   * at confirmation from its product's list (adcp#8618).
   */
  packages: ReadonlyArray<{ package_id: string; reporting_delivery_offering_ids: readonly string[] }>;
  /**
   * The buy's `flight_history` from `get_media_buys` (adcp#8618): its retroactive flight edits,
   * oldest first, each with the flight in force before it. The flight in force at an instant is
   * the one in the earliest entry recorded after it, or the current flight, so an extension or
   * reinstatement never makes an elapsed period owed.
   */
  flight_history?: readonly ReportingSubscriptionFlightHistoryEntryV1[];
}

/**
 * One grant of reporting authority over the account to the caller.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingSubscriptionGrantV1 {
  /**
   * When this grant began. The wire's `authorization.authorized_at` is the start of the
   * authorization chain and stays unchanged after a re-grant inside retention
   * (adcontextprotocol/adcp#8585); a buyer that saw only that value lists the continuation
   * with it (any value at or before the previous `unauthorized_at`), and the seller's
   * `gaps[]` then removes what the interruption cost. A later value starts a new chain, or
   * records the observed re-grant instant inside retention.
   */
  authorized_at: string;
  /** `accounts_unauthorized[].unauthorized_at` when it ended. Absent: still in force. */
  unauthorized_at?: string;
}

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export interface ReportingSubscriptionCoverageAccountV1 {
  account_id: string;
  /** The account's `operator` domain, needed when a version names `operator_domains`. */
  operator?: string;
  /**
   * The account's current IANA timezone as `list_accounts` shows it. Before a
   * `timezone_cutovers` entry, the entry's `previous_timezone` governs. Required when an
   * `account_timezone` offering resolves and no cutover covers the instant.
   */
  timezone?: string;
  /**
   * The seller-resolved upstream reporting timezone, the obligation's
   * `period.source_timezone`. Required when an `account_resolved` `source_timezone`
   * offering resolves.
   */
  source_timezone?: string;
  /**
   * Grants in order. A re-grant before the previous `accounts_unauthorized` entry expires
   * (`status_retention_days` after `unauthorized_at`) continues coverage; a later one is a
   * fresh start from its `authorized_at`.
   */
  grants: readonly ReportingSubscriptionGrantV1[];
}

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export interface OwedSubscriptionPeriodsInputV1 {
  subscription_id: string;
  /** Every version whose obligations matter, oldest first. */
  versions: readonly ReportingSubscriptionVersionRecordV1[];
  account: ReportingSubscriptionCoverageAccountV1;
  buys: readonly ReportingSubscriptionBuyV1[];
  /** Seller offerings as published, with `standard_dimensions` and `unmapped_dimensions`. */
  offerings: readonly ReportingSubscriptionOfferingV1[];
  /**
   * The readback's `inactive_intervals`, oldest first. Reactivation is a fresh start: nothing
   * that starts inside an interval is owed, and coverage resumes at the first boundary at or
   * after `reactivated_at`. An interval without `reactivated_at` is still open.
   */
  inactive_intervals?: ReportingSubscriptionState['inactive_intervals'];
  /** This subscription's `subscription_coverage` entry for the account, when one was read. */
  coverage?: Pick<ReportingSubscriptionCoverage, 'excluded' | 'gaps' | 'timezone_cutovers'>;
  /** The seller's `subscriptions.backfill_on_regrant`. Defaults to false. */
  backfill_on_regrant?: boolean;
  /** The seller's `status_retention_days`. Required when a grant was revoked and re-granted. */
  status_retention_days?: number;
  /** Only periods that have ended (been resolved) at or before this instant are returned. */
  now: string;
  /** Fail closed above this many periods. Defaults to 100000. */
  max_periods?: number;
  /** Fail closed above this many boundaries examined. Defaults to 2000000. */
  max_iterations?: number;
}

/**
 * One owed period for one (buy, offering) pair.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface OwedSubscriptionPeriodV1 {
  subscription_id: string;
  /** The version that owes it, the obligation's `delivery_config_version`. */
  subscription_version: number;
  account_id: string;
  media_buy_id: string;
  offering_id: string;
  report_definition_id: string;
  /** RFC 3339 instant, `toISOString()` form. */
  period_start: string;
  period_end: string;
  /**
   * A billing cutover stub (adcp#8617): the stretch from a cutover's E to the incoming schedule's
   * first boundary, owed as one period. Present only then.
   */
  stub?: true;
}

/**
 * Owed periods grouped the way the seller's obligations carry them.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface OwedSubscriptionObligationV1 {
  subscription_id: string;
  subscription_version: number;
  account_id: string;
  offering_id: string;
  report_definition_id: string;
  period_start: string;
  period_end: string;
  /** A billing cutover stub (adcp#8617); its obligation carries `stub: true`. */
  stub?: true;
  /** Sorted in byte order; the obligation's frozen `media_buy_ids`. */
  media_buy_ids: string[];
}

interface Flight {
  start: number;
  stop: number;
}

interface Window {
  from: number;
  until: number;
}

interface ResolvedOffering {
  offering: ReportingSubscriptionOfferingV1;
  calendar: ReportingPeriodCalendarV1;
}

interface Regime {
  from: number;
  until: number;
  version: ReportingSubscriptionVersionRecordV1;
  offerings: ResolvedOffering[];
  /** The instant each offering owed from (before its first boundary), set while walking. */
  handoffs: Map<string, number>;
  /**
   * Set when this regime follows an inactive interval (adcp#8622): the regime that was active
   * before the deactivation and the deactivation instant, so reactivation resumes no earlier
   * than the end of the last period owed before it.
   */
  resumes?: { regime: Regime; at: number };
}

interface AuthorityChain {
  start: number;
  /**
   * Revocations followed by a re-grant inside the retention window. `regrantedAt` is absent
   * when only the chain-start `authorized_at` was observed; the seller's gaps[] then applies.
   */
  interruptions: Array<{ revokedAt: number; regrantedAt?: number }>;
  /** Final revocation, when authority has not returned within retention. */
  end?: number;
}

/**
 * Every period a subscription owes for one account, one row per (buy, offering, period),
 * sorted by `period_start`, `subscription_version`, `offering_id` and `media_buy_id`.
 *
 * Throws `TypeError` for malformed input and `RangeError` when the result would exceed
 * `max_periods`.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function owedSubscriptionPeriodsV1(input: OwedSubscriptionPeriodsInputV1): OwedSubscriptionPeriodV1[] {
  const now = instant(input.now, 'now');
  const maxPeriods = input.max_periods ?? DEFAULT_MAX_PERIODS;
  if (!Number.isSafeInteger(maxPeriods) || maxPeriods < 1)
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'max_periods must be a positive integer', 'invalid_input');
  if (typeof input.subscription_id !== 'string' || input.subscription_id.length === 0) {
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'subscription_id is required', 'invalid_input');
  }
  const versions = normalizeVersions(input.versions, input.subscription_id, inactiveWindows(input.inactive_intervals));
  const chains = authorityChains(input.account.grants, input.status_retention_days);
  const timezones = timezoneTimeline(input.account.timezone, input.coverage?.timezone_cutovers);
  const removals = exceptionWindows(input.coverage);
  const offeringsById = new Map<string, ReportingSubscriptionOfferingV1>();
  for (const offering of input.offerings) {
    if (offeringsById.has(offering.offering_id))
      throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'offering_id values must be unique', 'invalid_input');
    offeringsById.set(offering.offering_id, offering);
  }
  const calendars = new Map<string, ReportingPeriodCalendarV1>();
  const result: OwedSubscriptionPeriodV1[] = [];
  const seenBuys = new Set<string>();
  const maxIterations = input.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      'max_iterations must be a positive integer',
      'invalid_input'
    );
  }
  let iterations = 0;

  for (const buy of input.buys) {
    if (seenBuys.has(buy.media_buy_id))
      throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'media_buy_id values must be unique', 'invalid_input');
    seenBuys.add(buy.media_buy_id);
    if (buy.confirmed_at === undefined || buy.confirmed_at === null) continue;
    const confirmedAt = instant(buy.confirmed_at, `${buy.media_buy_id}.confirmed_at`);
    const flights = flightTimeline(buy);
    const latestStop = Math.max(...flights.map(entry => entry.flight.stop));
    const earliestStart = Math.min(...flights.map(entry => entry.flight.start));
    const regimes = buildRegimes(buy, versions, input, offeringsById, timezones, calendars);

    for (let index = 0; index < regimes.length; index += 1) {
      const regime = regimes[index];
      if (regime === null || regime === undefined) continue;
      const predecessor = index > 0 ? regimes[index - 1] : null;
      for (const resolved of regime.offerings) {
        const { calendar, offering } = resolved;
        const { handoff, cutover } = incomingHandoff(regime, predecessor ?? null, resolved);
        regime.handoffs.set(offering.offering_id, handoff);
        const owes = (start: number, end: number): boolean => {
          if (coveringRemoval(removals, buy.media_buy_id, offering.offering_id, start) !== undefined) return false;
          const flight = flightAt(flights, end);
          return (
            flight.start < flight.stop && // an empty flight overlaps nothing
            start < flight.stop &&
            end > flight.start &&
            authorized(chains, calendar, start, input.backfill_on_regrant === true)
          );
        };
        // adcp#8617: when a cutover hands a billing feed periods from an E that is not one of its
        // boundaries, the stretch [E, first boundary) is owed as one stub period, so no billable
        // delivery goes unreported. Pacing and analytics leave it unowed.
        const firstBoundary = calendar.ceil(handoff);
        if (
          cutover &&
          offering.feed_purpose === 'billing' &&
          firstBoundary > handoff &&
          handoff < regime.until &&
          firstBoundary > confirmedAt &&
          firstBoundary <= now &&
          owes(handoff, firstBoundary)
        ) {
          result.push({
            subscription_id: input.subscription_id,
            subscription_version: regime.version.subscription_version,
            account_id: input.account.account_id,
            media_buy_id: buy.media_buy_id,
            offering_id: offering.offering_id,
            report_definition_id: offering.report_definition_id,
            period_start: new Date(handoff).toISOString(),
            period_end: new Date(firstBoundary).toISOString(),
            stub: true,
          });
          if (result.length > maxPeriods) {
            throw new CoverageInputError(
              'COVERAGE_BUDGET_EXCEEDED',
              `Expected subscription periods exceed max_periods (${maxPeriods})`
            );
          }
        }
        // A period starting before the last boundary at or before the earliest flight
        // start ends by then and cannot overlap any flight value, so skip ahead.
        let start = Math.max(firstOwedBoundary(calendar, handoff, confirmedAt), calendar.floor(earliestStart));
        while (start < regime.until && start < latestStop) {
          if (++iterations > maxIterations) {
            throw new CoverageInputError(
              'COVERAGE_BUDGET_EXCEEDED',
              `Expected subscription periods exceed the iteration budget (${maxIterations})`
            );
          }
          // next() is strictly later, so a zero-length period (a skipped civil date) is never owed.
          const end = calendar.next(start);
          if (end > now) break;
          const covering = coveringRemoval(removals, buy.media_buy_id, offering.offering_id, start);
          if (covering !== undefined) {
            // Skip the whole removed stretch rather than walking it boundary by boundary.
            if (!Number.isFinite(covering.until)) break;
            start = Math.max(end, calendar.ceil(covering.until));
            continue;
          }
          if (!owes(start, end)) {
            start = end;
            continue;
          }
          result.push({
            subscription_id: input.subscription_id,
            subscription_version: regime.version.subscription_version,
            account_id: input.account.account_id,
            media_buy_id: buy.media_buy_id,
            offering_id: offering.offering_id,
            report_definition_id: offering.report_definition_id,
            period_start: new Date(start).toISOString(),
            period_end: new Date(end).toISOString(),
          });
          if (result.length > maxPeriods) {
            throw new CoverageInputError(
              'COVERAGE_BUDGET_EXCEEDED',
              `Expected subscription periods exceed max_periods (${maxPeriods})`
            );
          }
          start = end;
        }
      }
    }
  }
  return result.sort(comparePeriods);
}

/**
 * The start rule, kept in one place (adcp#8593): the first boundary at or after the cutover
 * handoff (the version's `accepted_at`, or E after a cutover), and no period ending at or
 * before the buy's `confirmed_at`. A period ends after `confirmed_at` exactly when it starts
 * at or after the last boundary at or before it, so the period in which the buy is confirmed
 * is owed in full. The account's `authorized_at` term is applied per authorization chain in
 * `authorized`; ceil is monotone, so together the start bound is the first boundary at or
 * after the later of `accepted_at` and `authorized_at`.
 */
function firstOwedBoundary(calendar: ReportingPeriodCalendarV1, handoff: number, confirmedAt: number): number {
  return Math.max(calendar.ceil(handoff), calendar.floor(confirmedAt));
}

/**
 * Group owed periods into the obligations that must carry them, with frozen `media_buy_ids`.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function groupOwedSubscriptionPeriodsV1(
  periods: readonly OwedSubscriptionPeriodV1[]
): OwedSubscriptionObligationV1[] {
  const groups = new Map<string, OwedSubscriptionObligationV1>();
  for (const period of periods) {
    const key = JSON.stringify([
      period.subscription_id,
      period.subscription_version,
      period.account_id,
      period.offering_id,
      period.period_start,
      period.period_end,
      period.stub === true,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        subscription_id: period.subscription_id,
        subscription_version: period.subscription_version,
        account_id: period.account_id,
        offering_id: period.offering_id,
        report_definition_id: period.report_definition_id,
        period_start: period.period_start,
        period_end: period.period_end,
        ...(period.stub === true ? { stub: true as const } : {}),
        media_buy_ids: [],
      };
      groups.set(key, group);
    }
    if (!group.media_buy_ids.includes(period.media_buy_id)) group.media_buy_ids.push(period.media_buy_id);
  }
  return [...groups.values()]
    .map(group => ({ ...group, media_buy_ids: group.media_buy_ids.sort(compareReportingIdsByteOrderV1) }))
    .sort(
      (left, right) =>
        Date.parse(left.period_start) - Date.parse(right.period_start) ||
        left.subscription_version - right.subscription_version ||
        compareReportingIdsByteOrderV1(left.offering_id, right.offering_id)
    );
}

function comparePeriods(left: OwedSubscriptionPeriodV1, right: OwedSubscriptionPeriodV1): number {
  return (
    Date.parse(left.period_start) - Date.parse(right.period_start) ||
    left.subscription_version - right.subscription_version ||
    compareReportingIdsByteOrderV1(left.offering_id, right.offering_id) ||
    compareReportingIdsByteOrderV1(left.media_buy_id, right.media_buy_id)
  );
}

interface NormalizedVersion {
  record: ReportingSubscriptionVersionRecordV1;
  acceptedAt: number;
  /** Superseded or deactivated: periods starting at or after it are not this version's. */
  endsAt: number;
  inactive: Window[];
}

function normalizeVersions(
  records: readonly ReportingSubscriptionVersionRecordV1[],
  subscriptionId: string,
  globalInactive: readonly Window[]
): NormalizedVersion[] {
  if (!Array.isArray(records) || records.length === 0)
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'versions must list at least one version', 'invalid_input');
  const versions: NormalizedVersion[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const next = records[index + 1];
    const label = `version ${record.subscription_version}`;
    if (!Number.isSafeInteger(record.subscription_version) || record.subscription_version < 1) {
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        'subscription_version must be a positive integer',
        'invalid_input'
      );
    }
    // The selector's period_duration follows the schedule pattern (no W designator; a week is P7D). A
    // selector no offering could ever match is an input error, not an empty owed set.
    const selectorDuration = (record.configuration?.selector as { period_duration?: unknown } | undefined)
      ?.period_duration;
    if (selectorDuration !== undefined) parseReportingPeriodDurationV1(selectorDuration as string);
    if (record.configuration?.subscription_id !== subscriptionId) {
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        `${label} configuration names a different subscription_id`,
        'invalid_input'
      );
    }
    if (record.configuration.subscription_version !== record.subscription_version) {
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        `${label} configuration carries a different subscription_version`,
        'invalid_input'
      );
    }
    if (record.configuration.destination !== undefined && record.destination_method === undefined) {
      throw new CoverageInputError(
        'COVERAGE_INPUT_INCOMPLETE',
        `${label} names a destination; destination_method is required`,
        'missing_destination_method'
      );
    }
    const acceptedAt = instant(record.accepted_at, `${label} accepted_at`);
    const previous = versions.at(-1);
    if (
      previous &&
      (record.subscription_version <= previous.record.subscription_version || acceptedAt < previous.acceptedAt)
    ) {
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        'versions must be in ascending subscription_version and accepted_at order',
        'invalid_input'
      );
    }
    const supersededAt =
      record.superseded_at !== undefined
        ? instant(record.superseded_at, `${label} superseded_at`)
        : next !== undefined
          ? instant(next.accepted_at, `version ${next.subscription_version} accepted_at`)
          : Number.POSITIVE_INFINITY;
    if (next !== undefined && supersededAt !== instant(next.accepted_at, 'accepted_at')) {
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        `${label} superseded_at must equal the next version's accepted_at`,
        'invalid_input'
      );
    }
    const inactive: Window[] = [];
    if (record.deactivated_at !== undefined) {
      inactive.push({
        from: instant(record.deactivated_at, `${label} deactivated_at`),
        until: Number.POSITIVE_INFINITY,
      });
    } else if (
      record.configuration.active === false &&
      next === undefined &&
      !globalInactive.some(window => !Number.isFinite(window.until))
    ) {
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        `${label} is inactive; deactivated_at or an open inactive_intervals entry is required`,
        'invalid_input'
      );
    }
    versions.push({ record, acceptedAt, endsAt: supersededAt, inactive: [...inactive, ...globalInactive] });
  }
  return versions;
}

/** The readback's `inactive_intervals` as half-open windows. */
function inactiveWindows(intervals: ReportingSubscriptionState['inactive_intervals']): Window[] {
  if (intervals !== undefined && !Array.isArray(intervals))
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'inactive_intervals must be an array', 'invalid_input');
  return (intervals ?? []).map(interval => {
    const from = instant(interval.deactivated_at, 'inactive_intervals.deactivated_at');
    const until =
      interval.reactivated_at === undefined
        ? Number.POSITIVE_INFINITY
        : instant(interval.reactivated_at, 'inactive_intervals.reactivated_at');
    if (!(until > from))
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        'inactive_intervals reactivated_at must be after deactivated_at',
        'invalid_input'
      );
    return { from, until };
  });
}

function authorityChains(
  grants: readonly ReportingSubscriptionGrantV1[],
  retentionDays: number | undefined
): AuthorityChain[] {
  if (!Array.isArray(grants))
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'account.grants must be an array', 'invalid_input');
  const chains: AuthorityChain[] = [];
  let previousEnd: number | undefined;
  for (let index = 0; index < grants.length; index += 1) {
    const grant = grants[index]!;
    const authorizedAt = instant(grant.authorized_at, 'grants.authorized_at');
    const unauthorizedAt =
      grant.unauthorized_at === undefined ? undefined : instant(grant.unauthorized_at, 'grants.unauthorized_at');
    if (unauthorizedAt !== undefined && unauthorizedAt < authorizedAt) {
      throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'A grant cannot end before it began', 'invalid_input');
    }
    if (previousEnd === undefined && index > 0)
      throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'Only the last grant may be unrevoked', 'invalid_input');
    const current = chains.at(-1);
    if (current !== undefined && previousEnd !== undefined) {
      if (authorizedAt <= previousEnd) {
        // The wire's authorized_at stays at the chain's first grant after a re-grant inside
        // retention (adcontextprotocol/adcp#8585), so the buyer does not know the re-grant
        // instant. The chain continues and the seller's gaps[] says what it removed.
        current.interruptions.push({ revokedAt: previousEnd });
        delete current.end;
      } else if (retentionDays === undefined || !Number.isSafeInteger(retentionDays) || retentionDays < 1) {
        throw new CoverageInputError(
          'COVERAGE_INPUT_INCOMPLETE',
          'status_retention_days is required to evaluate a re-grant',
          'missing_status_retention_days'
        );
      } else if (authorizedAt < previousEnd + retentionDays * DAY_MS) {
        current.interruptions.push({ revokedAt: previousEnd, regrantedAt: authorizedAt });
        delete current.end;
      } else {
        chains.push({ start: authorizedAt, interruptions: [] });
      }
    } else {
      chains.push({ start: authorizedAt, interruptions: [] });
    }
    if (unauthorizedAt !== undefined) chains.at(-1)!.end = unauthorizedAt;
    previousEnd = unauthorizedAt;
  }
  return chains;
}

/**
 * Whether the account was authorized for a period starting at `start`, under `calendar`'s
 * boundaries. Coverage within a chain begins at the first boundary at or after its first
 * grant. A revocation removes periods from the last boundary at or before it; a re-grant
 * inside retention restores them from the first boundary at or after it, or, with
 * `backfill_on_regrant`, keeps the revoked interval owed.
 */
function authorized(
  chains: readonly AuthorityChain[],
  calendar: ReportingPeriodCalendarV1,
  start: number,
  backfill: boolean
): boolean {
  return chains.some(chain => {
    if (start < calendar.ceil(chain.start)) return false;
    if (chain.end !== undefined && start >= calendar.floor(chain.end)) return false;
    if (!backfill) {
      for (const gap of chain.interruptions) {
        if (gap.regrantedAt === undefined) continue;
        if (start >= calendar.floor(gap.revokedAt) && start < calendar.ceil(gap.regrantedAt)) return false;
      }
    }
    return true;
  });
}

interface TimezoneCutover {
  at: number;
  timezone: string;
  previous?: string;
  offeringId?: string;
}

interface TimezoneTimeline {
  current: string | undefined;
  cutovers: TimezoneCutover[];
}

function timezoneTimeline(
  current: string | undefined,
  entries: ReportingSubscriptionCoverage['timezone_cutovers']
): TimezoneTimeline {
  if (current !== undefined) assertReportingIanaTimezoneV1(current, 'account.timezone');
  const cutovers = [...(entries ?? [])]
    .map(entry => {
      assertReportingIanaTimezoneV1(entry.timezone, 'timezone_cutovers.timezone');
      if (entry.previous_timezone !== undefined) {
        assertReportingIanaTimezoneV1(entry.previous_timezone, 'timezone_cutovers.previous_timezone');
      }
      return {
        at: instant(entry.effective_at, 'timezone_cutovers.effective_at'),
        timezone: entry.timezone,
        ...(entry.previous_timezone !== undefined ? { previous: entry.previous_timezone } : {}),
        ...(entry.offering_id !== undefined ? { offeringId: entry.offering_id } : {}),
      };
    })
    .sort((left, right) => left.at - right.at);
  return { current, cutovers };
}

/**
 * The account timezone governing one offering at an instant. Entries without `offering_id`
 * apply to every offering. Before an offering's first cutover its `previous_timezone`
 * governs; after the last, its `timezone`; with no cutovers, the account's current zone.
 */
function timezoneFor(timeline: TimezoneTimeline, offeringId: string, at: number): string | undefined {
  const applicable = timeline.cutovers.filter(
    cutover => cutover.offeringId === undefined || cutover.offeringId === offeringId
  );
  if (applicable.length === 0) return timeline.current;
  if (at < applicable[0]!.at) {
    if (applicable[0]!.previous === undefined) {
      throw new CoverageInputError(
        'COVERAGE_INPUT_INCOMPLETE',
        'timezone_cutovers entries require previous_timezone',
        'missing_previous_timezone'
      );
    }
    return applicable[0]!.previous;
  }
  let zone = applicable[0]!.timezone;
  for (const cutover of applicable) if (cutover.at <= at) zone = cutover.timezone;
  return zone;
}

interface ExceptionWindow extends Window {
  mediaBuyId?: string;
  /** Exclusions and gaps may name one offering; absent applies to every offering. */
  offeringId?: string;
}

function exceptionWindows(coverage: OwedSubscriptionPeriodsInputV1['coverage']): ExceptionWindow[] {
  const windows: ExceptionWindow[] = [];
  for (const entry of coverage?.excluded ?? []) {
    // A package-level offering_unsupported entry removes packages from the buy's
    // coverage, not periods: the buy stays covered for its other packages.
    if (entry.package_ids !== undefined) continue;
    windows.push({
      from: instant(entry.from, 'excluded.from'),
      until: entry.until === undefined ? Number.POSITIVE_INFINITY : instant(entry.until, 'excluded.until'),
      ...(entry.media_buy_id !== undefined ? { mediaBuyId: entry.media_buy_id } : {}),
      // With different period boundaries the seller lists one entry per offering, each with that
      // offering's cutover instants; it removes only that offering's periods.
      ...(entry.offering_id !== undefined ? { offeringId: entry.offering_id } : {}),
    });
  }
  for (const gap of coverage?.gaps ?? []) {
    windows.push({
      from: instant(gap.from, 'gaps.from'),
      until: instant(gap.until, 'gaps.until'),
      ...(gap.offering_id !== undefined ? { offeringId: gap.offering_id } : {}),
    });
  }
  return windows;
}

/** `excluded[]` entries naming packages of one buy, as half-open windows. */
function packageExclusions(
  coverage: OwedSubscriptionPeriodsInputV1['coverage'],
  mediaBuyId: string
): Array<{ from: number; until: number; packageIds: readonly string[] }> {
  return (coverage?.excluded ?? [])
    .filter(entry => entry.media_buy_id === mediaBuyId && entry.package_ids !== undefined)
    .map(entry => ({
      from: instant(entry.from, 'excluded.from'),
      until: entry.until === undefined ? Number.POSITIVE_INFINITY : instant(entry.until, 'excluded.until'),
      packageIds: entry.package_ids!,
    }));
}

function coveringRemoval(
  windows: readonly ExceptionWindow[],
  mediaBuyId: string,
  offeringId: string,
  start: number
): ExceptionWindow | undefined {
  return windows.find(
    window =>
      (window.mediaBuyId === undefined || window.mediaBuyId === mediaBuyId) &&
      (window.offeringId === undefined || window.offeringId === offeringId) &&
      start >= window.from &&
      start < window.until
  );
}

/**
 * The buy's flights over time: each `flight_history` entry governs instants before its
 * `recorded_at` (adcp#8618), and the current flight governs the rest. The current stop time is
 * the earliest of `end_time`, the cancellation's delivery stop (`cancellation_effective_at`, or
 * `canceled_at` when it is absent; adcp#8617) and `completed_at`.
 */
function flightTimeline(buy: ReportingSubscriptionBuyV1): Array<{ until: number; flight: Flight }> {
  const label = buy.media_buy_id;
  const stops = [instant(buy.end_time, `${label}.end_time`)];
  if (buy.cancellation_effective_at !== undefined) {
    stops.push(instant(buy.cancellation_effective_at, `${label}.cancellation_effective_at`));
  } else if (buy.canceled_at !== undefined) {
    stops.push(instant(buy.canceled_at, `${label}.canceled_at`));
  }
  if (buy.completed_at !== undefined) stops.push(instant(buy.completed_at, `${label}.completed_at`));
  const current: Flight = { start: instant(buy.start_time, `${label}.start_time`), stop: Math.min(...stops) };
  if (buy.flight_history !== undefined && !Array.isArray(buy.flight_history)) {
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', `${label}.flight_history must be an array`, 'invalid_input');
  }
  const history = [...(buy.flight_history ?? [])]
    .map(entry => ({
      until: instant(entry.recorded_at, `${label}.flight_history.recorded_at`),
      flight: {
        start: instant(entry.start_time, `${label}.flight_history.start_time`),
        stop: instant(entry.stop_time, `${label}.flight_history.stop_time`),
      },
    }))
    .sort((left, right) => left.until - right.until);
  return [...history, { until: Number.POSITIVE_INFINITY, flight: current }];
}

/**
 * Flight values in effect at a period's `scope_resolved_at`: the earliest `flight_history` entry
 * recorded after it, else the current flight.
 */
function flightAt(timeline: ReadonlyArray<{ until: number; flight: Flight }>, resolvedAt: number): Flight {
  return timeline.find(entry => resolvedAt < entry.until)!.flight;
}

/**
 * Split the timeline into regimes: maximal intervals in which one version is active for the
 * account and the buy's resolved offerings and their calendars are unchanged. `null` marks
 * an interval with no active version, which breaks cutover continuity.
 */
function buildRegimes(
  buy: ReportingSubscriptionBuyV1,
  versions: readonly NormalizedVersion[],
  input: OwedSubscriptionPeriodsInputV1,
  offeringsById: ReadonlyMap<string, ReportingSubscriptionOfferingV1>,
  timezones: TimezoneTimeline,
  calendars: Map<string, ReportingPeriodCalendarV1>
): Array<Regime | null> {
  const points = new Set<number>();
  for (const version of versions) {
    points.add(version.acceptedAt);
    if (Number.isFinite(version.endsAt)) points.add(version.endsAt);
    for (const window of version.inactive) {
      points.add(window.from);
      if (Number.isFinite(window.until)) points.add(window.until);
    }
  }
  for (const offering of offeringsById.values()) {
    if (offering.available_from !== undefined) points.add(instant(offering.available_from, 'available_from'));
    if (offering.withdrawn_at !== undefined) points.add(instant(offering.withdrawn_at, 'withdrawn_at'));
  }
  for (const cutover of timezones.cutovers) points.add(cutover.at);
  // Package-level exceptions change which packages the buy resolves for (adcp#8619).
  for (const window of packageExclusions(input.coverage, buy.media_buy_id)) {
    points.add(window.from);
    if (Number.isFinite(window.until)) points.add(window.until);
  }
  const ordered = [...points].sort((left, right) => left - right);
  const regimes: Array<Regime | null> = [];
  // adcp#8619: membership edits (account_ids, exclude_account_ids) apply in place and the seller
  // records them per account as excluded_by_buyer intervals. When such an entry is published, the
  // intervals govern membership instead of the version's current lists, so periods that started
  // before a removal stay owed.
  const membershipByExceptions = (input.coverage?.excluded ?? []).some(
    entry => entry.reason === 'excluded_by_buyer' && entry.media_buy_id === undefined
  );
  // The regime active before a deactivation, while the subscription stays inactive (adcp#8622).
  let pendingResume: { regime: Regime; at: number } | undefined;
  for (let index = 0; index < ordered.length; index += 1) {
    const from = ordered[index]!;
    const until = ordered[index + 1] ?? Number.POSITIVE_INFINITY;
    const current = (candidate: NormalizedVersion) => from >= candidate.acceptedAt && from < candidate.endsAt;
    const inactiveAt = (candidate: NormalizedVersion) =>
      candidate.inactive.some(window => from >= window.from && from < window.until);
    const version = versions.find(candidate => current(candidate) && !inactiveAt(candidate));
    const configuration = version?.record.configuration;
    const inScope =
      configuration !== undefined &&
      reportingSubscriptionScopeIncludesV1(
        membershipByExceptions
          ? {
              scope: { all_authorized_accounts: true },
              ...(configuration.operator_domains ? { operator_domains: configuration.operator_domains } : {}),
            }
          : configuration,
        {
          account_id: input.account.account_id,
          ...(input.account.operator !== undefined ? { operator: input.account.operator } : {}),
        }
      );
    if (!version || !inScope) {
      const previous = regimes.at(-1);
      if (version === undefined && versions.some(candidate => current(candidate) && inactiveAt(candidate))) {
        if (previous) pendingResume = { regime: previous, at: from };
      } else {
        pendingResume = undefined;
      }
      if (previous !== null) regimes.push(null);
      continue;
    }
    const offerings = resolveForBuy(buy, version.record, input, offeringsById, timezones, from, calendars);
    const previous = regimes.at(-1);
    if (previous && previous.version === version.record && sameResolution(previous.offerings, offerings)) {
      previous.until = until;
      continue;
    }
    regimes.push({
      from,
      until,
      version: version.record,
      offerings,
      handoffs: new Map(),
      ...(previous === null && pendingResume !== undefined ? { resumes: pendingResume } : {}),
    });
    pendingResume = undefined;
  }
  return regimes;
}

function sameResolution(left: readonly ResolvedOffering[], right: readonly ResolvedOffering[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.offering.offering_id === right[index]!.offering.offering_id &&
        entry.calendar.key === right[index]!.calendar.key
    )
  );
}

function resolveForBuy(
  buy: ReportingSubscriptionBuyV1,
  version: ReportingSubscriptionVersionRecordV1,
  input: OwedSubscriptionPeriodsInputV1,
  offeringsById: ReadonlyMap<string, ReportingSubscriptionOfferingV1>,
  timezones: TimezoneTimeline,
  at: number,
  calendars: Map<string, ReportingPeriodCalendarV1>
): ResolvedOffering[] {
  const ids = new Set<string>();
  const removed = packageExclusions(input.coverage, buy.media_buy_id).filter(
    window => at >= window.from && at < window.until
  );
  for (const pkg of buy.packages) {
    // A package-level exception (overridden: another subscription of the caller owes it; or
    // offering_unsupported) removes the package from the buy's coverage, not the buy's periods.
    if (removed.some(window => window.packageIds.includes(pkg.package_id))) continue;
    for (const id of packageResolutionAt(buy, pkg, version, offeringsById, at)) ids.add(id);
  }
  return [...ids].sort(compareReportingIdsByteOrderV1).map(id => {
    const offering = offeringsById.get(id)!;
    const spec = calendarSpec(
      offering,
      version.configuration.selector.period_timezone,
      offering.schedule.alignment === 'account_timezone' && version.configuration.selector.period_timezone === undefined
        ? timezoneFor(timezones, id, at)
        : undefined,
      input.account.source_timezone
    );
    const key = JSON.stringify(spec);
    let calendar = calendars.get(key);
    if (!calendar) {
      calendar = createReportingPeriodCalendarV1(spec);
      calendars.set(key, calendar);
    }
    return { offering, calendar };
  });
}

/** The offerings one package resolves at `at`: sticky per (buy, version) (adcp#8619). */
function packageResolutionAt(
  buy: ReportingSubscriptionBuyV1,
  pkg: ReportingSubscriptionBuyV1['packages'][number],
  version: ReportingSubscriptionVersionRecordV1,
  offeringsById: ReadonlyMap<string, ReportingSubscriptionOfferingV1>,
  at: number
): string[] {
  return resolveReportingSubscriptionPackageV1({
    selector: version.configuration.selector,
    reconciliation_mode: version.configuration.reconciliation_mode,
    ...(version.destination_method ? { destination_method: version.destination_method } : {}),
    offerings: [...offeringsById.values()],
    eligible_offering_ids: pkg.reporting_delivery_offering_ids,
    resolves_at: Math.max(
      instant(version.accepted_at, `version ${version.subscription_version} accepted_at`),
      buy.confirmed_at ? instant(buy.confirmed_at, `${buy.media_buy_id}.confirmed_at`) : Number.NEGATIVE_INFINITY
    ),
    at,
  });
}

/**
 * Where the incoming side of a regime starts owing, and whether that start is a cutover (which
 * owes a billing stub). After an adjacent regime it is the cutover's E. After an inactive interval
 * (adcp#8622) it is the later of the reactivation instant and the E computed at the deactivation
 * instant against the regime that was active then: a reactivation before that E is a cutover with
 * E equal to it, so nothing is owed twice; a later one is a fresh start.
 */
function incomingHandoff(
  regime: Regime,
  predecessor: Regime | null,
  incoming: ResolvedOffering
): { handoff: number; cutover: boolean } {
  if (predecessor !== null) {
    return { handoff: cutoverEnd(regime.from, predecessor, incoming), cutover: predecessor.offerings.length > 0 };
  }
  if (regime.resumes !== undefined && regime.resumes.regime.offerings.length > 0) {
    const end = cutoverEnd(regime.resumes.at, regime.resumes.regime, incoming);
    if (end > regime.from) return { handoff: end, cutover: true };
  }
  return { handoff: regime.from, cutover: false };
}

/** The published schedule's calendar for this account, with any `period_timezone` override. */
function calendarSpec(
  offering: ReportingSubscriptionOfferingV1,
  override: string | undefined,
  accountTimezone: string | undefined,
  sourceTimezone: string | undefined
) {
  const schedule = offering.schedule;
  const base = { period_duration: schedule.period_duration, alignment: schedule.alignment };
  switch (schedule.alignment) {
    case 'utc':
      return base;
    case 'account_timezone': {
      const timezone = override ?? accountTimezone;
      if (timezone === undefined) {
        throw new CoverageInputError(
          'COVERAGE_INPUT_INCOMPLETE',
          `Offering ${offering.offering_id} is account_timezone aligned; account.timezone is required`,
          'missing_account_timezone'
        );
      }
      return { ...base, timezone };
    }
    case 'source_timezone': {
      // A period_timezone override only ever matches the offering's own published zone.
      const timezone = schedule.period_timezone_policy === 'fixed' ? schedule.period_timezone : sourceTimezone;
      if (timezone === undefined) {
        throw new CoverageInputError(
          'COVERAGE_INPUT_INCOMPLETE',
          `Offering ${offering.offering_id} resolves its source timezone per account; account.source_timezone is required`,
          'missing_source_timezone'
        );
      }
      return { ...base, timezone };
    }
    case 'billing_cycle':
      return { ...base, timezone: schedule.period_timezone!, period_anchor: schedule.period_anchor! };
    default:
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        `Offering ${offering.offering_id} has an unknown alignment`,
        'invalid_input'
      );
  }
}

/**
 * The instant from which an incoming schedule owes periods (before taking its first
 * boundary at or after it). With no adjacent outgoing regime this is the regime start, the
 * ordinary start rule. Otherwise it is E, the end of the last outgoing period that started
 * before the handoff: the same offering's own outgoing calendar when it continues, or the
 * latest such end across the outgoing offerings when the resolution changed, so that
 * nothing is owed twice.
 */
function cutoverEnd(handoff: number, predecessor: Regime | null, incoming: ResolvedOffering): number {
  if (predecessor === null || predecessor.offerings.length === 0) return handoff;
  const same = predecessor.offerings.find(entry => entry.offering.offering_id === incoming.offering.offering_id);
  const end = same
    ? same.calendar.ceil(handoff)
    : Math.max(...predecessor.offerings.map(entry => entry.calendar.ceil(handoff)));
  // A predecessor that itself only began owing at a later E (two cutovers inside one
  // period) hands off no earlier than that: its outgoing period still runs to there.
  const carried = same
    ? predecessor.handoffs.get(incoming.offering.offering_id)
    : predecessor.handoffs.size > 0
      ? Math.max(...predecessor.handoffs.values())
      : undefined;
  return carried === undefined ? end : Math.max(end, carried);
}

function instant(value: unknown, field: string): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  ) {
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', `${field} must be an RFC 3339 date-time`, 'invalid_instant');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', `${field} must be an RFC 3339 date-time`, 'invalid_instant');
  return parsed;
}

/** @deprecated Renamed {@link owedSubscriptionPeriodsV1}: "owed" is the one word for what a seller must deliver. This alias is removed in a later beta. */
export const expectedSubscriptionPeriods = owedSubscriptionPeriodsV1;
/** @deprecated Renamed {@link groupOwedSubscriptionPeriodsV1}: "owed" is the one word for what a seller must deliver. This alias is removed in a later beta. */
export const groupExpectedSubscriptionPeriodsV1 = groupOwedSubscriptionPeriodsV1;
/** @deprecated Renamed {@link OwedSubscriptionPeriodV1}: "owed" is the one word for what a seller must deliver. This alias is removed in a later beta. */
export type ExpectedSubscriptionPeriodV1 = OwedSubscriptionPeriodV1;
/** @deprecated Renamed {@link OwedSubscriptionObligationV1}: "owed" is the one word for what a seller must deliver. This alias is removed in a later beta. */
export type ExpectedSubscriptionObligationV1 = OwedSubscriptionObligationV1;
/** @deprecated Renamed {@link OwedSubscriptionPeriodsInputV1}: "owed" is the one word for what a seller must deliver. This alias is removed in a later beta. */
export type ExpectedSubscriptionPeriodsInputV1 = OwedSubscriptionPeriodsInputV1;
