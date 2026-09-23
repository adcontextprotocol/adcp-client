import type { ReportingLedgerConfigurationV1, ReportingLedgerSnapshotQueryV1 } from './types';
import { reportingPeriodSchedule } from './schedule';

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

export function reportingLedgerConfigurationMatchesScope(
  query: ReportingLedgerSnapshotQueryV1,
  configuration: ReportingLedgerConfigurationV1
): boolean {
  return (
    (!query.feed_purposes || query.feed_purposes.includes(configuration.feedPurpose)) &&
    (!query.media_buy_ids || configuration.mediaBuyIds.some(value => query.media_buy_ids!.includes(value)))
  );
}

export function reportingLedgerSuccessor(
  configuration: ReportingLedgerConfigurationV1,
  configurations: readonly ReportingLedgerConfigurationV1[]
): ReportingLedgerConfigurationV1 | undefined {
  const installed = Date.parse(configuration.installedAt);
  return configurations
    .filter(value => {
      if (
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
    const installed = Date.parse(configuration.installedAt);
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
  obligations: ReadonlyArray<{ configurationId: string; periodOrdinal: number }>,
  ledgerAsOf: string
): { complete: boolean; retainedFrom: string } {
  const period = reportingLedgerEffectivePeriod(query, ledgerAsOf);
  if (configurations.length === 0) return { complete: true, retainedFrom: period.start };
  const stored = new Map<string, Set<number>>();
  for (const obligation of obligations) {
    const ordinals = stored.get(obligation.configurationId) ?? new Set<number>();
    ordinals.add(obligation.periodOrdinal);
    stored.set(obligation.configurationId, ordinals);
  }
  let complete = true;
  let retainedFrom: string | undefined;
  for (const configuration of configurations.filter(value => reportingLedgerConfigurationMatchesScope(query, value))) {
    const schedule = reportingPeriodSchedule(configuration);
    const installedAt = Date.parse(configuration.installedAt);
    const successor = reportingLedgerSuccessor(configuration, configurations);
    const firstOwned = Math.max(0, schedule.ceil(installedAt));
    const ownershipEnd = Math.min(
      successor ? Date.parse(successor.installedAt) : Number.POSITIVE_INFINITY,
      configuration.supersededAt ? Date.parse(configuration.supersededAt) : Number.POSITIVE_INFINITY
    );
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
    if (matching.length !== Math.max(0, last - first + 1)) complete = false;
    const earliest = matching[0];
    if (earliest !== undefined) {
      const boundary = new Date(schedule.boundary(earliest)).toISOString();
      if (!retainedFrom || Date.parse(boundary) < Date.parse(retainedFrom)) retainedFrom = boundary;
    }
    if (!complete) break;
  }
  return { complete, retainedFrom: retainedFrom ?? period.start };
}
