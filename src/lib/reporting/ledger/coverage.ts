import { createHash } from 'node:crypto';

import { canonicalJsonV1 } from '../source';
import type {
  ReportingSubscriptionReceiptAdmissionV1,
  ReportingLedgerConfigurationV1,
  ReportingLedgerOwedSetProgressV1,
  ReportingLedgerOwedSetV1,
  ReportingLedgerSnapshotQueryV1,
  PrincipalRef,
  ReportingLedgerSubscriptionV1,
} from './types';
import {
  frozenCalendarObligationsCoverOwnership,
  isFrozenCalendarRulesMismatch,
  reportingPeriodSchedule,
} from './schedule';

export function reportingLedgerEffectivePeriod(query: ReportingLedgerSnapshotQueryV1, ledgerAsOf: string) {
  return {
    start: query.period?.start ?? new Date(Date.parse(ledgerAsOf) - 24 * 60 * 60 * 1_000).toISOString(),
    end: query.period?.end ?? ledgerAsOf,
  };
}

export function reportingLedgerScopeClosed(
  query: ReportingLedgerSnapshotQueryV1,
  ledgerAsOf: string,
  coverageComplete = true
): boolean {
  return (
    Date.parse(reportingLedgerEffectivePeriod(query, ledgerAsOf).end) <= Date.parse(ledgerAsOf) && coverageComplete
  );
}

/**
 * Whether evaluated coverage lets the scope close: every grid generation is complete and every
 * owed-set generation's horizon has reached the scope end. `coverage_complete` stays
 * `complete` alone, because an owed set that is still being frozen is not missing history.
 * @experimental Storage-facing building block; see docs/guides/REPORTING-STABILITY.md.
 */
export function reportingLedgerCoverageClosedV1(coverage: { complete: boolean; owedSetOpen?: boolean }): boolean {
  return coverage.complete && coverage.owedSetOpen !== true;
}

/**
 * Whether a generation owns an owed set (a principal-level reporting subscription) rather than a
 * contiguous period grid.
 * @experimental Storage-facing building block; see docs/guides/REPORTING-STABILITY.md.
 */
export function isReportingLedgerOwedSetV1(configuration: {
  subscription?: ReportingLedgerSubscriptionV1 | undefined;
}): boolean {
  return configuration.subscription?.ownership === 'owed_set';
}

/**
 * The uniqueness discriminator a store keys generations by beside `(account_id,
 * delivery_config_id, delivery_config_version)`: empty for an account generation, and a digest
 * of the owning principal and the resolved offering for a subscription generation.
 * @experimental Storage-facing building block; see docs/guides/REPORTING-STABILITY.md.
 */
export function reportingLedgerSubscriptionKeyV1(configuration: {
  subscription?: ReportingLedgerSubscriptionV1 | undefined;
}): string {
  const subscription = configuration.subscription;
  if (!subscription) return '';
  return createHash('sha256')
    .update(
      canonicalJsonV1(['subscription-key-v1', subscription.tenantId, subscription.principalId, subscription.offeringId])
    )
    .digest('hex');
}

/**
 * Whether a generation or obligation is visible to the authenticated principal: account
 * generations always are, a subscription generation only to its owner, and nothing of a
 * subscription without a principal.
 * @experimental Storage-facing building block; see docs/guides/REPORTING-STABILITY.md.
 */
export function reportingLedgerSubscriptionVisibleV1(
  value: { subscription?: ReportingLedgerSubscriptionV1 | undefined },
  principal: PrincipalRef | undefined
): boolean {
  const subscription = value.subscription;
  if (!subscription) return true;
  return (
    principal !== undefined &&
    subscription.tenantId === principal.tenantId &&
    subscription.principalId === principal.principalId
  );
}

/**
 * `periodOrdinal` of an owed-set obligation: the period start in whole seconds since the epoch.
 * @experimental Storage-facing building block; see docs/guides/REPORTING-STABILITY.md.
 */
export function reportingLedgerOwedSetOrdinalV1(periodStart: string): number {
  const start = Date.parse(periodStart);
  if (!Number.isFinite(start)) throw new TypeError('Owed-set period start must be an RFC 3339 instant');
  return Math.floor(start / 1_000);
}

/**
 * Monotonic merge of owed-set progress: `through` and `until` only move later, `from` only
 * earlier, and `mediaBuyIds` is a sorted union. Stores apply it under their account fence.
 * @experimental Storage-facing building block; see docs/guides/REPORTING-STABILITY.md.
 */
