import { createHash } from 'node:crypto';

import { canonicalJsonV1 } from '../source';
import { canonicalReportingInstant } from './instant';
import type {
  ReportingConsumerStatusBatchInputV1,
  ReportingConsumerStatusChainIdentityV1,
  ReportingLedgerConsumerStatementV1,
  ReportingLedgerConsumerStatusInputV1,
} from './types';

const CONSUMER_STATUS_ID_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
}

/**
 * Returns the stable logical-chain key adapters must use for duplicate and
 * current-leaf checks. Equivalent RFC 3339 spellings share one chain.
 */
export function reportingConsumerStatusChainKeyV1(status: ReportingLedgerConsumerStatusInputV1): string {
  return reportingConsumerStatusChainKeyFromIdentityV1({
    delivery_config_id: status.delivery_config_id,
    delivery_config_version: status.delivery_config_version,
    report_definition_id: status.report_definition_id,
    periodStart: status.period.start,
    periodEnd: status.period.end,
    sourceTimezone: status.period.source_timezone,
  });
}

/** Returns the stable logical-chain key for an item that failed full parsing. */
export function reportingConsumerStatusChainKeyFromIdentityV1(value: ReportingConsumerStatusChainIdentityV1): string {
  return digest({
    delivery_config_id: value.delivery_config_id,
    delivery_config_version: value.delivery_config_version,
    report_definition_id: value.report_definition_id,
    period: {
      start: canonicalReportingInstant(value.periodStart),
      end: canonicalReportingInstant(value.periodEnd),
      source_timezone: value.sourceTimezone,
    },
  });
}

/** Returns the immutable semantic fingerprint used for unchanged/conflict checks. */
export function reportingConsumerStatusFingerprintV1(
  status: ReportingLedgerConsumerStatusInputV1 | ReportingLedgerConsumerStatementV1
): string {
  const semanticValue = Object.fromEntries(
    Object.entries(status).filter(([key]) => !['account_id', 'consumerId', 'recorded_at'].includes(key))
  );
  return digest(JSON.parse(JSON.stringify(semanticValue)) as Record<string, unknown>);
}

/**
 * Produces collision-free result IDs while marking malformed caller IDs.
 * Stores should reject marked entries and retain these IDs in ordered replay.
 */
export function normalizeReportingConsumerStatusIdsV1(entries: ReportingConsumerStatusBatchInputV1['entries']): {
  values: string[];
  invalidIndexes: Set<number>;
} {
  const invalidIndexes = new Set<number>();
  const reserved = new Set<string>();
  for (const entry of entries) {
    const value = 'status' in entry ? entry.status.reporting_status_id : entry.reporting_status_id;
    if (
      typeof value === 'string' &&
      CONSUMER_STATUS_ID_PATTERN.test(value) &&
      !('syntheticReportingStatusId' in entry && entry.syntheticReportingStatusId)
    ) {
      reserved.add(value);
    }
  }
  const values = entries.map((entry, index) => {
    const value = 'status' in entry ? entry.status.reporting_status_id : entry.reporting_status_id;
    if (
      typeof value === 'string' &&
      CONSUMER_STATUS_ID_PATTERN.test(value) &&
      !('syntheticReportingStatusId' in entry && entry.syntheticReportingStatusId)
    ) {
      return value;
    }
    invalidIndexes.add(index);
    let candidate = `invalid-reporting-status-id-${index + 1}`;
    let suffix = 1;
    while (reserved.has(candidate)) candidate = `invalid-reporting-status-id-${index + 1}-${suffix++}`;
    reserved.add(candidate);
    return candidate;
  });
  return { values, invalidIndexes };
}