export function mergeReportingLedgerOwedSetV1(
  current: ReportingLedgerOwedSetV1 | undefined,
  progress: Omit<ReportingLedgerOwedSetProgressV1, 'configurationId' | 'account_id'>
): ReportingLedgerOwedSetV1 {
  const later = (left: string | undefined, right: string | undefined) =>
    left === undefined ? right : right === undefined ? left : Date.parse(right) > Date.parse(left) ? right : left;
  const earlier = (left: string | undefined, right: string | undefined) =>
    left === undefined ? right : right === undefined ? left : Date.parse(right) < Date.parse(left) ? right : left;
  for (const value of [progress.through, progress.from, progress.until]) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) {
      throw new TypeError('Owed-set progress instants must be RFC 3339 instants');
    }
  }
  const canonical = (value: string | undefined) => (value === undefined ? undefined : new Date(value).toISOString());
  const through = later(current?.through, canonical(progress.through));
  const from = earlier(current?.from, canonical(progress.from));
  const until = later(current?.until, canonical(progress.until));
  return {
    ...(through !== undefined ? { through } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(until !== undefined ? { until } : {}),
    mediaBuyIds: [...new Set([...(current?.mediaBuyIds ?? []), ...(progress.mediaBuyIds ?? [])])].sort(),
  };
}

/**
 * The media buys a generation answers for in scope matching. An owed-set generation answers for
 * the union of its written obligations' frozen `media_buy_ids`, never its own (empty)
 * install-time `mediaBuyIds`.
 * @experimental Storage-facing building block; see docs/guides/REPORTING-STABILITY.md.
 */
export function reportingLedgerConfigurationMediaBuyIdsV1(configuration: ReportingLedgerConfigurationV1): string[] {
  return isReportingLedgerOwedSetV1(configuration)
    ? (configuration.owedSet?.mediaBuyIds ?? [])
    : configuration.mediaBuyIds;
}

export function reportingLedgerConfigurationMatchesScope(
  query: ReportingLedgerSnapshotQueryV1,
  configuration: ReportingLedgerConfigurationV1
): boolean {
  return (
    (!query.feed_purposes || query.feed_purposes.includes(configuration.feedPurpose)) &&
    (!query.media_buy_ids ||
      reportingLedgerConfigurationMediaBuyIdsV1(configuration).some(value => query.media_buy_ids!.includes(value)))
  );
}

export function reportingLedgerSuccessor(
  configuration: ReportingLedgerConfigurationV1,
  configurations: readonly ReportingLedgerConfigurationV1[]
): ReportingLedgerConfigurationV1 | undefined {
  // An owed-set generation owns exactly its written obligations: nothing succeeds it, and it
  // never succeeds an account generation.
  if (isReportingLedgerOwedSetV1(configuration)) return undefined;
  const installed = Date.parse(configuration.installedAt);
  return configurations
    .filter(value => {
      if (
        isReportingLedgerOwedSetV1(value) ||
        value.account.account_id !== configuration.account.account_id ||
        value.delivery_config_id !== configuration.delivery_config_id
      ) {
        return false;
      }
      const candidateInstalled = Date.parse(value.installedAt);
      return (
        candidateInstalled > installed ||
        (candidateInstalled === installed && value.delivery_config_version > configuration.delivery_config_version)
      );
    })
    .sort(
      (left, right) =>
        Date.parse(left.installedAt) - Date.parse(right.installedAt) ||
        left.delivery_config_version - right.delivery_config_version ||
        left.configurationId.localeCompare(right.configurationId)
    )[0];
}

export function relevantReportingLedgerConfigurations(
  configurations: ReportingLedgerConfigurationV1[],
  periodStart: string,
  periodEnd: string
): ReportingLedgerConfigurationV1[] {
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  return configurations.filter(configuration => {
    if (isReportingLedgerOwedSetV1(configuration)) {
      // Relevant where its written obligations are, which is all it owns.
      const owedSet = configuration.owedSet;
      if (owedSet?.from === undefined || owedSet.until === undefined) return false;
      return Date.parse(owedSet.from) < end && Date.parse(owedSet.until) > start;
    }
    const installed = Date.parse(configuration.historyStart ?? configuration.installedAt);
    const successor = reportingLedgerSuccessor(configuration, configurations);
    const superseded = Math.min(
      successor ? Date.parse(successor.installedAt) : Number.POSITIVE_INFINITY,
      configuration.supersededAt ? Date.parse(configuration.supersededAt) : Number.POSITIVE_INFINITY
    );
    return installed < end && superseded > start;
  });
}

export function matchingReportingLedgerConfigurations(
  query: ReportingLedgerSnapshotQueryV1,
  configurations: ReportingLedgerConfigurationV1[],
  ledgerAsOf: string
): ReportingLedgerConfigurationV1[] {
  const period = reportingLedgerEffectivePeriod(query, ledgerAsOf);
  return relevantReportingLedgerConfigurations(configurations, period.start, period.end).filter(configuration =>
    reportingLedgerConfigurationMatchesScope(query, configuration)
  );
}

export function evaluateReportingLedgerCoverageV1(
  query: ReportingLedgerSnapshotQueryV1,
  configurations: ReportingLedgerConfigurationV1[],
  obligations: ReadonlyArray<{
    configurationId: string;
    periodOrdinal: number;
    period?: { start: string; end: string };
  }>,
  ledgerAsOf: string
): { complete: boolean; retainedFrom: string; owedSetOpen?: true } {
  const period = reportingLedgerEffectivePeriod(query, ledgerAsOf);
  if (configurations.length === 0) return { complete: true, retainedFrom: period.start };
  const stored = new Map<string, Set<number>>();
  for (const obligation of obligations) {
    const ordinals = stored.get(obligation.configurationId) ?? new Set<number>();
    ordinals.add(obligation.periodOrdinal);
    stored.set(obligation.configurationId, ordinals);
  }
  let complete = true;
  let owedSetOpen = false;
  let retainedFrom: string | undefined;
  for (const configuration of configurations.filter(value => reportingLedgerConfigurationMatchesScope(query, value))) {
    if (isReportingLedgerOwedSetV1(configuration)) {
      // The obligations present are the owed set by construction, so a gap is a period that is
      // not owed, never a continuity failure. Completeness is the planner's horizon: until
      // `owedSet.through` reaches the scope end, an owed period may still enter the scope.
      const through = configuration.owedSet?.through;
      if (through === undefined || Date.parse(through) < Date.parse(period.end)) owedSetOpen = true;
      for (const obligation of obligations) {
        if (obligation.configurationId !== configuration.configurationId || !obligation.period) continue;
        if (
          Date.parse(obligation.period.start) < Date.parse(period.end) &&
          Date.parse(obligation.period.end) > Date.parse(period.start) &&
          (!retainedFrom || Date.parse(obligation.period.start) < Date.parse(retainedFrom))
        ) {
          retainedFrom = obligation.period.start;
        }
      }
      continue;
    }
    const installedAt = Date.parse(configuration.historyStart ?? configuration.installedAt);
    const successor = reportingLedgerSuccessor(configuration, configurations);
    const ownershipEnd = Math.min(
      successor ? Date.parse(successor.installedAt) : Number.POSITIVE_INFINITY,
      configuration.supersededAt ? Date.parse(configuration.supersededAt) : Number.POSITIVE_INFINITY
    );
    let schedule: ReturnType<typeof reportingPeriodSchedule>;
    try {
      schedule = reportingPeriodSchedule(configuration);
    } catch (error) {
      const frozen = obligations.filter(
        (value): value is { configurationId: string; periodOrdinal: number; period: { start: string; end: string } } =>
          value.period !== undefined
      );
      if (
        !isFrozenCalendarRulesMismatch(error) ||
        !frozenCalendarObligationsCoverOwnership(configuration, ownershipEnd, frozen)
      ) {
        throw error;
      }
      const owned = frozen
        .filter(value => value.configurationId === configuration.configurationId)
        .sort((left, right) => left.periodOrdinal - right.periodOrdinal);
      if (!owned.length) continue;
      const start = owned[0]!.period.start;
      const end = owned.at(-1)!.period.end;
      if (Date.parse(period.start) < Date.parse(end) && Date.parse(period.end) > Date.parse(start)) {
        if (!retainedFrom || Date.parse(start) < Date.parse(retainedFrom)) retainedFrom = start;
      }
      continue;
    }
    const firstOwned = configuration.historyStartOrdinal ?? Math.max(0, schedule.ceil(installedAt));
    const ownershipLast = Number.isFinite(ownershipEnd) ? schedule.ceil(ownershipEnd) - 1 : Number.POSITIVE_INFINITY;
    if (ownershipLast < firstOwned) continue;
    const end = Number.isFinite(ownershipLast) ? schedule.boundary(ownershipLast + 1) : Number.POSITIVE_INFINITY;
    const start = schedule.boundary(firstOwned);
    if (Date.parse(period.start) >= end || Date.parse(period.end) <= start) continue;
    const first = schedule.floor(Math.max(start, Date.parse(period.start)));
    const queryLast = schedule.ceil(Math.min(Date.parse(period.end), end)) - 1;
    const closedLast = schedule.floor(Math.min(Date.parse(ledgerAsOf), end)) - 1;
    const last = Math.min(ownershipLast, queryLast, closedLast);
    const ordinals = stored.get(configuration.configurationId) ?? new Set<number>();
    const matching = [...ordinals].filter(ordinal => ordinal >= first && ordinal <= last).sort((a, b) => a - b);
    if (first <= last) {
      schedule.period(first);
      schedule.period(last);
    }
    // Counts alone cannot certify coverage over an unrepresentable civil
    // interval, including a missing interior date between valid outer bounds.
    // Validate every retained interval counted here, without walking absent
    // history (which already makes the count incomplete).
    for (const ordinal of matching) schedule.period(ordinal);
    if (matching.length !== Math.max(0, last - first + 1)) complete = false;
    const earliest = matching[0];
    if (earliest !== undefined) {
      const boundary = new Date(schedule.boundary(earliest)).toISOString();
      if (!retainedFrom || Date.parse(boundary) < Date.parse(retainedFrom)) retainedFrom = boundary;
    }
    if (!complete) break;
  }
  return { complete, retainedFrom: retainedFrom ?? period.start, ...(owedSetOpen ? { owedSetOpen: true } : {}) };
}

/**
 * Store-side guard, evaluated under the same account lock as generation writes.
 * @experimental Storage-facing building block; see docs/guides/REPORTING-STABILITY.md.
 */
export function assertReportingLedgerHistoryDoesNotOverlap(
  configuration: ReportingLedgerConfigurationV1,
  configurations: readonly ReportingLedgerConfigurationV1[]
): void {
  if (configuration.historyStart === undefined || isReportingLedgerOwedSetV1(configuration)) return;
  configurations = configurations.filter(value => !isReportingLedgerOwedSetV1(value));
  const all = [
    ...configurations.filter(value => value.configurationId !== configuration.configurationId),
    configuration,
  ];
  const range = (value: ReportingLedgerConfigurationV1): [number, number] => {
    const schedule = reportingPeriodSchedule(value);
    const first = value.historyStartOrdinal ?? Math.max(0, schedule.ceil(Date.parse(value.installedAt)));
    const successor = reportingLedgerSuccessor(value, all);
    const end = Math.min(
      successor ? Date.parse(successor.installedAt) : Infinity,
      value.supersededAt ? Date.parse(value.supersededAt) : Infinity
    );
    return [schedule.boundary(first), Number.isFinite(end) ? schedule.boundary(schedule.ceil(end)) : Infinity];
  };
  const [start, ownershipEnd] = range(configuration);
  const previous = configurations.find(value => value.configurationId === configuration.configurationId);
  const schedule = reportingPeriodSchedule(configuration);
  const previousStart =
    previous?.historyStart !== undefined
      ? Date.parse(previous.historyStart)
      : schedule.boundary(Math.max(0, schedule.ceil(Date.parse(configuration.installedAt))));
  // Generation handoffs may already overlap when schedules change. Only the
  // newly added prefix may acquire ownership; preserve existing straddling periods.
  const end = Math.min(ownershipEnd, previousStart);
  if (start >= end) return;
  for (const other of all) {
    if (
      other.configurationId === configuration.configurationId ||
      other.account.account_id !== configuration.account.account_id ||
      other.delivery_config_id !== configuration.delivery_config_id
    )
      continue;
    // This lower bound proves disjointness even when a sealed sibling's
    // timezone rules cannot be resolved on the current runtime.
    if (Date.parse(other.historyStart ?? other.installedAt) >= end) continue;
    const [otherStart, otherEnd] = range(other);
    if (start < end && otherStart < otherEnd && start < otherEnd && otherStart < end) {
      throw new RangeError('Reporting history overlaps another configuration generation');
    }
  }
}

/**
 * The single admission rule for receipts and consumer statuses against subscription
 * obligations (experimental, AdCP 3.3). Change it here and nowhere else.
 *
 * - Without an admission, nothing is scoped: subscriptions are off.
 * - An account obligation accepts any consumer of the account; a subscription obligation only
 *   its owning principal.
 *
 * Access means access: there is no post-revocation window. Once a principal loses authority for
 * an account, the host's account resolution refuses every task on it, `sync_reporting_receipts`
 * and `sync_reporting_status` included, so this rule never sees such a caller. A seller that
 * wants a buyer to finish reconciling keeps a reduced grant instead of revoking (for example
 * `allowed_tasks` limited to `get_reporting_status`, `sync_reporting_receipts` and
 * `sync_reporting_status`), and this rule then applies as usual.
 * @experimental Storage-facing building block; see docs/guides/REPORTING-STABILITY.md.
 */
export function reportingSubscriptionReceiptAdmissibleV1(input: {
  obligation: { subscription?: ReportingLedgerSubscriptionV1 | undefined };
  admission?: ReportingSubscriptionReceiptAdmissionV1;
}): boolean {
  const { admission, obligation } = input;
  if (!admission) return true;
  const owner = obligation.subscription;
  return (
    owner === undefined ||
    (owner.tenantId === admission.principal.tenantId && owner.principalId === admission.principal.principalId)
  );
}
